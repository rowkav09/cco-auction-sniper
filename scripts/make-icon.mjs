// One-off generator for a tiny solid-color tray icon (no image editing tool available in this
// environment). Produces a 32x32 PNG-in-ICO, the format Windows tray icons need. Run once with
// `node scripts/make-icon.mjs` -- not part of the app's runtime.
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SIZE = 32;
// App accent color (#e07b39) on a dark circle, close enough at 32x32 to read as a simple dot/badge.
const [R, G, B] = [0xe0, 0x7b, 0x39];

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makePng() {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(SIZE, 0);
  ihdrData.writeUInt32BE(SIZE, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type RGBA
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdr = chunk('IHDR', ihdrData);

  const cx = SIZE / 2, cy = SIZE / 2, radius = SIZE / 2 - 1;
  const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
  for (let y = 0; y < SIZE; y++) {
    const rowStart = y * (1 + SIZE * 4);
    raw[rowStart] = 0; // filter type: none
    for (let x = 0; x < SIZE; x++) {
      const dx = x - cx + 0.5, dy = y - cy + 0.5;
      const inCircle = dx * dx + dy * dy <= radius * radius;
      const o = rowStart + 1 + x * 4;
      if (inCircle) { raw[o] = R; raw[o + 1] = G; raw[o + 2] = B; raw[o + 3] = 255; }
      else { raw[o] = 0; raw[o + 1] = 0; raw[o + 2] = 0; raw[o + 3] = 0; }
    }
  }
  const idat = chunk('IDAT', zlib.deflateSync(raw));
  const iend = chunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, idat, iend]);
}

function makeIco(pngBuf) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count

  const entry = Buffer.alloc(16);
  entry[0] = SIZE === 256 ? 0 : SIZE; // width
  entry[1] = SIZE === 256 ? 0 : SIZE; // height
  entry[2] = 0; // color count
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bit count
  entry.writeUInt32BE == null;
  entry.writeUInt32LE(pngBuf.length, 8); // bytes in resource
  entry.writeUInt32LE(22, 12); // offset (6 header + 16 entry)

  return Buffer.concat([header, entry, pngBuf]);
}

const png = makePng();
const ico = makeIco(png);
const outDir = path.join(__dirname, '..', 'public');
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);
fs.writeFileSync(path.join(outDir, 'icon.png'), png);
console.log('wrote', path.join(outDir, 'icon.ico'), ico.length, 'bytes');
console.log('wrote', path.join(outDir, 'icon.png'), png.length, 'bytes');
