/**
 * Preloaded into every Node process of the local dev server (scripts/local/dev.mjs
 * puts it in NODE_OPTIONS), so the local test app can never reach production:
 *
 * 1. No .env file is read. Next loads .env.local (production keys) on its own,
 *    including again whenever the file changes; here every .env* file in the app
 *    reads as missing, so the only settings are the ones dev.mjs passed in.
 * 2. The process stops at once unless the Supabase URL and the database URL are
 *    this machine's.
 * 3. fetch refuses any hosted Supabase address (*.supabase.co, *.supabase.com),
 *    and with PM_E2E=1 (the end-to-end suite's server) any chat provider.
 * 4. Next builds into .next-local, apart from the app's usual dev server.
 */
'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS preload, loaded with node --require */

const fs = require('node:fs');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..', '..');
const ROOT_DIR = path.resolve(APP_DIR, '..');
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function fail(message) {
  console.error(`[local-guard] ${message}`);
  process.exit(87);
}

function hostOf(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

// 2. Only this machine's Supabase and database.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
if (process.env.PM_LOCAL_STACK !== '1') fail('Start the local app with npm run local:dev (PM_LOCAL_STACK is not set).');
if (!LOCAL_HOSTS.has(hostOf(supabaseUrl) || '')) fail(`NEXT_PUBLIC_SUPABASE_URL is not local (${hostOf(supabaseUrl) || 'unset'}). Refusing to start.`);
for (const name of ['DATABASE_URL', 'SUPABASE_DB_URL']) {
  const value = process.env[name];
  if (value && !LOCAL_HOSTS.has(hostOf(value) || '')) fail(`${name} is not local. Refusing to start.`);
}

if (process.env.PM_LOCAL_GUARD_QUIET !== '1') console.log(`[local-guard] on in pid ${process.pid}: Supabase ${supabaseUrl}`);

// 1. Every .env* file of the app (and the monorepo root) reads as missing.
const ENV_FILE = /^\.env(\..+)?$/;
function blocked(target) {
  if (typeof target !== 'string' && !(target instanceof URL)) return false;
  let full;
  try {
    full = path.resolve(target instanceof URL ? target.pathname.replace(/^\/([A-Za-z]:)/, '$1') : target);
  } catch {
    return false;
  }
  const base = path.basename(full);
  if (!ENV_FILE.test(base) || base === '.env.example') return false;
  const dir = path.dirname(full).toLowerCase();
  return dir === APP_DIR.toLowerCase() || dir === ROOT_DIR.toLowerCase();
}
function enoent(target, syscall) {
  const error = new Error(`ENOENT: no such file or directory, ${syscall} '${target}' (blocked by the local guard)`);
  error.code = 'ENOENT';
  error.errno = -2;
  error.syscall = syscall;
  error.path = String(target);
  return error;
}

let announced = false;
function note(target) {
  if (announced) return;
  announced = true;
  if (process.env.PM_LOCAL_GUARD_QUIET !== '1') console.log(`[local-guard] blocked ${path.basename(String(target))}: settings come only from scripts/local/.env.test.local`);
}

for (const name of ['readFileSync', 'statSync', 'lstatSync', 'openSync']) {
  const original = fs[name];
  fs[name] = function guarded(target, ...rest) {
    if (blocked(target)) {
      note(target);
      // statSync with throwIfNoEntry: false answers undefined for a missing file.
      if ((name === 'statSync' || name === 'lstatSync') && rest[0] && rest[0].throwIfNoEntry === false) return undefined;
      throw enoent(target, name.replace(/Sync$/, ''));
    }
    return original.call(this, target, ...rest);
  };
}
const existsSync = fs.existsSync;
fs.existsSync = function guardedExists(target) {
  if (blocked(target)) return false;
  return existsSync.call(this, target);
};
for (const name of ['readFile', 'stat', 'lstat', 'open']) {
  const original = fs.promises[name];
  fs.promises[name] = async function guarded(target, ...rest) {
    if (blocked(target)) {
      note(target);
      throw enoent(target, name);
    }
    return original.call(this, target, ...rest);
  };
  const callback = fs[name];
  fs[name] = function guardedCallback(target, ...rest) {
    if (blocked(target)) {
      note(target);
      const done = rest[rest.length - 1];
      if (typeof done === 'function') return process.nextTick(done, enoent(target, name));
    }
    return callback.call(this, target, ...rest);
  };
}

// 4. Its own build folder, .next-local: the app's usual `npm run dev` (another
//    chat, port 3009, production keys) holds .next/dev and its lock, and its
//    compiled pages carry the production URL. Next's config loader is wrapped
//    so distDir reads .next-local, and tsconfig.json and next-env.d.ts (shared
//    with that server) are never rewritten to point at it.
const DIST = '.next-local';
const Module = require('node:module');
const originalRequire = Module.prototype.require;
let wrappedConfig = null;
function relocate(config) {
  if (!config || typeof config.distDir !== 'string') return config;
  const move = (dir) => (dir === '.next' ? DIST : /^\.next[\\/]/.test(dir) ? DIST + dir.slice('.next'.length) : dir);
  config.distDir = move(config.distDir);
  if (typeof config.distDirRoot === 'string') config.distDirRoot = move(config.distDirRoot);
  return config;
}
Module.prototype.require = function guardedRequire(id) {
  const exported = originalRequire.apply(this, arguments);
  if (typeof id === 'string' && /(^|\/)config$/.test(id) && exported && exported.__esModule
    && typeof exported.default === 'function' && exported.default.name === 'loadConfig') {
    if (!wrappedConfig) {
      const loadConfig = exported.default;
      wrappedConfig = Object.create(null);
      for (const key of Object.keys(exported)) wrappedConfig[key] = exported[key];
      Object.defineProperty(wrappedConfig, '__esModule', { value: true });
      wrappedConfig.default = async function loadLocalConfig(...args) {
        return relocate(await loadConfig.apply(this, args));
      };
    }
    return wrappedConfig;
  }
  return exported;
};
const SHARED_FILES = new Set([path.join(APP_DIR, 'tsconfig.json'), path.join(APP_DIR, 'next-env.d.ts')].map((p) => p.toLowerCase()));
const isShared = (target) => typeof target === 'string' && SHARED_FILES.has(path.resolve(target).toLowerCase());
const writeFileSync = fs.writeFileSync;
fs.writeFileSync = function guardedWriteSync(target, ...rest) {
  if (isShared(target)) return undefined;
  return writeFileSync.call(this, target, ...rest);
};
const writeFile = fs.promises.writeFile;
fs.promises.writeFile = async function guardedWrite(target, ...rest) {
  if (isShared(target)) return undefined;
  return writeFile.call(this, target, ...rest);
};

// 3. No request to hosted Supabase from server code. The end-to-end suite's
//    server (PM_E2E=1) also never reaches a chat provider: its test
//    connections hold made-up tokens, and a send fails here, recorded as failed.
const HOSTED = /(^|\.)supabase\.(co|com|in)$/i;
const CHAT_PROVIDERS = /(^|\.)(telegram\.org|slack\.com|discord\.com|discordapp\.com)$/i;
if (typeof globalThis.fetch === 'function') {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function guardedFetch(input, init) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url;
    const host = url ? hostOf(url) : null;
    if (host && HOSTED.test(host)) {
      return Promise.reject(new Error(`[local-guard] refused a request to hosted Supabase (${host})`));
    }
    if (host && process.env.PM_E2E === '1' && CHAT_PROVIDERS.test(host)) {
      return Promise.reject(new Error(`[local-guard] the end-to-end server never reaches a chat provider (${host})`));
    }
    return originalFetch.call(this, input, init);
  };
}
