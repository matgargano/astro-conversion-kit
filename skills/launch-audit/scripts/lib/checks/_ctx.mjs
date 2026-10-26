// The audit context every launch-audit check reads.
//
// buildAuditContext(net, dns, options) does all of the fetching for the launch-audit phase, once,
// and hands the result to the check modules as a frozen-in-spirit `ctx`. Checks are pure over it:
// a check never fetches, so everything a check could want is probed here, in this order:
//
//   1. robots.txt          — parsed when it 200s, `parsed: null` otherwise (a 404 is not a parse)
//   2. sitemaps            — discovery, then one-level expansion of the FIRST sitemap found
//   3. crawl               — seeded with the start url and every expanded sitemap loc
//   4. root variants       — http://host/, https://host/, the apex root, the www counterpart when
//                            the host is one that could have one (`probes.wwwRoot` is null for a
//                            subdomain target, which is never probed), plus the trailing-slash
//                            variant of the start path when it isn't "/"
//   5. notFound            — /this-page-should-not-exist-<random>, for soft-404 detection
//   6. llms.txt            — presence and shape
//   7. static asset sample — up to two stylesheets, scripts and images the crawl actually saw
//   8. head assets         — every og:image, icon, apple-touch-icon and manifest url the crawled
//                            pages declare, deduped across the whole crawl and fetched once each
//   9. externals           — every off-origin link the crawl saw, HEADed once each
//  10. images              — every <img src> and srcset candidate, GET (the bytes are the evidence)
//  11. embeds              — the iframes and scripts that could be a form: inside a <form>, or on a
//                            host that exists to host forms
//  12. certs               — net.cert() per host variant; `cert` is the target host's
//  13. old site            — only when `options.oldUrl` is given: the same crawl again over the
//                            old origin (its own robots.txt and sitemap, the same caps), and then
//                            every path that crawl found, requested once on the NEW origin, so the
//                            redirects dimension can say what each old url does after the cutover
//
// Every one of those probe sets is capped, and every cap is recorded in `ctx.probes.caps` as
// `{cap, dropped}` so the report's mandatory "Not covered" section can say what the audit did not
// look at instead of implying it looked at everything. A url past a cap is simply absent from its
// map, and a check that cannot see a response says nothing rather than guessing.
//
// The 404 probe's random suffix comes from `options.random`, which defaults to crypto randomness;
// tests pin it (`random: () => 'deadbeef'`) so a recorded fixture can hold that exact path. Time
// is pinned the same way through `options.now`, so "is this lastmod in the future" never drifts.
//
// `ctx.dns` is the adapter from dns.mjs; `ctx.dnsRecords` is the one set of records resolved here,
// because every dimension that asks about email authentication asks about the same three records
// on the same registrable domain. Every lookup in dns.mjs is total, so an absent record is the
// absent shape rather than a rejection, and a site whose DNS cannot be resolved at all still
// produces a context.
//
// `ctx.browser` is whatever the orchestrator learned about the browser tier — `{available,
// reason}` — or null when it was never asked. The http-tier checks that have a browser-tier
// counterpart read it to say, once, that the deeper check did not run and why.

import { randomBytes } from 'node:crypto'
import { parseRobots } from '../robots.mjs'
import { discoverSitemaps, expandSitemap } from '../sitemap.mjs'
import { crawlSite } from '../crawl.mjs'
import { DKIM_SELECTORS } from '../dns.mjs'

const EMPTY_EXPANSION = { urls: [], children: [], errors: [], failedClosed: false }

// Registrable-domain suffixes that occupy two labels, so `example.co.uk` is a site the way
// `example.test` is. Enough of the common ones to keep the www question honest; this is not a
// public suffix list and is not trying to be one.
const TWO_LABEL_SUFFIXES = new Set(['co.uk', 'org.uk', 'com.au', 'co.nz', 'com.br', 'co.jp', 'co.za', 'com.mx'])

// Does a `www.` counterpart of this host even make sense? It does for `example.test` and for
// `www.example.test`, and it does not for `app.example.test` — nobody serves `www.app.example.test`,
// so probing it would invent a broken host and then report it.
function hasWwwCounterpart(host) {
  if (/^www\./i.test(host)) return true
  const labels = host.split('.')
  if (labels.length === 2) return true
  if (labels.length === 3 && TWO_LABEL_SUFFIXES.has(labels.slice(1).join('.').toLowerCase())) return true
  return false
}

const ASSET_SAMPLE_PER_KIND = 2
// The head-asset set is a handful of urls on a normal site — one favicon, one touch icon, one
// manifest, one og:image per template — but a page builder that stamps a per-page og:image makes
// it grow with the crawl, so it is capped. A url past the cap is simply absent from the map, and
// the checks treat an absent url as unknown rather than broken.
const HEAD_ASSET_LIMIT = 100
const HEAD_ASSET_RELS = ['icon', 'apple-touch-icon', 'manifest']
const HEAD_ASSET_META = ['og:image', 'og:image:secure_url']

// An external link set is the crawl's own external link map, so it grows with the site's outbound
// links rather than its pages; 200 covers an ordinary site's footer, partner list and citations.
const EXTERNAL_LIMIT = 200
// Images are per page rather than per site, so this is the one set that a large crawl really can
// fill. Fetched with GET because the checks weigh the bytes and hash them.
const IMAGE_LIMIT = 300
// Form embeds are a handful on any site that has them at all.
const EMBED_LIMIT = 50

// Hosts that exist to host forms and booking widgets. A script or iframe from one of these is a
// form even when it is mounted outside the <form> it replaces, which is how most of them work.
const FORM_EMBED_HOSTS = [
  'hsforms.net', 'hubspot.com', 'typeform.com', 'jotform.com', 'formstack.com', 'cognitoforms.com',
  'gravityforms', 'wufoo.com', 'tally.so', 'formspree.io', 'submit-form.com', 'netlify.app', 'netlify.com', 'getform.io', 'basin.com',
  'formcarry.com', 'mailchimp.com', 'list-manage.com', 'calendly.com', 'acuityscheduling.com',
]

// A needle with a dot is a registrable host, matched as itself or as a parent of the host seen
// (`js.hsforms.net` is `hsforms.net`). A needle without one is a product name that appears inside
// whatever host that product happens to use, and is matched as a substring on purpose.
const isFormEmbedHost = (host) => FORM_EMBED_HOSTS.some((needle) => (
  needle.includes('.') ? host === needle || host.endsWith(`.${needle}`) : host.includes(needle)
))

// Absolute http(s) urls only, deduped, in discovery order. Everything a probe set collects goes
// through this: a data: icon, a mailto: link and a relative url that would not resolve all have no
// response to fetch, so none of them belongs in a map of responses.
function urlCollector() {
  const urls = new Set()
  return {
    add(href) {
      if (typeof href !== 'string' || href === '') return
      let parsed
      try {
        parsed = new URL(href)
      } catch {
        return
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
      urls.add(parsed.href)
    },
    all: () => [...urls],
  }
}

// Apply a cap, and say what it cost. The pair is what `probes.caps` reports.
function capped(urls, cap) {
  return { urls: urls.slice(0, cap), caps: { cap, dropped: Math.max(0, urls.length - cap) } }
}

// The candidate urls in a srcset, which is a comma-separated list whose entries are `url` followed
// by an optional descriptor. Split tolerantly: a url containing a comma (a data: uri, a query with
// a list) is not one of the http(s) urls this collects, so the simple split never loses one.
function srcsetUrls(srcset, base) {
  if (typeof srcset !== 'string' || srcset.trim() === '') return []
  const out = []
  for (const candidate of srcset.split(',')) {
    const url = candidate.trim().split(/\s+/)[0]
    if (url === undefined || url === '') continue
    try {
      out.push(new URL(url, base).href)
    } catch {
      // A candidate that does not resolve is markup to fix, not a url to fetch.
    }
  }
  return out
}

// The old-site pages worth asking the new site about: every old page that actually answered 2xx,
// as `{url, path}` where path is `pathname + search`, deduped by path, in crawl order. A url that
// was already gone on the old site is not a url anybody is still following, and a path is the
// right key because the whole question is what the NEW origin does with it. The redirects
// dimension reads the same list, so the rows it builds and the urls probed here never drift.
export function oldPageEntries(oldCrawl) {
  const byPath = new Map()
  for (const entry of oldCrawl?.pages ?? []) {
    if (entry.status < 200 || entry.status >= 300) continue
    try {
      const parsed = new URL(entry.url)
      const path = parsed.pathname + parsed.search
      if (!byPath.has(path)) byPath.set(path, { url: entry.url, path })
    } catch {
      // A page url the crawl produced always parses; if it does not, it is not a path to probe.
    }
  }
  return [...byPath.values()]
}

export const oldPagePaths = (oldCrawl) => oldPageEntries(oldCrawl).map((entry) => entry.path)

function sampleAssets(assets, origin) {
  const picked = []
  for (const kind of ['styles', 'scripts', 'images']) {
    const set = assets?.[kind]
    if (!set) continue
    let taken = 0
    for (const url of set) {
      if (taken >= ASSET_SAMPLE_PER_KIND) break
      let parsed
      try {
        parsed = new URL(url)
      } catch {
        continue
      }
      if (parsed.origin !== origin) continue
      picked.push({ url, kind })
      taken++
    }
  }
  return picked
}

// The urls a check like `head.favicon-broken` or `head.og-image-small` has to see a response for.
// Collected from the pages the crawl actually parsed, so nothing here invents a url the site does
// not declare; `page.head.links` and the og meta values are already absolute by the time they get
// here, and anything that is not http(s) (a data: icon, say) has no response to fetch.
function headAssetUrls(crawl) {
  const collector = urlCollector()
  for (const entry of crawl.pages) {
    if (entry.page === null) continue
    for (const key of HEAD_ASSET_META) collector.add(entry.page.head.metaByProperty.get(key))
    for (const link of entry.page.head.links) {
      if (link.rel === null) continue
      const rels = link.rel.split(/\s+/)
      if (rels.some((rel) => HEAD_ASSET_RELS.some((wanted) => rel.includes(wanted)))) collector.add(link.href)
    }
  }
  return collector.all()
}

// Every image a fetched page displays: the `src` a browser falls back to, and every candidate in a
// `srcset`, since a responsive image usually serves one of those and never the fallback. Relative
// candidates resolve against the page's own base, the way html.mjs already resolved `src`.
function imageUrls(crawl) {
  const collector = urlCollector()
  for (const entry of crawl.pages) {
    if (entry.page === null) continue
    const base = entry.page.head.base ?? entry.finalUrl ?? entry.url
    for (const image of entry.page.images) {
      collector.add(image.src)
      for (const candidate of srcsetUrls(image.srcset, base)) collector.add(candidate)
    }
  }
  return collector.all()
}

// The embeds that could be a form: an iframe or a script written inside a <form>, plus anything
// off-origin from a host that exists to host forms, wherever it sits on the page. Off-origin is
// required for the host-list branch, because a site *hosted* on one of those domains matches its
// own host: `https://acme.netlify.app/widget.html` in an <iframe> is that site's own page, not an
// embedded form. A same-origin script outside a form is the site's own bundle, and is left alone
// for the same reason.
function embedUrls(crawl) {
  const collector = urlCollector()
  for (const entry of crawl.pages) {
    if (entry.page === null) continue
    let origin = null
    try {
      origin = new URL(entry.finalUrl ?? entry.url).origin
    } catch {
      origin = null
    }
    const parse = (src) => {
      if (typeof src !== 'string' || src === '') return null
      try {
        return new URL(src)
      } catch {
        return null
      }
    }
    // An iframe is a form embed when it sits inside a <form>, or when it comes from another origin
    // that exists to host forms.
    for (const frame of entry.page.iframes) {
      const parsed = parse(frame.src)
      if (parsed === null) continue
      if (frame.inForm || (parsed.origin !== origin && isFormEmbedHost(parsed.hostname.toLowerCase()))) collector.add(frame.src)
    }
    // A script is only ever a form embed when it comes from another origin: a same-origin script is
    // the site's own code, inside a <form> or not.
    for (const script of entry.page.scripts) {
      const parsed = parse(script.src)
      if (parsed === null || parsed.origin === origin) continue
      if (script.inForm || isFormEmbedHost(parsed.hostname.toLowerCase())) collector.add(script.src)
    }
  }
  return collector.all()
}

export async function buildAuditContext(net, dns, options = {}) {
  if (!options || typeof options.url !== 'string' || options.url === '') throw new Error('buildAuditContext: options.url is required')
  const start = new URL(options.url)
  const url = start.href
  const origin = start.origin
  const host = start.hostname
  const apex = host.replace(/^www\./i, '')
  const www = `www.${apex}`
  const random = typeof options.random === 'function' ? options.random : () => randomBytes(4).toString('hex')
  const now = options.now === undefined ? new Date() : new Date(options.now)

  const maxPages = options.maxPages ?? 200
  const maxDepth = options.maxDepth ?? 4
  const ignoreRobots = options.ignoreRobots === true
  // The probe-set limits, overridable per set. Nothing on the command line sets these — they are
  // here so a test can trip a cap against a small fixture instead of needing a fixture with three
  // hundred images in it, and so a caller with a reason can lower one.
  const limits = {
    headAssets: HEAD_ASSET_LIMIT,
    externals: EXTERNAL_LIMIT,
    images: IMAGE_LIMIT,
    embeds: EMBED_LIMIT,
    ...(options.caps ?? {}),
  }

  const wwwCounterpart = hasWwwCounterpart(host)
  const target = {
    url,
    origin,
    host,
    apex,
    www,
    hasWwwCounterpart: wwwCounterpart,
    staging: options.staging === true,
    devHosts: [...(options.devHosts ?? [])],
  }

  // 1. robots.txt
  const robotsUrl = `${origin}/robots.txt`
  const robotsResponse = await net.get(robotsUrl)
  const robotsText = robotsResponse.status === 200 && typeof robotsResponse.body === 'string' ? robotsResponse.body : null
  const robots = {
    url: robotsUrl,
    status: robotsResponse.status,
    text: robotsText,
    parsed: robotsText === null ? null : parseRobots(robotsText),
    response: robotsResponse,
  }

  // 2. sitemaps
  const { candidates, found } = await discoverSitemaps(net, origin, robots.parsed)
  const expanded = found.length > 0 ? await expandSitemap(net, found[0].url) : { ...EMPTY_EXPANSION }
  const sitemaps = { candidates, found, expanded, urls: expanded.urls.map((entry) => entry.loc) }

  // 3. crawl
  const crawl = await crawlSite(net, {
    url,
    maxPages,
    maxDepth,
    ignoreRobots,
    robots: robots.parsed,
    sitemapUrls: sitemaps.urls,
  })

  // 4. root variants
  const wwwUrl = wwwCounterpart ? `${start.protocol}//${www}/` : null
  const variantUrls = [
    `http://${host}/`,
    `https://${host}/`,
    ...(wwwUrl === null ? [] : [wwwUrl]),
    `${start.protocol}//${apex}/`,
  ]
  const slashPath = start.pathname === '/'
    ? null
    : (start.pathname.endsWith('/') ? start.pathname.slice(0, -1) : `${start.pathname}/`)
  const slashUrl = slashPath === null ? null : `${origin}${slashPath}${start.search}`

  // 5/6. the 404 probe and llms.txt
  const notFoundUrl = `${origin}/this-page-should-not-exist-${random()}`
  const llmsUrl = `${origin}/llms.txt`

  // An apex https target makes httpsRoot and apexRoot the same url; fetch each distinct url once.
  const probeUrls = [...new Set([...variantUrls, ...(slashUrl === null ? [] : [slashUrl]), notFoundUrl, llmsUrl])]
  const probeResponses = await net.map(probeUrls, (probeUrl) => net.get(probeUrl))
  const byProbeUrl = new Map(probeUrls.map((probeUrl, i) => [probeUrl, probeResponses[i]]))
  const at = (probeUrl) => byProbeUrl.get(probeUrl)

  // 7. a sample of the static assets the crawl actually saw. HEAD is enough for a script or an
  // image, where only the headers are ever read — but a stylesheet is one of the few assets a
  // check reads the *text* of (`perf.font-display-missing` looks for @font-face blocks), and a
  // real server answers HEAD with no body at all, so stylesheets are fetched with GET.
  const assetPicks = sampleAssets(crawl.assets, origin)
  const fetchAsset = typeof net.head === 'function' ? (u) => net.head(u) : (u) => net.get(u)
  const assetResponses = await net.map(assetPicks, (pick) => (pick.kind === 'styles' ? net.get(pick.url) : fetchAsset(pick.url)))
  const assets = assetPicks.map((pick, i) => ({ ...pick, response: assetResponses[i] }))

  // 8. every head asset the crawl saw, fetched once each. net.get rather than net.head, because
  // the og:image checks read the response bytes to measure the image.
  const headAssetPick = capped(headAssetUrls(crawl), limits.headAssets)
  const headAssetResponses = await net.map(headAssetPick.urls, (assetUrl) => net.get(assetUrl))
  const headAssets = new Map(headAssetPick.urls.map((assetUrl, i) => [assetUrl, headAssetResponses[i]]))

  // 9. every off-origin link the crawl saw. HEAD, because a link check only needs the status, and
  // net.head already falls back to GET on a server that refuses the method.
  const externalPick = capped([...crawl.externalLinks.keys()], limits.externals)
  const externalResponses = await net.map(externalPick.urls, fetchAsset)
  const externals = new Map(externalPick.urls.map((linkUrl, i) => [linkUrl, externalResponses[i]]))

  // 10. every image a fetched page displays. GET, because the bytes are the evidence: the size an
  // image weighs and the hash that proves two pages ship the same file.
  const imagePick = capped(imageUrls(crawl), limits.images)
  const imageResponses = await net.map(imagePick.urls, (imageUrl) => net.get(imageUrl))
  const images = new Map(imagePick.urls.map((imageUrl, i) => [imageUrl, imageResponses[i]]))

  // 11. the form embeds. GET, because a form host that answers 200 with an error page is a broken
  // form, and the body is what says so.
  const embedPick = capped(embedUrls(crawl), limits.embeds)
  const embedResponses = await net.map(embedPick.urls, (embedUrl) => net.get(embedUrl))
  const embeds = new Map(embedPick.urls.map((embedUrl, i) => [embedUrl, embedResponses[i]]))

  // 13. the old site, when the audit was told there is one: crawled the same way the new site was,
  // then every path it found asked once on the new origin. Nothing about the old origin is probed
  // beyond its own crawl — the question is what the new site does, not what the old one still does.
  let oldCrawl = null
  let oldPathPick = { urls: [], caps: { cap: maxPages, dropped: 0 } }
  const oldPaths = new Map()
  const oldStart = typeof options.oldUrl === 'string' && options.oldUrl !== '' ? new URL(options.oldUrl) : null
  // An old url on the origin being audited is the same site, not a cutover: crawling it would
  // fetch every page twice and then ask the new origin about its own paths, which answers
  // `same-path-200` for all of them and proves nothing. The cap records the skip so the report can
  // say why the redirect map is empty instead of implying every old url survived.
  if (oldStart !== null && oldStart.origin === origin) {
    oldPathPick = { urls: [], caps: { cap: 0, dropped: 0, skipped: 'old-url has the same origin as url' } }
  } else if (oldStart !== null) {
    const oldOrigin = oldStart.origin
    const oldRobotsResponse = await net.get(`${oldOrigin}/robots.txt`)
    const oldRobotsText = oldRobotsResponse.status === 200 && typeof oldRobotsResponse.body === 'string'
      ? oldRobotsResponse.body
      : null
    const oldRobots = oldRobotsText === null ? null : parseRobots(oldRobotsText)
    const oldDiscovery = await discoverSitemaps(net, oldOrigin, oldRobots)
    const oldExpanded = oldDiscovery.found.length > 0
      ? await expandSitemap(net, oldDiscovery.found[0].url)
      : { ...EMPTY_EXPANSION }
    oldCrawl = await crawlSite(net, {
      url: oldStart.href,
      maxPages,
      maxDepth,
      ignoreRobots,
      robots: oldRobots,
      sitemapUrls: oldExpanded.urls.map((entry) => entry.loc),
    })
    oldPathPick = capped(oldPagePaths(oldCrawl), maxPages)
    const oldResponses = await net.map(oldPathPick.urls, (path) => net.get(`${origin}${path}`))
    oldPathPick.urls.forEach((path, i) => oldPaths.set(path, oldResponses[i]))
  }

  const probes = {
    httpRoot: at(variantUrls[0]),
    httpsRoot: at(variantUrls[1]),
    wwwRoot: wwwUrl === null ? null : at(wwwUrl),
    apexRoot: at(`${start.protocol}//${apex}/`),
    slashVariant: slashUrl === null ? null : at(slashUrl),
    notFound: { url: notFoundUrl, response: at(notFoundUrl) },
    llmsTxt: at(llmsUrl),
    assets,
    headAssets,
    externals,
    images,
    embeds,
    oldPaths,
    caps: {
      externals: externalPick.caps,
      images: imagePick.caps,
      embeds: embedPick.caps,
      headAssets: headAssetPick.caps,
      oldPaths: oldPathPick.caps,
    },
  }

  // 12. cert — the target host's, and the other host variant's when one exists. Two certificates,
  // because they are routinely two: an apex on one provider and a www on a CDN in front of it each
  // present their own, and judging the www host by the apex's subject alternative names invents a
  // name mismatch no visitor would ever see.
  const certHosts = wwwCounterpart ? [...new Set([host, host === www ? apex : www])] : [host]
  const certs = new Map()
  if (typeof net.cert === 'function') {
    const results = await Promise.all(certHosts.map((name) => net.cert(name)))
    certHosts.forEach((name, i) => certs.set(name, results[i]))
  }
  const cert = certs.get(host) ?? null

  // The email records, on the registrable domain rather than the www host: mail is authenticated
  // for `example.test`, and `www.example.test` never publishes its own SPF.
  const [spf, dmarc, dkim] = await Promise.all([dns.spf(apex), dns.dmarc(apex), dns.dkim(apex, DKIM_SELECTORS)])
  const dnsRecords = { spf, dmarc, dkim }

  const browser = options.browser ?? null

  return { target, crawl, oldCrawl, robots, sitemaps, probes, cert, certs, dns, dnsRecords, browser, net, options, now }
}
