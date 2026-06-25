// Regenerate the three PWA home-screen icons.
//
// Reads the white circle logo (Circle_Text_Icon_White.png) and composites
// it centered on a sage-green (--color-understory = #76856C) square — same
// green as the sidebar, so the installed-app home-screen icon matches the
// in-app look.
//
// Usage:
//   node scripts/generate-pwa-icons.js
//
// Then commit /public/icons/{icon-192,icon-512,apple-touch-icon-180}.png.

const sharp = require('sharp');
const path  = require('path');

const ROOT       = path.join(__dirname, '..');
const LOGO_PATH  = path.join(ROOT, 'public', 'images', 'brand', 'Circle_Text_Icon_White.png');
const OUT_DIR    = path.join(ROOT, 'public', 'icons');

const GREEN = { r: 0x76, g: 0x85, b: 0x6C, alpha: 1 };  // --color-understory

// Icons are square. Padding ratio = how much of the icon's edge stays solid
// green around the logo. 0.10 gives a comfortable safe area on both iOS
// (which can round the corners) and Android (which can mask to circles).
const PADDING_RATIO = 0.10;

const SIZES = [
  { file: 'icon-192.png',             size: 192 },
  { file: 'icon-512.png',             size: 512 },
  { file: 'apple-touch-icon-180.png', size: 180 },
];

async function generate({ file, size }) {
  const inner = Math.round(size * (1 - PADDING_RATIO * 2));

  const logoBuf = await sharp(LOGO_PATH)
    .resize(inner, inner, { fit: 'inside', withoutEnlargement: false })
    .png()
    .toBuffer();

  const offset = Math.round((size - inner) / 2);

  await sharp({
    create: { width: size, height: size, channels: 4, background: GREEN },
  })
    .composite([{ input: logoBuf, left: offset, top: offset }])
    .png()
    .toFile(path.join(OUT_DIR, file));

  console.log(`✓ Wrote ${file} (${size}x${size})`);
}

(async () => {
  for (const s of SIZES) await generate(s);
  console.log('\nDone. Commit public/icons/ to ship.');
})().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
