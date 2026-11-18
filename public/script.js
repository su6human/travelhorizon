/*
 * TravelHorizon — browser logic.
 * Translations and language memory, navigation, tour filters, live price
 * estimate, enquiry submission, admin sign-in and the Site Editor.
 */
(function () {
  'use strict';

  var I18N = window.TH_I18N || { en: {}, ru: {}, ky: {} };
  var DATA = window.TH_DATA || { tours: {}, languages: ['en', 'ru', 'ky'], interests: [], travelers: { min: 1, max: 20 } };
  var LANGS = DATA.languages || ['en', 'ru', 'ky'];
  var STORAGE_KEY = 'th_lang';
  var LOCALES = { en: 'en-US', ru: 'ru-RU', ky: 'ky-KG' };
  var MIN_TRAVELERS = (DATA.travelers && DATA.travelers.min) || 1;
  var MAX_TRAVELERS = (DATA.travelers && DATA.travelers.max) || 20;
  var root = document.documentElement;
  var OPTIONAL = {};
  (DATA.optionalKeys || []).forEach(function (key) { OPTIONAL[key] = true; });

  var state = {
    lang: LANGS.indexOf(root.getAttribute('data-lang')) !== -1 ? root.getAttribute('data-lang') : 'en',
    overrides: emptyOverrides(),
    tourCount: null,
    hooks: []
  };

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------

  function emptyOverrides() { return { en: {}, ru: {}, ky: {} }; }
  function hasOwn(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }
  function $(selector, scope) { return (scope || document).querySelector(selector); }
  function all(selector, scope) { return Array.prototype.slice.call((scope || document).querySelectorAll(selector)); }
  function storageSet(key, value) { try { window.localStorage.setItem(key, value); } catch (e) { /* storage unavailable */ } }
  function isPlainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

  function normalizeOverrides(input) {
    var out = emptyOverrides();
    if (!isPlainObject(input)) return out;
    LANGS.forEach(function (lang) {
      if (!isPlainObject(input[lang])) return;
      Object.keys(input[lang]).forEach(function (key) {
        if (typeof input[lang][key] === 'string') out[lang][key] = input[lang][key];
      });
    });
    return out;
  }

  function humanize(key) {
    var parts = String(key).split('.');
    var text = parts.slice(1).join(' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : key;
  }

  function lookup(lang, key) {
    var o = state.overrides[lang];
    if (o && hasOwn(o, key) && typeof o[key] === 'string' && o[key] !== '') return o[key];
    var d = I18N[lang];
    if (d && hasOwn(d, key) && d[key] !== '') return d[key];
    return undefined;
  }

  function interpolate(text, vars) {
    return String(text).replace(/\{(\w+)\}/g, function (match, name) {
      return vars && hasOwn(vars, name) && vars[name] !== undefined ? String(vars[name]) : match;
    });
  }

  // Translate a key: override in current language → built-in text → English → readable key.
  function t(key, vars) {
    var value = lookup(state.lang, key);
    if (value === undefined && state.lang !== 'en') value = lookup('en', key);
    if (value === undefined) value = OPTIONAL[key] ? '' : humanize(key);
    var merged = { year: new Date().getFullYear() };
    if (vars) Object.keys(vars).forEach(function (k) { merged[k] = vars[k]; });
    return interpolate(value, merged);
  }

  function locale() {
    var tag = LOCALES[state.lang] || 'en-US';
    try {
      if (state.lang === 'ky' && Intl.NumberFormat.supportedLocalesOf([tag]).length === 0) return 'ru-RU';
    } catch (e) { /* Intl unavailable */ }
    return tag;
  }

  function formatNumber(n) {
    try { return new Intl.NumberFormat(locale()).format(n); } catch (e) { return String(n); }
  }

  function money(amount) {
    var options = { style: 'currency', currency: DATA.currency || 'USD', maximumFractionDigits: 0, minimumFractionDigits: 0 };
    try {
      return new Intl.NumberFormat(locale(), Object.assign({ currencyDisplay: 'narrowSymbol' }, options)).format(amount);
    } catch (e) {
      try { return new Intl.NumberFormat(locale(), options).format(amount); } catch (e2) { return '$' + amount; }
    }
  }

  function plural(base, n) {
    var rule = 'other';
    try { rule = new Intl.PluralRules(locale()).select(n); } catch (e) { rule = n === 1 ? 'one' : 'other'; }
    var key = base + '.' + rule;
    var exists = lookup(state.lang, key) !== undefined || (state.lang === 'en' && lookup('en', key) !== undefined);
    return t(exists ? key : base + '.other', { n: formatNumber(n) });
  }

  function monthName(month) {
    try {
      return new Intl.DateTimeFormat(locale(), { month: state.lang === 'en' ? 'short' : 'long' }).format(new Date(2026, month - 1, 15));
    } catch (e) {
      return String(month);
    }
  }

  function setChildren(el, nodes) {
    while (el.firstChild) el.removeChild(el.firstChild);
    nodes.forEach(function (node) { el.appendChild(node); });
  }

  function span(className, text) {
    var s = document.createElement('span');
    if (className) s.className = className;
    s.textContent = text;
    return s;
  }

  // -------------------------------------------------------------------------
  // Translations
  // -------------------------------------------------------------------------

  function parseVars(el) {
    var raw = el.getAttribute('data-i18n-vars');
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  function renderOptional(el, value) {
    var row = el.closest('[data-optional-row]');
    if (row) row.hidden = value === '';
    var type = el.getAttribute('data-contact-type');
    var href = null;
    if (value && type === 'email' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) href = 'mailto:' + value;
    if (value && type === 'phone') href = 'tel:' + value.replace(/[^\d+]/g, '');
    if (value && type === 'telegram' && /^@?[A-Za-z0-9_]{4,32}$/.test(value)) href = 'https://t.me/' + value.replace(/^@/, '');
    if (href) {
      var a = document.createElement('a');
      a.href = href;
      a.textContent = value;
      if (type === 'telegram') { a.target = '_blank'; a.rel = 'noopener'; }
      setChildren(el, [a]);
    } else {
      el.textContent = value;
    }
  }

  function renderPriceTemplate(el) {
    var key = el.getAttribute('data-i18n-template');
    var tourKey = el.getAttribute('data-price-tour');
    var tour = DATA.tours[tourKey];
    if (!tour) return;
    var parts = t(key).split('{price}');
    var nodes = [span('price__text', parts[0] || ''), span('price__value', money(tour.price))];
    if (parts.length > 1) nodes.push(span('price__text', parts.slice(1).join('')));
    setChildren(el, nodes);
  }

  function applyTranslations() {
    root.lang = state.lang;
    root.setAttribute('data-lang', state.lang);

    var titleKey = root.getAttribute('data-title-key');
    if (titleKey) document.title = t(titleKey);
    var descKey = root.getAttribute('data-description-key');
    var meta = $('meta[name="description"]');
    if (descKey && meta) meta.setAttribute('content', t(descKey));

    all('[data-i18n]').forEach(function (el) {
      var value = t(el.getAttribute('data-i18n'), parseVars(el));
      if (el.hasAttribute('data-i18n-optional')) {
        renderOptional(el, value);
      } else if (el.textContent !== value) {
        el.textContent = value;
      }
    });

    all('[data-i18n-attr]').forEach(function (el) {
      el.getAttribute('data-i18n-attr').split(';').forEach(function (pair) {
        var index = pair.indexOf(':');
        if (index < 1) return;
        el.setAttribute(pair.slice(0, index).trim(), t(pair.slice(index + 1).trim()));
      });
    });

    all('[data-i18n-template]').forEach(renderPriceTemplate);

    all('[data-tour-days]').forEach(function (el) {
      var tour = DATA.tours[el.getAttribute('data-tour-days')];
      if (tour) el.textContent = plural('units.days', tour.days);
    });

    all('[data-tour-season]').forEach(function (el) {
      var tour = DATA.tours[el.getAttribute('data-tour-season')];
      if (tour && tour.season) el.textContent = monthName(tour.season[0]) + ' – ' + monthName(tour.season[1]);
    });

    all('[data-set-lang]').forEach(function (button) {
      button.setAttribute('aria-pressed', String(button.getAttribute('data-set-lang') === state.lang));
    });

    state.hooks.forEach(function (hook) { hook(); });
    root.classList.remove('i18n-pending');
  }

  function setLang(lang) {
    if (LANGS.indexOf(lang) === -1) return;
    state.lang = lang;
    storageSet(STORAGE_KEY, lang);
    applyTranslations();
  }

  function loadOverrides() {
    if (!window.fetch) return Promise.resolve();
    return fetch('/api/content', { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (data && data.overrides) {
          state.overrides = normalizeOverrides(data.overrides);
          applyTranslations();
        }
      })
      .catch(function () { /* built-in text stays in place */ });
  }

  // -------------------------------------------------------------------------
  // Header and navigation
  // -------------------------------------------------------------------------

  function initHeader() {
    var header = $('[data-header]');
    var toggle = $('[data-nav-toggle]');
    var nav = $('[data-nav]');

    if (header) {
      var onScroll = function () { header.classList.toggle('is-scrolled', window.scrollY > 16); };
      onScroll();
      window.addEventListener('scroll', onScroll, { passive: true });
    }

    document.addEventListener('click', function (event) {
      var button = event.target.closest('[data-set-lang]');
      if (button) setLang(button.getAttribute('data-set-lang'));
    });

    if (!toggle || !nav || !header) return;
    var label = $('.nav-toggle__label', toggle);

    function setOpen(open) {
      toggle.setAttribute('aria-expanded', String(open));
      nav.classList.toggle('is-open', open);
      header.classList.toggle('menu-open', open);
      root.classList.toggle('nav-open', open);
      if (label) {
        label.setAttribute('data-i18n', open ? 'nav.close' : 'nav.menu');
        label.textContent = t(open ? 'nav.close' : 'nav.menu');
      }
    }

    toggle.addEventListener('click', function () {
      setOpen(toggle.getAttribute('aria-expanded') !== 'true');
    });
    nav.addEventListener('click', function (event) {
      if (event.target.closest('a')) setOpen(false);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
        setOpen(false);
        toggle.focus();
      }
    });
    var wide = window.matchMedia('(min-width: 1101px)');
    var onWide = function () { if (wide.matches) setOpen(false); };
    if (wide.addEventListener) wide.addEventListener('change', onWide); else if (wide.addListener) wide.addListener(onWide);
  }

  function initReveal() {
    var items = all('[data-reveal]');
    if (!items.length || !('IntersectionObserver' in window)) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    root.classList.add('reveal-ready');
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
    items.forEach(function (item) { observer.observe(item); });
  }

  // -------------------------------------------------------------------------
  // Tours: filters and result count
  // -------------------------------------------------------------------------

  function initTours() {
    var list = $('[data-tour-list]');
    if (!list) return;
    var cards = all('[data-tour]', list);
    var buttons = all('[data-filter]');
    var empty = $('[data-tour-empty]');
    var countEl = $('[data-tour-count]');

    function apply(filter, fromUser) {
      var shown = 0;
      cards.forEach(function (card) {
        var categories = (card.getAttribute('data-categories') || '').split(/\s+/);
        var visible = filter === 'all' || categories.indexOf(filter) !== -1;
        card.hidden = !visible;
        card.classList.remove('tour--flip', 'is-first');
        if (visible) {
          if (shown === 0) card.classList.add('is-first');
          if (shown % 2 === 1) card.classList.add('tour--flip');
          shown += 1;
        }
      });
      buttons.forEach(function (button) {
        button.setAttribute('aria-pressed', String(button.getAttribute('data-filter') === filter));
      });
      if (empty) empty.hidden = shown !== 0;
      state.tourCount = shown;
      updateCount();
      if (fromUser && window.history && window.history.replaceState) {
        var url = new URL(window.location.href);
        if (filter === 'all') url.searchParams.delete('filter'); else url.searchParams.set('filter', filter);
        window.history.replaceState(null, '', url.pathname + url.search + url.hash);
      }
    }

    function updateCount() {
      if (countEl && typeof state.tourCount === 'number') countEl.textContent = plural('tours.count', state.tourCount);
    }

    buttons.forEach(function (button) {
      button.addEventListener('click', function () { apply(button.getAttribute('data-filter'), true); });
    });
    all('[data-filter-reset]').forEach(function (button) {
      button.addEventListener('click', function () { apply('all', true); });
    });

    state.hooks.push(updateCount);
    var initial = new URLSearchParams(window.location.search).get('filter');
    apply(DATA.filters && DATA.filters.indexOf(initial) !== -1 ? initial : 'all', false);
  }

  // -------------------------------------------------------------------------
  // Contact form and live estimate
  // -------------------------------------------------------------------------

  function setStatus(el, type, key, vars) {
    if (!el) return;
    el.hidden = false;
    el.className = 'form-status form-status--' + type;
    el.setAttribute('data-i18n', key);
    if (vars) el.setAttribute('data-i18n-vars', JSON.stringify(vars)); else el.removeAttribute('data-i18n-vars');
    el.textContent = t(key, vars);
  }

  function clearStatus(el) {
    if (!el) return;
    el.hidden = true;
    el.removeAttribute('data-i18n');
    el.textContent = '';
  }

  function initContact() {
    var form = document.getElementById('enquiry-form');
    if (!form) return;
    var fields = {
      name: form.elements.name,
      email: form.elements.email,
      tour: form.elements.tour,
      travelers: form.elements.travelers,
      interest: form.elements.interest,
      message: form.elements.message,
      website: form.elements.website
    };
    var status = document.getElementById('form-status');
    var submit = $('[data-submit]', form);
    var counter = $('[data-message-count]', form);
    var sending = false;

    // Preselect tour and interest from the link that opened the page.
    var params = new URLSearchParams(window.location.search);
    var tourParam = params.get('tour');
    var interestParam = params.get('interest');
    if (tourParam && hasOwn(DATA.tours, tourParam)) fields.tour.value = tourParam;
    if (interestParam && DATA.interests.indexOf(interestParam) !== -1) {
      fields.interest.value = interestParam;
    } else {
      fields.interest.value = 'general';
    }

    function readTravelers() {
      var raw = String(fields.travelers.value).trim();
      if (!/^\d{1,2}$/.test(raw)) return null;
      var n = parseInt(raw, 10);
      return n >= MIN_TRAVELERS && n <= MAX_TRAVELERS ? n : null;
    }

    function clampTravelers() {
      var n = Math.round(Number(fields.travelers.value));
      if (!isFinite(n) || n < MIN_TRAVELERS) n = MIN_TRAVELERS;
      if (n > MAX_TRAVELERS) n = MAX_TRAVELERS;
      fields.travelers.value = String(n);
      return n;
    }

    var lastTotal = null;
    function updateEstimate() {
      var tourKey = fields.tour.value;
      var tour = hasOwn(DATA.tours, tourKey) ? DATA.tours[tourKey] : null;
      var n = readTravelers();
      var set = function (name, value) {
        var el = $('[data-estimate="' + name + '"]');
        if (el && el.textContent !== value) el.textContent = value;
      };
      set('tour', tour ? t('tour.' + tourKey + '.name') : '—');
      set('per', tour ? money(tour.price) : '—');
      set('travelers', n ? formatNumber(n) : '—');
      var total = tour && n ? money(tour.price * n) : '—';
      var totalEl = $('[data-estimate="total"]');
      if (totalEl && totalEl.textContent !== total) {
        totalEl.textContent = total;
        if (lastTotal !== null) {
          totalEl.classList.remove('is-updated');
          void totalEl.offsetWidth;
          totalEl.classList.add('is-updated');
        }
      }
      lastTotal = total;
      set('total-inline', total);
      var inline = $('[data-estimate-inline]');
      if (inline) inline.hidden = !(tour && n);
      var hint = $('[data-estimate-hint]');
      if (hint) hint.hidden = !!tour;
    }

    function updateCounter() {
      if (counter) counter.textContent = formatNumber(fields.message.value.length);
    }

    function fieldEl(name) { return $('[data-field="' + name + '"]', form); }

    function showError(name) {
      var wrap = fieldEl(name);
      if (!wrap) return;
      var input = fields[name];
      if (input) input.setAttribute('aria-invalid', 'true');
      var error = $('.field__error', wrap);
      if (error) error.hidden = false;
    }

    function clearError(name) {
      var wrap = fieldEl(name);
      if (!wrap) return;
      var input = fields[name];
      if (input) input.removeAttribute('aria-invalid');
      var error = $('.field__error', wrap);
      if (error) error.hidden = true;
    }

    var validators = {
      name: function () { var v = fields.name.value.trim(); return v.length > 0 && v.length <= 100; },
      email: function () {
        var v = fields.email.value.trim();
        return v.length > 0 && v.length <= 254 && /^[^\s@<>()[\]\\,;:"]{1,64}@[^\s@<>()[\]\\,;:"_]+\.[^\s@<>()[\]\\,;:"_]{2,}$/.test(v);
      },
      tour: function () { return fields.tour.value === '' || hasOwn(DATA.tours, fields.tour.value); },
      travelers: function () { return readTravelers() !== null; },
      interest: function () { return DATA.interests.indexOf(fields.interest.value) !== -1; },
      message: function () { return fields.message.value.length <= 2000; }
    };

    function validate() {
      var invalid = [];
      Object.keys(validators).forEach(function (name) {
        if (validators[name]()) clearError(name); else { showError(name); invalid.push(name); }
      });
      return invalid;
    }

    form.addEventListener('click', function (event) {
      var button = event.target.closest('[data-step]');
      if (!button) return;
      var current = readTravelers() || clampTravelers();
      var next = Math.min(MAX_TRAVELERS, Math.max(MIN_TRAVELERS, current + Number(button.getAttribute('data-step'))));
      fields.travelers.value = String(next);
      clearError('travelers');
      updateEstimate();
    });

    fields.travelers.addEventListener('input', function () {
      if (readTravelers() !== null) clearError('travelers');
      updateEstimate();
    });
    fields.travelers.addEventListener('change', function () {
      clampTravelers();
      clearError('travelers');
      updateEstimate();
    });
    fields.tour.addEventListener('change', updateEstimate);
    fields.message.addEventListener('input', updateCounter);

    ['name', 'email', 'interest', 'message', 'tour'].forEach(function (name) {
      fields[name].addEventListener('input', function () {
        if (fields[name].getAttribute('aria-invalid') === 'true' && validators[name]()) clearError(name);
      });
    });

    function setSending(value) {
      sending = value;
      submit.disabled = value;
      submit.setAttribute('aria-busy', String(value));
      var label = $('[data-i18n]', submit);
      if (label) {
        label.setAttribute('data-i18n', value ? 'form.sending' : 'form.submit');
        label.textContent = t(value ? 'form.sending' : 'form.submit');
      }
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (sending) return;
      var invalid = validate();
      if (invalid.length) {
        setStatus(status, 'error', 'form.error.summary');
        var first = fields[invalid[0]];
        if (first) first.focus();
        return;
      }
      clearStatus(status);
      var payload = {
        name: fields.name.value.trim(),
        email: fields.email.value.trim(),
        tour: fields.tour.value,
        travelers: readTravelers(),
        interest: fields.interest.value,
        message: fields.message.value.trim(),
        language: state.lang,
        website: fields.website ? fields.website.value : ''
      };
      setSending(true);
      fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload)
      })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (body) { return { res: res, body: body }; });
        })
        .then(function (result) {
          var res = result.res;
          var body = result.body || {};
          if (res.ok && body.sent) {
            setStatus(status, 'success', 'form.success');
            fields.name.value = '';
            fields.email.value = '';
            fields.message.value = '';
            updateCounter();
          } else if (res.status === 400 && body.fields) {
            Object.keys(body.fields).forEach(showError);
            setStatus(status, 'error', 'form.error.summary');
          } else if (res.status === 429) {
            setStatus(status, 'error', 'form.error.rate');
          } else if (res.status === 502 || res.status === 503) {
            setStatus(status, 'error', 'form.error.delivery');
          } else {
            setStatus(status, 'error', 'form.error.generic');
          }
        })
        .catch(function () {
          setStatus(status, 'error', 'form.error.network');
        })
        .then(function () {
          setSending(false);
          if (status && !status.hidden) status.focus();
        });
    });

    state.hooks.push(updateEstimate, updateCounter);
    updateEstimate();
    updateCounter();
  }

  // -------------------------------------------------------------------------
  // Admin: sign in
  // -------------------------------------------------------------------------

  function initLogin() {
    var form = document.getElementById('login-form');
    if (!form) return;
    var status = document.getElementById('login-status');
    var submit = $('[data-submit]', form);

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var username = form.elements.username.value.trim();
      var password = form.elements.password.value;
      if (!username || !password) {
        setStatus(status, 'error', 'admin.login.error.invalid');
        (username ? form.elements.password : form.elements.username).focus();
        return;
      }
      submit.disabled = true;
      var label = $('[data-i18n]', submit);
      label.setAttribute('data-i18n', 'admin.login.submitting');
      label.textContent = t('admin.login.submitting');
      fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ username: username, password: password })
      })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (body) { return { res: res, body: body }; });
        })
        .then(function (result) {
          if (result.res.ok && result.body.authenticated) {
            window.location.replace('/admin.html');
            return;
          }
          if (result.res.status === 429) {
            setStatus(status, 'error', 'admin.login.error.rate', { minutes: Math.max(1, Math.ceil((result.body.retryAfter || 60) / 60)) });
          } else if (result.res.status === 503) {
            setStatus(status, 'error', 'admin.login.error.config');
          } else {
            setStatus(status, 'error', 'admin.login.error.invalid');
            form.elements.password.value = '';
            form.elements.password.focus();
          }
        })
        .catch(function () { setStatus(status, 'error', 'admin.login.error.network'); })
        .then(function () {
          submit.disabled = false;
          label.setAttribute('data-i18n', 'admin.login.submit');
          label.textContent = t('admin.login.submit');
        });
    });
  }

  // -------------------------------------------------------------------------
  // Admin: Site Editor
  // -------------------------------------------------------------------------

  var GROUP_ORDER = ['page', 'nav', 'home', 'tours', 'tour', 'place', 'units', 'exp', 'about', 'partners', 'contacts', 'form', 'interest', 'estimate', 'photo', 'footer', 'notFound'];

  function initEditor() {
    var fieldsEl = $('[data-editor-fields]');
    if (!fieldsEl) return;

    var editor = {
      lang: state.lang,
      csrf: null,
      saved: emptyOverrides(),
      working: emptyOverrides(),
      query: '',
      ready: false
    };
    var keys = Object.keys(I18N.en).filter(function (key) { return key.indexOf('admin.') !== 0; });
    var editable = {};
    keys.forEach(function (key) { editable[key] = true; });
    var groups = {};
    keys.forEach(function (key) {
      var group = key.split('.')[0];
      (groups[group] = groups[group] || []).push(key);
    });
    var groupNames = GROUP_ORDER.filter(function (g) { return groups[g]; })
      .concat(Object.keys(groups).filter(function (g) { return GROUP_ORDER.indexOf(g) === -1; }));

    var status = document.getElementById('editor-status');
    var saveBtn = $('[data-editor-save]');
    var restoreBtn = $('[data-editor-restore]');
    var dirtyEl = $('[data-editor-dirty]');
    var navEl = $('[data-editor-nav]');
    var searchEl = document.getElementById('editor-search');
    var userEl = $('[data-editor-user]');
    var restoreTimer = null;

    function copy(o) { return normalizeOverrides(JSON.parse(JSON.stringify(o))); }
    function serialize(o) {
      return JSON.stringify(LANGS.map(function (lang) {
        return Object.keys(o[lang]).sort().map(function (k) { return [k, o[lang][k]]; });
      }));
    }
    function isDirty() { return serialize(editor.working) !== serialize(editor.saved); }

    function updateDirty() {
      var dirty = isDirty();
      saveBtn.disabled = !dirty || !editor.ready;
      dirtyEl.setAttribute('data-dirty', String(dirty));
      dirtyEl.setAttribute('data-i18n', dirty ? 'admin.editor.unsaved' : 'admin.editor.clean');
      dirtyEl.textContent = t(dirty ? 'admin.editor.unsaved' : 'admin.editor.clean');
    }

    function original(lang, key) {
      var d = I18N[lang] || {};
      return hasOwn(d, key) ? d[key] : '';
    }

    function rowsFor(text) {
      var lines = String(text).split('\n').length;
      return Math.min(10, Math.max(1, Math.ceil(String(text).length / 80) + lines - 1));
    }

    function buildField(key) {
      var lang = editor.lang;
      var orig = original(lang, key);
      var edited = hasOwn(editor.working[lang], key);
      var value = edited ? editor.working[lang][key] : orig;
      var id = 'ed-' + key.replace(/[^a-zA-Z0-9]/g, '-');

      var wrap = document.createElement('div');
      wrap.className = 'editor-field' + (edited ? ' is-edited' : '');
      wrap.setAttribute('data-key', key);

      var head = document.createElement('div');
      head.className = 'editor-field__head';
      var label = document.createElement('label');
      label.className = 'editor-field__key';
      label.setAttribute('for', id);
      label.textContent = key;
      var badge = span('editor-field__badge', t('admin.editor.edited'));
      badge.setAttribute('data-i18n', 'admin.editor.edited');
      badge.hidden = !edited;
      head.appendChild(label);
      head.appendChild(badge);

      var area = document.createElement('textarea');
      area.className = 'input editor-field__input';
      area.id = id;
      area.value = value;
      area.rows = rowsFor(value);
      area.setAttribute('lang', lang);
      area.setAttribute('spellcheck', 'true');

      var foot = document.createElement('div');
      foot.className = 'editor-field__foot';
      foot.hidden = !edited;
      var origText = document.createElement('p');
      origText.className = 'editor-field__original';
      var origLabel = span('editor-field__original-label', t('admin.editor.original') + ': ');
      origLabel.setAttribute('data-i18n-prefix', 'admin.editor.original');
      origText.appendChild(origLabel);
      origText.appendChild(span('', orig === '' ? '—' : orig));
      var reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'link-button';
      reset.setAttribute('data-i18n', 'admin.editor.useOriginal');
      reset.textContent = t('admin.editor.useOriginal');
      foot.appendChild(origText);
      foot.appendChild(reset);

      function sync() {
        var v = area.value;
        if (v === orig) delete editor.working[lang][key]; else editor.working[lang][key] = v;
        var isEdited = hasOwn(editor.working[lang], key);
        wrap.classList.toggle('is-edited', isEdited);
        badge.hidden = !isEdited;
        foot.hidden = !isEdited;
        updateDirty();
      }
      area.addEventListener('input', function () {
        area.rows = rowsFor(area.value);
        sync();
      });
      reset.addEventListener('click', function () {
        area.value = orig;
        area.rows = rowsFor(orig);
        sync();
        area.focus();
      });

      wrap.appendChild(head);
      wrap.appendChild(area);
      wrap.appendChild(foot);
      return wrap;
    }

    function render() {
      var fragment = document.createDocumentFragment();
      setChildren(navEl, []);
      groupNames.forEach(function (group) {
        var section = document.createElement('section');
        section.className = 'editor__group';
        section.id = 'group-' + group;
        var h = document.createElement('h2');
        h.className = 'editor__group-title';
        h.setAttribute('data-i18n', 'admin.group.' + group);
        h.textContent = t('admin.group.' + group);
        section.appendChild(h);
        groups[group].forEach(function (key) { section.appendChild(buildField(key)); });
        fragment.appendChild(section);

        var li = document.createElement('li');
        var a = document.createElement('a');
        a.href = '#group-' + group;
        a.setAttribute('data-i18n', 'admin.group.' + group);
        a.textContent = t('admin.group.' + group);
        li.appendChild(a);
        navEl.appendChild(li);
      });
      var empty = document.createElement('p');
      empty.className = 'lead editor__empty';
      empty.setAttribute('data-i18n', 'admin.editor.empty');
      empty.textContent = t('admin.editor.empty');
      empty.hidden = true;
      fragment.appendChild(empty);
      setChildren(fieldsEl, [fragment]);
      fieldsEl.setAttribute('aria-busy', 'false');
      all('[data-edit-lang]').forEach(function (button) {
        button.setAttribute('aria-pressed', String(button.getAttribute('data-edit-lang') === editor.lang));
      });
      filter();
      updateDirty();
    }

    function filter() {
      var q = editor.query.toLowerCase();
      var any = false;
      all('.editor__group', fieldsEl).forEach(function (section) {
        var visible = 0;
        all('.editor-field', section).forEach(function (field) {
          var key = field.getAttribute('data-key');
          var area = $('textarea', field);
          var match = !q || key.toLowerCase().indexOf(q) !== -1 ||
            area.value.toLowerCase().indexOf(q) !== -1 ||
            original(editor.lang, key).toLowerCase().indexOf(q) !== -1;
          field.hidden = !match;
          if (match) visible += 1;
        });
        section.hidden = visible === 0;
        var link = $('a[href="#' + section.id + '"]', navEl);
        if (link) link.parentNode.hidden = visible === 0;
        if (visible) any = true;
      });
      var empty = $('.editor__empty', fieldsEl);
      if (empty) empty.hidden = any;
    }

    function relabel() {
      // Labels created in JS that combine text with a prefix.
      all('[data-i18n-prefix]', fieldsEl).forEach(function (el) {
        el.textContent = t(el.getAttribute('data-i18n-prefix')) + ': ';
      });
      if (userEl && editor.username) userEl.textContent = t('admin.editor.signedInAs', { user: editor.username });
      updateDirty();
    }

    function request(method, url, body) {
      var headers = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (editor.csrf) headers['X-CSRF-Token'] = editor.csrf;
      return fetch(url, {
        method: method,
        headers: headers,
        credentials: 'same-origin',
        body: body === undefined ? undefined : JSON.stringify(body)
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) { return { res: res, body: data }; });
      });
    }

    function sessionEnded() {
      setStatus(status, 'error', 'admin.editor.error.session');
      window.setTimeout(function () { window.location.replace('/admin-login.html'); }, 1500);
    }

    // Load session, then content.
    request('GET', '/api/admin/session')
      .then(function (result) {
        if (!result.res.ok || !result.body.authenticated) {
          window.location.replace('/admin-login.html');
          return null;
        }
        editor.csrf = result.body.csrfToken;
        editor.username = result.body.username;
        relabel();
        return request('GET', '/api/content');
      })
      .then(function (result) {
        if (!result) return;
        if (!result.res.ok) throw new Error('load');
        editor.saved = normalizeOverrides(result.body.overrides);
        editor.working = copy(editor.saved);
        state.overrides = copy(editor.saved);
        editor.ready = true;
        render();
        applyTranslations();
      })
      .catch(function () {
        setStatus(status, 'error', 'admin.editor.error.load');
      });

    all('[data-edit-lang]').forEach(function (button) {
      button.addEventListener('click', function () {
        editor.lang = button.getAttribute('data-edit-lang');
        if (editor.ready) render();
      });
    });

    if (searchEl) {
      searchEl.addEventListener('input', function () {
        editor.query = searchEl.value.trim();
        filter();
      });
    }

    saveBtn.addEventListener('click', function () {
      if (!editor.ready || !isDirty()) return;
      clearStatus(status);
      saveBtn.disabled = true;
      var label = $('[data-i18n]', saveBtn);
      label.setAttribute('data-i18n', 'admin.editor.saving');
      label.textContent = t('admin.editor.saving');
      request('PUT', '/api/admin/content', { overrides: editor.working })
        .then(function (result) {
          if (result.res.ok && result.body.saved) {
            editor.saved = normalizeOverrides(result.body.overrides);
            editor.working = copy(editor.saved);
            state.overrides = copy(editor.saved);
            applyTranslations();
            setStatus(status, 'success', 'admin.editor.saved');
          } else if (result.res.status === 401) {
            sessionEnded();
          } else {
            var detail = result.body && result.body.details ? result.body.details.join(' ') : (result.body.error || 'HTTP ' + result.res.status);
            setStatus(status, 'error', 'admin.editor.error.save', { detail: detail });
          }
        })
        .catch(function () { setStatus(status, 'error', 'admin.editor.error.save', { detail: '' }); })
        .then(function () {
          label.setAttribute('data-i18n', 'admin.editor.save');
          label.textContent = t('admin.editor.save');
          updateDirty();
        });
    });

    $('[data-editor-export]').addEventListener('click', function () {
      var backup = {
        format: 'travelhorizon-content',
        version: 1,
        exportedAt: new Date().toISOString(),
        overrides: editor.saved
      };
      var blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'travelhorizon-content-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });

    $('[data-editor-import]').addEventListener('change', function (event) {
      var file = event.target.files && event.target.files[0];
      event.target.value = '';
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var parsed = JSON.parse(String(reader.result));
          var source = isPlainObject(parsed) && parsed.overrides !== undefined ? parsed.overrides : parsed;
          if (!isPlainObject(source)) throw new Error('shape');
          var langs = Object.keys(source);
          if (!langs.length || langs.some(function (l) { return LANGS.indexOf(l) === -1 || !isPlainObject(source[l]); })) throw new Error('shape');
          var next = emptyOverrides();
          langs.forEach(function (lang) {
            Object.keys(source[lang]).forEach(function (key) {
              var value = source[lang][key];
              if (typeof value !== 'string') throw new Error('value');
              if (editable[key]) next[lang][key] = value;
            });
          });
          editor.working = next;
          render();
          setStatus(status, 'info', 'admin.editor.imported');
        } catch (e) {
          setStatus(status, 'error', 'admin.editor.importError');
        }
      };
      reader.onerror = function () { setStatus(status, 'error', 'admin.editor.importError'); };
      reader.readAsText(file);
    });

    function disarmRestore() {
      restoreBtn.removeAttribute('data-armed');
      restoreBtn.setAttribute('data-i18n', 'admin.editor.restore');
      restoreBtn.textContent = t('admin.editor.restore');
    }

    restoreBtn.addEventListener('click', function () {
      if (!editor.ready) return;
      if (!restoreBtn.hasAttribute('data-armed')) {
        restoreBtn.setAttribute('data-armed', '');
        restoreBtn.setAttribute('data-i18n', 'admin.editor.restoreConfirm');
        restoreBtn.textContent = t('admin.editor.restoreConfirm');
        window.clearTimeout(restoreTimer);
        restoreTimer = window.setTimeout(disarmRestore, 5000);
        return;
      }
      window.clearTimeout(restoreTimer);
      disarmRestore();
      clearStatus(status);
      restoreBtn.disabled = true;
      request('DELETE', '/api/admin/content')
        .then(function (result) {
          if (result.res.ok && result.body.restored) {
            editor.saved = emptyOverrides();
            editor.working = emptyOverrides();
            state.overrides = emptyOverrides();
            render();
            applyTranslations();
            setStatus(status, 'success', 'admin.editor.restored');
          } else if (result.res.status === 401) {
            sessionEnded();
          } else {
            setStatus(status, 'error', 'admin.editor.error.save', { detail: result.body.error || '' });
          }
        })
        .catch(function () { setStatus(status, 'error', 'admin.editor.error.save', { detail: '' }); })
        .then(function () { restoreBtn.disabled = false; });
    });

    $('[data-editor-signout]').addEventListener('click', function () {
      request('POST', '/api/admin/logout', {})
        .catch(function () { return null; })
        .then(function () {
          editor.working = copy(editor.saved);
          window.location.replace('/admin-login.html');
        });
    });

    window.addEventListener('beforeunload', function (event) {
      if (editor.ready && isDirty()) {
        event.preventDefault();
        event.returnValue = '';
      }
    });

    state.hooks.push(relabel);
  }

  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------

  // A photo that fails to load keeps its calm placeholder instead of a broken icon and alt text.
  function initImageFallback() {
    document.addEventListener('error', function (event) {
      var target = event.target;
      if (target && target.tagName === 'IMG') target.classList.add('is-broken');
    }, true);
    all('img').forEach(function (img) {
      if (img.complete && img.naturalWidth === 0 && img.currentSrc) img.classList.add('is-broken');
    });
  }

  function start() {
    initImageFallback();
    initHeader();
    initTours();
    initContact();
    initLogin();
    initEditor();
    initReveal();
    applyTranslations();
    if (!$('[data-editor-fields]')) loadOverrides();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
