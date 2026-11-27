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
  LOGO_KINDS,
  cleanShades,
  generateShades,
  logoKindFor,
  logoKindShape,
  logoKindTheme,
  resolveBrand,
  type BrandSettings,
} from '../src/lib/brand';
import { rowToSettings, type WorkspaceBrandRow } from '../src/lib/brand/resolve';
import { BRAND_LIMITS, imageSize, parseBrandInput, sniffImage, squareCrop } from '../src/lib/brand/validate';
import { logoLuminance, logoShapeProblem, logoToneHint } from '../src/components/settings/workspace/logo-checks';

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
  // The active projects section: its own option since 2.0.2, once part of the 'list' style.
  check('parse: active projects left out stays out, so the stored value is kept', ok.data !== null && !('sidebarActiveProjects' in ok.data), ok.data);
  check('parse: active projects off is accepted', parseBrandInput({ sidebarActiveProjects: false }).data?.sidebarActiveProjects === false);
  check('parse: a non-boolean active projects is refused', parseBrandInput({ sidebarActiveProjects: 'yes' }).error !== null);
  check('row: without the column, a list workspace keeps its section', rowToSettings(oldRow).sidebarActiveProjects === true);
  check('row: without the column, a menu workspace keeps none', rowToSettings({ ...oldRow, sidebar_projects: 'menu' }).sidebarActiveProjects === false);
  check('row: a stored value wins over the style', rowToSettings({ ...oldRow, sidebar_projects: 'menu', sidebar_active_projects: true }).sidebarActiveProjects === true
    && rowToSettings({ ...oldRow, sidebar_projects: 'list', sidebar_active_projects: false }).sidebarActiveProjects === false);
  check('resolve: active projects carry to the brand, on by default', resolveBrand({ ...EMPTY_BRAND_SETTINGS, sidebarActiveProjects: false }).sidebarActiveProjects === false
    && DEFAULT_BRAND.sidebarActiveProjects === true && EMPTY_BRAND_SETTINGS.sidebarActiveProjects === true);
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
  check('db: active projects start shown', (await db.query<{ v: boolean }>('SELECT sidebar_active_projects AS v FROM pm.workspace_brand')).rows[0]?.v === true);
  check('db: active projects off is stored', (await failure(db, 'UPDATE pm.workspace_brand SET sidebar_active_projects = false')) === null);
  check('db: shades that are not an object are refused', !!(await failure(db, `UPDATE pm.workspace_brand SET brand_shades = '["#FFFFFF"]'`)));
  const after = await db.query<{ name: string; brand_color: string }>('SELECT name, brand_color FROM pm.workspace_brand');
  check('db: a refused write leaves the row as it was', after.rows[0].name === 'Acme' && after.rows[0].brand_color === '#4F46E5', after.rows);
  await db.close();
}

/**
 * 20261123000200 on a 2.0 database from before it: each workspace keeps what
 * its sidebar showed (the section came with 'list' only), and a second run
 * changes nothing.
 */
async function activeProjectsMigration() {
  const migration = readFileSync(join(__dirname, '..', 'supabase', 'migrations', '20261123000200_sidebar_active_projects.sql'), 'utf8');
  for (const style of ['list', 'menu'] as const) {
    const db = await createFullSchemaDatabase();
    await db.exec('ALTER TABLE pm.workspace_brand DROP COLUMN sidebar_active_projects');
    await db.exec(`UPDATE pm.workspace_brand SET sidebar_projects = '${style}'`);
    await db.exec(migration);
    const first = (await db.query<{ v: boolean }>('SELECT sidebar_active_projects AS v FROM pm.workspace_brand')).rows[0]?.v;
    check(`migration: a ${style} workspace ${style === 'list' ? 'keeps' : 'gets no'} active projects section`, first === (style === 'list'), first);
    await db.exec('UPDATE pm.workspace_brand SET sidebar_active_projects = NOT sidebar_active_projects');
    await db.exec(migration);
    const second = (await db.query<{ v: boolean }>('SELECT sidebar_active_projects AS v FROM pm.workspace_brand')).rows[0]?.v;
    check(`migration: a second run keeps a ${style} workspace's own choice`, second === (style !== 'list'), second);
    await db.close();
  }
}

/** Settings cleanup (SE1): four logo slots on the old three columns plus one, their fallbacks and guards. */
function logoSlots() {
  const base = { ...EMPTY_BRAND_SETTINGS, logoLightUrl: 'https://cdn.example/brand/light-1.png', faviconUrl: 'https://cdn.example/brand/favicon-1.png' };
  check('slots: four kinds, the old three kept by name', JSON.stringify(LOGO_KINDS) === JSON.stringify(['light', 'dark', 'favicon', 'square_dark']), LOGO_KINDS);
  check('slots: light and dark are horizontal, favicon and square_dark square', logoKindShape('light') === 'horizontal' && logoKindShape('dark') === 'horizontal'
    && logoKindShape('favicon') === 'square' && logoKindShape('square_dark') === 'square');
  check('slots: shape and theme name the slot back', LOGO_KINDS.every((kind) => logoKindFor(logoKindShape(kind), logoKindTheme(kind)) === kind));
  check('resolve: no square dark logo falls back to the square light one', resolveBrand(base).logos.squareDark === base.faviconUrl, resolveBrand(base).logos);
  const both = resolveBrand({ ...base, squareDarkUrl: 'https://cdn.example/brand/square_dark-1.png' });
  check('resolve: an uploaded square dark logo is used for dark', both.logos.squareDark === 'https://cdn.example/brand/square_dark-1.png' && both.logos.favicon === base.faviconUrl, both.logos);
  check('resolve: nothing uploaded leaves every slot empty', JSON.stringify(resolveBrand(EMPTY_BRAND_SETTINGS).logos) === JSON.stringify({ light: null, dark: null, favicon: null, squareDark: null }));
  const oldRow = { name: null, tagline: null, description: null, brand_color: null, brand_shades: null, accent_color: null, logo_light_path: 'light-1.png', logo_dark_path: null, favicon_path: 'favicon-1.png', invert_logo_in_sidebar: false, show_name_under_logo: false } as WorkspaceBrandRow;
  const oldSettings = rowToSettings(oldRow, 'https://db.example');
  check('row: a database before the migration reads no square dark logo, the others as before', oldSettings.squareDarkUrl === null
    && oldSettings.faviconUrl === 'https://db.example/storage/v1/object/public/pm-brand/favicon-1.png'
    && oldSettings.logoLightUrl === 'https://db.example/storage/v1/object/public/pm-brand/light-1.png', oldSettings);
  check('row: a stored square dark logo reads back', rowToSettings({ ...oldRow, logo_square_dark_path: 'square_dark-2.png' }, 'https://db.example').squareDarkUrl === 'https://db.example/storage/v1/object/public/pm-brand/square_dark-2.png');

  const ico = new Uint8Array([0, 0, 1, 0, 1, 0]);
  check('sniff: ICO is accepted for the dark square logo too', sniffImage(ico, 'square_dark')?.ext === 'ico');

  // A 400 by 100 PNG header, and a JPEG whose frame header says 120 wide, 80 tall after an APP0 segment.
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0x90, 0, 0, 0, 100]);
  check('size: a PNG header gives width and height', JSON.stringify(imageSize(png)) === JSON.stringify({ width: 400, height: 100 }), imageSize(png));
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0, 80, 0, 120, 3, 0, 0, 0, 0]);
  check('size: a JPEG frame header gives width and height', JSON.stringify(imageSize(jpeg)) === JSON.stringify({ width: 120, height: 80 }), imageSize(jpeg));
  check('size: anything else has none', imageSize(new TextEncoder().encode('<svg></svg>')) === null && imageSize(new Uint8Array([0xff, 0xd8])) === null);
  check('crop: a wide logo fills the square\'s height from its left edge', JSON.stringify(squareCrop({ width: 400, height: 100 }, 64)) === JSON.stringify({ width: 256, height: 64, left: 0 }));
  check('crop: a narrow logo is fitted and centered', JSON.stringify(squareCrop({ width: 50, height: 100 }, 64)) === JSON.stringify({ width: 32, height: 64, left: 16 }));

  check('guard: a square image on a horizontal slot belongs in Square', logoShapeProblem('horizontal', { width: 512, height: 512 })?.belongs === 'square');
  check('guard: a wide image on a square slot belongs in Horizontal', logoShapeProblem('square', { width: 800, height: 200 })?.belongs === 'horizontal');
  check('guard: a wide image fits a horizontal slot, a square one a square slot', logoShapeProblem('horizontal', { width: 800, height: 200 }) === null && logoShapeProblem('square', { width: 500, height: 480 }) === null);
  check('guard: a size it cannot read is let through', logoShapeProblem('square', null) === null && logoShapeProblem('horizontal', { width: 0, height: 0 }) === null);

  const pixels = (rgba: number[], count: number) => Array.from({ length: count }, () => rgba).flat();
  const whiteOnClear = logoLuminance([...pixels([255, 255, 255, 255], 10), ...pixels([0, 0, 0, 0], 10)]);
  const blackOnClear = logoLuminance([...pixels([0, 0, 0, 255], 10), ...pixels([0, 0, 0, 0], 10)]);
  const whiteBox = logoLuminance(pixels([255, 255, 255, 255], 20));
  check('tone: a white mark on a clear background reads light and see-through', whiteOnClear?.luminance === 1 && whiteOnClear.transparent, whiteOnClear);
  check('tone: a fully clear image has no tone', logoLuminance(pixels([255, 255, 255, 0], 4)) === null);
  check('hint: a light see-through logo warns on the light theme only', !!logoToneHint('light', whiteOnClear) && logoToneHint('dark', whiteOnClear) === null);
  check('hint: a dark see-through logo warns on the dark theme only', !!logoToneHint('dark', blackOnClear) && logoToneHint('light', blackOnClear) === null);
  check('hint: a logo with its own background never warns', logoToneHint('light', whiteBox) === null);
}

async function squareDarkMigration() {
  const migration = readFileSync(join(__dirname, '..', 'supabase', 'migrations', '20261127003100_settings_cleanup.sql'), 'utf8');
  const db = await createFullSchemaDatabase();
  await db.exec('ALTER TABLE pm.workspace_brand DROP COLUMN logo_square_dark_path');
  await db.exec("UPDATE pm.workspace_brand SET favicon_path = 'favicon-1.png'");
  await db.exec(migration);
  await db.exec(migration);
  const row = (await db.query<{ favicon_path: string | null; logo_square_dark_path: string | null }>('SELECT favicon_path, logo_square_dark_path FROM pm.workspace_brand')).rows[0];
  check('migration: the square dark column is added empty, twice over, and the square logo stays', row?.favicon_path === 'favicon-1.png' && row.logo_square_dark_path === null, row);
  const fresh = await createFullSchemaDatabase();
  const column = await fresh.query("SELECT 1 FROM information_schema.columns WHERE table_schema = 'pm' AND table_name = 'workspace_brand' AND column_name = 'logo_square_dark_path'");
  check('schema: a fresh install has the square dark column', column.rows.length === 1);
  await fresh.close();
  await db.close();
}

async function main() {
  shades();
  resolving();
  parsing();
  cleaning();
  sniffing();
  logoSlots();
  await upgrade();
  await database();
  await activeProjectsMigration();
  await squareDarkMigration();

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
