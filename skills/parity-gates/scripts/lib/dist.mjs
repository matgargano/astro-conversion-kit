// Where a site path lives in a static build, and the baseline files the gates read.
// No side effects on import.
//
// Astro writes `/about/` to `about/index.html` (build.format "directory", the default) or to
// `about.html` (build.format "file"); "preserve" mixes the two. `/` is always `index.html`.
// Every page path is looked up in both forms, the build's main layout first.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT_FILES = new Set(['index.html', '404.html']);
export const PAGE_KINDS = new Set(['page', 'post', 'archive']);

// Every file under dir, as "/"-separated paths relative to it, sorted.
export function distFiles(dir) {
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(relative(dir, full).split(sep).join('/'));
    }
  };
  visit(dir);
  return files.sort();
}

// 'directory' when any page is <dir>/index.html, 'file' when pages are <name>.html.
export function pageFormat(files) {
  if (files.some((f) => f.endsWith('/index.html'))) return 'directory';
  if (files.some((f) => f.endsWith('.html') && !ROOT_FILES.has(f))) return 'file';
  return 'directory';
}

const decode = (path) => {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
};
const trim = (path) => decode(String(path).split(/[?#]/)[0]).replace(/^\/+|\/+$/g, '');

// The dist-relative files that may serve a page path, the build's main layout first.
export function pageFiles(path, format = 'directory') {
  const p = trim(path);
  if (!p) return ['index.html'];
  // A page linked with its extension (/about.html) is the file of that name.
  if (/\.html?$/i.test(p)) return [p];
  const both = [`${p}/index.html`, `${p}.html`];
  return format === 'file' ? both.reverse() : both;
}

// The dist-relative files that may serve a feed path, in order of preference.
export function feedFiles(path) {
  const p = trim(path);
  if (!p) return ['index.xml'];
  return [`${p}/index.xml`, `${p}.xml`];
}

// The site path a dist file answers at, in the baseline's slashed form: about/index.html and
// about.html -> /about/, feed/index.xml -> /feed/; any other file is its own path.
export function servedPath(file) {
  if (file === 'index.html') return '/';
  if (file.endsWith('/index.html')) return `/${file.slice(0, -'index.html'.length)}`;
  if (file.endsWith('/index.xml')) return `/${file.slice(0, -'index.xml'.length)}`;
  if (file.endsWith('.html') && file !== '404.html') return `/${file.slice(0, -'.html'.length)}/`;
  return `/${file}`;
}

// Every built HTML page among distFiles() as { path, file }, path in the baseline's form.
export function htmlPages(files) {
  return files.filter((f) => f.endsWith('.html')).map((file) => ({ path: servedPath(file), file }));
}

// The origin of a URL string, or null when it is not an absolute URL.
export function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

// The first of the candidates that exists in dist, or null.
export function firstExisting(dist, candidates) {
  return candidates.find((c) => existsSync(join(dist, c))) ?? null;
}

// Exits 2 with a message when dist or a baseline file is missing.
export function requireInputs(name, dist, baseline, files) {
  const missing = [];
  if (!existsSync(dist) || !statSync(dist).isDirectory()) missing.push(`${dist} (the built site)`);
  for (const file of files) if (!existsSync(join(baseline, file))) missing.push(join(baseline, file));
  if (missing.length === 0) return;
  process.stderr.write(`${name}: not found: ${missing.join(', ')}\n`);
  process.exit(2);
}

export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
