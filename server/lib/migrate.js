// Upgrade migrations (UPDATE.md "Upgrade plan"). Every release that changes data on disk, accounts or permissions
// ships a migration in server/migrations/: listed in manifest.json (id, version, title, detail) and implemented in
// <id>.js as `export async function up(ctx)`. Migrations are idempotent, so any older install, including one that
// never recorded a schema, can run all of them in order.
//
// Applied migrations are recorded in ~/.porthole/schema.json. Before the first pending one runs, the whole state
// folder is archived to ~/.porthole/migrate/pre-<version>-<stamp>.tar.gz; if any migration fails, that archive is
// restored, nothing is recorded and the server refuses to start (so the updater's health check rolls the code back
// too). The updater can also restore the archive after a later health-check failure (bin/porthole-update).
//
// Runs at every server start (boot()), and from the command line:
//   node server/lib/migrate.js plan  [--state DIR] [--from VERSION]   pending migrations as JSON
//   node server/lib/migrate.js apply [--state DIR]                    apply them now
//   node server/lib/migrate.js status [--state DIR]
//   node server/lib/migrate.js restore [--state DIR] [--file ARCHIVE]   put the last pre-migration archive back

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(here, '..', 'migrations');
const KEEP_BACKUPS = 5;

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, data) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file); }
export function cmpVersion(a, b) { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; }
function codeVersion() { return readJson(path.resolve(here, '..', 'package.json'), {}).version || '0.0.0'; }

export function manifest(dir = MIGRATIONS_DIR) {
    const m = readJson(path.join(dir, 'manifest.json'), { migrations: [] });
    return (m.migrations || []).slice().sort((a, b) => cmpVersion(a.version, b.version) || String(a.id).localeCompare(String(b.id)));
}

export function schema(state) {
    return readJson(path.join(state, 'schema.json'), { version: null, applied: [] });
}

// What would run: every migration not yet applied whose version is at most the code's version.
export function plan({ state, dir = MIGRATIONS_DIR, upTo = codeVersion() } = {}) {
    const done = new Set((schema(state).applied || []).map(a => a.id));
    return manifest(dir).filter(m => !done.has(m.id) && cmpVersion(m.version, upTo) <= 0);
}

async function backup(state, label) {
    const dir = path.join(state, 'migrate');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `pre-${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`);
    await run('tar', ['-czf', file, '-C', state, '--exclude=./migrate', '--exclude=./update.lock', '--exclude=*.log', '.'], { timeout: 300_000 });
    fs.chmodSync(file, 0o600);
    const old = fs.readdirSync(dir).filter(f => /^pre-.*\.tar\.gz$/.test(f)).sort();
    for (const f of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) fs.rmSync(path.join(dir, f), { force: true });
    return file;
}

// Put the state folder back exactly as the archive has it (migrate/ and the update lock/log are left alone).
export async function restore(state, file) {
    for (const e of fs.readdirSync(state)) {
        if (e === 'migrate' || e === 'update.lock' || e.endsWith('.log')) continue;
        fs.rmSync(path.join(state, e), { recursive: true, force: true });
    }
    await run('tar', ['-xzf', file, '-C', state], { timeout: 300_000 });
}

export async function apply({ state, dir = MIGRATIONS_DIR, log = console.log } = {}) {
    const pending = plan({ state, dir });
    const sc = schema(state);
    const to = codeVersion();
    if (!pending.length) {
        if (sc.version !== to) { fs.mkdirSync(state, { recursive: true }); writeJson(path.join(state, 'schema.json'), { ...sc, applied: sc.applied || [], version: to, updatedAt: Date.now() }); }
        return { applied: [], backup: null };
    }
    const archive = await backup(state, sc.version || 'unknown');
    log(`migrate: ${pending.length} pending (${pending.map(m => m.id).join(', ')}); state archived to ${archive}`);
    const applied = [];
    for (const m of pending) {
        const started = Date.now();
        try {
            const mod = await import(pathToFileURL(path.join(dir, `${m.id}.js`)).href);
            const out = await mod.up({ state, from: sc.version, to, log: msg => log(`migrate ${m.id}: ${msg}`) });
            applied.push({ id: m.id, version: m.version, at: Date.now(), ms: Date.now() - started, ...(out && typeof out === 'object' ? { result: out } : {}) });
            log(`migrate: ${m.id} done (${Date.now() - started} ms)`);
        } catch (e) {
            log(`migrate: ${m.id} FAILED: ${e.message}; restoring ${archive}`);
            try { await restore(state, archive); } catch (r) { log(`migrate: restore failed too: ${r.message} — restore ${archive} by hand`); }
            const err = new Error(`Migration ${m.id} failed: ${e.message}. State restored from ${path.basename(archive)}.`);
            err.migration = m.id; err.backup = archive;
            throw err;
        }
    }
    const next = { version: to, applied: [...(sc.applied || []), ...applied], updatedAt: Date.now(), lastBackup: archive, lastRun: { from: sc.version, to, at: Date.now(), ids: applied.map(a => a.id) } };
    writeJson(path.join(state, 'schema.json'), next);
    return { applied, backup: archive };
}

// Server start: apply what is pending, or throw (the caller exits so nothing runs on half-migrated state).
export async function boot(state, log) { return apply({ state, log }); }

// ---- CLI ----
// Run as a CLI when this file is the script, even through a symlinked path (2.0: /opt/porthole → /opt/platopypus).
const realOf = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
if (process.argv[1] && realOf(process.argv[1]) === realOf(fileURLToPath(import.meta.url))) {
    const args = process.argv.slice(2);
    const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
    const state = opt('--state') || process.env.PORTHOLE_STATE || path.join(process.env.HOME || '/root', '.porthole');
    const dir = opt('--dir') || MIGRATIONS_DIR;
    const cmd = args[0] || 'status';
    try {
        if (cmd === 'plan') {
            const p = plan({ state, dir });
            console.log(JSON.stringify({ from: schema(state).version, to: codeVersion(), pending: p }, null, 2));
        } else if (cmd === 'apply') {
            const r = await apply({ state, dir });
            console.log(JSON.stringify(r, null, 2));
        } else if (cmd === 'restore') {
            const file = opt('--file') || schema(state).lastBackup;
            if (!file || !fs.existsSync(file)) throw new Error('No archive to restore (give --file).');
            await restore(state, file);
            console.log(JSON.stringify({ restored: file }));
        } else if (cmd === 'status') {
            console.log(JSON.stringify({ code: codeVersion(), ...schema(state), pending: plan({ state, dir }).map(m => m.id) }, null, 2));
        } else { console.error('usage: migrate.js plan|apply|status|restore [--state DIR] [--dir DIR] [--file ARCHIVE]'); process.exit(2); }
    } catch (e) { console.error(e.message); process.exit(1); }
}
