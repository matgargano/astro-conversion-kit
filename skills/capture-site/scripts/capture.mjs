#!/usr/bin/env node
// Page capture: a paced, read-only crawl of one site into a capture folder.
// Discovery: the home page, sitemaps (via fingerprint), --seed paths, then every same-site
// <a href>, <link rel=canonical> and HTML/hreflang <link rel=alternate> on a 200 HTML page.
// Each URL is requested once with redirects followed by hand, so chains are recorded hop by
// hop. Shortlinks (`/?p=N`) are recorded as unverified redirects and only requested with
// --verify-shortlinks. On WordPress the REST lists are dumped after the sitemaps (their pages and
// posts join the queue); every stylesheet and <style> block goes to css/, every same-site
// <script src> (classic or module), import map URL and modulepreload file to js/ (stylesheets'
// @import rules are followed, 5 deep); after the crawl the
// Wayback Machine's archived paths the crawl did not find go to wayback-unverified.txt.
// CAPTURE_WAYBACK_CDX overrides the CDX API address (tests point it at a local stand-in) and
// CAPTURE_WAYBACK_RETRY_MS the wait before its one retry.
// A bot challenge (lib/challenge.mjs) on any page or discovery request stops the run at once:
// the URL is recorded with status "challenge" (never a page) and queued again for --resume.
// The tiny-untitled-page rule alone stops it only on the capture's first HTML response or on
// SUSPECT_LIMIT such responses in a row; a single one mid-crawl is a "suspect-challenge" row.
// After the crawl one path that cannot exist (/<32 hex>/) is requested once, so the site's own
// 404 page lands in pages/404.html and meta.json `notFound` (it is not a route).
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion } from './lib/node-version.mjs';
import { fingerprint } from './fingerprint.mjs';
import { BLOCK_LIMIT, DEFAULT_CONCURRENCY, DEFAULT_DELAY_MS, DEFAULT_UA, fetchPaced, http, pacing, POLITE_DELAY_MS } from './lib/http.mjs';
import { expandSitemaps } from './lib/sitemaps.mjs';
import { extractPage } from './lib/extract.mjs';
import { slugFor } from './lib/slug.mjs';
import { loadState, newState, saveState } from './lib/state.mjs';
import { dumpWpRest } from './lib/wp-rest.mjs';
import { CDX_ENDPOINT, WAYBACK_FILE, waybackPaths } from './lib/wayback.mjs';
import { extensionOf, NEVER, NOT_PAGES, PAGE_EXTENSIONS } from './lib/page-rules.mjs';
import { cssImports } from './lib/css-urls.mjs';
import { CHALLENGE, SUSPECT, detectChallenge } from './lib/challenge.mjs';
import { excludedBy, parseExclude } from './lib/exclude.mjs';
import { parse } from 'parse5';

const USAGE = `Usage: node capture.mjs <origin> --out <dir> [options]

Crawl a live site, read-only and paced, into a capture folder: one record per page in
inventory.json, the raw HTML in pages/<slug>.html, the visible text in text/<slug>.txt,
redirects.json (chains collapsed, hops kept), links.json, scripts.json (third-party vendors),
meta.json (notFound: the site's 404 page, from one request for a path that cannot exist, saved
as pages/404.html and text/404.txt; icons: { status, file, contentType, bytes } for
/favicon.ico and /apple-touch-icon.png, one request each, redirects followed, a 200 saved as
assets/root-favicon.ico and assets/root-apple-touch-icon.png), sitemaps/ (every sitemap robots.txt names, and their children;
index.json lists every sitemap URL asked for with its status and file, and one robots.txt
names that did not answer 200 is also in meta.json discoveryErrors; one on another host is
listed with skipped: "other host" and never fetched), robots.txt, feeds/, files/ (a file a sitemap or --seed names, a .kml or PDF, saved at its path; index.json lists them with a sha1), css/ (every stylesheet and the sheets it @imports,
on any host and up to 5 deep, <style> blocks as inline-<slug>.css, manifest.json), js/ (every same-site <script src>,
import map and modulepreload file, manifest.json with each one's kind),
wp-rest/ (WordPress REST lists), wayback-unverified.txt
(archived paths the crawl did not find) and state.json. Then run media.mjs --capture <dir>
to list and download the media.

  <origin>              the site, e.g. https://www.example.com
  --out <dir>           the capture folder to write (e.g. capture)
  --delay <ms>          time between request starts on the site (default ${DEFAULT_DELAY_MS})
  --concurrency <n>     requests in flight on the site at once (default ${DEFAULT_CONCURRENCY})
  --polite              one request at a time, ${POLITE_DELAY_MS} ms apart (for shared hosts with
                        bot walls); --delay and --concurrency override it
  --max <n>             stop after n page records (resume later with --resume)
  --resume              continue the crawl saved in <dir>/state.json
  --ua "<string>"       user agent (default: a desktop Chrome)
  --seed <path>         also request this path or URL (repeatable), e.g. old URLs to
                        check for redirects
  --seed-file <path>    also request every path or URL in this file, one per line
                        (blank lines and lines starting with # are skipped); with
                        --resume on a finished capture this is the Wayback second pass:
                        --resume --seed-file <dir>/wayback-unverified.txt
  --verify-shortlinks   request every ?p= shortlink to confirm where it redirects
                        (by default they are recorded unverified, without a request)
  --include-query       keep query strings (by default only ?p= shortlinks keep theirs)
                        --seed, --seed-file and --include-query also apply on --resume
  --no-rest             do not use the platform's REST API for discovery
  --no-wayback          do not ask the Wayback Machine for archived URLs
  --exclude <prefix>[,<prefix>...]  never request a URL whose path starts with one of these
                        (repeatable), e.g. a multisite's sub-sites: --exclude /president/,/news-room/.
                        Sitemaps under one are listed in sitemaps/index.json as skipped: "excluded",
                        links to one stay in the HTML and are listed in links.json "excluded",
                        and meta.json "excluded" names the prefixes. Paths compare in one form
                        (/présidence/ = /pr%c3%a9sidence/). A stylesheet or root icon that
                        redirects under one is not followed there. --resume keeps them; one
                        added on --resume removes what was already captured under it (pages and
                        their files, redirects from it, stylesheets and scripts only those pages
                        used) and says what it removed
  --help                show this help

Never requests wp-admin, wp-login, xmlrpc.php or ?s= searches, and /wp-json/ only for the
REST lists. A Wayback listing that fails is asked for once more 10 s later; a second failure
is noted in meta.json and never fails the capture.

Test hooks: CAPTURE_WAYBACK_CDX=<url> replaces the Wayback CDX API address;
CAPTURE_WAYBACK_RETRY_MS=<ms> replaces the 10 s wait before the Wayback retry.
Each URL is tried 3 times; one that still answers 403, 429, 503 or a network error is
recorded with that status and its attempts, and the crawl moves on.
An anti-bot challenge (SiteGround's /.well-known/sgcaptcha/, Cloudflare's challenge page, a
tiny page with no title) is never retried and never counted as a page: the run stops at the
first one (a tiny untitled page only when it is the first HTML answer or the third in a row;
a single one mid-crawl is recorded "suspect-challenge" and the crawl goes on) with "blocked: <host> anti-bot challenge (<cause>)", the URL recorded with status
"challenge" in inventory.json and meta.json, and queued again for --resume.
Exit codes: 0 done, 2 usage error, 3 stopped because 3 different URLs in a row used up their
tries, the site cannot be reached, it answered with a bot challenge (resume with --resume
once the capture machine is allowed through), or no page answered 200.`;

const BLOCK_STATUSES = new Set([0, 403, 429, 503]);
// Same-site script files: larger ones are not saved, and redirects are followed at most this far.
const JS_MAX_BYTES = 5 * 1024 * 1024;
const JS_MAX_HOPS = 5;
// @import is followed this many levels below a linked stylesheet; a deeper one is "too-deep".
const IMPORT_MAX_DEPTH = 5;
// The one block status that never counts towards the block streak in discovery (a sitemap or
// REST list closed for good is that URL's answer, not a sign the site is blocking the crawl).
const PERMANENT_BLOCK = 403;
const MAX_HOPS = 10;
// A discovery URL that is a sitemap (saved under sitemaps/ and listed in sitemaps/index.json).
const SITEMAP_PATH = /sitemap|\.xml(\.gz)?$/i;
// Why a sitemap on another host is listed in sitemaps/index.json but never fetched.
const OTHER_HOST = 'other host';
// Why a sitemap under an --exclude prefix is listed in sitemaps/index.json but never fetched.
const EXCLUDED = 'excluded';
// The root icons a launch needs, asked for once so a missing one is evidence live lacked it;
// one that answers 200 is saved as assets/root-<name> for the build to ship at the same path.
const ROOT_ICONS = ['/favicon.ico', '/apple-touch-icon.png'];
// A root icon larger than this is recorded "too-large", not saved.
const ICON_MAX_BYTES = 5 * 1024 * 1024;
// HTML responses in a row matching only the tiny-page heuristic that stop the run.
const SUSPECT_LIMIT = 3;
const MAX_ATTEMPTS = 3;
// The Wayback listing is asked for at most twice, 10 s apart.
const WAYBACK_TRIES = 2;
const WAYBACK_RETRY_MS = 10_000;
const RETRY_MIN_MS = 500;
const SAVE_EVERY = 25;
const SOURCE_ORDER = ['sitemap', 'rest', 'crawl', 'shortlink', 'seed'];
const HTML_TYPE = /^(text\/html|application\/xhtml\+xml)/i;
const FEED_TYPE = /^(application\/(rss|atom)\+xml|application\/xml|text\/xml)/i;
const FEED_ALTERNATE = /^application\/(rss|atom)\+xml$/;

class UsageError extends Error {}
class Blocked extends Error {}
class Challenged extends Error {
  constructor(url, found) {
    super(found.cause);
    this.url = url;
    this.found = found;
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// The paths or URLs in a seed file: one per line, blank lines and # comments skipped.
function readSeedFile(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new UsageError(`cannot read --seed-file ${file}: ${err.code ?? err.message}`);
  }
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
}

function parseArgs(argv) {
  const args = {
    origin: null, out: null, delayMs: null, concurrency: null, polite: false, max: null, resume: false, ua: DEFAULT_UA,
    seeds: [], exclude: [], verifyShortlinks: false, includeQuery: false, noRest: false, noWayback: false, help: false,
  };
  const value = (i, flag) => {
    if (i >= argv.length || argv[i].startsWith('--')) throw new UsageError(`${flag} needs a value`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--out') args.out = value((i += 1), arg);
    else if (arg === '--delay' || arg === '--max' || arg === '--concurrency') {
      const n = Number(value((i += 1), arg));
      if (!Number.isInteger(n) || n < (arg === '--delay' ? 0 : 1)) throw new UsageError(`${arg} needs a whole number`);
      if (arg === '--delay') args.delayMs = n;
      else if (arg === '--concurrency') args.concurrency = n;
      else args.max = n;
    } else if (arg === '--polite') args.polite = true; else if (arg === '--ua') args.ua = value((i += 1), arg);
    else if (arg === '--seed') args.seeds.push(value((i += 1), arg));
    else if (arg === '--seed-file') args.seeds.push(...readSeedFile(value((i += 1), arg)));
    else if (arg === '--exclude') {
      try {
        args.exclude = parseExclude([...args.exclude, value((i += 1), arg)]);
      } catch (err) {
        throw new UsageError(err.message);
      }
    }
    else if (arg === '--resume') args.resume = true;
    else if (arg === '--verify-shortlinks') args.verifyShortlinks = true;
    else if (arg === '--include-query') args.includeQuery = true;
    else if (arg === '--no-rest') args.noRest = true;
    else if (arg === '--no-wayback') args.noWayback = true;
    else if (arg.startsWith('--')) throw new UsageError(`unknown option ${arg}`);
    else if (args.origin) throw new UsageError('only one origin is allowed');
    else args.origin = arg;
  }
  if (args.help) return args;
  if (!args.origin) throw new UsageError('an origin is required');
  try {
    const origin = new URL(args.origin);
    if (!/^https?:$/.test(origin.protocol)) throw new Error();
    args.origin = origin.origin;
  } catch {
    throw new UsageError(`${args.origin} is not an http(s) origin`);
  }
  if (!args.out) throw new UsageError('--out <dir> is required');
  return { ...args, ...pacing(args) };
}

const bareHost = (url) => url.host.toLowerCase().replace(/^www\./, '');
const pathOf = (href) => {
  const url = new URL(href);
  return url.pathname + url.search;
};

function isShortlink(url) {
  if (url.pathname !== '/') return false;
  const keys = [...url.searchParams.keys()];
  return keys.length === 1 && ['p', 'page_id'].includes(keys[0]) && /^\d+$/.test(url.searchParams.get(keys[0]));
}

// Never requested at all, whether linked or reached through a redirect.
const forbidden = (url) => NEVER.test(url.pathname) || url.searchParams.has('s');
// Not a page: never downloaded by the crawl (files are enumerated by the media step).
const notAPage = (url) => !PAGE_EXTENSIONS.has(extensionOf(url.pathname)) || NOT_PAGES.test(url.pathname);

// %e2 and %E2 are the same octet (RFC 3986 6.2.2.1): keys carry upper-case escapes, so a page
// linked with both spellings is requested once.
const upperEscapes = (href) => href.replace(/%[0-9a-f]{2}/gi, (m) => m.toUpperCase());

// The crawl's view of a URL: its canonical key (same site, canonical scheme and host, no
// fragment, query kept only where the rules allow, upper-case escapes), or null when it is out
// of scope.
function scoper(state) {
  const canonical = new URL(state.canonicalOrigin);
  // allowFile: a sitemap or a --seed named it, so a file (a .kml, a PDF) is in scope too.
  return (href, base = state.canonicalOrigin, allowFile = false) => {
    let url;
    try {
      url = new URL(href, base);
    } catch {
      return null;
    }
    if (!/^https?:$/.test(url.protocol) || bareHost(url) !== bareHost(canonical)) return null;
    url.protocol = canonical.protocol;
    url.host = canonical.host;
    url.hash = '';
    if (forbidden(url)) return null;
    if (!state.options.includeQuery && !isShortlink(url)) url.search = '';
    if (notAPage(url) && !(allowFile && !NOT_PAGES.test(url.pathname))) return null;
    return upperEscapes(url.href);
  };
}

function sourceFor(key, foundBy) {
  if (isShortlink(new URL(key))) return 'shortlink';
  const sources = foundBy[key] ?? [];
  return ['sitemap', 'rest', 'crawl', 'seed'].find((s) => sources.includes(s)) ?? 'crawl';
}

function sortSources(sources) {
  return [...new Set(sources)].sort((a, b) => SOURCE_ORDER.indexOf(a) - SOURCE_ORDER.indexOf(b));
}

function writeText(file, content) {
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, content);
}

const withSuffix = (name, suffix) => name.replace(/(\.xml(?:\.gz)?)?$/i, (ext) => `-${suffix}${ext}`);
const fileSafe = (text) => text.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');

// A sitemap's file under sitemaps/: its base name (plus its query, if any). `taken` maps the
// file names already used to their URL: a second URL with the same name gets a suffix from its
// directory path, then a number, so one sitemap never overwrites another.
function sitemapFileName(href, taken = new Map()) {
  const url = new URL(href);
  let name = basename(url.pathname) || 'sitemap.xml';
  if (url.search) name = withSuffix(name, url.search.slice(1).toLowerCase().replace(/[^a-z0-9_-]/g, '-'));
  const free = (candidate) => !taken.has(candidate) || taken.get(candidate) === href;
  if (free(name)) return name;
  const dir = fileSafe(url.pathname.split('/').slice(0, -1).join('-'));
  const base = dir ? withSuffix(name, dir) : name;
  if (free(base)) return base;
  for (let n = 2; ; n += 1) if (free(withSuffix(base, String(n)))) return withSuffix(base, String(n));
}

// The next free numbered file name (<n>.css, <n>.js) among entries: one past the highest, so a
// name is never reused after entries are dropped (--resume with a new --exclude prefix).
const nextFile = (entries, ext) => `${Math.max(0, ...entries.map((e) => Number.parseInt(e.file, 10)).filter(Number.isFinite)) + 1}.${ext}`;

const byKey = (key) => (a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);

// The text of every <style> element, in document order.
function styleBlocks(html) {
  const blocks = [];
  const walk = (node) => {
    if (node.tagName === 'style') blocks.push(node.childNodes.map((c) => c.value ?? '').join(''));
    for (const child of node.content?.childNodes ?? node.childNodes ?? []) walk(child);
  };
  walk(parse(html));
  return blocks;
}

class Crawler {
  constructor(state, { out, fetch, delayMs, concurrency = 1 }) {
    // A challenge row only marks where the last run stopped: that URL is asked again.
    state.records = state.records.filter((r) => r.status !== CHALLENGE);
    delete state.challenge;
    state.firstHtmlSeen ??= state.records.some((r) => r.status === 200);
    this.state = state;
    this.suspects = []; // items whose HTML answers in a row matched the tiny-page heuristic only
    this.out = out;
    this.fetch = fetch;
    this.delayMs = delayMs;
    this.concurrency = concurrency; // queue items fetched ahead of the one being recorded
    this.seen = new Set(state.seen);
    this.recorded = new Set(state.records.map((r) => r.url));
    this.full = new Map(); // url -> full record of this run (state.records keeps a slim copy)
    this.streak = new Set(); // distinct URLs blocked in a row
    this.lastStarted = null;
  }

  get scope() {
    this.scopeFn ??= scoper(this.state);
    return this.scopeFn;
  }

  // True for a URL on the site whose path is under an --exclude prefix: never requested.
  excluded(href) {
    const prefixes = this.state.options.exclude ?? [];
    if (prefixes.length === 0) return false;
    const url = new URL(href);
    return bareHost(url) === bareHost(new URL(this.state.origin)) && excludedBy(prefixes, url.pathname) !== null;
  }

  retryWait(attempts) {
    return Math.max(RETRY_MIN_MS, this.delayMs) * 2 ** Math.max(0, attempts - 1);
  }

  // Track the block streak: three different URLs blocked in a row means the site is blocking us.
  // A single URL that keeps answering 403 does not count more than once.
  noteBlocked(url) {
    this.streak.add(url);
    return this.streak.size >= BLOCK_LIMIT;
  }

  noteOk() {
    this.streak.clear();
  }

  enqueue(href, source, base, kind = 'page') {
    const key = this.scope(href, base, source === 'sitemap' || source === 'seed');
    if (!key || this.excluded(key)) return null;
    if (isShortlink(new URL(key))) return null; // recorded as an unverified redirect instead
    const sources = (this.state.foundBy[key] ??= []);
    if (!sources.includes(source)) sources.push(source);
    if (!this.seen.has(key)) {
      this.seen.add(key);
      this.state.seen.push(key);
      this.state.queue.push({ url: key, attempts: 0, kind });
    }
    return key;
  }

  // Discovery fetch: retries a blocked answer (spaced out). A block that persists is that URL's
  // answer (noted in meta.json, not fatal); a streak of 429, 503 or network errors on different
  // URLs throws Blocked so the run stops and resumes later.
  discoveryFetch() {
    const site = bareHost(new URL(this.state.origin));
    return async (url, options) => {
      // A sitemap on another host (robots.txt may name a sister site's) is never asked for:
      // its files would collide with the site's own and its URLs are not this site's.
      const target = new URL(url);
      if (SITEMAP_PATH.test(target.pathname) && bareHost(target) !== site) {
        this.noteSitemap(url, null, null, { host: target.host, skipped: OTHER_HOST });
        return { status: null, skipped: OTHER_HOST, headers: {}, body: '' };
      }
      // Under an --exclude prefix (a multisite's sub-site sitemap index): never asked for.
      if (this.excluded(url)) {
        if (SITEMAP_PATH.test(target.pathname)) this.noteSitemap(url, null, null, { skipped: EXCLUDED });
        return { status: null, skipped: EXCLUDED, headers: {}, body: '' };
      }
      for (let attempt = 1; ; attempt += 1) {
        const res = await this.fetch(url, options);
        const verdict = this.judge(res, url);
        if (verdict?.stop) throw new Challenged(url, verdict.stop);
        if (!BLOCK_STATUSES.has(res.status)) {
          this.noteOk();
          const path = new URL(url).pathname;
          if (path === '/' && !this.homeRes) this.homeRes = res;
          else if (SITEMAP_PATH.test(path)) {
            let file = null;
            if (res.status === 200) {
              file = this.state.sitemapLog?.[url]?.file ?? `sitemaps/${sitemapFileName(url, this.sitemapFiles())}`;
              writeText(join(this.out, file), res.body);
            }
            this.noteSitemap(url, res.status, file);
          }
          return res;
        }
        if (res.status !== PERMANENT_BLOCK && this.noteBlocked(url)) throw new Blocked();
        if (attempt >= MAX_ATTEMPTS) {
          const errors = (this.state.discoveryErrors ??= []);
          if (!errors.some((e) => e.url === url)) errors.push({ url, status: res.status });
          if (SITEMAP_PATH.test(new URL(url).pathname)) this.noteSitemap(url, res.status, null);
          return res;
        }
        await sleep(this.retryWait(attempt));
      }
    };
  }

  // Every sitemap the capture asked for, with its answer: sitemaps/index.json.
  // A skipped one is never fetched: { url, host, skipped: "other host" } or { url, skipped: "excluded" }.
  noteSitemap(url, status, file, skipped = null) {
    const log = (this.state.sitemapLog ??= {});
    log[url] = skipped ?? { status, file };
  }

  // The file names under sitemaps/ already taken, each with the sitemap URL it holds.
  sitemapFiles() {
    const taken = new Map();
    for (const [url, { file }] of Object.entries(this.state.sitemapLog ?? {})) if (file) taken.set(basename(file), url);
    return taken;
  }

  // A sitemap robots.txt names (or a sitemap index lists) that did not answer 200 is a
  // discoveryErrors entry with its status, never dropped silently (one skipped as another
  // host's is not an error: it is listed in sitemaps/index.json).
  noteMissingSitemaps(urls) {
    const errors = (this.state.discoveryErrors ??= []);
    for (const url of urls) {
      const seen = this.state.sitemapLog?.[url];
      if (seen && !seen.skipped && seen.status !== 200 && !errors.some((e) => e.url === url)) errors.push({ url, status: seen.status });
    }
  }

  // Discovery in resumable steps: fingerprint (home, robots, sitemap index), then each sitemap.
  // Returns 'ok', 'blocked' or 'challenge'.
  async discover() {
    const fetch = this.discoveryFetch();
    try {
      if (!this.state.fingerprint) {
        const fp = await fingerprint(this.state.origin, { fetch, detect: false });
        if (BLOCK_STATUSES.has(fp.homeStatus)) return 'blocked';
        const live = this.homeRes?.finalUrl ? new URL(this.homeRes.finalUrl) : null;
        this.state.canonicalOrigin =
          live && bareHost(live) === bareHost(new URL(this.state.origin)) ? live.origin : this.state.origin;
        if (fp.robots) writeText(join(this.out, 'robots.txt'), fp.robots);
        const { robots, ...rest } = fp;
        this.state.fingerprint = rest;
        this.state.sitemapsDone = [];
        for (const url of rest.otherHostSitemaps ?? []) this.noteSitemap(url, null, null, { host: new URL(url).host, skipped: OTHER_HOST });
        this.noteMissingSitemaps(rest.robotsSitemaps ?? []);
        this.enqueue('/', 'crawl');
        for (const seed of this.state.options.seeds ?? []) this.enqueue(seed, 'seed');
        saveState(this.out, this.state);
      }
      for (const sitemap of this.state.fingerprint.sitemapUrls) {
        if (this.state.sitemapsDone.includes(sitemap)) continue;
        const errors = (this.state.discoveryErrors ??= []);
        const onError = (e) => {
          if (!errors.some((x) => x.url === e.url)) errors.push(e);
        };
        const entries = await expandSitemaps([sitemap], { fetch, onError });
        for (const entry of entries) this.enqueue(entry.loc, 'sitemap');
        this.noteMissingSitemaps([sitemap]);
        this.state.sitemapsDone.push(sitemap);
        saveState(this.out, this.state);
      }
      await this.restDump(fetch);
    } catch (err) {
      if (err instanceof Blocked) return 'blocked';
      if (err instanceof Challenged) {
        this.noteChallenge(err.url, err.found);
        return 'challenge';
      }
      throw err;
    }
    this.state.phase = 'crawl';
    return 'ok';
  }

  // WordPress REST lists, once: saved under wp-rest/, their pages and posts found by 'rest'.
  async restDump(fetch) {
    const { fingerprint: fp, options } = this.state;
    if (this.state.restDone || options.noRest || !fp.hasRest || fp.platform !== 'wordpress') return;
    const rest = await dumpWpRest(this.state.canonicalOrigin, this.out, { fetch });
    for (const path of [...rest.pagePaths, ...rest.postPaths]) this.enqueue(path, 'rest');
    const errors = (this.state.discoveryErrors ??= []);
    for (const e of rest.errors) if (!errors.some((x) => x.url === e.url)) errors.push(e);
    this.state.restDone = true;
    saveState(this.out, this.state);
  }

  // How much a challenge match weighs. A signature (SiteGround, Cloudflare, a redirect to a
  // captcha path) stops the run at once. The tiny-page heuristic stops it only on the capture's
  // first HTML answer, or on the SUSPECT_LIMIT-th such page in a row (the earlier ones are queued
  // again with it); otherwise it is a suspect. A heuristic stop happens at most once per URL
  // (state.heuristicStops): asked again, a URL that still matches is a suspect and the crawl goes
  // on, so real tiny pages cannot stop every resume. Only an HTML answer that is neither a
  // redirect nor a block counts as the first answer or breaks the streak.
  // `url` is the URL that answered; `item` the queue item (null outside the crawl).
  // Returns null, { stop, requeue[] } or { suspect }.
  judge(res, url, item = null) {
    const found = detectChallenge(res);
    if (!found) {
      const { status } = res;
      const answered = typeof status === 'number' && !BLOCK_STATUSES.has(status) && !(status >= 300 && status < 400);
      if (answered && HTML_TYPE.test(res.headers?.['content-type'] ?? '')) {
        this.state.firstHtmlSeen = true;
        this.suspects = [];
      }
      return null;
    }
    if (found.kind === 'signature') return { stop: found, requeue: [] };
    const stopped = (this.state.heuristicStops ??= []);
    if (stopped.includes(pathOf(url))) {
      this.state.firstHtmlSeen = true;
      return { suspect: found };
    }
    if (!this.state.firstHtmlSeen) {
      stopped.push(pathOf(url));
      return { stop: found, requeue: [] };
    }
    if (!item) return { suspect: found };
    this.suspects.push({ url, kind: item.kind });
    if (this.suspects.length < SUSPECT_LIMIT) return { suspect: found };
    const streak = this.suspects;
    this.suspects = [];
    for (const s of streak) stopped.push(pathOf(s.url));
    return { stop: found, requeue: streak.slice(0, -1).map((s) => ({ url: s.url, attempts: 0, kind: s.kind })) };
  }

  // Where the run stopped on a challenge: state.challenge for meta.json, and (for a page) an
  // inventory row with status "challenge" and no snapshot. Suspect rows queued again with it
  // become "challenge" rows too, so a resume asks for them again.
  noteChallenge(url, found, { row = true, requeue = [] } = {}) {
    this.state.challenge = { url, path: pathOf(url), provider: found.provider, cause: found.cause, kind: found.kind };
    for (const { url: again } of requeue) {
      for (const r of [this.state.records.find((x) => x.url === again), this.full.get(again)]) if (r) r.status = CHALLENGE;
      this.recorded.delete(again);
    }
    if (row) this.addRecord({ ...extractPage('', url, { status: CHALLENGE, finalUrl: url }), challenge: found.cause });
  }

  // --resume with new --exclude prefixes (`added`): forget what was captured under them, as a run
  // with them from the start would never have had it. Records under them and their pages/ and
  // text/ files, their foundBy, slugs and seen rows, queued URLs, redirects from them, feeds and
  // sitemaps under them (sitemaps are then listed skipped), discovery errors on them, and the
  // stylesheets and scripts only their pages used (with the sheets only those imported). Returns
  // what was removed: { page, redirect, feed, sitemap, stylesheet, script } counts.
  dropExcluded(added) {
    const state = this.state;
    const under = (url) => this.excluded(url);
    const fromUnder = (path) => excludedBy(added, path.split('?')[0]) !== null;
    const remove = (file) => rmSync(join(this.out, file), { force: true });
    const counts = { page: 0, redirect: 0, feed: 0, sitemap: 0, stylesheet: 0, script: 0 };
    const pages = new Set();
    state.records = state.records.filter((r) => {
      if (!under(r.url)) return true;
      if (r.snapshot) {
        remove(r.snapshot);
        remove(`text/${r.snapshot.replace(/^pages\//, '').replace(/\.html$/, '')}.txt`);
      }
      pages.add(r.path);
      this.recorded.delete(r.url);
      counts.page += 1;
      return false;
    });
    for (const key of Object.keys(state.foundBy)) if (under(key)) delete state.foundBy[key];
    for (const [slug, key] of Object.entries(state.slugs)) if (under(key)) delete state.slugs[slug];
    state.seen = state.seen.filter((key) => !under(key));
    this.seen = new Set(state.seen);
    state.queue = state.queue.filter((item) => !under(item.url));
    const redirects = state.redirects.length;
    state.redirects = state.redirects.filter((r) => !fromUnder(r.from));
    counts.redirect = redirects - state.redirects.length;
    state.feeds = state.feeds.filter((f) => {
      if (!under(f.url)) return true;
      if (f.file) remove(f.file);
      counts.feed += 1;
      return false;
    });
    state.files = (state.files ?? []).filter((f) => {
      if (!under(f.url)) return true;
      if (f.file) remove(f.file);
      return false;
    });
    for (const [url, e] of Object.entries(state.sitemapLog ?? {})) {
      if (e.skipped || !under(url)) continue;
      if (e.file) remove(e.file);
      state.sitemapLog[url] = { skipped: EXCLUDED };
      counts.sitemap += 1;
    }
    if (state.discoveryErrors) state.discoveryErrors = state.discoveryErrors.filter((e) => !under(e.url));
    // Stylesheets and scripts: drop the removed pages; one left with no page goes, with its file,
    // and so does a sheet only removed sheets imported.
    const prune = (bucket, key, folder, count) => {
      if (!bucket) return;
      const lost = new Set();
      for (const e of bucket.entries) {
        const before = e.pages.length;
        e.pages = e.pages.filter((p) => !pages.has(p));
        if (before > 0 && e.pages.length === 0) lost.add(e);
      }
      const dead = new Set(lost);
      const deadHrefs = () => new Set([...dead].map((d) => d[key]));
      for (let changed = true; changed;) {
        changed = false;
        const gone = deadHrefs();
        for (const e of bucket.entries) {
          const importers = e.importedBy ?? [];
          if (dead.has(e) || e.pages.length > 0 || importers.length === 0 || !importers.every((href) => gone.has(href))) continue;
          dead.add(e);
          changed = true;
        }
      }
      for (const e of dead) if (e.file) remove(join(folder, e.file));
      bucket.entries = bucket.entries.filter((e) => !dead.has(e));
      const kept = new Set(bucket.entries.map((e) => e[key]));
      bucket.queue = bucket.queue.filter((q) => kept.has(q.url));
      counts[count] = dead.size;
    };
    prune(state.css, 'href', 'css', 'stylesheet');
    prune(state.js, 'src', 'js', 'script');
    return counts;
  }

  // The site's own 404 page, from one request for a random path, once per capture. A 200 (a soft
  // 404) or a redirect is recorded with no page; a challenge stops the run like any other; a
  // blocked answer leaves it for the next run.
  async probeNotFound() {
    if (this.state.notFound) return 'done';
    const path = `/${randomBytes(16).toString('hex')}/`;
    const url = new URL(path, this.state.canonicalOrigin).href;
    const res = await this.fetch(url, { redirect: 'manual' });
    const verdict = this.judge(res, url);
    if (verdict?.stop) {
      this.noteChallenge(url, verdict.stop, { row: false });
      return 'challenge';
    }
    // Blocked or unreachable: left unset, so the next run asks again.
    if (BLOCK_STATUSES.has(res.status)) return 'done';
    const entry = { path, status: verdict?.suspect ? SUSPECT : res.status, snapshot: null, text: null };
    const location = res.headers?.location;
    if (res.status >= 300 && res.status < 400 && location) {
      const to = new URL(location, url);
      entry.location = bareHost(to) === bareHost(new URL(url)) ? pathOf(to.href) : to.href;
    }
    const body = typeof res.body === 'string' ? res.body : '';
    if ((res.status === 404 || res.status === 410) && HTML_TYPE.test(res.headers?.['content-type'] ?? '') && body) {
      let slug = '404';
      for (let n = 2; this.state.slugs[slug]; n += 1) slug = `404-${n}`;
      this.state.slugs[slug] = url;
      entry.snapshot = `pages/${slug}.html`;
      entry.text = `text/${slug}.txt`;
      writeText(join(this.out, entry.snapshot), body);
      writeText(join(this.out, entry.text), `${extractPage(body, url).text}\n`);
    }
    this.state.notFound = entry;
    return 'done';
  }

  // /favicon.ico and /apple-touch-icon.png, one request each per capture (redirects followed),
  // each in meta.json `icons` as { status, file, contentType, bytes }: proof of what live served
  // at the root, whatever the pages link. A 200 is saved byte for byte as assets/root-<name>
  // (file); a 200 that is an HTML page (a soft 404) is not saved and says so in `note`; one
  // over ICON_MAX_BYTES is status "too-large"; one that redirects under an --exclude prefix is
  // not followed there (its 3xx is recorded with a note). A blocked answer is left unset, so the
  // next run asks again.
  async probeIcons() {
    this.state.icons ??= {};
    for (const path of ROOT_ICONS) {
      if (this.state.icons[path] !== undefined) continue;
      const url = new URL(path, this.state.canonicalOrigin).href;
      const { res, excludedAt } = await this.fetchFollowing(url, { raw: true, maxBytes: ICON_MAX_BYTES });
      const verdict = this.judge(res, url);
      if (verdict?.stop) {
        this.noteChallenge(url, verdict.stop, { row: false });
        return 'challenge';
      }
      if (BLOCK_STATUSES.has(res.status)) continue;
      const contentType = res.headers?.['content-type'] ?? null;
      const entry = { status: res.status, file: null, contentType, bytes: null };
      if (excludedAt) entry.note = `redirects to ${excludedAt}, under an excluded prefix`;
      else if (res.status === 200 && HTML_TYPE.test(contentType ?? '')) entry.note = 'answered HTML, not an icon';
      else if (res.status === 200) {
        const body = Buffer.isBuffer(res.body) ? res.body : Buffer.from(String(res.body ?? ''));
        entry.file = `assets/root-${basename(path)}`;
        entry.bytes = body.length;
        writeText(join(this.out, entry.file), body);
      }
      this.state.icons[path] = entry;
    }
    return 'done';
  }

  // A file's redirects followed by hand, each hop asked with `options`: a hop under an --exclude
  // prefix is never requested (excludedAt names its path), nor one past MAX_HOPS.
  // Returns { res, finalUrl, excludedAt? }: the last answer and the URL that gave it.
  async fetchFollowing(url, options = {}) {
    let current = url;
    for (let hop = 0; ; hop += 1) {
      const res = await this.fetch(current, { ...options, redirect: 'manual' });
      const location = res.headers?.location;
      if (!(res.status >= 300 && res.status < 400) || !location || hop >= MAX_HOPS) return { res, finalUrl: current };
      const next = new URL(location, current);
      next.hash = '';
      if (this.excluded(next.href)) return { res, finalUrl: current, excludedAt: pathOf(next.href) };
      current = next.href;
    }
  }

  // Where an answer leads: { next } to follow, or { end } (fetchChain's result) to stop there.
  // A hop to another site, a forbidden path, a file or a loop ends the chain without a request.
  redirectStep(res, current, chain, hop) {
    const location = res.headers?.location;
    if (res.status < 300 || res.status >= 400 || !location) return { end: { res, finalUrl: current, chain } };
    chain.push({ url: current, status: res.status });
    const next = new URL(location, current);
    next.hash = '';
    const offSite = bareHost(next) !== bareHost(new URL(this.state.canonicalOrigin));
    const looped = chain.some((c) => c.url === next.href);
    const excluded = !offSite && this.excluded(next.href);
    if (offSite || looped || excluded || forbidden(next) || notAPage(next) || hop === MAX_HOPS) {
      return { end: { res: null, finalUrl: next.href, chain, offSite, looped, excluded } };
    }
    return { next: next.href };
  }

  // The network half of fetchChain, safe to run ahead of the queue: every hop's answer, up to
  // where fetchChain stops whatever judge() decides (a signature challenge, a block, the end).
  async fetchHops(start) {
    const hops = [];
    const chain = [];
    let current = start;
    for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
      const res = await this.fetch(current, { redirect: 'manual' });
      hops.push({ url: current, res });
      if (detectChallenge(res)?.kind === 'signature' || BLOCK_STATUSES.has(res.status)) break;
      const step = this.redirectStep(res, current, chain, hop);
      if (step.end) break;
      current = step.next;
    }
    return hops;
  }

  // Follow one URL's redirects by hand, judging each answer in queue order. `hops` are the
  // answers fetchHops already has; any hop it lacks is asked for here. Returns { blocked, status },
  // { challenge, requeue[] } or { res, finalUrl, chain[] } (res.suspect set when the page is a
  // suspected challenge).
  async fetchChain(start, item = null, hops = []) {
    const chain = [];
    let current = start;
    for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
      const res = hops[hop]?.url === current ? hops[hop].res : await this.fetch(current, { redirect: 'manual' });
      const verdict = this.judge(res, current, item);
      if (verdict?.stop) return { challenge: verdict.stop, requeue: verdict.requeue };
      if (verdict?.suspect) res.suspect = verdict.suspect;
      if (BLOCK_STATUSES.has(res.status)) return { blocked: true, status: res.status };
      const step = this.redirectStep(res, current, chain, hop);
      if (step.end) return step.end;
      current = step.next;
    }
    return { res: null, finalUrl: current, chain };
  }

  slugFor(key) {
    let slug = slugFor(pathOf(key));
    for (let n = 2; this.state.slugs[slug] && this.state.slugs[slug] !== key; n += 1) slug = `${slugFor(pathOf(key))}-${n}`;
    this.state.slugs[slug] = key;
    return slug;
  }

  addRecord(record) {
    this.full.set(record.url, record);
    const { text, jsonLd, ...slim } = record;
    this.state.records.push(slim);
  }

  record(key, res, kind = 'page', extra = {}) {
    this.recorded.add(key);
    if (res.suspect) {
      this.addRecord({ ...extractPage('', key, { status: SUSPECT, finalUrl: key }), challenge: res.suspect.cause });
      return;
    }
    const type = res.headers?.['content-type'] ?? '';
    const body = typeof res.body === 'string' ? res.body : '';
    // A .kml or .pdf a sitemap named is a file even when the server calls it text/xml, unless it reads as a feed.
    const readsAsFeed = /^application\/(rss|atom)\+xml/i.test(type) || /<(?:rss|feed)\b/i.test(body.slice(0, 2000));
    if (res.status === 200 && kind !== 'feed' && !readsAsFeed && this.keepsFile(key, res)) return this.saveFile(key, res, type);
    if (res.status === 200 && (FEED_TYPE.test(type) || (kind === 'feed' && !HTML_TYPE.test(type)))) {
      const file = `feeds/${this.slugFor(key)}.xml`;
      writeText(join(this.out, file), res.body);
      this.state.feeds.push({ url: key, path: pathOf(key), status: res.status, contentType: type, file });
      return;
    }
    if (HTML_TYPE.test(type)) {
      const slug = this.slugFor(key);
      const snapshot = `pages/${slug}.html`;
      writeText(join(this.out, snapshot), body);
      const record = extractPage(body, key, { status: res.status, finalUrl: key, snapshot });
      writeText(join(this.out, 'text', `${slug}.txt`), `${record.text}\n`);
      this.addRecord(record);
      if (res.status === 200) {
        this.collectCss(record, body, slug);
        this.collectJs(record);
        this.follow(record);
      }
      return;
    }
    // A file a sitemap or a --seed named (a .kml, a PDF) is saved under files/ at its path, so the
    // build can serve it. Any other 200 is a file the crawl does not keep; a non-200 is still
    // recorded with its status.
    if (res.status === 200 && this.keepsFile(key, res)) return this.saveFile(key, res, type);
    if (res.status !== 200) this.addRecord({ ...extractPage('', key, { status: res.status, finalUrl: key }), ...extra });
  }

  keepsFile(key, res) {
    const sources = this.state.foundBy[key] ?? [];
    if (!sources.includes('sitemap') && !sources.includes('seed')) return false;
    if (!notAPage(new URL(key))) return false;
    return Buffer.byteLength(res.body ?? '') > 0;
  }

  saveFile(key, res, contentType) {
    const path = pathOf(key);
    let parts;
    try {
      parts = decodeURIComponent(path).split('/').filter(Boolean);
    } catch {
      parts = path.split('/').filter(Boolean);
    }
    if (parts.length === 0 || parts.some((part) => part === '..' || part === '.')) return;
    const file = ['files', ...parts].join('/');
    const body = Buffer.isBuffer(res.body) ? res.body : Buffer.from(String(res.body ?? ''), 'utf8');
    mkdirSync(resolve(join(this.out, file), '..'), { recursive: true });
    writeFileSync(join(this.out, file), body);
    const files = (this.state.files ??= []);
    const entry = { url: key, path, status: res.status, contentType: contentType || null, bytes: body.length, sha1: createHash('sha1').update(body).digest('hex'), file };
    const at = files.findIndex((f) => f.url === key);
    if (at === -1) files.push(entry);
    else files[at] = entry;
  }

  // Stylesheets in first-seen order, each fetched once after the crawl (css/<n>.css); a page's
  // <style> blocks concatenated into css/inline-<slug>.css, shared by pages with the same blocks.
  collectCss(record, html, slug) {
    const css = (this.state.css ??= { entries: [], queue: [] });
    let inlineDone = false;
    for (const style of record.styles) {
      if (style.inline) {
        if (inlineDone) continue;
        inlineDone = true;
        const blocks = styleBlocks(html);
        if (blocks.length === 0) continue;
        const text = blocks.map((b) => `${b.trim()}\n`).join('');
        const hash = createHash('sha1').update(text).digest('hex');
        let entry = css.entries.find((e) => e.hash === hash);
        if (!entry) {
          entry = { file: `inline-${slug}.css`, inline: true, pages: [], hash };
          writeText(join(this.out, 'css', entry.file), text);
          css.entries.push(entry);
        }
        if (!entry.pages.includes(record.path)) entry.pages.push(record.path);
        continue;
      }
      let url;
      try {
        url = new URL(style.href);
      } catch {
        continue;
      }
      if (!/^https?:$/.test(url.protocol) || forbidden(url) || this.excluded(url.href)) continue;
      let entry = css.entries.find((e) => e.href === style.href);
      if (!entry) {
        entry = { file: nextFile(css.entries, 'css'), href: style.href, pages: [], status: null };
        css.entries.push(entry);
        css.queue.push({ url: style.href, attempts: 0 });
      }
      if (!entry.pages.includes(record.path)) entry.pages.push(record.path);
    }
  }

  // A sheet that redirects under an --exclude prefix is recorded "excluded", not followed there.
  async visitCss(item, { res, finalUrl, excludedAt }) {
    if (BLOCK_STATUSES.has(res.status)) return { blocked: true, status: res.status };
    const entry = this.state.css.entries.find((e) => e.href === item.url);
    if (excludedAt) {
      entry.status = EXCLUDED;
      return {};
    }
    entry.status = res.status;
    if (res.status === 200) {
      const text = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body ?? '');
      writeText(join(this.out, 'css', entry.file), text);
      // A redirected sheet's relative url()s and @imports resolve against where it ended up.
      if (finalUrl !== item.url) entry.finalUrl = finalUrl;
      this.followImports(entry, text, entry.finalUrl ?? item.url);
    }
    return {};
  }

  // The sheets a stylesheet @imports, on any host, queued once each (a cycle only records its
  // importer); each records the sheets that import it. Below IMPORT_MAX_DEPTH, listed unfetched.
  followImports(importer, text, base) {
    const css = this.state.css;
    for (const href of cssImports(text, base)) {
      if (forbidden(new URL(href)) || this.excluded(href)) continue;
      let entry = css.entries.find((e) => e.href === href);
      if (!entry) {
        const depth = (importer.depth ?? 0) + 1;
        entry = { file: nextFile(css.entries, 'css'), href, pages: [], status: null, depth, importedBy: [] };
        css.entries.push(entry);
        if (depth > IMPORT_MAX_DEPTH) entry.status = 'too-deep';
        else css.queue.push({ url: href, attempts: 0 });
      }
      if (entry !== importer && !entry.importedBy?.includes(importer.href)) (entry.importedBy ??= []).push(importer.href);
    }
  }

  // The pages a stylesheet serves: those that link it and those of every sheet importing it.
  cssPages(entry, entries, seen = new Set()) {
    seen.add(entry);
    const pages = new Set(entry.pages);
    for (const href of entry.importedBy ?? []) {
      const importer = entries.find((e) => e.href === href);
      if (importer && !seen.has(importer)) for (const page of this.cssPages(importer, entries, seen)) pages.add(page);
    }
    return pages;
  }

  async fetchCss() {
    if (!this.state.css) return 'done';
    return this.drain(
      this.state.css.queue,
      (item) => this.fetchFollowing(item.url),
      (item, fetched) => this.visitCss(item, fetched),
      (item, status) => {
        this.state.css.entries.find((e) => e.href === item.url).status = status;
      },
    );
  }

  // Same-site script files (the theme's own JavaScript, module scripts, import map URLs and
  // modulepreload files, each with the kind it was first seen as) in first-seen order, each fetched once
  // after the crawl (js/<n>.js). Vendor tags and inline code stay in the page HTML. Redirects are
  // followed by hand while they stay on the site's host; one that leaves it is recorded
  // "off-site" and not requested. A file over JS_MAX_BYTES is recorded "too-large", not saved.
  collectJs(record) {
    const js = (this.state.js ??= { entries: [], queue: [] });
    const site = bareHost(new URL(this.state.canonicalOrigin));
    for (const script of record.scripts) {
      if (!script.src) continue;
      let url;
      try {
        url = new URL(script.src);
      } catch {
        continue;
      }
      if (!/^https?:$/.test(url.protocol) || bareHost(url) !== site || forbidden(url) || this.excluded(url.href)) continue;
      let entry = js.entries.find((e) => e.src === script.src);
      if (!entry) {
        const kind = script.kind ?? 'script';
        entry = { file: nextFile(js.entries, 'js'), src: script.src, kind, pages: [], status: null };
        js.entries.push(entry);
        js.queue.push({ url: script.src, attempts: 0 });
      }
      if (!entry.pages.includes(record.path)) entry.pages.push(record.path);
    }
  }

  // The network half of visitJs: the last answer, and offSite when a redirect leaves the host.
  async fetchJsFile(item) {
    const site = bareHost(new URL(this.state.canonicalOrigin));
    let url = item.url;
    for (let hop = 0; ; hop += 1) {
      const res = await this.fetch(url, { raw: true, maxBytes: JS_MAX_BYTES });
      if (BLOCK_STATUSES.has(res.status)) return { res };
      const location = res.headers?.location;
      if (res.status < 300 || res.status >= 400 || !location || hop >= JS_MAX_HOPS) return { res };
      const next = new URL(location, url);
      if (bareHost(next) !== site) return { res, offSite: true };
      url = next.href;
    }
  }

  async visitJs(item, { res, offSite }) {
    const entry = this.state.js.entries.find((e) => e.src === item.url);
    if (BLOCK_STATUSES.has(res.status)) return { blocked: true, status: res.status };
    if (offSite) {
      entry.status = 'off-site';
      return {};
    }
    entry.status = res.status;
    if (res.status !== 200) return {};
    const body = Buffer.isBuffer(res.body) ? res.body : Buffer.from(String(res.body ?? ''));
    if (body.length > JS_MAX_BYTES) entry.status = 'too-large';
    else writeText(join(this.out, 'js', entry.file), body);
    return {};
  }

  async fetchJs() {
    if (!this.state.js) return 'done';
    return this.drain(
      this.state.js.queue,
      (item) => this.fetchJsFile(item),
      (item, fetched) => this.visitJs(item, fetched),
      (item, status) => {
        this.state.js.entries.find((e) => e.src === item.url).status = status;
      },
    );
  }

  jsManifest() {
    return (this.state.js?.entries ?? []).map((e) => {
      const pages = [...e.pages].sort();
      const kind = e.kind ?? 'script';
      return e.status === 200 ? { file: e.file, src: e.src, kind, pages } : { file: null, src: e.src, kind, pages, status: e.status };
    });
  }

  cssManifest() {
    const entries = this.state.css?.entries ?? [];
    return entries.map((e) => {
      if (e.inline) return { file: e.file, inline: true, pages: [...e.pages].sort() };
      const pages = [...this.cssPages(e, entries)].sort();
      const importedBy = e.importedBy?.length ? { importedBy: e.importedBy } : {};
      const finalUrl = e.finalUrl ? { finalUrl: e.finalUrl } : {};
      if (e.status === 200) return { file: e.file, href: e.href, ...finalUrl, pages, ...importedBy };
      return { file: null, href: e.href, pages, status: e.status, ...importedBy };
    });
  }

  // Archived paths on this host that the crawl never saw. The archive is often slow or briefly
  // down, so a failed listing is asked for once more after `retryMs`. Never fatal: a second
  // failure is noted and the file is written empty.
  async wayback(endpoint, retryMs = WAYBACK_RETRY_MS) {
    const known = new Set([...this.state.seen.map(pathOf), ...this.state.records.map((r) => r.path)]);
    const host = new URL(this.state.canonicalOrigin).host.replace(/^www\./i, '');
    for (let attempt = 1; ; attempt += 1) {
      try {
        const prefixes = this.state.options.exclude ?? [];
        const skip = (path) => excludedBy(prefixes, path) !== null;
        const paths = await waybackPaths(host, { fetch: this.fetch, known, out: this.out, endpoint, skip });
        return { status: 'ok', paths: paths.length };
      } catch (err) {
        if (attempt < WAYBACK_TRIES) {
          await sleep(retryMs);
          continue;
        }
        writeText(join(this.out, WAYBACK_FILE), '');
        return { status: 'failed', error: err.message };
      }
    }
  }

  follow(record) {
    for (const href of record.internalLinks) this.enqueue(href, 'crawl', record.url);
    if (record.canonical) this.enqueue(record.canonical, 'crawl', record.url);
    for (const alt of record.alternates) {
      if (alt.type && FEED_ALTERNATE.test(alt.type)) this.enqueue(alt.href, 'crawl', record.url, 'feed');
      else if (!alt.type || alt.type === 'text/html' || alt.hreflang) this.enqueue(alt.href, 'crawl', record.url);
    }
  }

  async visit(item, hops) {
    const result = await this.fetchChain(item.url, item, hops);
    if (result.challenge) this.noteChallenge(item.url, result.challenge, { requeue: result.requeue });
    if (result.blocked || result.challenge) return result;
    const { res, chain } = result;
    if (chain.length === 0) {
      this.record(item.url, res, item.kind);
      return {};
    }

    const finalKey = result.offSite || result.excluded ? null : this.scope(result.finalUrl);
    const landed = res && finalKey && upperEscapes(result.finalUrl) === finalKey;
    // A redirect that only changes the escapes' case lands on this same page: no redirect row.
    if (landed && finalKey === item.url) {
      this.record(item.url, res, item.kind);
      return {};
    }
    this.state.redirects.push({
      from: pathOf(item.url),
      to: result.offSite ? result.finalUrl : pathOf(result.finalUrl),
      status: chain[0].status,
      source: sourceFor(item.url, this.state.foundBy),
      hops: chain.slice(1).map((c) => pathOf(c.url)),
      ...(result.looped ? { error: 'loop' } : {}),
    });
    if (!finalKey || isShortlink(new URL(finalKey))) return {};
    if (!this.seen.has(finalKey)) {
      this.seen.add(finalKey);
      this.state.seen.push(finalKey);
      this.state.foundBy[finalKey] = [...(this.state.foundBy[item.url] ?? ['crawl'])];
      if (landed) this.record(finalKey, res, item.kind);
      else this.state.queue.push({ url: finalKey, attempts: 0, kind: item.kind });
    } else if (landed && !this.recorded.has(finalKey)) {
      // In place: drain() holds this same array.
      const queued = this.state.queue.findIndex((q) => q.url === finalKey);
      if (queued !== -1) this.state.queue.splice(queued, 1);
      this.record(finalKey, res, item.kind);
    }
    return {};
  }

  // Shortlinks that point at a page (its rel=shortlink) or appear in a page's links.
  shortlinks() {
    const found = new Map();
    const records = this.state.records.filter((r) => r.status === 200);
    for (const r of records) {
      if (r.shortlink?.startsWith('/') && isShortlink(new URL(r.shortlink, this.state.canonicalOrigin))) {
        if (!found.has(r.shortlink)) found.set(r.shortlink, r.path);
      }
    }
    for (const r of records) {
      for (const link of r.internalLinks) {
        if (!found.has(link) && isShortlink(new URL(link, this.state.canonicalOrigin))) found.set(link, null);
      }
    }
    return found;
  }

  shortlinkUrl(item) {
    return new URL(item.url, this.state.canonicalOrigin).href;
  }

  async visitShortlink(item, hops) {
    const result = await this.fetchChain(this.shortlinkUrl(item), null, hops);
    if (result.challenge) this.noteChallenge(item.url, result.challenge, { row: false });
    if (result.blocked || result.challenge) return result;
    const { res, chain } = result;
    const final = chain.length === 0 ? null : result.offSite ? result.finalUrl : pathOf(result.finalUrl);
    this.state.shortlinkChecks[item.url] = {
      to: final,
      status: chain[0]?.status ?? res.status,
      hops: chain.slice(1).map((c) => pathOf(c.url)),
    };
    return {};
  }

  // Work through a queue with per-URL retries and the block streak.
  // Up to `concurrency` items at the front of the queue are fetched at once (fetchAhead: network
  // only, no state), and each is recorded (visit) in queue order, so the capture is the same
  // whatever the concurrency; blocks and challenges are judged in that order too.
  // A URL still blocked (403, 429, 503 or a network error) after its retries is given up:
  // recorded with that status and its attempts, and the run moves on. A URL counts towards the
  // streak only once its retries are used up: three different URLs used up in a row, with no
  // success between them, stop the run with those three back at the front of the queue (fresh
  // tries, `stops` counted). One that was already put back once is given up for good when it
  // fails again and no longer counts, so URLs that are down for good cannot stop every resume.
  // A challenge stops at once, that URL back at the front of the queue. Fetches still in flight
  // when the run stops are dropped: their items are still in the queue for --resume.
  // Returns 'done', 'max', 'blocked' or 'challenge'.
  async drain(queue, fetchAhead, visit, giveUp, max = null) {
    let sinceSave = 0;
    let pending = []; // used up, given up once a success shows the site is still answering
    const inFlight = new Map(); // queue item -> its fetchAhead promise
    const settle = () => {
      for (const { item, status } of pending) giveUp(item, status);
      pending = [];
    };
    const start = (item) => {
      const retry = item.attempts > 0 && this.lastStarted === item.url;
      this.lastStarted = item.url;
      const wait = retry ? sleep(this.retryWait(item.attempts)) : Promise.resolve();
      const fetched = wait.then(() => fetchAhead(item));
      fetched.catch(() => {}); // a dropped fetch never fails the run; the awaited one still throws
      inFlight.set(item, fetched);
    };
    while (queue.length > 0) {
      if (max && this.state.records.length >= max) {
        settle();
        return 'max';
      }
      const room = max ? Math.max(1, Math.min(this.concurrency, max - this.state.records.length)) : this.concurrency;
      for (const ahead of queue.slice(0, room)) if (!inFlight.has(ahead)) start(ahead);
      const item = queue.shift();
      const fetched = await inFlight.get(item);
      inFlight.delete(item);
      const result = await visit(item, fetched);
      // visit() may drop queued URLs it recorded through a redirect: forget their fetches. Such a
      // URL (a redirect target already queued and fetched ahead) has then been requested twice;
      // only the answer at the end of the chain is recorded. Likewise, when the run stops below,
      // fetches still in flight are dropped unrecorded and their items stay queued for --resume.
      if (inFlight.size > 0) {
        const queued = new Set(queue);
        for (const ahead of inFlight.keys()) if (!queued.has(ahead)) inFlight.delete(ahead);
      }
      if (result.challenge) {
        queue.unshift(...(result.requeue ?? []), item);
        settle();
        return 'challenge';
      }
      if (result.blocked) {
        item.attempts += 1;
        if (item.attempts < MAX_ATTEMPTS) queue.push(item);
        else if (item.stops) giveUp(item, result.status);
        else {
          pending.push({ item, status: result.status });
          if (this.noteBlocked(item.url)) {
            const back = pending.map((p) => ({ ...p.item, attempts: 0, stops: (p.item.stops ?? 0) + 1 }));
            queue.splice(0, 0, ...back);
            return 'blocked';
          }
        }
      } else {
        this.noteOk();
        settle();
      }
      sinceSave += 1;
      if (sinceSave >= SAVE_EVERY) {
        saveState(this.out, this.state);
        sinceSave = 0;
      }
    }
    settle();
    return 'done';
  }

  async crawl(max) {
    const outcome = await this.drain(
      this.state.queue,
      (item) => this.fetchHops(item.url),
      (item, hops) => this.visit(item, hops),
      (item, status) => this.record(item.url, { status, headers: {}, body: '' }, item.kind, { attempts: item.attempts }),
      max,
    );
    if (outcome === 'done') this.state.phase = 'done';
    return outcome;
  }

  async verifyShortlinks() {
    this.state.shortlinkChecks ??= {};
    this.state.verifyQueue ??= [];
    const queued = new Set(this.state.verifyQueue.map((q) => q.url));
    for (const from of this.shortlinks().keys()) {
      if (!this.state.shortlinkChecks[from] && !queued.has(from)) this.state.verifyQueue.push({ url: from, attempts: 0 });
    }
    return this.drain(
      this.state.verifyQueue,
      (item) => this.fetchHops(this.shortlinkUrl(item)),
      (item, hops) => this.visitShortlink(item, hops),
      (item, status) => {
        this.state.shortlinkChecks[item.url] = { to: null, status, hops: [] };
      },
    );
  }

  // A record from an earlier run keeps text and JSON-LD on disk only; read them back.
  fullRecord(slim) {
    const kept = this.full.get(slim.url);
    if (kept) return kept;
    if (!slim.snapshot) return { ...slim, text: '', jsonLd: [] };
    const html = readFileSync(join(this.out, slim.snapshot), 'utf8');
    const slug = slim.snapshot.replace(/^pages\//, '').replace(/\.html$/, '');
    const text = readFileSync(join(this.out, 'text', `${slug}.txt`), 'utf8').trim();
    return { ...slim, text, jsonLd: extractPage(html, slim.url).jsonLd };
  }

  redirectList() {
    const byFrom = new Map(this.state.redirects.map((r) => [r.from, r]));
    const checks = this.state.shortlinkChecks ?? {};
    for (const [from, to] of this.shortlinks()) {
      if (byFrom.has(from)) continue;
      const check = checks[from];
      byFrom.set(
        from,
        check
          ? { from, to: check.to, status: check.status, source: 'shortlink', verified: true, hops: check.hops }
          : { from, to, status: to ? 301 : null, source: 'shortlink', verified: false, hops: [] },
      );
    }
    return [...byFrom.values()].sort(byKey('from'));
  }

  writeOutputs({ finished }) {
    const { records, feeds, foundBy } = this.state;
    const inventory = records
      .map((r) => {
        const { text, jsonLd, snapshot, alternates, shortlink, ...head } = this.fullRecord(r);
        // Keep the brief's field order: snapshot and text last, then the crawl extras.
        return { ...head, snapshot, text, jsonLd, alternates, shortlink, foundBy: sortSources(foundBy[r.url] ?? []) };
      })
      .sort(byKey('path'));
    const json = (file, data) => writeText(join(this.out, file), `${JSON.stringify(data, null, 2)}\n`);
    json('inventory.json', inventory);
    json('redirects.json', this.redirectList());
    json('feeds/index.json', [...feeds].sort(byKey('path')));
    json('files/index.json', [...(this.state.files ?? [])].sort(byKey('path')));
    json('meta.json', {
      origin: this.state.origin,
      canonicalOrigin: this.state.canonicalOrigin ?? null,
      startedAt: this.state.startedAt,
      finishedAt: finished ? new Date().toISOString() : null,
      options: this.state.options,
      discoveryErrors: this.state.discoveryErrors ?? [],
      wayback: this.state.wayback ?? (this.state.options.noWayback ? { status: 'skipped' } : null),
      challenge: this.state.challenge ?? null,
      notFound: this.state.notFound ?? null,
      icons: this.state.icons ?? {},
      excluded: this.state.options.exclude ?? [],
    });
    json('sitemaps/index.json', Object.entries(this.state.sitemapLog ?? {})
      .map(([url, e]) => (e.skipped ? { url, ...(e.host ? { host: e.host } : {}), skipped: e.skipped } : { url, status: e.status, file: e.file }))
      .sort(byKey('url')));
    json('css/manifest.json', this.cssManifest());
    json('js/manifest.json', this.jsManifest());

    // Links to a path under an --exclude prefix are listed apart (excluded), never as internal:
    // the build serves no such page, and the gates treat them like links off the site.
    const internal = {};
    const external = {};
    const excluded = {};
    const prefixes = this.state.options.exclude ?? [];
    const add = (map, target, from) => {
      (map[target] ??= new Set()).add(from);
    };
    for (const r of inventory) {
      for (const link of r.internalLinks) {
        if (link === r.path) continue;
        add(excludedBy(prefixes, link.split('?')[0]) ? excluded : internal, link, r.path);
      }
      for (const link of r.externalLinks) add(external, link, r.path);
    }
    const plain = (map) => Object.fromEntries(Object.keys(map).sort().map((k) => [k, [...map[k]].sort()]));
    json('links.json', { internal: plain(internal), external: plain(external), ...(prefixes.length ? { excluded: plain(excluded) } : {}) });

    const vendors = {};
    for (const r of inventory) {
      for (const s of r.scripts) {
        if (s.vendor === 'other') continue;
        const v = (vendors[s.vendor] ??= { id: null, ids: [], pages: [] });
        if (s.id && !v.ids.includes(s.id)) v.ids.push(s.id);
        if (!v.pages.includes(r.path)) v.pages.push(r.path);
        v.id ??= s.id;
      }
    }
    json('scripts.json', Object.fromEntries(Object.keys(vendors).sort().map((k) => [k, vendors[k]])));
    return inventory;
  }
}

async function main() {
  assertNodeVersion();
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const out = resolve(args.out);
  let state;
  let newSeeds = [];
  let addedExclude = [];
  if (args.resume) {
    try {
      state = loadState(out);
    } catch (err) {
      console.error(`Cannot read the saved crawl: ${err.message}`);
      process.exit(2);
    }
    if (!state) {
      console.error(`Nothing to resume: ${join(out, 'state.json')} does not exist.`);
      process.exit(2);
    }
    if (bareHost(new URL(state.origin)) !== bareHost(new URL(args.origin))) {
      console.error(`The saved crawl in ${out} is for ${state.origin}, not ${args.origin}.`);
      process.exit(2);
    }
    if (args.includeQuery) state.options.includeQuery = true;
    const known = new Set(state.options.seeds ?? []);
    newSeeds = [...new Set(args.seeds.filter((seed) => !known.has(seed)))];
    state.options.seeds = [...known, ...newSeeds];
    // Prefixes given on --resume join the saved ones; what was captured under them is dropped below.
    const saved = state.options.exclude ?? [];
    state.options.exclude = parseExclude([...saved, ...args.exclude]);
    addedExclude = state.options.exclude.filter((p) => !saved.includes(p));
  } else {
    state = newState(args.origin, {
      includeQuery: args.includeQuery,
      noRest: args.noRest,
      seeds: args.seeds,
      exclude: args.exclude,
      verifyShortlinks: args.verifyShortlinks,
      noWayback: args.noWayback,
    });
  }
  mkdirSync(out, { recursive: true });

  http.resetBlocked();
  const fetch = (url, options) => fetchPaced(url, { ...options, delayMs: args.delayMs, concurrency: args.concurrency, ua: args.ua, trusted: [args.origin, process.env.CAPTURE_WAYBACK_CDX] });
  const crawler = new Crawler(state, { out, fetch, delayMs: args.delayMs, concurrency: args.concurrency });
  if (addedExclude.length > 0) {
    const removed = crawler.dropExcluded(addedExclude);
    const parts = Object.entries(removed).filter(([, n]) => n > 0).map(([what, n]) => `${n} ${what}${n === 1 ? '' : 's'}`);
    if (parts.length > 0) {
      const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
      console.log(`Removed ${list} now under --exclude ${addedExclude.join(', ')}.`);
    }
    saveState(out, state);
  }
  // Seeds given on --resume: once the home page is known they join the queue here (before that,
  // discovery queues every seed in the options), and a finished capture crawls again for them.
  if (state.fingerprint && newSeeds.length > 0) {
    for (const seed of newSeeds) crawler.enqueue(seed, 'seed');
    if (state.phase === 'done' && state.queue.length > 0) state.phase = 'crawl';
    saveState(out, state);
  }
  const stopBlocked = () => {
    saveState(out, state);
    console.error(
      `Stopped: ${state.origin} is blocking requests or cannot be reached. Wait a while, then run the same command with --resume.`,
    );
    process.exit(3);
  };

  // The host answers with a bot challenge: no retry gets past it, so stop and say what is needed.
  const stopChallenge = () => {
    crawler.writeOutputs({ finished: false });
    saveState(out, state);
    const { provider, cause, path, kind } = state.challenge;
    const tiny = kind === 'heuristic'
      ? `\nIf ${path} is a real page that is this small and untitled, run --resume anyway: it is then recorded "suspect-challenge" and `
        + 'the crawl goes on; give pages it cannot reach with --seed <path> (or --seed-file).'
      : '';
    console.error(
      `blocked: ${provider ?? new URL(state.origin).hostname} anti-bot challenge (${cause}) at ${path}.\n`
        + 'The host or its firewall is checking for a real browser; the capture does not get past that and will not try.\n'
        + 'Needs the site owner: allowlist the capture machine\'s public IP on the host or in the WAF for the capture window, '
        + `or send a URL list (then --seed-file it). Then run the same command with --resume.${tiny}`,
    );
    process.exit(3);
  };

  if (state.phase === 'discover') {
    const found = await crawler.discover();
    if (found === 'blocked') stopBlocked();
    if (found === 'challenge') stopChallenge();
    saveState(out, state);
  }

  let outcome = state.phase === 'crawl' ? await crawler.crawl(args.max) : 'done';
  // A resumed run keeps the verify pass the first run asked for, flag or not.
  if (args.verifyShortlinks) state.options.verifyShortlinks = true;
  const verify = state.options.verifyShortlinks || (state.verifyQueue?.length ?? 0) > 0;
  if (outcome === 'done') outcome = await crawler.probeNotFound();
  if (outcome === 'done') outcome = await crawler.probeIcons();
  if (outcome === 'done') outcome = await crawler.fetchCss();
  if (outcome === 'done') outcome = await crawler.fetchJs();
  if (outcome === 'done' && verify) outcome = await crawler.verifyShortlinks();
  if (args.noWayback) state.options.noWayback = true;
  if (outcome === 'done' && !state.options.noWayback && !state.wayback) {
    const retryMs = Number(process.env.CAPTURE_WAYBACK_RETRY_MS);
    state.wayback = await crawler.wayback(process.env.CAPTURE_WAYBACK_CDX || CDX_ENDPOINT, Number.isFinite(retryMs) && retryMs >= 0 ? retryMs : undefined);
  }
  if (outcome === 'challenge') stopChallenge();
  const inventory = crawler.writeOutputs({ finished: outcome === 'done' });
  if (outcome === 'blocked') stopBlocked();
  saveState(out, state);

  const failed = inventory.filter((r) => r.status !== 200).length;
  if (failed === inventory.length) {
    console.error(
      `Stopped: no page answered 200 (${inventory.length} recorded, none with content), so there is nothing to build from. `
        + `Check inventory.json and whether ${state.origin} is blocking the capture or this is the wrong origin. `
        + 'Then give the pages with --seed <path> or --seed-file <file> on --resume, or start a fresh capture in a new --out folder.',
    );
    process.exit(3);
  }
  const tail = outcome === 'max' ? ` Stopped at --max ${args.max}; ${state.queue.length} URLs left (use --resume).` : '';
  console.log(
    `Captured ${inventory.length} pages (${failed} not 200), ${crawler.redirectList().length} redirects, ${state.feeds.length} feeds${state.files?.length ? `, ${state.files.length} files` : ''} into ${out}.${tail}`,
  );
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
