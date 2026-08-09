/**
 * Fetches the outside-the-window assets for the live floor (`/agent/live`).
 *
 * Committed rather than run once and forgotten, because the alternative is a
 * dozen binary files in `public/` whose provenance and licence live only in
 * whoever-added-them's memory. Re-run it and you get byte-identical output.
 *
 *   node scripts/fetch-city-assets.mjs
 *
 * ── What it fetches, and under what licence ──────────────────────────────────
 *
 * Building facades — ambientCG (https://ambientcg.com), CC0 1.0 Public Domain.
 *   Colour and emission only. The sets also ship normal/roughness/displacement
 *   maps, which are deliberately skipped: the nearest building is 45m away and
 *   the furthest 700m, so surface relief is below a pixel everywhere it would
 *   apply, and each map we skip is another 4MB of VRAM per facade.
 *
 *   The emission map is the whole reason these particular sets were chosen. It
 *   is a photograph of the same wall with its lights on, so the lit windows sit
 *   exactly on the real windows. The previous approach scattered glowing quads
 *   on a synthetic grid over an untextured box because there was no facade for
 *   them to line up with.
 *
 * Moon colour map — NASA Scientific Visualization Studio, CGI Moon Kit
 *   (https://svs.gsfc.nasa.gov/4720). Public domain. Assembled by the Lunar
 *   Reconnaissance Orbiter camera team; 1024x512 equirectangular, which is the
 *   right projection for a UV sphere and plenty for a disc a few hundred pixels
 *   across at most.
 *
 * Timezone coordinates — IANA time zone database `zone1970.tab`. Public domain.
 *   Generated into a committed TypeScript table rather than fetched at runtime:
 *   it changes a few times a year, and the scene must not depend on the network
 *   to work out where the sun is.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEXTURES = path.join(ROOT, 'public/textures/command');
const FACADES = path.join(TEXTURES, 'facade');
const TZ_TABLE = path.join(ROOT, 'src/components/command/scene/tzCoords.ts');

/**
 * The six facades, chosen from all 27 in ambientCG's catalogue by how their
 * emission maps read: the mix of dense, moderate and sparse lit-window
 * densities is what stops 300 buildings looking like 300 copies of one
 * building. Variants suffixed A are the unlit daytime captures and have a black
 * emission map, which is why 019B rather than 019A.
 */
const FACADE_IDS = [
  'Facade002', // modern blue-grey glass grid, sparse lit windows
  'Facade013', // tan photographic curtain wall, dense
  'Facade015', // pale grey curtain wall, moderate
  'Facade016', // warm brown curtain wall, moderate
  'Facade017', // dark piers with warm lit bands
  'Facade019B', // grey concrete horizontal bands, dense
];

/**
 * ambientCG serves each map of an asset individually here at its full 2048px.
 * The alternative is `ambientcg.com/get?file=<id>_1K-JPG.zip`, which bundles
 * every map — including the four we don't want — and needs a zip reader that
 * Node has no built-in for. Same CC0 asset either way.
 */
const acgMap = (id, map) =>
  `https://f003.backblazeb2.com/file/ambientCG-Web/media/surface-preview/${id}/${id}_SQ_${map}.jpg`;

const MOON_URL = 'https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_1k.jpg';
const ZONE_TAB_URL = 'https://data.iana.org/time-zones/tzdb/zone1970.tab';

/** Everything is downsampled to this. See the licence note above on why 2k is wasted here. */
const TEXTURE_SIZE = 1024;
const JPEG_QUALITY = 82;

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Downsample to TEXTURE_SIZE and re-encode. Returns the written byte count. */
async function writeTexture(buffer, destination, size = TEXTURE_SIZE) {
  const out = await sharp(buffer)
    .resize(size, null, { fit: 'inside' })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer();
  await writeFile(destination, out);
  return out.length;
}

/**
 * `+DDMM+DDDMM` or `+DDMMSS+DDDMMSS` (ISO 6709) -> decimal degrees.
 *
 * The two forms are distinguished by field width, not by a separator: latitude
 * is 5 characters in the short form and 7 in the long one, and the sign is
 * always present. Splitting on the second sign is what tells them apart.
 */
function parseIso6709(coords) {
  const m = /^([+-]\d{4,6})([+-]\d{5,7})$/.exec(coords);
  if (!m) return null;
  const toDegrees = (field, degreeDigits) => {
    const sign = field[0] === '-' ? -1 : 1;
    const digits = field.slice(1);
    const deg = Number(digits.slice(0, degreeDigits));
    const min = Number(digits.slice(degreeDigits, degreeDigits + 2));
    const sec = digits.length > degreeDigits + 2 ? Number(digits.slice(degreeDigits + 2)) : 0;
    return sign * (deg + min / 60 + sec / 3600);
  };
  return {
    latitude: Number(toDegrees(m[1], 2).toFixed(3)),
    longitude: Number(toDegrees(m[2], 3).toFixed(3)),
  };
}

async function buildTimezoneTable() {
  const text = (await download(ZONE_TAB_URL)).toString('utf8');
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [, coords, zone] = line.split('\t');
    if (!coords || !zone) continue;
    const point = parseIso6709(coords.trim());
    if (!point) continue;
    rows.push([zone.trim(), point]);
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]));

  const body = rows.map(([zone, p]) => `  '${zone}': [${p.latitude}, ${p.longitude}],`).join('\n');
  const source = `/**
 * Where each IANA timezone is, in degrees.
 *
 * GENERATED by \`scripts/fetch-city-assets.mjs\` from the IANA time zone
 * database's own \`zone1970.tab\` (public domain). Do not edit by hand — re-run
 * the script.
 *
 * The live floor needs a latitude and longitude to work out where the sun is,
 * and all it is given is the viewer's \`team_members.timezone\`. A timezone is
 * not a point, but every zone in this file is defined by a representative
 * location and that is exactly what \`zone1970.tab\` records — so this is the
 * authoritative answer to the question rather than an approximation of it.
 *
 * ${rows.length} zones. Zones absent here (deprecated aliases such as
 * \`US/Pacific\`, which the database keeps in its \`backward\` file rather than
 * this one) fall back to a longitude derived from the zone's live UTC offset —
 * see \`coordsForTimezone\` in \`celestial.ts\`.
 */

export const TZ_COORDS: Record<string, readonly [latitude: number, longitude: number]> = {
${body}
};
`;
  await writeFile(TZ_TABLE, source, 'utf8');
  return rows.length;
}

async function main() {
  if (!existsSync(FACADES)) await mkdir(FACADES, { recursive: true });

  let total = 0;
  for (const id of FACADE_IDS) {
    const slug = id.toLowerCase();
    for (const [map, suffix] of [
      ['Color', 'color'],
      ['Emission', 'emissive'],
    ]) {
      const bytes = await writeTexture(
        await download(acgMap(id, map)),
        path.join(FACADES, `${slug}_${suffix}.jpg`)
      );
      total += bytes;
      console.log(`  facade/${slug}_${suffix}.jpg  ${(bytes / 1024).toFixed(0)} KB`);
    }
  }

  // The moon map is already 1024x512 and equirectangular; passing it through
  // the same re-encode only normalises the quality setting.
  const moonBytes = await writeTexture(
    await download(MOON_URL),
    path.join(TEXTURES, 'moon_color_1k.jpg')
  );
  total += moonBytes;
  console.log(`  moon_color_1k.jpg  ${(moonBytes / 1024).toFixed(0)} KB`);

  const zones = await buildTimezoneTable();
  console.log(`  scene/tzCoords.ts  ${zones} zones`);
  console.log(`\ntextures: ${(total / 1024 / 1024).toFixed(2)} MB total`);
}

await main();
