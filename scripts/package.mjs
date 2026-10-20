// Zips the built extension. `npm run package` writes two files to release/:
//   wasmcheat-extension-v<version>.zip  files under wasmcheat/, what people unzip and "Load unpacked"
//   wasmcheat-store-v<version>.zip      the same files at the root, what the Chrome Web Store takes
// Plain zlib, no zip dependency; it refuses to run on a stale or mismatched build.
import { deflateRawSync, crc32 } from 'node:zlib';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'packages/extension/dist');
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));
if (manifest.version !== version) {
  throw new Error(`dist/manifest.json is ${manifest.version} but package.json is ${version}: bump both, then npm run build`);
}

function files(dir) {
  return readdirSync(dir).sort().flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

// One fixed timestamp (2026-01-01 00:00) so the same build zips to the same bytes.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function header(signature, size) {
  const buffer = Buffer.alloc(size);
  buffer.writeUInt32LE(signature, 0);
  return buffer;
}

function zip(prefix) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const path of files(DIST)) {
    const name = Buffer.from(`${prefix}${relative(DIST, path).split('\\').join('/')}`);
    const data = readFileSync(path);
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const head = header(0x04034b50, 30);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(8, 8); // deflate
    head.writeUInt16LE(DOS_TIME, 10);
    head.writeUInt16LE(DOS_DATE, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    local.push(head, name, packed);

    const entry = header(0x02014b50, 46);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += head.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const count = central.length / 2;
  const end = header(0x06054b50, 22);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return { bytes: Buffer.concat([...local, directory, end]), count };
}

mkdirSync(join(ROOT, 'release'), { recursive: true });
for (const [file, prefix] of [
  [`wasmcheat-extension-v${version}.zip`, 'wasmcheat/'],
  [`wasmcheat-store-v${version}.zip`, ''],
]) {
  const { bytes, count } = zip(prefix);
  writeFileSync(join(ROOT, 'release', file), bytes);
  console.log(`release/${file} (${count} files)`);
}
