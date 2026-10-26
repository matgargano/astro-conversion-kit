// The unfinished-site detectors: text nobody meant to ship, ids nobody replaced, hosts only the
// developer can reach, and credentials nobody meant to publish.
//
// Four pattern lists and one scanner, deliberately separated from the checks that use them, so the
// same list drives the launch-audit content and forms dimensions and the pre-launch gate without
// either one re-deriving it. Every pattern is proved by a planted string in test/detect.test.mjs:
// the proof table has one entry per pattern and fails if a pattern is added without one, which is
// what keeps a silently-broken regex from reading as a clean site.
//
// Two conventions matter to callers:
//
// - These are matchers, not validators. `scanText` reports what it saw and where; deciding whether
//   a `TODO` in a code sample is a defect is the check's job, not this module's.
// - `extraHosts` (the operator's own `--dev-host` list) is escaped and anchored to host segments
//   before it joins DEV_HOSTS, so `dev` never matches `devices.example.test` and a host containing
//   regex punctuation is matched literally rather than as a pattern.

export const PLACEHOLDER_TEXT = [
  /lorem ipsum/i,
  /\byour text here\b/i,
  /\bcoming soon\b/i,
  /\[INSERT[^\]]*\]/i,
  /\{\{\s*[\w.]+\s*\}\}/,
  /\bTODO\b/,
  /\bFIXME\b/,
  /REPLACE[_ ]ME/i,
]

export const PLACEHOLDER_IDS = [
  /G-XXXXXXX+/i,
  /G-PLACEHOLDER/i,
  /UA-\d+-\d+/,
  /formspree\.io\/f\/(your-form-id|xxxx+|REPLACE)/i,
  /submit-form\.com\/(your-form-id|xxxx+|REPLACE)/i,
  /GTM-XXXX+/i,
]

export const DEV_HOSTS = [
  /\blocalhost\b/,
  /127\.0\.0\.1/,
  /\.vercel\.app\b/,
  /\.netlify\.app\b/,
  /\.pages\.dev\b/,
  /\bstaging\./,
  /\bdev\./,
  /\.local\b/,
]

export const SECRETS = [
  /sk-[A-Za-z0-9]{20,}/,
  /ghp_[A-Za-z0-9]{36}/,
  /AKIA[0-9A-Z]{16}/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]

const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// An operator-supplied host, as a pattern that only matches a whole host segment: `old.internal`
// matches `build.old.internal` and not `old.internals.test`, and `dev` matches `dev.example.test`
// and not `devices.example.test`. A host written with a trailing dot (`dev.`) is already anchored
// on its right by that dot, so no trailing assertion is added — one would forbid the very thing it
// is meant to match.
export function hostPattern(host) {
  const literal = escapeRe(String(host).trim())
  if (literal === '') return null
  const tail = literal.endsWith('\\.') ? '' : '(?![A-Za-z0-9-])'
  return new RegExp(`(?<![A-Za-z0-9-])${literal}${tail}`, 'i')
}

// Every pattern that matches, in pattern order, with the text it matched and where. One entry per
// pattern: a second `TODO` further down the page is the same defect, and the evidence a check
// prints is the pattern and the first thing it caught.
export function scanText(text, patterns, { extraHosts = [] } = {}) {
  if (typeof text !== 'string' || text === '') return []
  const all = [...patterns]
  for (const host of extraHosts) {
    const pattern = hostPattern(host)
    if (pattern !== null) all.push(pattern)
  }
  const out = []
  for (const pattern of all) {
    const found = pattern.exec(text)
    if (found === null) continue
    out.push({ pattern, match: found[0], index: found.index })
  }
  return out
}
