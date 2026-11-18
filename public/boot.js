/* Runs before the page renders: picks the language so translated pages do not flash English text. */
(function () {
  'use strict';
  var root = document.documentElement;
  var langs = ['en', 'ru', 'ky'];
  var lang = null;
  try {
    var match = /[?&]lang=(en|ru|ky)\b/.exec(window.location.search);
    if (match) {
      lang = match[1];
      try { window.localStorage.setItem('th_lang', lang); } catch (e) { /* storage unavailable */ }
    }
  } catch (e) { /* ignore */ }
  if (!lang) {
    try { lang = window.localStorage.getItem('th_lang'); } catch (e) { lang = null; }
  }
  if (langs.indexOf(lang) === -1) {
    var nav = (navigator.languages && navigator.languages[0]) || navigator.language || '';
    nav = String(nav).toLowerCase();
    lang = nav.indexOf('ky') === 0 ? 'ky' : nav.indexOf('ru') === 0 ? 'ru' : 'en';
  }
  root.setAttribute('data-lang', lang);
  root.classList.add('js');
  if (lang !== 'en') {
    root.lang = lang;
    root.classList.add('i18n-pending');
  }
})();
