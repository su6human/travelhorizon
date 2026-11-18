'use strict';

// Run with: npm test  (Node.js 20+, no dependencies)
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp, validateEnquiry, buildTelegramMessage } = require('../server.js');
const DATA = require('../public/data.js');

const ADMIN = { username: 'editor', password: 'a-very-long-password-123' };
const TELEGRAM_TOKEN = '987654:SECRET-TOKEN-VALUE';
const silent = { info() {}, warn() {}, error() {}, log() {} };

// ---------------------------------------------------------------- helpers

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'th-test-'));
  return path.join(dir, 'content.json');
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

// Fake Telegram Bot API that records messages.
async function startTelegram({ fail = false } = {}) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ url: req.url, body: JSON.parse(body || '{}') });
      if (fail) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    });
  });
  const port = await listen(server);
  return { server, received, base: `http://127.0.0.1:${port}` };
}

async function startApp(options = {}) {
  const app = createApp({
    port: 0,
    production: false,
    adminUsername: ADMIN.username,
    adminPassword: ADMIN.password,
    telegramToken: TELEGRAM_TOKEN,
    telegramChatId: '-100123',
    telegramApiBase: 'http://127.0.0.1:9',
    contentFile: tmpFile(),
    logger: silent,
    ...options
  });
  const port = await listen(app.server);
  const origin = `http://127.0.0.1:${port}`;
  return { app, port, origin };
}

function request(port, method, urlPath, { headers = {}, body, json } = {}) {
  return new Promise((resolve, reject) => {
    const payload = json !== undefined ? JSON.stringify(json) : body;
    const finalHeaders = { ...headers };
    if (json !== undefined && !finalHeaders['content-type']) finalHeaders['content-type'] = 'application/json';
    if (payload !== undefined) finalHeaders['content-length'] = Buffer.byteLength(payload);
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: finalHeaders }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { parsed = null; }
        resolve({ status: res.statusCode, headers: res.headers, text: data, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function sameOrigin(port, extra = {}) {
  return { origin: `http://127.0.0.1:${port}`, ...extra };
}

function validEnquiry(extra = {}) {
  return {
    name: 'Aigerim',
    email: 'aigerim@example.com',
    tour: 'song',
    travelers: 3,
    interest: 'general',
    message: 'Late June, please.',
    language: 'ru',
    ...extra
  };
}

async function login(port) {
  const res = await request(port, 'POST', '/api/admin/login', { headers: sameOrigin(port), json: ADMIN });
  assert.equal(res.status, 200);
  const cookie = res.headers['set-cookie'][0].split(';')[0];
  return { cookie, csrf: res.body.csrfToken, res };
}

// ---------------------------------------------------------------- public site

test('A1: all six public pages and assets are served', async () => {
  const { app, port } = await startApp();
  try {
    for (const page of ['/', '/tours.html', '/about.html', '/partners.html', '/experiences.html', '/contacts.html', '/styles.css', '/script.js', '/i18n.js', '/data.js']) {
      const res = await request(port, 'GET', page);
      assert.equal(res.status, 200, page);
    }
    const clean = await request(port, 'GET', '/tours');
    assert.equal(clean.status, 200);
    const missing = await request(port, 'GET', '/no-such-page');
    assert.equal(missing.status, 404);
    const home = await request(port, 'GET', '/');
    assert.match(home.headers['content-security-policy'], /default-src 'self'/);
    assert.equal(home.headers['x-content-type-options'], 'nosniff');
  } finally {
    await close(app.server);
  }
});

test('server source, data files and path traversal are not reachable', async () => {
  const { app, port } = await startApp();
  try {
    for (const p of ['/server.js', '/package.json', '/../server.js', '/%2e%2e/server.js', '/data/content.json', '/images/.gitkeep']) {
      const res = await request(port, 'GET', p);
      assert.equal(res.status, 404, p);
    }
  } finally {
    await close(app.server);
  }
});

test('photos redirect to Wikimedia Commons unless a local file exists', async () => {
  const { app, port } = await startApp();
  try {
    const res = await request(port, 'GET', '/img/tour-ala?w=900');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c8/Ala-K%C3%B6l.jpg/960px-Ala-K%C3%B6l.jpg');
    const unknown = await request(port, 'GET', '/img/not-a-photo');
    assert.equal(unknown.status, 404);
  } finally {
    await close(app.server);
  }
});

test('local photos in public/images are served instead of Wikimedia', async () => {
  const { app, port } = await startApp();
  const file = path.join(__dirname, '..', 'public', 'images', 'about.jpg');
  const existed = fs.existsSync(file);
  if (!existed) fs.writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  try {
    const res = await request(port, 'GET', '/img/about?w=1280');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'image/jpeg');
  } finally {
    if (!existed) fs.rmSync(file);
    await close(app.server);
  }
});

test('every tour link key and every interest used in pages is valid', () => {
  const pagesDir = path.join(__dirname, '..', 'public');
  for (const file of ['index.html', 'tours.html', 'experiences.html', 'partners.html']) {
    const html = fs.readFileSync(path.join(pagesDir, file), 'utf8');
    for (const [, key] of html.matchAll(/contacts\.html\?tour=([a-z]+)/g)) assert.ok(DATA.tours[key], `${file}: ${key}`);
    for (const [, key] of html.matchAll(/contacts\.html\?interest=([a-z]+)/g)) assert.ok(DATA.interests.includes(key), `${file}: ${key}`);
  }
});

// ---------------------------------------------------------------- pricing

test('NFR-05: estimated total equals price per traveler times traveler count', () => {
  for (const [key, tour] of Object.entries(DATA.tours)) {
    for (const travelers of [1, 2, 4, 19, 20]) {
      const result = validateEnquiry(validEnquiry({ tour: key, travelers }));
      assert.equal(result.enquiry.estimatedTotal, tour.price * travelers, `${key} × ${travelers}`);
    }
  }
  assert.equal(validateEnquiry(validEnquiry({ tour: '' })).enquiry.estimatedTotal, null);
  assert.deepEqual(
    Object.fromEntries(Object.entries(DATA.tours).map(([k, t]) => [k, t.price])),
    { ala: 980, song: 740, issyk: 860, jyrgalan: 620 }
  );
});

// ---------------------------------------------------------------- enquiries

test('A7: a valid enquiry is delivered to Telegram with all details', async () => {
  const tg = await startTelegram();
  const { app, port } = await startApp({ telegramApiBase: tg.base });
  try {
    const res = await request(port, 'POST', '/api/contact', {
      headers: sameOrigin(port),
      json: validEnquiry({ name: 'Ai <b>Bold</b>' })
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.sent, true);
    assert.equal(res.body.estimatedTotal, 740 * 3);
    assert.equal(tg.received.length, 1);
    const { url, body } = tg.received[0];
    assert.equal(url, `/bot${TELEGRAM_TOKEN}/sendMessage`);
    assert.equal(body.chat_id, '-100123');
    assert.equal(body.parse_mode, 'HTML');
    assert.match(body.text, /Ai &lt;b&gt;Bold&lt;\/b&gt;/);
    assert.match(body.text, /aigerim@example\.com/);
    assert.match(body.text, /song/);
    assert.match(body.text, /USD 740 × 3 = USD 2,220/);
    assert.match(body.text, /Late June/);
  } finally {
    await close(app.server);
    await close(tg.server);
  }
});

test('Telegram message lists "Not selected" when no tour is chosen (English mode)', () => {
  const { enquiry } = validateEnquiry(validEnquiry({ tour: '', interest: 'partner', message: '' }));
  const text = buildTelegramMessage(enquiry, 'en');
  assert.match(text, /Tour:<\/b> Not selected/);
  assert.match(text, /Interest:<\/b> Partnership/);
  assert.doesNotMatch(text, /Estimated total/);
});

test('A8: invalid enquiries are rejected with field errors', async () => {
  const tg = await startTelegram();
  const { app, port } = await startApp({ telegramApiBase: tg.base, contactMax: 100 });
  const cases = [
    [{ name: '' }, 'name'],
    [{ name: 'x'.repeat(101) }, 'name'],
    [{ email: 'not-an-email' }, 'email'],
    [{ email: `${'a'.repeat(250)}@x.io` }, 'email'],
    [{ tour: 'everest' }, 'tour'],
    [{ travelers: 0 }, 'travelers'],
    [{ travelers: 21 }, 'travelers'],
    [{ travelers: 2.5 }, 'travelers'],
    [{ travelers: 'many' }, 'travelers'],
    [{ interest: 'skiing' }, 'interest'],
    [{ message: 'x'.repeat(2001) }, 'message'],
    [{ language: 'de' }, 'language']
  ];
  try {
    for (const [patch, field] of cases) {
      const res = await request(port, 'POST', '/api/contact', { headers: sameOrigin(port), json: validEnquiry(patch) });
      assert.equal(res.status, 400, JSON.stringify(patch));
      assert.equal(res.body.error, 'validation');
      assert.ok(res.body.fields[field], `${field} should be flagged for ${JSON.stringify(patch)}`);
    }
    const missingLang = validEnquiry();
    delete missingLang.language;
    const ok = await request(port, 'POST', '/api/contact', { headers: sameOrigin(port), json: missingLang });
    assert.equal(ok.status, 200, 'language defaults to en');
    assert.equal(tg.received.length, 1, 'only the valid enquiry reached Telegram');
  } finally {
    await close(app.server);
    await close(tg.server);
  }
});

test('NFR-10: content type, malformed JSON, size and origin are checked', async () => {
  const { app, port } = await startApp({ contactMax: 100 });
  try {
    const text = await request(port, 'POST', '/api/contact', { headers: sameOrigin(port, { 'content-type': 'text/plain' }), body: 'hello' });
    assert.equal(text.status, 415);
    const broken = await request(port, 'POST', '/api/contact', { headers: sameOrigin(port, { 'content-type': 'application/json' }), body: '{"name":' });
    assert.equal(broken.status, 400);
    const huge = await request(port, 'POST', '/api/contact', { headers: sameOrigin(port), json: validEnquiry({ message: 'x'.repeat(40000) }) });
    assert.equal(huge.status, 413);
    const foreign = await request(port, 'POST', '/api/contact', { headers: { origin: 'https://evil.example' }, json: validEnquiry() });
    assert.equal(foreign.status, 403);
    const noOrigin = await request(port, 'POST', '/api/contact', { json: validEnquiry() });
    assert.equal(noOrigin.status, 403);
  } finally {
    await close(app.server);
  }
});

test('NFR-11: the contact endpoint is rate limited', async () => {
  const tg = await startTelegram();
  const { app, port } = await startApp({ telegramApiBase: tg.base, contactMax: 3 });
  try {
    for (let i = 0; i < 3; i += 1) {
      const res = await request(port, 'POST', '/api/contact', { headers: sameOrigin(port), json: validEnquiry() });
      assert.equal(res.status, 200);
    }
    const blocked = await request(port, 'POST', '/api/contact', { headers: sameOrigin(port), json: validEnquiry() });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers['retry-after']) > 0);
  } finally {
    await close(app.server);
    await close(tg.server);
  }
});

test('A18 / NFR-15: Telegram problems return a clear error and the site stays up', async () => {
  const failing = await startTelegram({ fail: true });
  const broken = await startApp({ telegramApiBase: failing.base });
  const unconfigured = await startApp({ telegramToken: '', telegramChatId: '' });
  try {
    const a = await request(broken.port, 'POST', '/api/contact', { headers: sameOrigin(broken.port), json: validEnquiry() });
    assert.equal(a.status, 502);
    assert.equal(a.body.error, 'delivery_failed');
    assert.doesNotMatch(a.text, /SECRET-TOKEN/);

    const b = await request(unconfigured.port, 'POST', '/api/contact', { headers: sameOrigin(unconfigured.port), json: validEnquiry() });
    assert.equal(b.status, 503);
    assert.equal(b.body.error, 'delivery_unavailable');

    const page = await request(broken.port, 'GET', '/contacts.html');
    assert.equal(page.status, 200);
  } finally {
    await close(broken.app.server);
    await close(unconfigured.app.server);
    await close(failing.server);
  }
});

test('honeypot submissions are accepted silently and not forwarded', async () => {
  const tg = await startTelegram();
  const { app, port } = await startApp({ telegramApiBase: tg.base });
  try {
    const res = await request(port, 'POST', '/api/contact', { headers: sameOrigin(port), json: validEnquiry({ website: 'http://spam.example' }) });
    assert.equal(res.status, 200);
    assert.equal(tg.received.length, 0);
  } finally {
    await close(app.server);
    await close(tg.server);
  }
});

// ---------------------------------------------------------------- admin

test('A9: the editor route and editing API require a session', async () => {
  const { app, port } = await startApp();
  try {
    const page = await request(port, 'GET', '/admin.html');
    assert.equal(page.status, 302);
    assert.equal(page.headers.location, '/admin-login.html');
    const shortcut = await request(port, 'GET', '/admin');
    assert.equal(shortcut.headers.location, '/admin-login.html');
    const session = await request(port, 'GET', '/api/admin/session');
    assert.equal(session.status, 401);
    const put = await request(port, 'PUT', '/api/admin/content', { headers: sameOrigin(port, { 'x-csrf-token': 'x' }), json: { en: {} } });
    assert.equal(put.status, 401);
    const del = await request(port, 'DELETE', '/api/admin/content', { headers: sameOrigin(port, { 'x-csrf-token': 'x' }) });
    assert.equal(del.status, 401);
  } finally {
    await close(app.server);
  }
});

test('A10: sign-in creates an HttpOnly, SameSite=Strict session with a CSRF token', async () => {
  const { app, port } = await startApp();
  try {
    const { cookie, csrf, res } = await login(port);
    const setCookie = res.headers['set-cookie'][0];
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Max-Age=43200/);
    assert.doesNotMatch(setCookie, /Secure/, 'not secure outside production');
    assert.ok(csrf.length >= 32);

    const session = await request(port, 'GET', '/api/admin/session', { headers: { cookie } });
    assert.equal(session.status, 200);
    assert.equal(session.body.authenticated, true);
    assert.equal(session.body.csrfToken, csrf);

    const page = await request(port, 'GET', '/admin.html', { headers: { cookie } });
    assert.equal(page.status, 200);
    assert.match(page.text, /data-editor-fields/);
    const loginPage = await request(port, 'GET', '/admin-login.html', { headers: { cookie } });
    assert.equal(loginPage.status, 302);
  } finally {
    await close(app.server);
  }
});

test('production cookies are Secure and use the __Host- prefix', async () => {
  const { app, port } = await startApp({ production: true });
  try {
    const { res } = await login(port);
    const setCookie = res.headers['set-cookie'][0];
    assert.match(setCookie, /^__Host-th_admin=/);
    assert.match(setCookie, /Secure/);
    const home = await request(port, 'GET', '/');
    assert.match(home.headers['strict-transport-security'], /max-age=/);
  } finally {
    await close(app.server);
  }
});

test('wrong credentials are rejected and repeated failures are rate limited', async () => {
  const { app, port } = await startApp({ loginMaxFailures: 3 });
  try {
    for (let i = 0; i < 3; i += 1) {
      const res = await request(port, 'POST', '/api/admin/login', { headers: sameOrigin(port), json: { username: ADMIN.username, password: 'wrong-password-000' } });
      assert.equal(res.status, 401);
      assert.equal(res.headers['set-cookie'], undefined);
    }
    const blocked = await request(port, 'POST', '/api/admin/login', { headers: sameOrigin(port), json: ADMIN });
    assert.equal(blocked.status, 429, 'even correct credentials wait until the window ends');
    const foreign = await request(port, 'POST', '/api/admin/login', { headers: { origin: 'https://evil.example' }, json: ADMIN });
    assert.equal(foreign.status, 403);
  } finally {
    await close(app.server);
  }
});

test('sign-in is disabled when credentials are missing or the password is short', async () => {
  const { app, port } = await startApp({ adminPassword: 'short' });
  try {
    const res = await request(port, 'POST', '/api/admin/login', { headers: sameOrigin(port), json: { username: ADMIN.username, password: 'short' } });
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'admin_not_configured');
  } finally {
    await close(app.server);
  }
});

test('A11 / A14: content updates need session, same origin and CSRF, then appear publicly', async () => {
  const { app, port } = await startApp();
  try {
    const { cookie, csrf } = await login(port);
    const overrides = { en: { 'home.hero.title': 'New title' }, ru: { 'home.hero.title': 'Новый заголовок' }, ky: { 'home.hero.title': 'Жаңы аталыш' } };

    const noCsrf = await request(port, 'PUT', '/api/admin/content', { headers: sameOrigin(port, { cookie }), json: { overrides } });
    assert.equal(noCsrf.status, 403);
    const badCsrf = await request(port, 'PUT', '/api/admin/content', { headers: sameOrigin(port, { cookie, 'x-csrf-token': 'nope' }), json: { overrides } });
    assert.equal(badCsrf.status, 403);
    const foreign = await request(port, 'PUT', '/api/admin/content', { headers: { origin: 'https://evil.example', cookie, 'x-csrf-token': csrf }, json: { overrides } });
    assert.equal(foreign.status, 403);

    const ok = await request(port, 'PUT', '/api/admin/content', { headers: sameOrigin(port, { cookie, 'x-csrf-token': csrf }), json: { overrides } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.saved, true);

    const pub = await request(port, 'GET', '/api/content');
    assert.deepEqual(pub.body.overrides, overrides);
    const onDisk = JSON.parse(fs.readFileSync(app.config.contentFile, 'utf8'));
    assert.deepEqual(onDisk.overrides, overrides);
    assert.equal(onDisk.updatedBy, ADMIN.username);
  } finally {
    await close(app.server);
  }
});

test('content validation rejects unknown keys, languages, admin keys and non-text values', async () => {
  const { app, port } = await startApp();
  try {
    const { cookie, csrf } = await login(port);
    const headers = sameOrigin(port, { cookie, 'x-csrf-token': csrf });
    for (const bad of [
      { en: { 'nope.key': 'x' } },
      { de: { 'home.hero.title': 'x' } },
      { en: { 'admin.login.title': 'x' } },
      { en: { 'home.hero.title': 42 } },
      { en: { 'home.hero.title': 'x'.repeat(5001) } },
      ['not', 'an', 'object']
    ]) {
      const res = await request(port, 'PUT', '/api/admin/content', { headers, json: { overrides: bad } });
      assert.equal(res.status, 400, JSON.stringify(bad).slice(0, 60));
    }
  } finally {
    await close(app.server);
  }
});

test('restore original content deletes saved overrides', async () => {
  const { app, port } = await startApp();
  try {
    const { cookie, csrf } = await login(port);
    const headers = sameOrigin(port, { cookie, 'x-csrf-token': csrf });
    await request(port, 'PUT', '/api/admin/content', { headers, json: { en: { 'nav.home': 'Start' } } });
    assert.ok(fs.existsSync(app.config.contentFile));
    const res = await request(port, 'DELETE', '/api/admin/content', { headers });
    assert.equal(res.status, 200);
    assert.equal(res.body.restored, true);
    assert.equal(fs.existsSync(app.config.contentFile), false);
    const pub = await request(port, 'GET', '/api/content');
    assert.deepEqual(pub.body.overrides, { en: {}, ru: {}, ky: {} });
  } finally {
    await close(app.server);
  }
});

test('A13: sign out invalidates the session', async () => {
  const { app, port } = await startApp();
  try {
    const { cookie, csrf } = await login(port);
    const noCsrf = await request(port, 'POST', '/api/admin/logout', { headers: sameOrigin(port, { cookie }), json: {} });
    assert.equal(noCsrf.status, 403);
    const res = await request(port, 'POST', '/api/admin/logout', { headers: sameOrigin(port, { cookie, 'x-csrf-token': csrf }), json: {} });
    assert.equal(res.status, 200);
    assert.match(res.headers['set-cookie'][0], /Max-Age=0/);
    const after = await request(port, 'GET', '/api/admin/session', { headers: { cookie } });
    assert.equal(after.status, 401);
    const page = await request(port, 'GET', '/admin.html', { headers: { cookie } });
    assert.equal(page.status, 302);
  } finally {
    await close(app.server);
  }
});

test('FR-21: sessions expire after their lifetime', async () => {
  const { app, port } = await startApp({ sessionTtlMs: 50 });
  try {
    const { cookie } = await login(port);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const res = await request(port, 'GET', '/api/admin/session', { headers: { cookie } });
    assert.equal(res.status, 401);
  } finally {
    await close(app.server);
  }
});

test('A15: saved content survives a restart when the content file persists', async () => {
  const contentFile = tmpFile();
  const first = await startApp({ contentFile });
  const { cookie, csrf } = await login(first.port);
  await request(first.port, 'PUT', '/api/admin/content', {
    headers: sameOrigin(first.port, { cookie, 'x-csrf-token': csrf }),
    json: { overrides: { ky: { 'nav.tours': 'Саякаттар' } } }
  });
  await close(first.app.server);

  const second = await startApp({ contentFile });
  try {
    const res = await request(second.port, 'GET', '/api/content');
    assert.equal(res.body.overrides.ky['nav.tours'], 'Саякаттар');
    const stale = await request(second.port, 'GET', '/api/admin/session', { headers: { cookie } });
    assert.equal(stale.status, 401, 'in-memory sessions end on restart');
  } finally {
    await close(second.app.server);
  }
});

test('A17: no admin password or Telegram token appears in anything the server sends', async () => {
  const { app, port } = await startApp();
  try {
    const publicDir = path.join(__dirname, '..', 'public');
    const files = fs.readdirSync(publicDir).filter((f) => !f.startsWith('.') && fs.statSync(path.join(publicDir, f)).isFile());
    for (const file of files) {
      const res = await request(port, 'GET', `/${file}`);
      assert.doesNotMatch(res.text, /SECRET-TOKEN-VALUE/, file);
      assert.ok(!res.text.includes(ADMIN.password), file);
    }
    const health = await request(port, 'GET', '/healthz');
    assert.doesNotMatch(health.text, /SECRET|password/i);
  } finally {
    await close(app.server);
  }
});
