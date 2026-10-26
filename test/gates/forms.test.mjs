import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFixtureBaseline } from './fixtures/baseline.mjs';
import { edit, makeDist } from './fixtures/make-dist.mjs';
import { runGate } from './fixtures/run-gate.mjs';
import { externalHost, registrableDomain } from '../../skills/parity-gates/scripts/verify/forms.mjs';

// The fixture build keeps the live form's action, so that is the endpoint it is configured with.
const ENDPOINT = '/contact/';

let root;
let baseline;
let good;
before(async () => {
  root = mkdtempSync(join(tmpdir(), 'forms-gate-'));
  baseline = await buildFixtureBaseline(root);
  good = makeDist(join(root, 'dist-good'));
});
after(() => rmSync(root, { recursive: true, force: true }));

const forms = (dist, args = [], base = baseline) => runGate('forms', ['--dist', dist, '--baseline', base, ...args], { cwd: root });

test('dist-good passes: the contact form has the same fields, method and endpoint', async () => {
  const result = await forms(good, ['--endpoint', ENDPOINT]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^ {2}thank-you: not checked \(no --thank-you\)$/m);
  assert.match(result.stdout, /^ {2}1 search\/GET forms compared$/m);
  assert.match(result.stdout, /^forms: 2 checked, 0 failed, 1 skipped \(thank-you not checked\)$/m);
  const json = JSON.parse((await forms(good, ['--endpoint', ENDPOINT, '--json'])).stdout);
  assert.equal(json.skipped, 1);
});

test('--thank-you: a hidden _next equal to it passes; a form without it fails; a path not in dist fails', async () => {
  const dist = makeDist(join(root, 'dist-thank-you'));
  edit(dist, 'contact/index.html', '<button type="submit">', '<input type="hidden" name="_next" value="/thank-you/"><button type="submit">');
  mkdirSync(join(dist, 'thank-you'));
  writeFileSync(join(dist, 'thank-you', 'index.html'), '<!doctype html><title>Thanks</title>');
  const passed = await forms(dist, ['--endpoint', ENDPOINT, '--thank-you', '/thank-you/']);
  assert.equal(passed.code, 0, passed.stdout);
  assert.match(passed.stdout, /^forms: 2 checked, 0 failed$/m);

  const missing = await forms(good, ['--endpoint', ENDPOINT, '--thank-you', '/thank-you/']);
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /^ {2}\/contact\/ thank-you: expected "\/thank-you\/", got null$/m);

  rmSync(join(dist, 'thank-you'), { recursive: true });
  const notBuilt = await forms(dist, ['--endpoint', ENDPOINT, '--thank-you', '/thank-you/']);
  assert.equal(notBuilt.code, 1);
  assert.match(notBuilt.stdout, /^ {2}\/thank-you\/ thank-you: expected "thank-you\/index\.html", got null$/m);
});

test('--thank-you: an absolute _next on the canonical host passes; on another host it fails with the raw value', async () => {
  const { canonicalOrigin } = JSON.parse(readFileSync(join(baseline, 'meta.json'), 'utf8'));
  const withNext = (name, value) => {
    const dist = makeDist(join(root, name));
    edit(dist, 'contact/index.html', '<button type="submit">', `<input type="hidden" name="_next" value="${value}"><button type="submit">`);
    mkdirSync(join(dist, 'thank-you'));
    writeFileSync(join(dist, 'thank-you', 'index.html'), '<!doctype html><title>Thanks</title>');
    return dist;
  };
  const canonical = await forms(withNext('dist-next-canonical', `${canonicalOrigin}/thank-you/`), ['--endpoint', ENDPOINT, '--thank-you', '/thank-you/']);
  assert.equal(canonical.code, 0, canonical.stdout + canonical.stderr);
  assert.match(canonical.stdout, /^forms: 2 checked, 0 failed$/m);

  const path = await forms(withNext('dist-next-path', '/thank-you/'), ['--endpoint', ENDPOINT, '--thank-you', '/thank-you/']);
  assert.equal(path.code, 0, path.stdout + path.stderr);

  const foreign = await forms(withNext('dist-next-foreign', 'https://elsewhere.example.com/thank-you/'), ['--endpoint', ENDPOINT, '--thank-you', '/thank-you/']);
  assert.equal(foreign.code, 1);
  assert.match(foreign.stdout, /^ {2}\/contact\/ thank-you: expected "\/thank-you\/", got "https:\/\/elsewhere\.example\.com\/thank-you\/"$/m);

  const otherPath = await forms(withNext('dist-next-other-path', `${canonicalOrigin}/thanks/`), ['--endpoint', ENDPOINT, '--thank-you', '/thank-you/']);
  assert.equal(otherPath.code, 1);
  assert.match(otherPath.stdout, /thank-you: expected "\/thank-you\/", got "https?:\/\/[^"]+\/thanks\/"$/m);
});

test('a reordered field fails with both field lists', async () => {
  const bad = makeDist(join(root, 'dist-reordered'), { bad: ['reordered-field'] });
  const result = await forms(bad, ['--endpoint', ENDPOINT]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^ {2}\/contact\/ fields: expected \["name","email","message","website"\], got \["email","name","message","website"\]$/m);
});

test('an action other than the endpoint fails; so does a changed method', async () => {
  const other = await forms(good, ['--endpoint', 'https://forms.example.com/f/abc']);
  assert.equal(other.code, 1);
  assert.match(other.stdout, /\/contact\/ action: expected "https:\/\/forms\.example\.com\/f\/abc", got "\/contact\/"/);
  const dist = makeDist(join(root, 'dist-get'));
  edit(dist, 'contact/index.html', 'method="post"', 'method="get"');
  const method = await forms(dist, ['--endpoint', ENDPOINT]);
  assert.equal(method.code, 1);
  assert.match(method.stdout, /\/contact\/ method: expected "post", got "get"/);
});

test('a page whose form is gone fails', async () => {
  const dist = makeDist(join(root, 'dist-no-form'));
  edit(dist, 'contact/index.html', '<form class="contact-form"', '<div class="contact-form"');
  edit(dist, 'contact/index.html', '</form>', '</div>');
  const result = await forms(dist, ['--endpoint', ENDPOINT]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /\/contact\/ forms: expected 1, got 0/);
});

test('--honeypot requires the named field and allows it beside the baseline fields', async () => {
  assert.equal((await forms(good, ['--endpoint', ENDPOINT, '--honeypot', 'website'])).code, 0);
  const missing = await forms(good, ['--endpoint', ENDPOINT, '--honeypot', 'hp_check']);
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /\/contact\/ honeypot: expected "hp_check", got null/);
  // A baseline whose live form had no honeypot: the build adds one.
  const copy = join(root, 'baseline-no-honeypot');
  cpSync(baseline, copy, { recursive: true });
  writeFileSync(
    join(copy, 'forms.json'),
    JSON.stringify({ '/contact/': [{ action: '/contact/', method: 'post', fields: ['name', 'email', 'message'].map((name) => ({ name })) }] }),
  );
  assert.equal((await forms(good, ['--endpoint', ENDPOINT, '--honeypot', 'website'], copy)).code, 0);
  assert.equal((await forms(good, ['--endpoint', ENDPOINT], copy)).code, 1);
});

test('a GET search form is compared with live: action path, method and fields; no endpoint, honeypot or thank-you', async () => {
  const only = await forms(good, ['--paths', '/blog/', '--honeypot', '_gotcha', '--thank-you', '/thank-you/']);
  assert.equal(only.code, 0, only.stdout + only.stderr);
  assert.match(only.stdout, /^ {2}1 search\/GET forms compared$/m);
  assert.match(only.stdout, /^forms: 1 checked, 0 failed$/m);
  const dist = makeDist(join(root, 'dist-search'));
  edit(dist, 'blog/index.html', 'action="/"', 'action="/search/"');
  edit(dist, 'blog/index.html', 'name="s"', 'name="q"');
  const changed = await forms(dist, ['--paths', '/blog/']);
  assert.equal(changed.code, 1);
  assert.match(changed.stdout, /^ {2}\/blog\/ action: expected "\/", got "\/search\/"$/m);
  assert.match(changed.stdout, /^ {2}\/blog\/ fields: expected \["s"\], got \["q"\]$/m);
  // A search box rewired to the form endpoint is no longer the live search.
  const posted = makeDist(join(root, 'dist-search-posted'));
  edit(posted, 'blog/index.html', 'method="get" class="search-form" action="/"', `method="post" class="search-form" action="${ENDPOINT}"`);
  const result = await forms(posted, ['--paths', '/blog/', '--endpoint', ENDPOINT]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /\/blog\/ method: expected "get", got "post"/);
});

// A newsletter signup that already posts to a third party (a Mailchimp-style list host).
const SIGNUP_ACTION = 'https://example.us1.list-manage.com/subscribe/post?u=abc&amp;id=def';
const SIGNUP_URL = 'https://example.us1.list-manage.com/subscribe/post?u=abc&id=def';
const SIGNUP = `<form action="${SIGNUP_ACTION}" method="post" class="signup"><input type="email" name="EMAIL"><input type="text" name="b_abc_def" tabindex="-1" value=""><input type="submit" value="Subscribe"></form>`;

test('a POST form whose action is on another origin is kept as is: compared like live, no endpoint, honeypot or thank-you', async () => {
  const base = join(root, 'baseline-signup');
  cpSync(baseline, base, { recursive: true });
  const captured = JSON.parse(readFileSync(join(base, 'forms.json'), 'utf8'));
  const field = (name, type) => ({ name, type, required: false });
  captured['/about/'] = [{ action: SIGNUP_URL, method: 'post', fields: [field('EMAIL', 'email'), field('b_abc_def', 'text')] }];
  writeFileSync(join(base, 'forms.json'), JSON.stringify(captured));
  const dist = makeDist(join(root, 'dist-signup'));
  edit(dist, 'about/index.html', '</main>', `${SIGNUP}</main>`);

  const kept = await forms(dist, ['--paths', '/about/'], base);
  assert.equal(kept.code, 0, kept.stdout + kept.stderr);
  assert.match(kept.stdout, /^ {2}1 form kept as is \(posts to example\.us1\.list-manage\.com\)$/m);
  assert.match(kept.stdout, /^forms: 1 checked, 0 failed$/m);
  const strict = await forms(dist, ['--paths', '/about/', '--endpoint', ENDPOINT, '--honeypot', '_gotcha', '--thank-you', '/thank-you/'], base);
  assert.equal(strict.code, 0, strict.stdout + strict.stderr);

  // Rewired to the form service, it is no longer the live signup.
  const rewired = makeDist(join(root, 'dist-signup-rewired'));
  edit(rewired, 'about/index.html', '</main>', `${SIGNUP.replace(SIGNUP_ACTION, ENDPOINT)}</main>`);
  const failed = await forms(rewired, ['--paths', '/about/', '--endpoint', ENDPOINT], base);
  assert.equal(failed.code, 1, failed.stdout);
  assert.match(failed.stdout, new RegExp(`^ {2}/about/ action: expected "${SIGNUP_URL.replace(/[?.]/g, '\\$&')}", got "/contact/"$`, 'm'));

  // The contact form still posts to the old site, so the whole baseline still needs --endpoint.
  assert.equal((await forms(dist, [], base)).code, 2);
  const all = await forms(dist, ['--endpoint', ENDPOINT], base);
  assert.equal(all.code, 0, all.stdout);
  assert.match(all.stdout, /^forms: 3 checked, 0 failed, 1 skipped \(thank-you not checked\)$/m);
});

// The site's own forms, however the action spells the host, and WordPress's form handlers on any host.
const OLD_SITE_ACTIONS = [
  'https://www.example.com/wp-admin/admin-ajax.php',
  'http://example.com/wp-comments-post.php',
  '//example.com/x',
  'https://staging.example.wpengine.com/?wpcf7=1',
  'https://forms.example.com/contact',
  'https://cdn.other.example.net/wp-json/contact-form-7/v1/contact-forms/5/feedback',
];

test('externalHost: only a POST action on another registrable domain posts elsewhere', () => {
  const origins = ['https://example.com'];
  for (const action of OLD_SITE_ACTIONS) assert.equal(externalHost({ action, method: 'post' }, '/about/', origins), null, action);
  assert.equal(externalHost({ action: SIGNUP_URL, method: 'post' }, '/about/', origins), 'example.us1.list-manage.com');
  assert.equal(externalHost({ action: 'https://formspree.io/f/abc', method: 'post' }, '/', origins), 'formspree.io');
  assert.equal(externalHost({ action: 'https://forms.hsforms.com/submissions', method: 'post' }, '/', origins), 'forms.hsforms.com');
  assert.equal(externalHost({ action: SIGNUP_URL, method: 'get' }, '/', origins), null, 'a GET form is not a submission form');
  for (const action of ['https://example.wpengine.com/contact/', 'https://staging-site.kinsta.cloud/signup/', 'https://dev-x.pantheonsite.io/form/', 'https://Example.WPEngine.com./x']) {
    assert.equal(externalHost({ action, method: 'post' }, '/', origins), null, `${action} is a managed-WordPress staging host`);
  }
  assert.equal(externalHost({ action: '', method: 'post' }, '/', origins), null);
  // Two-level public suffixes: the registrable domain keeps three labels.
  const uk = ['https://www.example.co.uk'];
  assert.equal(externalHost({ action: 'https://forms.example.co.uk/x', method: 'post' }, '/', uk), null);
  assert.equal(externalHost({ action: 'https://other.co.uk/x', method: 'post' }, '/', uk), 'other.co.uk');
  assert.equal(registrableDomain('a.b.example.com.au'), 'example.com.au');
  assert.equal(registrableDomain('127.0.0.1'), '127.0.0.1');
});

test('a POST form posting to the old site under another spelling of its host still needs --endpoint', async () => {
  const base = join(root, 'baseline-old-site');
  cpSync(baseline, base, { recursive: true });
  const meta = JSON.parse(readFileSync(join(base, 'meta.json'), 'utf8'));
  writeFileSync(join(base, 'meta.json'), JSON.stringify({ ...meta, origin: 'https://example.com', canonicalOrigin: 'https://example.com' }));
  const captured = JSON.parse(readFileSync(join(base, 'forms.json'), 'utf8'));
  for (const action of OLD_SITE_ACTIONS) {
    writeFileSync(join(base, 'forms.json'), JSON.stringify({ ...captured, '/about/': [{ action, method: 'post', fields: [{ name: 'email', type: 'email', required: true }] }] }));
    const result = await forms(good, ['--paths', '/about/'], base);
    assert.equal(result.code, 2, `${action}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /--endpoint <url> is required/);
  }
  writeFileSync(join(base, 'forms.json'), JSON.stringify({ ...captured, '/about/': [{ action: SIGNUP_URL, method: 'post', fields: [{ name: 'EMAIL', type: 'email', required: false }, { name: 'b_abc_def', type: 'text', required: false }] }] }));
  const dist = makeDist(join(root, 'dist-signup-example'));
  edit(dist, 'about/index.html', '</main>', `${SIGNUP}</main>`);
  const kept = await forms(dist, ['--paths', '/about/'], base);
  assert.equal(kept.code, 0, kept.stdout + kept.stderr);
  assert.match(kept.stdout, /^ {2}1 form kept as is \(posts to example\.us1\.list-manage\.com\)$/m);
});

test('--endpoint is required when the baseline has a form', async () => {
  const result = await forms(good);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--endpoint/);
  // Not when no checked page has one.
  assert.equal((await forms(good, ['--paths', '/about/'])).code, 0);
  // Nor for a GET form (the /blog/ search box): it is no submission form.
  assert.equal((await forms(good, ['--paths', '/blog/'])).code, 0);
});

test('usage and missing inputs exit 2; --help exits 0', async () => {
  assert.equal((await forms(good, ['--bogus'])).code, 2);
  assert.equal((await runGate('forms', ['--dist', good, '--baseline', join(root, 'nope'), '--endpoint', ENDPOINT], { cwd: root })).code, 2);
  const help = await runGate('forms', ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--endpoint/);
  assert.match(help.stdout, /--thank-you/);
});

test('--thank-you: a hidden _redirect (Formspark) leads to the thank-you page like _next', async () => {
  const dist = makeDist(join(root, 'dist-redirect'));
  edit(dist, 'contact/index.html', '<button type="submit">', '<input type="hidden" name="_redirect" value="/thank-you/"><button type="submit">');
  mkdirSync(join(dist, 'thank-you'));
  writeFileSync(join(dist, 'thank-you', 'index.html'), '<!doctype html><title>Thanks</title>');
  const passed = await forms(dist, ['--endpoint', ENDPOINT, '--thank-you', '/thank-you/']);
  assert.equal(passed.code, 0, passed.stdout);
  assert.match(passed.stdout, /^forms: 2 checked, 0 failed$/m);
});
