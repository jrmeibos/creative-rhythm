/**
 * Run once after placing logo files in public/images/logo/
 * Usage: node scripts/process-logos.js
 *
 * Removes near-black pixels (R<30, G<30, B<30) to make the
 * black PNG backgrounds transparent.
 * Requires sharp: npm install sharp
 */

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const LOGO_DIR = path.join(__dirname, '..', 'public', 'images', 'logo');
const LOGOS = [
  'Circle_Logo_Icon1500x.png',
  'Main_Logo__Bloem1500x.png',
];

const THRESHOLD = 30;

async function removeBlackBackground(inputPath, outputPath) {
  const image = sharp(inputPath);
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const output = Buffer.from(data);

  for (let i = 0; i < width * height; i++) {
    const offset = i * channels;
    const r = output[offset];
    const g = output[offset + 1];
    const b = output[offset + 2];
    if (r < THRESHOLD && g < THRESHOLD && b < THRESHOLD) {
      output[offset + 3] = 0; // make transparent
    }
  }

  await sharp(output, { raw: { width, height, channels } })
    .png()
    .toFile(outputPath);

  console.log(`✓ Processed ${path.basename(inputPath)}`);
}

(async () => {
  for (const filename of LOGOS) {
    const inputPath = path.join(LOGO_DIR, filename);
    if (!fs.existsSync(inputPath)) {
      console.warn(`  Skipping ${filename} — file not found`);
      continue;
    }
    const outputPath = inputPath; // overwrite in place
    await removeBlackBackground(inputPath, outputPath);
  }
  console.log('\nDone. Restart the server to see the updated logos.');
})().catch(console.error);
