/**
 * The workspace brand (Settings > Workspace > Brand):
 *
 * - One picked color generates the 50 to 700 scale, and core's own teal comes
 *   back out of it.
 * - What an Owner sets wins over core's defaults, field by field.
 * - The save body and logo uploads are checked before anything is stored.
 * - In the database: one row, readable by anyone, written only by the
 *   service role, with CHECK constraints that refuse a bad color.
 *
 * Runs on PGlite over the whole real schema. Nothing touches a live database.
 *
 *   npm run -s test:brand
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { actAs, createFullSchemaDatabase, schemaBeforeMigration } from './full-schema-db';
import {
  BRAND_SHADES,
  DEFAULT_BRAND,
  EMPTY_BRAND_SETTINGS,
  cleanShades,
  generateShades,
  resolveBrand,
  type BrandSettings,
} from '../src/lib/brand';
import { rowToSettings, type WorkspaceBrandRow } from '../src/lib/brand/resolve';
import { BRAND_LIMITS, parseBrandInput, sniffImage } from '../src/lib/brand/validate';

const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', '20261121001500_workspace_brand.sql'), 'utf8');
const SIDEBAR_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', '20261121063000_sidebar_projects_style.sql'), 'utf8');

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

function channels(hex: string): number[] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const lightness = (hex: string) => channels(hex).reduce((sum, c) => sum + c, 0);

function shades() {
  const scale = generateShades('#4f46e5');
  check('shades: 500 is the picked color', scale[500] === '#4F46E5', scale);
  check('shades: every shade is a hex color', BRAND_SHADES.every((shade) => /^#[0-9A-F]{6}$/.test(scale[shade])), scale);
  const ordered = BRAND_SHADES.every((shade, i) => i === 0 || lightness(scale[BRAND_SHADES[i - 1]]) > lightness(scale[shade]));
  check('shades: each lighter shade is lighter than the next', ordered, scale);

  // Core's teal, regenerated from its 500, lands within a few units of the
  // hand-tuned scale (6 at most today, on the 300's green).
  const teal = generateShades(DEFAULT_BRAND.colors.brand[500]);
  const drift = Math.max(...BRAND_SHADES.flatMap((shade) => {
    const [a, b] = [channels(teal[shade]), channels(DEFAULT_BRAND.colors.brand[shade])];
    return a.map((c, i) => Math.abs(c - b[i]));
  }));
  check('shades: core\'s teal comes back within 8 units per channel', drift <= 8, { drift, teal });
}

function resolving() {
  const empty = resolveBrand({ ...EMPTY_BRAND_SETTINGS });
  check('resolve: nothing set is core\'s default brand', JSON.stringify(empty) === JSON.stringify(DEFAULT_BRAND), empty);

  const set: BrandSettings = {
    ...EMPTY_BRAND_SETTINGS,
    name: 'Acme Studio',
    brandColor: '#4F46E5',
    brandShades: { 50: '#FAFAFF', 700: '#1E1B4B' },
    logoLightUrl: 'https://cdn.example/brand/light-1.png',
  };
  const acme = resolveBrand(set);
  check('resolve: the name wins and the tagline keeps the default', acme.name === 'Acme Studio' && acme.tagline === DEFAULT_BRAND.tagline);
  check('resolve: a shade override wins over the generated scale', acme.colors.brand[50] === '#FAFAFF' && acme.colors.brand[700] === '#1E1B4B', acme.colors.brand);
  check('resolve: shades not overridden come from the picked color', acme.colors.brand[500] === '#4F46E5' && acme.colors.brand[300] === generateShades('#4F46E5')[300]);
  check('resolve: with no accent set, the accent is the scale\'s 700', acme.colors.accent === '#1E1B4B', acme.colors.accent);
  const noOverride = resolveBrand({ ...set, brandShades: null });
  check('resolve: the accent falls back to the picked color\'s own 700', noOverride.colors.accent === generateShades('#4F46E5')[700], noOverride.colors.accent);
  check('resolve: a set accent wins', resolveBrand({ ...set, accentColor: '#C27C4E' }).colors.accent === '#C27C4E');
  check('resolve: the dark logo falls back to the light one', acme.logos.dark === set.logoLightUrl && acme.logos.light === set.logoLightUrl, acme.logos);
  const both = resolveBrand({ ...set, logoDarkUrl: 'https://cdn.example/brand/dark-1.png' });
  check('resolve: an uploaded dark logo is used for dark', both.logos.dark === 'https://cdn.example/brand/dark-1.png');
  check('resolve: no logo stays null, so screens show the name', empty.logos.light === null && empty.logos.dark === null && empty.logos.favicon === null);
}

function parsing() {
  const ok = parseBrandInput({ name: '  Acme  ', tagline: '   ', brandColor: '#4f46e5', accentColor: '', invertLogoInSidebar: true });
  check('parse: a valid body parses', ok.error === null, ok.error);
  check('parse: text is trimmed', ok.data?.name === 'Acme', ok.data);
  check('parse: blank text and a blank color become null', ok.data?.tagline === null && ok.data?.accentColor === null && ok.data?.description === null, ok.data);
  check('parse: colors are stored upper case', ok.data?.brandColor === '#4F46E5', ok.data);
  check('parse: flags left out are false', ok.data?.invertLogoInSidebar === true && ok.data?.showNameUnderLogo === false, ok.data);
  check('parse: a bad hex is refused', parseBrandInput({ brandColor: 'red' }).error !== null && parseBrandInput({ accentColor: '#12345' }).error !== null);
  check('parse: a name over the limit is refused', parseBrandInput({ name: 'x'.repeat(BRAND_LIMITS.name + 1) }).error !== null);
  check('parse: a name at the limit is accepted', parseBrandInput({ name: 'x'.repeat(BRAND_LIMITS.name) }).error === null);
  check('parse: a description over the limit is refused', parseBrandInput({ description: 'x'.repeat(BRAND_LIMITS.description + 1) }).error !== null);
  check('parse: a non-boolean flag is refused', parseBrandInput({ showNameUnderLogo: 'yes' }).error !== null);
  check('parse: text that is not a string is refused', parseBrandInput({ name: 42 }).error !== null);
  check('parse: projects style left out stays out, so the stored one is kept', ok.data !== null && !('sidebarProjects' in ok.data), ok.data);
  check('parse: projects as a menu is accepted', parseBrandInput({ sidebarProjects: 'menu' }).data?.sidebarProjects === 'menu');
  check('parse: an unknown projects style is refused', parseBrandInput({ sidebarProjects: 'grid' }).error !== null);
  const oldRow = { name: null, tagline: null, description: null, brand_color: null, brand_shades: null, accent_color: null, logo_light_path: null, logo_dark_path: null, favicon_path: null, invert_logo_in_sidebar: false, show_name_under_logo: false } as WorkspaceBrandRow;
  check('row: a database without the column reads projects as a list', rowToSettings(oldRow).sidebarProjects === 'list');
  check('row: a stored menu reads as a menu', rowToSettings({ ...oldRow, sidebar_projects: 'menu' }).sidebarProjects === 'menu');
  check('resolve: the projects style carries to the brand', resolveBrand({ ...EMPTY_BRAND_SETTINGS, sidebarProjects: 'menu' }).sidebarProjects === 'menu' && DEFAULT_BRAND.sidebarProjects === 'list');
  check('parse: a body that is not an object is refused', parseBrandInput(null).error !== null && parseBrandInput([]).error !== null);
  check('parse: shades that are not an object are refused', parseBrandInput({ brandShades: ['#FFFFFF'] }).error !== null);
}

function cleaning() {
  const cleaned = cleanShades({ 50: '#ffffff', 100: 'red', 500: '#12345', 900: '#000000', 700: '#1e1b4b' });
  check('clean: only valid shades survive, upper cased', JSON.stringify(cleaned) === JSON.stringify({ 50: '#FFFFFF', 700: '#1E1B4B' }), cleaned);
  check('clean: nothing valid is null', cleanShades({ 100: 'red' }) === null && cleanShades('#fff') === null && cleanShades(['#FFFFFF']) === null);
}

function sniffing() {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const ico = new Uint8Array([0, 0, 1, 0, 1, 0]);
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  check('sniff: PNG is accepted for every kind', ['light', 'dark', 'favicon'].every((kind) => sniffImage(png, kind as 'light')?.ext === 'png'));
  check('sniff: JPEG is accepted', sniffImage(jpeg, 'light')?.contentType === 'image/jpeg');
  check('sniff: ICO is accepted for the favicon', sniffImage(ico, 'favicon')?.ext === 'ico');
  check('sniff: ICO is refused for a logo', sniffImage(ico, 'light') === null && sniffImage(ico, 'dark') === null);
  check('sniff: SVG text is refused', sniffImage(svg, 'light') === null && sniffImage(svg, 'favicon') === null);
  check('sniff: too few bytes are refused', sniffImage(new Uint8Array([0x89, 0x50]), 'light') === null);
}

/** The error a statement raises, or null when it runs. */
async function failure(db: PGlite, sql: string): Promise<string | null> {
  try {
    await db.exec(sql);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

/** The 1.x migrations on the schema before them (in public, as 1.x had it): they run, and re-run safely. */
async function upgrade() {
  const db = await createFullSchemaDatabase({ schemaSql: schemaBeforeMigration('20261121001500_workspace_brand.sql') });
  await db.exec(MIGRATION_SQL);
  await db.exec(MIGRATION_SQL);
  await db.exec(SIDEBAR_SQL);
  await db.exec(SIDEBAR_SQL);
  const rows = await db.query<{ n: number; s: string }>('SELECT count(*)::int AS n, min(sidebar_projects) AS s FROM public.workspace_brand');
  check('upgrade: the migrations re-run and leave one brand row, projects as a list', rows.rows[0].n === 1 && rows.rows[0].s === 'list', rows.rows);
  await db.close();
}

async function database() {
  const db = await createFullSchemaDatabase();

  await actAs(db, null);
  const rows = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM pm.workspace_brand');
  check('db: the brand table has exactly one row', rows.rows[0].n === 1, rows.rows);
  const fresh = await db.query<{ name: string | null; brand_color: string | null }>('SELECT name, brand_color FROM pm.workspace_brand');
  check('db: the row starts empty (core\'s defaults)', fresh.rows[0].name === null && fresh.rows[0].brand_color === null, fresh.rows);
  check('db: a second row is refused', !!(await failure(db, 'INSERT INTO pm.workspace_brand (id) VALUES (false)')));

  // Storage belongs to the database owner in the stand-ins, as on Supabase.
  await db.exec('RESET ROLE');
  const bucket = await db.query<{ public: boolean; allowed_mime_types: string[] }>("SELECT public, allowed_mime_types FROM storage.buckets WHERE id = 'pm-brand'");
  check('db: the brand bucket is public and refuses SVG', bucket.rows[0]?.public === true && !bucket.rows[0].allowed_mime_types.some((type) => type.includes('svg')), bucket.rows);

  await db.exec('RESET ROLE');
  await db.exec('SET ROLE anon');
  const anon = await db.query('SELECT name FROM pm.workspace_brand');
  check('db: anon can read the brand (sign-in page, portal)', anon.rows.length === 1);
  check('db: anon cannot change it', !!(await failure(db, "UPDATE pm.workspace_brand SET name = 'x'")));

  await actAs(db, '00000000-0000-0000-0000-00000000b001');
  const member = await db.query('SELECT name FROM pm.workspace_brand');
  check('db: a signed-in member can read the brand', member.rows.length === 1);
  check('db: a signed-in member cannot insert', !!(await failure(db, 'INSERT INTO pm.workspace_brand (id) VALUES (true) ON CONFLICT DO NOTHING')));
  check('db: a signed-in member cannot update', !!(await failure(db, "UPDATE pm.workspace_brand SET name = 'Hijacked'")));
  check('db: a signed-in member cannot delete', !!(await failure(db, 'DELETE FROM pm.workspace_brand')));

  await actAs(db, null);
  check('db: the service role can update', (await failure(db, "UPDATE pm.workspace_brand SET name = 'Acme', brand_color = '#4F46E5'")) === null);
  check('db: a bad brand color is refused', !!(await failure(db, "UPDATE pm.workspace_brand SET brand_color = 'red'")));
  check('db: a bad accent color is refused', !!(await failure(db, "UPDATE pm.workspace_brand SET accent_color = '#12345'")));
  check('db: a name over 60 characters is refused', !!(await failure(db, `UPDATE pm.workspace_brand SET name = '${'x'.repeat(61)}'`)));
  check('db: projects start as a list', (await db.query<{ s: string }>('SELECT sidebar_projects AS s FROM pm.workspace_brand')).rows[0]?.s === 'list');
  check('db: projects as a menu is stored', (await failure(db, "UPDATE pm.workspace_brand SET sidebar_projects = 'menu'")) === null);
  check('db: an unknown projects style is refused', !!(await failure(db, "UPDATE pm.workspace_brand SET sidebar_projects = 'grid'")));
  check('db: shades that are not an object are refused', !!(await failure(db, `UPDATE pm.workspace_brand SET brand_shades = '["#FFFFFF"]'`)));
  const after = await db.query<{ name: string; brand_color: string }>('SELECT name, brand_color FROM pm.workspace_brand');
  check('db: a refused write leaves the row as it was', after.rows[0].name === 'Acme' && after.rows[0].brand_color === '#4F46E5', after.rows);
  await db.close();
}

async function main() {
  shades();
  resolving();
  parsing();
  cleaning();
  sniffing();
  await upgrade();
  await database();

  console.log(`${passed} checks passed`);
  if (failures.length) {
    console.error(`${failures.length} failed:\n- ${failures.join('\n- ')}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
