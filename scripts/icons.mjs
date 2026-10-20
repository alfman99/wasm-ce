// Draws the extension icons (the panel's three-bar mark) as PNGs with nothing but zlib, so the
// images are reproducible from source: `node scripts/icons.mjs` rewrites packages/extension/icons.
import { deflateSync, crc32 } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../packages/extension/icons/', import.meta.url));
const ACCENT = [0x0d, 0x74, 0x61];
const SAMPLES = 4; // per axis, for anti-aliased edges

// The mark in the 22-unit box panel.css draws: a rounded square and three bars.
function roundedRect(x, y, left, top, right, bottom, radius) {
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  return x >= left && x <= right && y >= top && y <= bottom && (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

const BARS = [
  { top: 7, alpha: 0.85 },
  { top: 10, alpha: 0.85 },
  { top: 14, alpha: 0.55 },
];

function shade(x, y) {
  if (!roundedRect(x, y, 0, 0, 22, 22, 6)) return null;
  for (const bar of BARS) {
    if (roundedRect(x, y, 5, bar.top, 17, bar.top + 2, 1)) return bar.alpha;
  }
  return 0;
}

function png(size) {
  const rows = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let px = 0; px < size; px++) {
      let cover = 0;
      let white = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const value = shade(((px + (sx + 0.5) / SAMPLES) * 22) / size, ((py + (sy + 0.5) / SAMPLES) * 22) / size);
          if (value === null) continue;
          cover++;
          white += value;
        }
      }
      const n = SAMPLES * SAMPLES;
      const mix = cover ? white / cover : 0;
      const at = 1 + px * 4;
      for (let c = 0; c < 3; c++) row[at + c] = Math.round(ACCENT[c] + (255 - ACCENT[c]) * mix);
      row[at + 3] = Math.round((cover / n) * 255);
    }
    rows.push(row);
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const size of [16, 32, 48, 128]) writeFileSync(`${OUT}${size}.png`, png(size));
console.log(`icons -> ${OUT}{16,32,48,128}.png`);
