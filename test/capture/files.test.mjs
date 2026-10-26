import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startStub } from './helpers.mjs';
import { buildRoutes } from '../../skills/parity-gates/scripts/build-baseline.mjs';
import { checkRoutes } from '../../skills/parity-gates/scripts/verify/routes.mjs';
import { checkSitemaps } from '../../skills/parity-gates/scripts/verify/sitemaps.mjs';

const exec = promisify(execFile);
const skill = (path) => fileURLToPath(new URL(`../../skills/${path}`, import.meta.url));
const dirs = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'files-test-'));
  dirs.push(dir);
  return dir;
};
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const KML = '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Locations</name></Document></kml>\n';
const KML_TYPE = 'application/vnd.google-earth.kml+xml';
const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0xff, 0xfe, 0x00, 0x01]);

async function run(script, args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [skill(script), ...args]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    if (typeof err.code !== 'number') throw err;
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

// A site whose sitemap lists a .kml and a binary .pdf, and whose home page links to a second .pdf
// the sitemap does not list (the media step's job, not a file the capture keeps).
function startSite() {
  return startStub({
    '/': { body: '<html lang="en"><head><title>Home</title></head><body><h1>Home</h1><a href="/linked-only.pdf">Brochure</a></body></html>' },
    '/robots.txt': (origin) => ({ headers: { 'Content-Type': 'text/plain' }, body: `User-agent: *\nSitemap: ${origin}/sitemap.xml\n` }),
    '/sitemap.xml': (origin) => ({
      headers: { 'Content-Type': 'application/xml' },
      body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url><url><loc>${origin}/locations.kml</loc></url><url><loc>${origin}/docs/Report%20One.pdf</loc></url></urlset>`,
    }),
    '/locations.kml': { headers: { 'Content-Type': KML_TYPE }, body: KML },
    '/docs/Report%20One.pdf': { headers: { 'Content-Type': 'application/pdf' }, body: PDF },
    '/linked-only.pdf': { headers: { 'Content-Type': 'application/pdf' }, body: PDF },
  });
}

test('a file a sitemap lists is saved under files/ at its path, byte for byte, and indexed; a file only a page links to is not', async () => {
  const stub = await startSite();
  try {
    const out = tempDir();
    const result = await run('capture-site/scripts/capture.mjs', [stub.origin, '--out', out, '--delay', '0', '--no-wayback']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /, 2 files into /);
    assert.equal(readFileSync(join(out, 'files', 'locations.kml'), 'utf8'), KML);
    assert.deepEqual(readFileSync(join(out, 'files', 'docs', 'Report One.pdf')), PDF);
    assert.equal(existsSync(join(out, 'files', 'linked-only.pdf')), false);
    const index = JSON.parse(readFileSync(join(out, 'files', 'index.json'), 'utf8'));
    assert.deepEqual(index.map((f) => f.path), ['/docs/Report%20One.pdf', '/locations.kml']);
    const kml = index.find((f) => f.path === '/locations.kml');
    assert.equal(kml.status, 200);
    assert.equal(kml.contentType, KML_TYPE);
    assert.equal(kml.file, 'files/locations.kml');
    assert.equal(kml.bytes, Buffer.byteLength(KML));
    assert.equal(kml.sha1, createHash('sha1').update(KML).digest('hex'));
    // The page inventory is only pages.
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'inventory.json'), 'utf8')).map((r) => r.path), ['/']);
  } finally {
    await stub.close();
  }
});

test('--seed of a file path saves it too; a file that answers 404 is not saved', async () => {
  const stub = await startSite();
  try {
    const out = tempDir();
    const result = await run('capture-site/scripts/capture.mjs', [stub.origin, '--out', out, '--delay', '0', '--no-wayback', '--seed', '/linked-only.pdf', '--seed', '/gone.kml']);
    assert.equal(result.code, 0, result.stderr);
    const index = JSON.parse(readFileSync(join(out, 'files', 'index.json'), 'utf8'));
    assert.ok(index.some((f) => f.path === '/linked-only.pdf'));
    assert.equal(existsSync(join(out, 'files', 'gone.kml')), false);
  } finally {
    await stub.close();
  }
});

test('the baseline routes a captured file as kind file; the sitemaps and routes gates accept it only when it is built', () => {
  const capturedFiles = [{ url: 'https://x.test/locations.kml', path: '/locations.kml', status: 200, file: 'files/locations.kml' }];
  const routes = buildRoutes({
    inventory: [{ path: '/', status: 200, snapshot: 'pages/home.html', foundBy: ['sitemap'] }],
    feeds: [], capturedFiles, media: [], templates: [], rest: new Map(), foundBy: { 'https://x.test/locations.kml': ['sitemap'] },
  });
  const route = routes.find((r) => r.path === '/locations.kml');
  assert.deepEqual({ kind: route.kind, status: route.status, snapshot: route.snapshot, foundBy: route.foundBy }, { kind: 'file', status: 200, snapshot: 'files/locations.kml', foundBy: ['sitemap'] });

  const origin = 'https://x.test';
  const dist = tempDir();
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Home</title>');
  writeFileSync(join(dist, 'sitemap.xml'), `<urlset><url><loc>${origin}/</loc></url><url><loc>${origin}/locations.kml</loc></url></urlset>`);
  const capture = tempDir();

  // Not built: the routes gate fails on the file and the sitemap entry is not what is blamed.
  let gate = checkRoutes({ dist, routes, media: [] });
  assert.deepEqual(gate.failures.filter((f) => f.path === '/locations.kml'), [{ path: '/locations.kml', field: 'file', expected: 'locations.kml', actual: null }]);
  assert.deepEqual(checkSitemaps({ dist, capture, routes, compareOrigin: origin }).failures, []);

  // Built: both pass, and the file is not an extra.
  writeFileSync(join(dist, 'locations.kml'), KML);
  gate = checkRoutes({ dist, routes, media: [] });
  assert.deepEqual(gate.failures, []);

  // A listed URL with no file route still fails, as before.
  const withoutRoute = routes.filter((r) => r.path !== '/locations.kml');
  assert.equal(checkSitemaps({ dist, capture, routes: withoutRoute, compareOrigin: origin }).failures.length, 1);
});

test('copy-assets copies a captured file to public/ at its live path', async () => {
  const stub = await startSite();
  const out = tempDir();
  try {
    const result = await run('capture-site/scripts/capture.mjs', [stub.origin, '--out', out, '--delay', '0', '--no-wayback']);
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await stub.close();
  }
  const site = tempDir();
  mkdirSync(join(site, 'public'), { recursive: true });
  const copy = await run('convert-site/scripts/copy-assets.mjs', ['--capture', out, '--site', site]);
  assert.equal(copy.code, 0, copy.stderr + copy.stdout);
  assert.match(copy.stdout, /^files: 2$/m);
  assert.equal(readFileSync(join(site, 'public', 'locations.kml'), 'utf8'), KML);
  assert.deepEqual(readFileSync(join(site, 'public', 'docs', 'Report One.pdf')), PDF);
});
