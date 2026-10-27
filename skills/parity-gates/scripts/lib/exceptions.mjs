// Approved differences between the baseline and the build. No side effects on import.
// exceptions.json is an array of { path, field, from, to, reason, approvedBy, date }, and of
// { kind: "redirect", path, reason, action: "none", approvedBy, date } (see isNoRedirect).
// `from: ""` records a field the build adds, `to: ""` a field the build removes.
// With PROPOSALS=on, proposals.json (same record shape) is loaded after it.
import { existsSync, readFileSync } from 'node:fs';

export const DEFAULT_EXCEPTIONS = 'exceptions.json';
export const DEFAULT_PROPOSALS = 'proposals.json';
export const EXCEPTION_KEYS = ['path', 'field', 'from', 'to', 'reason', 'approvedBy', 'date'];
export const EXCEPTION_FIELDS = [
  'title', 'description', 'canonical', 'robots', 'lang', 'h1', 'h2', 'text',
  'og', 'jsonLd', 'link', 'redirect', 'media', 'routes',
  // A form field the build names differently from live (forms gate): `from` is the live name, `to` the built one.
  // It renames only; a field cannot be added or dropped this way.
  'formField',
  // A reviewed change no gate measures (a rewritten href that still resolves): accepted as a
  // record, never compared.
  'markup',
];
const MAY_BE_EMPTY = new Set(['from', 'to']);

// A record with a `kind` instead of a `field`: { kind: "redirect", path, reason, action: "none", approvedBy, date }
// means "no redirect for this path, on purpose" (a broken live href with nothing to redirect).
// The redirects gate reads it; every other gate ignores it.
export const isNoRedirect = (record) => record.kind === 'redirect' && record.action === 'none';
function checkKindRecord(record, where) {
  if (record.kind !== 'redirect') throw new Error(`${where}: kind "${record.kind}" is not redirect`);
  // approvedBy and date as on every record: it removes a live behaviour, so somebody signs it off.
  for (const key of ['path', 'reason', 'approvedBy', 'date']) {
    if (typeof record[key] !== 'string' || record[key] === '') throw new Error(`${where}: missing "${key}"`);
  }
  if (record.action !== 'none') throw new Error(`${where}: action must be "none" for kind "redirect", got ${JSON.stringify(record.action)}`);
}

// Only the default file name may be missing; a path somebody chose must exist (exit 2).
function readRecords(file, defaultName) {
  if (!existsSync(file)) {
    if (file === defaultName) return [];
    process.stderr.write(`${file}: exceptions file not found\n`);
    process.exit(2);
  }
  let records;
  try {
    records = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file}: not valid JSON (${error.message})`);
  }
  if (!Array.isArray(records)) throw new Error(`${file}: expected an array of exceptions`);
  records.forEach((record, index) => {
    const where = `${file}[${index}]`;
    if (!record || typeof record !== 'object') throw new Error(`${where}: expected an object`);
    if ('kind' in record) return checkKindRecord(record, where);
    for (const key of EXCEPTION_KEYS) {
      const value = record[key];
      const missing = MAY_BE_EMPTY.has(key) ? value === undefined : value === undefined || value === null || value === '';
      if (missing) throw new Error(`${where}: missing "${key}"`);
    }
    if (!EXCEPTION_FIELDS.includes(record.field)) {
      throw new Error(`${where}: field "${record.field}" is not one of ${EXCEPTION_FIELDS.join('|')}`);
    }
  });
  return records;
}

export function loadExceptions(file = DEFAULT_EXCEPTIONS, { proposals = DEFAULT_PROPOSALS, env = process.env } = {}) {
  const records = readRecords(file, DEFAULT_EXCEPTIONS);
  if (env.PROPOSALS === 'on') records.push(...readRecords(proposals, DEFAULT_PROPOSALS));
  return records;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Replace every occurrence of `from` inside value: a whole value that equals `from`, an array
// item or object value that equals it, or (for visible text) a non-empty phrase inside a string.
function substitute(value, from, to, phrase) {
  if (same(value, from)) return { value: to, hit: true };
  if (Array.isArray(value)) {
    let hit = false;
    const next = value.map((item) => {
      const r = substitute(item, from, to, phrase);
      hit ||= r.hit;
      return r.value;
    });
    return { value: next, hit };
  }
  if (value && typeof value === 'object') {
    let hit = false;
    const next = {};
    for (const [key, item] of Object.entries(value)) {
      const r = substitute(item, from, to, phrase);
      hit ||= r.hit;
      next[key] = r.value;
    }
    return { value: next, hit };
  }
  if (phrase && typeof value === 'string' && typeof from === 'string' && from !== '' && value.includes(from)) {
    return { value: value.split(from).join(String(to)), hit: true };
  }
  return { value, hit: false };
}

// Returns { expected, stale, staleExceptions }: a copy of `expected` with matching exceptions
// applied; `stale` is true when an exception for this path no longer matches anything.
export function applyExceptions(expected, path, exceptions = []) {
  const record = structuredClone(expected ?? {});
  const staleExceptions = [];
  for (const exception of exceptions) {
    if (exception.path !== path) continue;
    const { field, from, to } = exception;
    const current = field in record ? record[field] : '';
    const result = substitute(current, from, to, field === 'text');
    if (result.hit) record[field] = result.value;
    else staleExceptions.push(exception);
  }
  return { expected: record, stale: staleExceptions.length > 0, staleExceptions };
}

// The gate failure for an exception a gate could not use. Gates never skip one silently: the
// exceptions file is the record of what the client approved, so a stale entry fails the gate.
export function exceptionFailure(exception, reason) {
  return {
    path: exception.path,
    field: 'exception',
    expected: 'kind' in exception
      ? { kind: exception.kind, action: exception.action }
      : { field: exception.field, from: exception.from, to: exception.to },
    actual: reason,
  };
}
