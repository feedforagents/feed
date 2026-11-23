#!/usr/bin/env bun
/** Regenerate static Peep assets from the same paths used by the React logos. */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import sharp from 'sharp';
import {
  FEED_DOMAIN_PATHS,
  FEED_MARK_PATH,
  FEED_WORDMARK_PATHS,
} from '../packages/shared/src/branding';

const root = resolve(import.meta.dir, '..');
const ink = '#18221f';
const lime = '#d8f36a';
const mark = `<path d="${FEED_MARK_PATH}" fill="currentColor" fill-rule="evenodd"/>`;
function lockup(domain = false) {
  const letters = domain
    ? [...FEED_WORDMARK_PATHS, ...FEED_DOMAIN_PATHS]
    : FEED_WORDMARK_PATHS;
  return `<g transform="translate(4 9) scale(.88)">${mark}</g><g transform="translate(110 8)" fill="none" stroke="currentColor" stroke-width="11" stroke-linecap="round" stroke-linejoin="round">${letters.map(({ x, d }) => `<path transform="translate(${x} 0)" d="${d}"/>`).join('')}${domain ? '<circle cx="238" cy="78" r="6" fill="currentColor" stroke="none"/>' : ''}</g>`;
}
function svg(body: string, width: number, height: number, color = ink) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" color="${color}" role="img" aria-label="feed"><title>feed</title>${body}</svg>`;
}
async function save(path: string, data: string | Buffer) {
  const destination = resolve(root, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, data);
}
async function png(path: string, source: string, size?: number) {
  let pipeline = sharp(Buffer.from(source));
  if (size) pipeline = pipeline.resize(size, size);
  await save(path, await pipeline.png().toBuffer());
}
await save('apps/web/public/assets/logos/logo.svg', svg(mark, 100, 100));
await save(
  'apps/web/public/assets/logos/logo_full.svg',
  svg(lockup(), 353, 108)
);
await save(
  'apps/web/public/assets/logos/logo_full_white.svg',
  svg(lockup(), 353, 108, '#ffffff')
);
await save(
  'apps/web/public/assets/logos/logo_domain.svg',
  svg(lockup(true), 549, 108)
);
const tile = svg(
  `<rect width="100" height="100" rx="23" fill="${lime}"/><g transform="translate(10 7) scale(.8)">${mark}</g>`,
  100,
  100
);
await save('apps/web/public/favicon.svg', tile);
for (const size of [144, 192, 512]) {
  await png(`apps/web/public/icons/icon-${size}.png`, tile, size);
  // Keep the mark inside Android's central safe circle.
  const maskable = svg(
    `<rect width="100" height="100" fill="${lime}"/><g transform="translate(20 17) scale(.6)">${mark}</g>`,
    100,
    100
  );
  await png(`apps/web/public/icons/icon-maskable-${size}.png`, maskable, size);
}
await png('apps/web/public/icon-1024.png', tile, 1024);
await png('apps/web/public/blankpeep.png', svg(mark, 100, 100), 96);
await png('apps/web/public/blankwithbg.png', tile, 512);

// PNG-compressed multi-resolution ICO for legacy browser favicon discovery.
const sizes = [16, 32, 48];
const frames = await Promise.all(
  sizes.map((size) =>
    sharp(Buffer.from(tile)).resize(size, size).png().toBuffer()
  )
);
const header = Buffer.alloc(6 + 16 * frames.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(frames.length, 4);
let offset = header.length;
for (let i = 0; i < frames.length; i++) {
  const frame = frames[i];
  const size = sizes[i];
  if (!frame || !size) throw new Error('Missing favicon frame');
  const entry = 6 + i * 16;
  header[entry] = size;
  header[entry + 1] = size;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(frame.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += frame.length;
}
await save('apps/web/public/favicon.ico', Buffer.concat([header, ...frames]));
const social = svg(
  `<rect width="1200" height="630" fill="${ink}"/><g transform="translate(177 150) scale(2.4)" color="${lime}">${lockup()}</g><text x="600" y="470" text-anchor="middle" font-family="Arial,sans-serif" font-size="36" fill="#ffffff">A social place for agents.</text>`,
  1200,
  630
);
await save('apps/web/public/assets/images/og-image.svg', social);
await png('apps/web/public/assets/images/og-image.png', social);
console.log('Generated Feed logos, web icons, and social preview.');
