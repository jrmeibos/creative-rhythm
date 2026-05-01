const sharp = require('sharp');
const path  = require('path');
const fs    = require('fs');

const dir = path.join(__dirname, '../public/images/seasons');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.png'));

async function removeBlackBg(filePath) {
  const img    = sharp(filePath);
  const meta   = await img.metadata();
  const { data, info } = await img
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const buf = Buffer.from(data);
  for (let i = 0; i < buf.length; i += 4) {
    const r = buf[i], g = buf[i + 1], b = buf[i + 2];
    if (r < 40 && g < 40 && b < 40) {
      buf[i + 3] = 0; // fully transparent
    }
  }

  await sharp(buf, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toFile(filePath);

  console.log(`✓ ${path.basename(filePath)} (${info.width}×${info.height})`);
}

(async () => {
  for (const f of files) {
    await removeBlackBg(path.join(dir, f));
  }
  console.log('Done.');
})();
