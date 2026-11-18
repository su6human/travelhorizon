/*
 * TravelHorizon — single source of truth for tour data, prices and photos.
 * Used by the browser (window.TH_DATA) and by the Node.js server (require).
 * Change a price here and it updates the tour pages, the live estimate and
 * the Telegram enquiry at once.
 */
(function (root) {
  'use strict';

  var TH_DATA = {
    currency: 'USD',
    languages: ['en', 'ru', 'ky'],
    defaultLanguage: 'en',
    travelers: { min: 1, max: 20 },

    // key: { price per person (USD), days, start place key, season months [from, to], filter categories }
    tours: {
      ala:      { price: 980, days: 8, start: 'karakol',  season: [6, 9],  categories: ['trekking', 'lakes'],         image: 'tour-ala' },
      song:     { price: 740, days: 6, start: 'naryn',    season: [6, 10], categories: ['horse', 'yurt', 'lakes'],   image: 'tour-song' },
      issyk:    { price: 860, days: 7, start: 'issyk',    season: [5, 10], categories: ['lakes', 'culture'],         image: 'tour-issyk' },
      jyrgalan: { price: 620, days: 5, start: 'jyrgalan', season: [6, 10], categories: ['trekking', 'horse'],        image: 'tour-jyrgalan' }
    },
    tourOrder: ['ala', 'song', 'issyk', 'jyrgalan'],

    filters: ['all', 'trekking', 'horse', 'lakes', 'yurt', 'culture'],

    interests: ['general', 'partner', 'experience', 'horse', 'yurt', 'food', 'trek'],

    // Text keys that may be left empty on purpose (the row is hidden when empty).
    optionalKeys: ['contacts.email.value', 'contacts.phone.value', 'contacts.telegram.value'],

    /*
     * Photos. Each image is served from /img/<key>. If you put your own file at
     * public/images/<key>.jpg (or .webp/.png), the server uses it automatically;
     * otherwise it redirects to the Wikimedia Commons original below.
     * Update author/licence here when you replace a photo.
     */
    images: {
      'hero':          { file: 'Lake Son Kol, Kyrgyzstan.jpg',                                   author: 'Benjamin Goetzinger',      license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/', caption: 'photo.hero' },
      'tour-ala':      { file: 'Ala-Köl.jpg',                                                    author: 'Ondřej Žváček',            license: 'CC BY 2.5',    licenseUrl: 'https://creativecommons.org/licenses/by/2.5/',    caption: 'photo.ala' },
      'tour-song':     { file: 'Song-Kul, Kyrgyzstan (44580008121).jpg',                         author: 'Ninara',                   license: 'CC BY 2.0',    licenseUrl: 'https://creativecommons.org/licenses/by/2.0/',    caption: 'photo.song' },
      'tour-issyk':    { file: 'Issyk-Kul, Kyrgyzstan (43713946455).jpg',                        author: 'Ninara',                   license: 'CC BY 2.0',    licenseUrl: 'https://creativecommons.org/licenses/by/2.0/',    caption: 'photo.issyk' },
      'tour-jyrgalan': { file: 'Teleti Pass Trek (Kyrgyzstan, August 2019) - 59 (50569990002).jpg', author: 'Bruno Rijsman',         license: 'CC BY-SA 2.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/2.0/', caption: 'photo.jyrgalan' },
      'exp-horse':     { file: 'Riding at Song Kol lake.jpg',                                    author: 'Kondephy',                 license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/', caption: 'photo.horse' },
      'exp-yurt':      { file: 'Lake Son Kol, Kyrgyzstan, afternoon.jpg',                        author: 'Benjamin Goetzinger',      license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/', caption: 'photo.yurt' },
      'exp-food':      { file: 'Beshbarmak, national dish (3991850909).jpg',                     author: 'Peretz Partensky',         license: 'CC BY-SA 2.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/2.0/', caption: 'photo.food' },
      'exp-trek':      { file: 'Lake Ala Kul Trek (Kyrgyzstan, August 2019) - 58 (50565169838).jpg', author: 'Bruno Rijsman',        license: 'CC BY-SA 2.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/2.0/', caption: 'photo.trek' },
      'about':         { file: 'Issyk-Kul, Kyrgyzstan (6019934565).jpg',                         author: 'Thomas Depenbusch',        license: 'CC BY 2.0',    licenseUrl: 'https://creativecommons.org/licenses/by/2.0/',    caption: 'photo.about' },
      'partners':      { file: 'NoviNomad yurt camp, near Son-Kol lake, Kyrgyzstan - panoramio (1).jpg', author: 'ThomasG',         license: 'CC BY-SA 3.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/', caption: 'photo.partners' }
    }
  };

  TH_DATA.commonsPage = function (file) {
    return 'https://commons.wikimedia.org/wiki/File:' + encodeURIComponent(String(file).replace(/ /g, '_'));
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = TH_DATA;
  } else {
    root.TH_DATA = TH_DATA;
  }
})(typeof window !== 'undefined' ? window : globalThis);
