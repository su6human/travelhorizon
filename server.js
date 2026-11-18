'use strict';

/*
 * TravelHorizon — Node.js server (native http module, no dependencies).
 * Serves the public site and the JSON API, forwards enquiries to Telegram,
 * and protects the Site Editor with server-side sessions and CSRF tokens.
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA = require('./public/data.js');
const I18N = require('./public/i18n.js');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const LANGS = DATA.languages;
const TOUR_KEYS = Object.keys(DATA.tours);
const INTERESTS = DATA.interests;
const EDITABLE_KEYS = new Set(Object.keys(I18N.en).filter((key) => !key.startsWith('admin.')));
const IMAGE_WIDTHS = [500, 960, 1280, 1920];
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const LIMITS = {
  contactBody: 16 * 1024,
  loginBody: 4 * 1024,
  contentBody: 1024 * 1024,
  valueLength: 5000,
  name: 100,
  email: 254,
  message: 2000
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2'
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  return {
    port: Number.parseInt(env.PORT, 10) || 3000,
    host: env.HOST || '0.0.0.0',
    production,
    adminUsername: (env.ADMIN_USERNAME || '').trim(),
    adminPassword: env.ADMIN_PASSWORD || '',
    telegramToken: (env.TELEGRAM_BOT_TOKEN || '').trim(),
    telegramChatId: (env.TELEGRAM_CHAT_ID || '').trim(),
    telegramThreadId: (env.TELEGRAM_THREAD_ID || '').trim(),
    telegramApiBase: (env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, ''),
    telegramLang: env.TELEGRAM_MESSAGE_LANG === 'en' ? 'en' : 'ru',
    telegramTimeoutMs: Number.parseInt(env.TELEGRAM_TIMEOUT_MS, 10) || 10000,
    contentFile: env.CONTENT_FILE ? path.resolve(env.CONTENT_FILE) : path.join(ROOT, 'data', 'content.json'),
    trustProxy: env.TRUST_PROXY ? env.TRUST_PROXY !== 'false' : true,
    sessionTtlMs: SESSION_TTL_MS,
    loginMaxFailures: Number.parseInt(env.LOGIN_MAX_FAILURES, 10) || 5,
    loginWindowMs: 15 * 60 * 1000,
    contactMax: Number.parseInt(env.CONTACT_RATE_LIMIT, 10) || 5,
    contactWindowMs: 10 * 60 * 1000
  };
}

function adminConfigured(config) {
  return config.adminUsername.length > 0 && config.adminPassword.length >= 12;
}

function telegramConfigured(config) {
  return config.telegramToken.length > 0 && config.telegramChatId.length > 0;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, code, extra) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

function clientIp(req, config) {
  if (config.trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0].trim();
    }
  }
  return req.socket.remoteAddress || 'unknown';
}

function isSameOrigin(req) {
  const host = req.headers.host;
  if (!host) return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin';
  const referer = req.headers.referer;
  if (referer) {
    try {
      return new URL(referer).host === host;
    } catch {
      return false;
    }
  }
  return false;
}

function stripControl(text) {
  // Remove control characters except tab and newline.
  return text.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
}

// Direct Wikimedia Commons thumbnail address (one request, no redirect through commons.wikimedia.org).
function commonsThumbUrl(file, width) {
  const name = String(file).replace(/ /g, '_').normalize('NFC');
  const hash = crypto.createHash('md5').update(name, 'utf8').digest('hex');
  const encoded = encodeURIComponent(name);
  return `https://upload.wikimedia.org/wikipedia/commons/thumb/${hash[0]}/${hash.slice(0, 2)}/${encoded}/${width}px-${encoded}`;
}

function commonsFilePathUrl(file, width) {
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(String(file).replace(/ /g, '_'))}?width=${width}`;
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Rate limiting (in memory, per client IP)
// ---------------------------------------------------------------------------

function createRateLimiter({ windowMs, max }) {
  const entries = new Map();

  function current(key, now) {
    let entry = entries.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      entries.set(key, entry);
    }
    return entry;
  }

  return {
    // Count one request and report whether it is allowed.
    consume(key) {
      const now = Date.now();
      const entry = current(key, now);
      entry.count += 1;
      return { allowed: entry.count <= max, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
    },
    // Check without counting.
    blocked(key) {
      const now = Date.now();
      const entry = current(key, now);
      return { blocked: entry.count >= max, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
    },
    reset(key) {
      entries.delete(key);
    },
    sweep() {
      const now = Date.now();
      for (const [key, entry] of entries) {
        if (entry.resetAt <= now) entries.delete(key);
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Content storage (JSON file with atomic writes)
// ---------------------------------------------------------------------------

function emptyOverrides() {
  return { en: {}, ru: {}, ky: {} };
}

function createContentStore(file, logger) {
  let state = { overrides: emptyOverrides(), updatedAt: null };

  function load() {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      const validated = validateOverrides(parsed && parsed.overrides !== undefined ? parsed.overrides : parsed, { dropUnknown: true });
      state = { overrides: validated.overrides, updatedAt: parsed.updatedAt || null };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error(`[content] Could not read ${file}: ${error.message}. Starting with built-in text.`);
      }
      state = { overrides: emptyOverrides(), updatedAt: null };
    }
  }

  async function save(overrides, username) {
    const record = {
      version: 1,
      updatedAt: new Date().toISOString(),
      updatedBy: username,
      overrides
    };
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomToken(6)}.tmp`;
    await fsp.writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await fsp.rename(tmp, file);
    state = { overrides, updatedAt: record.updatedAt };
    return state;
  }

  async function clear() {
    await fsp.rm(file, { force: true });
    state = { overrides: emptyOverrides(), updatedAt: null };
    return state;
  }

  load();
  return {
    get: () => state,
    save,
    clear,
    reload: load
  };
}

function validateOverrides(input, options = {}) {
  const errors = [];
  const overrides = emptyOverrides();
  if (!isPlainObject(input)) {
    return { overrides, errors: ['Content must be a JSON object with en, ru and ky sections.'] };
  }
  for (const [lang, entries] of Object.entries(input)) {
    if (!LANGS.includes(lang)) {
      if (!options.dropUnknown) errors.push(`Unknown language "${lang}".`);
      continue;
    }
    if (!isPlainObject(entries)) {
      errors.push(`Section "${lang}" must be an object.`);
      continue;
    }
    for (const [key, value] of Object.entries(entries)) {
      if (!EDITABLE_KEYS.has(key)) {
        if (!options.dropUnknown) errors.push(`Unknown text key "${key}".`);
        continue;
      }
      if (typeof value !== 'string') {
        errors.push(`Value of "${lang}.${key}" must be text.`);
        continue;
      }
      if (value.length > LIMITS.valueLength) {
        errors.push(`Value of "${lang}.${key}" is longer than ${LIMITS.valueLength} characters.`);
        continue;
      }
      overrides[lang][key] = stripControl(value);
    }
  }
  return { overrides, errors: errors.slice(0, 20) };
}

// ---------------------------------------------------------------------------
// Enquiry validation and Telegram delivery
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[^\s@<>()[\]\\,;:"_]+\.[^\s@<>()[\]\\,;:"_]{2,}$/;

function parseTravelers(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d{1,3}$/.test(value.trim())) return Number(value.trim());
  return NaN;
}

function validateEnquiry(body) {
  const fields = {};
  if (!isPlainObject(body)) {
    return { fields: { form: 'invalid' } };
  }

  const name = typeof body.name === 'string' ? stripControl(body.name).trim() : '';
  if (!name || name.length > LIMITS.name) fields.name = 'invalid';

  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (!email || email.length > LIMITS.email || !EMAIL_RE.test(email)) fields.email = 'invalid';

  const tour = body.tour === undefined || body.tour === null ? '' : body.tour;
  if (typeof tour !== 'string' || (tour !== '' && !TOUR_KEYS.includes(tour))) fields.tour = 'invalid';

  const travelers = parseTravelers(body.travelers);
  if (!Number.isInteger(travelers) || travelers < DATA.travelers.min || travelers > DATA.travelers.max) {
    fields.travelers = 'invalid';
  }

  const interest = body.interest;
  if (typeof interest !== 'string' || !INTERESTS.includes(interest)) fields.interest = 'invalid';

  const rawMessage = body.message === undefined || body.message === null ? '' : body.message;
  let message = '';
  if (typeof rawMessage !== 'string') {
    fields.message = 'invalid';
  } else {
    message = stripControl(rawMessage).trim();
    if (message.length > LIMITS.message) fields.message = 'invalid';
  }

  let language = body.language === undefined || body.language === null || body.language === '' ? 'en' : body.language;
  if (typeof language !== 'string' || !LANGS.includes(language)) {
    fields.language = 'invalid';
    language = 'en';
  }

  // Honeypot: real visitors never fill this hidden field.
  const honeypot = typeof body.website === 'string' && body.website.trim() !== '';

  if (Object.keys(fields).length > 0) return { fields };

  const price = tour ? DATA.tours[tour].price : null;
  return {
    enquiry: {
      name,
      email,
      tour,
      travelers,
      interest,
      message,
      language,
      pricePerPerson: price,
      estimatedTotal: price === null ? null : price * travelers
    },
    honeypot
  };
}

const TG_LABELS = {
  ru: {
    heading: 'Новая заявка с сайта TravelHorizon',
    name: 'Имя',
    email: 'Email',
    tour: 'Тур',
    notSelected: 'Не выбран',
    travelers: 'Путешественников',
    interest: 'Интерес',
    language: 'Язык сайта',
    estimate: 'Оценка',
    message: 'Сообщение',
    noMessage: '—'
  },
  en: {
    heading: 'New enquiry from the TravelHorizon website',
    name: 'Name',
    email: 'Email',
    tour: 'Tour',
    notSelected: 'Not selected',
    travelers: 'Travelers',
    interest: 'Interest',
    language: 'Site language',
    estimate: 'Estimated total',
    message: 'Message',
    noMessage: '—'
  }
};

function formatUsd(amount) {
  return `USD ${amount.toLocaleString('en-US')}`;
}

function buildTelegramMessage(enquiry, lang = 'ru') {
  const labels = TG_LABELS[lang] || TG_LABELS.ru;
  const dict = I18N[lang] || I18N.en;
  const tourText = enquiry.tour
    ? `${dict[`tour.${enquiry.tour}.name`] || enquiry.tour} (${enquiry.tour})`
    : labels.notSelected;
  const interestText = dict[`interest.${enquiry.interest}`] || enquiry.interest;
  const lines = [
    `<b>${escapeHtml(labels.heading)}</b>`,
    '',
    `<b>${labels.name}:</b> ${escapeHtml(enquiry.name)}`,
    `<b>${labels.email}:</b> ${escapeHtml(enquiry.email)}`,
    `<b>${labels.tour}:</b> ${escapeHtml(tourText)}`,
    `<b>${labels.travelers}:</b> ${enquiry.travelers}`,
    `<b>${labels.interest}:</b> ${escapeHtml(interestText)}`,
    `<b>${labels.language}:</b> ${enquiry.language.toUpperCase()}`
  ];
  if (enquiry.estimatedTotal !== null) {
    lines.push(`<b>${labels.estimate}:</b> ${formatUsd(enquiry.pricePerPerson)} × ${enquiry.travelers} = ${formatUsd(enquiry.estimatedTotal)}`);
  }
  lines.push('', `<b>${labels.message}:</b>`, escapeHtml(enquiry.message || labels.noMessage));
  return lines.join('\n').slice(0, 4000);
}

async function sendTelegram(config, text) {
  if (!telegramConfigured(config)) {
    throw new HttpError(503, 'delivery_unavailable');
  }
  const payload = {
    chat_id: config.telegramChatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (config.telegramThreadId) payload.message_thread_id = Number(config.telegramThreadId);

  let response;
  try {
    response = await fetch(`${config.telegramApiBase}/bot${config.telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.telegramTimeoutMs)
    });
  } catch (error) {
    throw new HttpError(502, 'delivery_failed', { reason: error.name === 'TimeoutError' ? 'timeout' : 'network' });
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok || !data || data.ok !== true) {
    const description = data && typeof data.description === 'string' ? data.description : `HTTP ${response.status}`;
    throw new HttpError(502, 'delivery_failed', { reason: description });
  }
  return data;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function securityHeaders(config) {
  const headers = {
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: https://commons.wikimedia.org https://upload.wikimedia.org",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'"
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin'
  };
  if (config.production) {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  return headers;
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(payload);
}

function sendError(res, error) {
  const status = error.status || 500;
  const body = { error: error.code || 'server_error', ...error.extra };
  const headers = {};
  if (status === 429 && error.extra && error.extra.retryAfter) {
    headers['Retry-After'] = String(error.extra.retryAfter);
  }
  sendJson(res, status, body, headers);
}

function redirect(res, location, status = 302, extraHeaders = {}) {
  res.writeHead(status, { Location: location, 'Cache-Control': 'no-store', ...extraHeaders });
  res.end();
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(new HttpError(413, 'payload_too_large'));
      return;
    }
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new HttpError(413, 'payload_too_large'));
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (!type.startsWith('application/json')) {
    req.resume();
    throw new HttpError(415, 'unsupported_media_type');
  }
  const raw = await readBody(req, limit);
  if (!raw) throw new HttpError(400, 'invalid_json');
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

function createApp(overrides = {}) {
  const config = { ...loadConfig(), ...overrides };
  const logger = overrides.logger || console;
  const content = createContentStore(config.contentFile, logger);
  const sessions = new Map();
  const loginLimiter = createRateLimiter({ windowMs: config.loginWindowMs, max: config.loginMaxFailures });
  const contactLimiter = createRateLimiter({ windowMs: config.contactWindowMs, max: config.contactMax });
  const cookieName = config.production ? '__Host-th_admin' : 'th_admin';
  const baseHeaders = securityHeaders(config);

  function sessionCookie(token, maxAgeSeconds) {
    const parts = [`${cookieName}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`];
    if (config.production) parts.push('Secure');
    return parts.join('; ');
  }

  function getSession(req) {
    const token = parseCookies(req.headers.cookie)[cookieName];
    if (!token) return null;
    const session = sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      sessions.delete(token);
      return null;
    }
    return { token, ...session };
  }

  function requireAdmin(req, { csrf = false, origin = false } = {}) {
    if (origin && !isSameOrigin(req)) throw new HttpError(403, 'forbidden_origin');
    const session = getSession(req);
    if (!session) throw new HttpError(401, 'unauthorized');
    if (csrf) {
      const token = req.headers['x-csrf-token'];
      if (typeof token !== 'string' || !safeEqual(token, session.csrf)) {
        throw new HttpError(403, 'invalid_csrf');
      }
    }
    return session;
  }

  // --- API handlers -------------------------------------------------------

  async function handleContact(req, res) {
    if (!isSameOrigin(req)) throw new HttpError(403, 'forbidden_origin');
    const ip = clientIp(req, config);
    const limit = contactLimiter.consume(ip);
    if (!limit.allowed) throw new HttpError(429, 'rate_limited', { retryAfter: limit.retryAfter });

    const body = await readJson(req, LIMITS.contactBody);
    const result = validateEnquiry(body);
    if (result.fields) throw new HttpError(400, 'validation', { fields: result.fields });
    if (result.honeypot) {
      sendJson(res, 200, { sent: true });
      return;
    }
    const message = buildTelegramMessage(result.enquiry, config.telegramLang);
    try {
      await sendTelegram(config, message);
    } catch (error) {
      if (error instanceof HttpError) {
        logger.error(`[contact] Telegram delivery failed: ${error.code}${error.extra.reason ? ` (${error.extra.reason})` : ''}`);
        throw new HttpError(error.status, error.code);
      }
      throw error;
    }
    sendJson(res, 200, { sent: true, estimatedTotal: result.enquiry.estimatedTotal });
  }

  async function handleLogin(req, res) {
    if (!isSameOrigin(req)) throw new HttpError(403, 'forbidden_origin');
    if (!adminConfigured(config)) throw new HttpError(503, 'admin_not_configured');
    const ip = clientIp(req, config);
    const state = loginLimiter.blocked(ip);
    if (state.blocked) throw new HttpError(429, 'rate_limited', { retryAfter: state.retryAfter });

    const body = await readJson(req, LIMITS.loginBody);
    const username = isPlainObject(body) && typeof body.username === 'string' ? body.username.trim() : '';
    const password = isPlainObject(body) && typeof body.password === 'string' ? body.password : '';
    const userOk = safeEqual(username, config.adminUsername);
    const passOk = safeEqual(password, config.adminPassword);
    if (!userOk || !passOk) {
      const after = loginLimiter.consume(ip);
      logger.warn(`[admin] Failed sign-in from ${ip}`);
      if (!after.allowed) throw new HttpError(429, 'rate_limited', { retryAfter: after.retryAfter });
      throw new HttpError(401, 'invalid_credentials');
    }
    loginLimiter.reset(ip);

    const previous = getSession(req);
    if (previous) sessions.delete(previous.token);
    const token = randomToken(32);
    const session = {
      username: config.adminUsername,
      csrf: randomToken(32),
      createdAt: Date.now(),
      expiresAt: Date.now() + config.sessionTtlMs
    };
    sessions.set(token, session);
    sendJson(res, 200, {
      authenticated: true,
      username: session.username,
      csrfToken: session.csrf,
      expiresAt: new Date(session.expiresAt).toISOString()
    }, { 'Set-Cookie': sessionCookie(token, Math.floor(config.sessionTtlMs / 1000)) });
  }

  function handleSession(req, res) {
    const session = getSession(req);
    if (!session) {
      sendJson(res, 401, { authenticated: false });
      return;
    }
    sendJson(res, 200, {
      authenticated: true,
      username: session.username,
      csrfToken: session.csrf,
      expiresAt: new Date(session.expiresAt).toISOString()
    });
  }

  async function handleSaveContent(req, res) {
    const session = requireAdmin(req, { csrf: true, origin: true });
    const body = await readJson(req, LIMITS.contentBody);
    const input = isPlainObject(body) && body.overrides !== undefined ? body.overrides : body;
    const { overrides, errors } = validateOverrides(input);
    if (errors.length > 0) throw new HttpError(400, 'validation', { details: errors });
    const saved = await content.save(overrides, session.username);
    logger.info(`[admin] Content saved by ${session.username}`);
    sendJson(res, 200, { saved: true, updatedAt: saved.updatedAt, overrides: saved.overrides });
  }

  async function handleRestoreContent(req, res) {
    const session = requireAdmin(req, { csrf: true, origin: true });
    await content.clear();
    logger.info(`[admin] Original content restored by ${session.username}`);
    sendJson(res, 200, { restored: true, overrides: emptyOverrides() });
  }

  function handleLogout(req, res) {
    const session = requireAdmin(req, { csrf: true, origin: true });
    sessions.delete(session.token);
    sendJson(res, 200, { signedOut: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }

  function handleContent(req, res) {
    const state = content.get();
    sendJson(res, 200, { overrides: state.overrides, updatedAt: state.updatedAt }, { 'Cache-Control': 'no-cache' });
  }

  // --- Static files -------------------------------------------------------

  async function serveFile(req, res, filePath, { cache, status = 200 } = {}) {
    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      return false;
    }
    if (!stat.isFile()) return false;
    const ext = path.extname(filePath).toLowerCase();
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cache || (ext === '.html' ? 'no-cache' : 'public, max-age=86400'),
      ETag: etag,
      'Last-Modified': stat.mtime.toUTCString()
    };
    if (status === 200 && req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    headers['Content-Length'] = stat.size;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filePath);
      stream.on('error', reject);
      stream.on('end', resolve);
      stream.pipe(res);
    });
    return true;
  }

  function resolvePublicPath(pathname) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (decoded.includes('\0')) return null;
    let relative = decoded.replace(/^\/+/, '');
    if (relative === '' || relative.endsWith('/')) relative += 'index.html';
    const resolved = path.resolve(PUBLIC_DIR, relative);
    if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) return null;
    // Never serve dotfiles.
    if (resolved.split(path.sep).some((segment) => segment.startsWith('.'))) return null;
    return resolved;
  }

  async function serveImage(req, res, key, url) {
    const image = DATA.images[key];
    if (!image) return false;
    for (const ext of ['.webp', '.jpg', '.jpeg', '.png', '.avif']) {
      const local = path.join(PUBLIC_DIR, 'images', `${key}${ext}`);
      if (await serveFile(req, res, local, { cache: 'public, max-age=604800' })) return true;
    }
    const requested = Number.parseInt(url.searchParams.get('w'), 10);
    const width = IMAGE_WIDTHS.find((w) => w >= requested) || 1280;
    redirect(res, commonsThumbUrl(image.file, width), 302, { 'Cache-Control': 'public, max-age=86400' });
    return true;
  }

  async function serveNotFound(req, res) {
    const served = await serveFile(req, res, path.join(PUBLIC_DIR, '404.html'), { status: 404, cache: 'no-cache' });
    if (!served) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
  }

  async function handleStatic(req, res, url) {
    const pathname = url.pathname;

    // Site Editor routes are protected on the server.
    if (pathname === '/admin' || pathname === '/admin/' || pathname === '/admin.html') {
      if (!getSession(req)) {
        redirect(res, '/admin-login.html');
        return;
      }
      if (pathname !== '/admin.html') {
        redirect(res, '/admin.html');
        return;
      }
      await serveFile(req, res, path.join(PUBLIC_DIR, 'admin.html'), { cache: 'no-store' });
      return;
    }
    if (pathname === '/admin-login.html' || pathname === '/admin-login') {
      if (getSession(req)) {
        redirect(res, '/admin.html');
        return;
      }
      await serveFile(req, res, path.join(PUBLIC_DIR, 'admin-login.html'), { cache: 'no-store' });
      return;
    }

    const imageMatch = /^\/img\/([a-z0-9-]+)$/.exec(pathname);
    if (imageMatch) {
      if (await serveImage(req, res, imageMatch[1], url)) return;
      await serveNotFound(req, res);
      return;
    }

    const filePath = resolvePublicPath(pathname);
    if (!filePath) {
      await serveNotFound(req, res);
      return;
    }
    if (await serveFile(req, res, filePath)) return;
    // Allow clean URLs such as /tours -> tours.html
    if (!path.extname(filePath) && await serveFile(req, res, `${filePath}.html`)) return;
    await serveNotFound(req, res);
  }

  // --- Router -------------------------------------------------------------

  const routes = {
    'GET /api/content': handleContent,
    'POST /api/contact': handleContact,
    'POST /api/admin/login': handleLogin,
    'GET /api/admin/session': handleSession,
    'PUT /api/admin/content': handleSaveContent,
    'DELETE /api/admin/content': handleRestoreContent,
    'POST /api/admin/logout': handleLogout,
    'GET /healthz': (req, res) => sendJson(res, 200, { ok: true, telegram: telegramConfigured(config), admin: adminConfigured(config) })
  };

  async function handler(req, res) {
    for (const [name, value] of Object.entries(baseHeaders)) res.setHeader(name, value);
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      sendError(res, new HttpError(400, 'bad_request'));
      return;
    }

    try {
      const route = routes[`${req.method} ${url.pathname}`];
      if (route) {
        await route(req, res);
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        const known = Object.keys(routes).some((key) => key.endsWith(` ${url.pathname}`));
        throw new HttpError(known ? 405 : 404, known ? 'method_not_allowed' : 'not_found');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        throw new HttpError(405, 'method_not_allowed');
      }
      await handleStatic(req, res, url);
    } catch (error) {
      if (!(error instanceof HttpError)) {
        logger.error('[server] Unexpected error:', error);
        error = new HttpError(500, 'server_error');
      }
      if (res.headersSent) {
        res.end();
        return;
      }
      sendError(res, error);
    }
  }

  const server = http.createServer(handler);
  server.headersTimeout = 20000;
  server.requestTimeout = 30000;

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now) sessions.delete(token);
    }
    loginLimiter.sweep();
    contactLimiter.sweep();
  }, 60 * 1000);
  sweeper.unref();
  server.on('close', () => clearInterval(sweeper));

  return { server, handler, config, content, sessions };
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

if (require.main === module) {
  const app = createApp();
  const { config } = app;
  if (!adminConfigured(config)) {
    console.warn('[config] ADMIN_USERNAME and ADMIN_PASSWORD (12+ characters) are not set. The Site Editor sign-in is disabled.');
  }
  if (!telegramConfigured(config)) {
    console.warn('[config] TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are not set. The contact form will report a delivery error.');
  }
  app.server.listen(config.port, config.host, () => {
    console.log(`TravelHorizon is running on http://${config.host}:${config.port} (${config.production ? 'production' : 'development'})`);
    console.log(`Content file: ${config.contentFile}`);
  });
  const shutdown = () => {
    app.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = {
  createApp,
  loadConfig,
  validateEnquiry,
  validateOverrides,
  buildTelegramMessage,
  isSameOrigin,
  commonsThumbUrl,
  commonsFilePathUrl
};
