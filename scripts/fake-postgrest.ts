/**
 * A small stand-in for Supabase's PostgREST over a pglite database, for
 * tests that run real server code with the real supabase-js client (a copy
 * of admin/scripts/fake-postgrest.ts). It serves only plain requests: rpc
 * calls; selects with eq/neq/is/gte/lte/gt/lt/in/or and not.<op> filters,
 * order, limit and offset, exact counts (Prefer: count=exact) and one level
 * of embedded resources found through a foreign key; inserts, updates and
 * deletes. `handle` can serve other paths (a Storage stand-in). Every request
 * runs in its own transaction as service_role with service_role claims and no
 * user, the way PostgREST runs a service-key request. Requests are serialized
 * because pglite has one connection.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { PGlite } from "@electric-sql/pglite";

const IDENT = /^[a-z_][a-z0-9_]*$/;
const ident = (name: string) => {
  if (!IDENT.test(name)) throw new Error(`Unsupported identifier ${name}`);
  return `"${name}"`;
};

function body(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => resolve(text));
    request.on("error", reject);
  });
}

function scalar(value: unknown) {
  return value !== null && typeof value === "object" ? JSON.stringify(value) : value;
}

function filter(column: string, expression: string, params: unknown[]): string {
  if (expression.startsWith("not.")) return `NOT (${filter(column, expression.slice(4), params)})`;
  const dot = expression.indexOf(".");
  const op = expression.slice(0, dot);
  const value = expression.slice(dot + 1);
  const col = ident(column);
  const bind = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  switch (op) {
    case "eq":
      return `${col}::text = ${bind(value)}`;
    case "neq":
      return `${col}::text <> ${bind(value)}`;
    case "gte":
      return `${col} >= ${bind(value)}`;
    case "lte":
      return `${col} <= ${bind(value)}`;
    case "gt":
      return `${col} > ${bind(value)}`;
    case "lt":
      return `${col} < ${bind(value)}`;
    case "is":
      if (value === "null") return `${col} IS NULL`;
      if (value === "true" || value === "false") return `${col} IS ${value.toUpperCase()}`;
      throw new Error(`Unsupported is.${value}`);
    case "in": {
      const items = value.replace(/^\(|\)$/g, "").split(",").filter(Boolean);
      return items.length ? `${col}::text IN (${items.map((item) => bind(item.replace(/^"|"$/g, ""))).join(", ")})` : "FALSE";
    }
    default:
      throw new Error(`Unsupported operator ${op}`);
  }
}

/** Splits a select list at top-level commas (not inside an embed's parentheses). */
function splitSelect(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

type Embed = { key: string; table: string; columns: string };

function parseSelect(value: string | null): { columns: string[] | null; embeds: Embed[] } {
  if (!value || value === "*") return { columns: null, embeds: [] };
  const columns: string[] = [];
  const embeds: Embed[] = [];
  for (const part of splitSelect(value)) {
    const embed = /^(?:([a-z_][a-z0-9_]*):)?([a-z_][a-z0-9_]*)(?:![a-z0-9_]+)?\((.*)\)$/.exec(part);
    if (embed) embeds.push({ key: embed[1] ?? embed[2], table: embed[2], columns: embed[3] });
    else if (part === "*") columns.push("*");
    else columns.push(part);
  }
  return { columns, embeds };
}

export type ExtraHandler = (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean>;

/** maxRows plays PostgREST's db-max-rows: no select returns more rows than this. */
export async function startFakePostgrest(db: PGlite, options: { maxRows?: number; handle?: ExtraHandler } = {}) {
  const maxRows = options.maxRows ?? 1000;
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);
    return run;
  };

  // Array columns take JS arrays (pglite writes a Postgres array); everything
  // else that is an object goes in as JSON, the way PostgREST reads a body.
  const arrayColumns = new Map<string, Set<string>>();
  const columnValue = async (table: string, column: string, value: unknown) => {
    if (!Array.isArray(value)) return scalar(value);
    if (!arrayColumns.has(table)) {
      const result = await db.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND data_type = 'ARRAY'",
        [table],
      );
      arrayColumns.set(table, new Set(result.rows.map((row) => row.column_name)));
    }
    return arrayColumns.get(table)!.has(column) ? value : scalar(value);
  };

  const asService = <T>(work: () => Promise<T>) =>
    serialized(async () => {
      await db.exec("RESET ROLE; BEGIN; SET LOCAL ROLE service_role;");
      await db.query("SELECT set_config('request.jwt.claims',$1,true), set_config('request.jwt.claim.sub','',true)", [
        JSON.stringify({ role: "service_role" }),
      ]);
      try {
        const result = await work();
        await db.exec("COMMIT;");
        return result;
      } catch (error) {
        await db.exec("ROLLBACK;");
        throw error;
      }
    });

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", "http://localhost");
    const send = (status: number, payload?: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, { "Content-Type": "application/json", ...headers });
      response.end(payload === undefined ? "" : JSON.stringify(payload));
    };
    const fail = (error: unknown) => {
      const code = (error as { code?: string }).code ?? "P0001";
      send(code === "23505" ? 409 : 400, { code, message: (error as Error).message, details: null, hint: null });
    };
    const rest = url.pathname.replace(/^\/rest\/v1\//, "");

    try {
      if (options.handle && (await options.handle(request, response, url))) return;
      if (rest.startsWith("rpc/") && request.method === "POST") {
        const fn = rest.slice(4);
        const args = JSON.parse((await body(request)) || "{}") as Record<string, unknown>;
        const params: unknown[] = [];
        const named = Object.entries(args).map(([key, value]) => {
          params.push(scalar(value));
          return `${ident(key)} => $${params.length}`;
        });
        const result = await asService(() => db.query<{ r: unknown }>(`SELECT public.${ident(fn)}(${named.join(", ")}) AS r`, params));
        return send(200, result.rows[0]?.r ?? null);
      }

      const table = ident(rest);
      if (request.method === "GET" || request.method === "HEAD") {
        const params: unknown[] = [];
        const where: string[] = [];
        let order = "";
        let limit = maxRows;
        let offset = 0;
        const select = parseSelect(url.searchParams.get("select"));
        for (const [key, value] of url.searchParams) {
          if (key === "select") continue;
          else if (key === "order")
            order =
              " ORDER BY " +
              value
                .split(",")
                .map((part) => {
                  const [col, dir] = part.split(".");
                  return `${ident(col)} ${dir === "desc" ? "DESC" : "ASC"}`;
                })
                .join(", ");
          else if (key === "limit") limit = Math.min(maxRows, Number(value));
          else if (key === "offset") offset = Number(value);
          else if (key === "or") {
            const parts = value.replace(/^\(|\)$/g, "").split(",");
            where.push(
              "(" +
                parts
                  .map((part) => {
                    const [col, ...rest] = part.split(".");
                    return filter(col, rest.join("."), params);
                  })
                  .join(" OR ") +
                ")",
            );
          } else where.push(filter(key, value, params));
        }
        const whereSql = where.length ? " WHERE " + where.join(" AND ") : "";
        const counted = (request.headers.prefer ?? "").includes("count=exact");
        const { rows, total } = await asService(async () => {
          const found = (await db.query<Record<string, unknown>>(`SELECT * FROM public.${table}${whereSql}${order} LIMIT ${limit} OFFSET ${offset}`, params)).rows;
          for (const embed of select.embeds) {
            const child = ident(embed.table);
            const childColumns = embed.columns === "*" ? "*" : embed.columns.split(",").map((c) => ident(c.trim())).join(", ");
            const fk = async (from: string, to: string) =>
              (await db.query<{ from_col: string; to_col: string }>(
                `SELECT a.attname AS from_col, af.attname AS to_col FROM pg_constraint c
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
                 JOIN pg_attribute af ON af.attrelid = c.confrelid AND af.attnum = c.confkey[1]
                 WHERE c.contype = 'f' AND c.conrelid = $1::regclass AND c.confrelid = $2::regclass LIMIT 1`,
                [`public.${from}`, `public.${to}`],
              )).rows[0];
            const many = await fk(embed.table, rest);
            const one = many ? undefined : await fk(rest, embed.table);
            if (!many && !one) throw new Error(`No relationship between ${rest} and ${embed.table}`);
            for (const row of found) {
              if (many) {
                row[embed.key] = (await db.query(`SELECT ${childColumns} FROM public.${child} WHERE ${ident(many.from_col)}::text = $1`, [String(row[many.to_col])])).rows;
              } else if (one) {
                const value = row[one.from_col];
                row[embed.key] = value == null ? null : (await db.query(`SELECT ${childColumns} FROM public.${child} WHERE ${ident(one.to_col)}::text = $1`, [String(value)])).rows[0] ?? null;
              }
            }
          }
          const total = counted
            ? Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${table}${whereSql}`, params)).rows[0].n)
            : null;
          return { rows: found, total };
        });
        const projected = select.columns === null || select.columns.includes("*")
          ? rows
          : rows.map((row) => {
              const out: Record<string, unknown> = {};
              for (const column of select.columns ?? []) out[column] = row[ident(column).slice(1, -1)];
              for (const embed of select.embeds) out[embed.key] = row[embed.key];
              return out;
            });
        const headers: Record<string, string> = {};
        if (total !== null) headers["Content-Range"] = projected.length ? `${offset}-${offset + projected.length - 1}/${total}` : `*/${total}`;
        if (request.method === "HEAD") return send(200, undefined, headers);
        if ((request.headers.accept ?? "").includes("vnd.pgrst.object+json")) {
          if (projected.length !== 1)
            return send(406, { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: `The result contains ${projected.length} rows`, hint: null });
          return send(200, projected[0], headers);
        }
        return send(200, projected, headers);
      }

      if (request.method === "DELETE") {
        const params: unknown[] = [];
        const where: string[] = [];
        for (const [key, value] of url.searchParams) {
          if (key === "select" || key === "columns") continue;
          where.push(filter(key, value, params));
        }
        const rows = (await asService(() => db.query(`DELETE FROM public.${table}${where.length ? " WHERE " + where.join(" AND ") : ""} RETURNING *`, params))).rows;
        const returning = (request.headers.prefer ?? "").includes("return=representation");
        return returning ? send(200, rows) : send(204);
      }

      if (request.method === "POST") {
        const payload = JSON.parse(await body(request)) as Record<string, unknown> | Record<string, unknown>[];
        const records = Array.isArray(payload) ? payload : [payload];
        const returning = (request.headers.prefer ?? "").includes("return=representation");
        const out: unknown[] = [];
        await asService(async () => {
          for (const record of records) {
            const keys = Object.keys(record);
            const params = await Promise.all(keys.map((key) => columnValue(rest, key, record[key])));
            const result = await db.query(
              `INSERT INTO public.${table} (${keys.map(ident).join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})${returning ? " RETURNING *" : ""}`,
              params,
            );
            out.push(...result.rows);
          }
        });
        return returning ? send(201, Array.isArray(payload) ? out : out[0]) : send(201);
      }
      if (request.method === "PATCH") {
        const changes = JSON.parse(await body(request)) as Record<string, unknown>;
        const keys = Object.keys(changes);
        if (keys.length === 0) return send(400, { code: "PGRST000", message: "Empty update" });
        const params: unknown[] = await Promise.all(keys.map((key) => columnValue(rest, key, changes[key])));
        const where: string[] = [];
        for (const [key, value] of url.searchParams) {
          if (key === "select" || key === "columns") continue;
          where.push(filter(key, value, params));
        }
        const sql = `UPDATE public.${table} SET ${keys.map((key, i) => `${ident(key)} = $${i + 1}`).join(", ")}${
          where.length ? " WHERE " + where.join(" AND ") : ""
        } RETURNING *`;
        const rows = (await asService(() => db.query(sql, params))).rows;
        if ((request.headers.accept ?? "").includes("vnd.pgrst.object+json")) {
          if (rows.length !== 1)
            return send(406, {
              code: "PGRST116",
              message: "JSON object requested, multiple (or no) rows returned",
              details: `The result contains ${rows.length} rows`,
              hint: null,
            });
          return send(200, rows[0]);
        }
        return send(200, rows);
      }
      return send(404, { code: "PGRST000", message: `Unsupported ${request.method} ${url.pathname}` });
    } catch (error) {
      return fail(error);
    }
  }

  const server = createServer((request, response) => void handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
