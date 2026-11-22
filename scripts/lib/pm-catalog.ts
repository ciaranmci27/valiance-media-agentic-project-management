/**
 * A comparable snapshot of everything in schema `pm`: what a fresh 2.0
 * install builds and what a 1.x install has after the move must match.
 * Permissions are compared as effective grants to PUBLIC and the API roles
 * (an object's owner always has everything), so equivalent ACLs written in a
 * different order or form still compare equal.
 */
import type { PGlite } from '@electric-sql/pglite';

export type Snapshot = Record<string, string>;

const API_GRANTEES = `('anon', 'authenticated', 'service_role')`;

async function rows<T>(db: PGlite, sql: string): Promise<T[]> {
  return (await db.query<T>(sql)).rows;
}

/** Key -> value lines for every object in `schema`; compare two with diffSnapshots. */
export async function pmSnapshot(db: PGlite, schema = 'pm'): Promise<Snapshot> {
  await db.exec(`SET search_path = ${schema}, public`);
  const out: Snapshot = {};
  const put = (key: string, value: unknown) => { out[key] = typeof value === 'string' ? value : JSON.stringify(value); };
  const ns = `'${schema}'`;

  for (const r of await rows<{ name: string; kind: string; rls: boolean; force: boolean }>(db, `
    SELECT c.relname name, c.relkind::text kind, c.relrowsecurity rls, c.relforcerowsecurity force
    FROM pg_class c WHERE c.relnamespace = ${ns}::regnamespace AND c.relkind IN ('r','p','v','m','S')`)) {
    put(`rel ${r.name}`, { kind: r.kind, rls: r.rls, force: r.force });
  }
  for (const r of await rows<{ t: string; c: string; type: string; nn: boolean; def: string | null; num: number }>(db, `
    SELECT c.relname t, a.attname c, format_type(a.atttypid, a.atttypmod) type, a.attnotnull nn, pg_get_expr(d.adbin, d.adrelid) def, a.attnum num
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE c.relnamespace = ${ns}::regnamespace AND c.relkind IN ('r','p','v','m') AND a.attnum > 0 AND NOT a.attisdropped`)) {
    put(`col ${r.t}.${r.c}`, { type: r.type, nn: r.nn, def: r.def });
  }
  for (const r of await rows<{ t: string; name: string; def: string }>(db, `
    SELECT c.relname t, con.conname name, pg_get_constraintdef(con.oid) def FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
    WHERE c.relnamespace = ${ns}::regnamespace`)) put(`con ${r.t}.${r.name}`, r.def);
  for (const r of await rows<{ name: string; def: string }>(db, `
    SELECT i.relname name, pg_get_indexdef(i.oid) def FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
    WHERE i.relnamespace = ${ns}::regnamespace`)) put(`idx ${r.name}`, r.def);
  for (const r of await rows<{ t: string; name: string; def: string; enabled: string }>(db, `
    SELECT c.relname t, tg.tgname name, pg_get_triggerdef(tg.oid) def, tg.tgenabled::text enabled FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
    WHERE c.relnamespace = ${ns}::regnamespace AND NOT tg.tgisinternal`)) put(`trg ${r.t}.${r.name}`, { def: r.def, enabled: r.enabled });
  for (const r of await rows<{ t: string; name: string; cmd: string; permissive: string; roles: string; qual: string | null; check: string | null }>(db, `
    SELECT tablename t, policyname name, cmd, permissive, roles::text roles, qual, with_check "check" FROM pg_policies WHERE schemaname = ${ns}`)) {
    put(`pol ${r.t}.${r.name}`, { cmd: r.cmd, permissive: r.permissive, roles: r.roles, qual: r.qual, check: r.check });
  }
  for (const r of await rows<{ name: string; def: string }>(db, `
    SELECT c.relname name, pg_get_viewdef(c.oid) def FROM pg_class c WHERE c.relnamespace = ${ns}::regnamespace AND c.relkind IN ('v','m')`)) put(`view ${r.name}`, r.def);
  for (const r of await rows<{ name: string; grantee: string; priv: string }>(db, `
    SELECT c.relname name, CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END grantee, a.privilege_type priv
    FROM pg_class c, aclexplode(c.relacl) a
    WHERE c.relnamespace = ${ns}::regnamespace AND c.relkind IN ('r','p','v','m','S')
      AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) IN ${API_GRANTEES}) ORDER BY 1, 2, 3`)) {
    const key = `acl ${r.name} ${r.grantee}`;
    out[key] = out[key] ? `${out[key]},${r.priv}` : r.priv;
  }
  // Column-level grants (members may read some columns of a table only).
  for (const r of await rows<{ t: string; c: string; grantee: string; priv: string }>(db, `
    SELECT c.relname t, a.attname c, CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END grantee, x.privilege_type priv
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid, aclexplode(a.attacl) x
    WHERE c.relnamespace = ${ns}::regnamespace AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
      AND (x.grantee = 0 OR pg_get_userbyid(x.grantee) IN ${API_GRANTEES}) ORDER BY 1, 2, 3, 4`)) {
    const key = `colacl ${r.t}.${r.c} ${r.grantee}`;
    out[key] = out[key] ? `${out[key]},${r.priv}` : r.priv;
  }
  for (const r of await rows<{ sig: string; result: string; src: string; config: string | null; secdef: boolean; vol: string; strict: boolean; lang: string; kind: string }>(db, `
    SELECT p.oid::regprocedure::text sig, pg_get_function_result(p.oid) result, p.prosrc src, array_to_string(p.proconfig, ';') config,
           p.prosecdef secdef, p.provolatile::text vol, p.proisstrict strict, l.lanname lang, p.prokind::text kind
    FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.pronamespace = ${ns}::regnamespace`)) {
    put(`fn ${r.sig}`, { result: r.result, config: r.config, secdef: r.secdef, vol: r.vol, strict: r.strict, lang: r.lang, kind: r.kind });
    put(`fnsrc ${r.sig}`, r.src.replace(/\r\n/g, '\n').trim());
  }
  for (const r of await rows<{ sig: string; grantees: string }>(db, `
    SELECT p.oid::regprocedure::text sig,
      coalesce((SELECT string_agg(g, ',' ORDER BY g) FROM (
        SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END g
        FROM aclexplode(p.proacl) a WHERE a.grantee = 0 OR pg_get_userbyid(a.grantee) IN ${API_GRANTEES}) s), '') ||
      CASE WHEN p.proacl IS NULL THEN 'PUBLIC(default)' ELSE '' END grantees
    FROM pg_proc p WHERE p.pronamespace = ${ns}::regnamespace`)) put(`fnacl ${r.sig}`, r.grantees.replace('PUBLIC(default)', 'PUBLIC'));
  for (const r of await rows<{ name: string }>(db, `
    SELECT tablename name FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = ${ns}`).catch(() => [])) put(`pub ${r.name}`, 'yes');
  for (const r of await rows<{ kind: string; acl: string }>(db, `
    SELECT d.defaclobjtype::text kind, d.defaclacl::text acl FROM pg_default_acl d WHERE d.defaclnamespace = ${ns}::regnamespace`)) put(`defacl ${r.kind}`, r.acl);
  for (const r of await rows<{ grantee: string; priv: string }>(db, `
    SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END grantee, a.privilege_type priv
    FROM pg_namespace n, aclexplode(n.nspacl) a WHERE n.nspname = ${ns}
      AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) IN ${API_GRANTEES})`)) put(`schema-acl ${r.grantee} ${r.priv}`, 'yes');
  await db.exec('RESET search_path');
  return out;
}

export function diffSnapshots(a: Snapshot, b: Snapshot, labels: [string, string] = ['fresh', 'upgraded']): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diffs: string[] = [];
  for (const key of [...keys].sort()) {
    if (a[key] === b[key]) continue;
    if (a[key] === undefined) diffs.push(`only in ${labels[1]}: ${key} = ${b[key]}`);
    else if (b[key] === undefined) diffs.push(`only in ${labels[0]}: ${key} = ${a[key]}`);
    else diffs.push(`differs: ${key}\n    ${labels[0]}: ${a[key]}\n    ${labels[1]}: ${b[key]}`);
  }
  return diffs;
}
