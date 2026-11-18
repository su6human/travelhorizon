'use strict';

/*
 * Downloads the website photos from Wikimedia Commons into public/images/,
 * so the site serves them itself instead of linking to Wikimedia.
 *
 *   npm run images            download the photos that are missing
 *   npm run images -- --force download all photos again
 */

const fs = require('node:fs');
const path = require('node:path');
const DATA = require('../public/data.js');
const { commonsThumbUrl, commonsFilePathUrl } = require('../server.js');

const OUT_DIR = path.join(__dirname, '..', 'public', 'images');
const FORCE = process.argv.includes('--force');
// Wikimedia asks scripts to identify themselves with a descriptive User-Agent.
const USER_AGENT = 'TravelHorizonSite/1.0 (one-time photo download for a travel website; Node.js)';
const MIN_BYTES = 10 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchImage(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'image/jpeg,image/*;q=0.9' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('image/')) throw new Error(`not an image (${type || 'no content type'})`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < MIN_BYTES) throw new Error(`file too small (${buffer.length} bytes)`);
  return buffer;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const entries = Object.entries(DATA.images);
  let ok = 0;
  let skipped = 0;
  const failed = [];

  console.log(`Downloading ${entries.length} photos into public/images/\n`);

  for (const [key, image] of entries) {
    const target = path.join(OUT_DIR, `${key}.jpg`);
    const hasLocal = ['.jpg', '.jpeg', '.webp', '.png', '.avif'].some((ext) => fs.existsSync(path.join(OUT_DIR, key + ext)));
    if (hasLocal && !FORCE) {
      console.log(`  -  ${key.padEnd(14)} already there, skipped`);
      skipped += 1;
      continue;
    }
    const width = key === 'hero' ? 1920 : 1280;
    const attempts = [commonsThumbUrl(image.file, width), commonsFilePathUrl(image.file, width)];
    let saved = false;
    const errors = [];
    for (const url of attempts) {
      try {
        const buffer = await fetchImage(url);
        fs.writeFileSync(target, buffer);
        console.log(`  OK ${key.padEnd(14)} ${(buffer.length / 1024).toFixed(0)} KB`);
        saved = true;
        break;
      } catch (error) {
        errors.push(`${error.message}`);
      }
    }
    if (saved) {
      ok += 1;
    } else {
      failed.push(key);
      console.log(`  X  ${key.padEnd(14)} ${errors.join(' / ')}`);
    }
    await sleep(400);
  }

  console.log(`\nDone: ${ok} downloaded, ${skipped} skipped, ${failed.length} failed.`);
  if (failed.length) {
    console.log('Failed photos keep loading from Wikimedia. You can also put your own file at public/images/<key>.jpg');
    process.exitCode = 1;
  } else {
    console.log('Restart the site (npm start). Then publish the photos: git add . && git commit -m "Photos" && git push');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
