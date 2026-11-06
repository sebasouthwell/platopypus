// Project backups to a private S3 bucket. One archive per run: the project's `backup.paths` plus every folder a
// container service mounts (its data), as tar + zstd, with owners and ACLs kept. The service is frozen for the
// few seconds the files are read (SIGSTOP / docker pause), so databases on disk are consistent, and unfrozen
// straight after; nothing is stopped. Restore downloads one archive, stops the service, puts the folders back,
// and starts it again. Storage is the Vault entry "Backup storage (S3)" (general scope): key, secret, bucket,
// region. Optional daily run at a chosen hour; retention keeps the last N archives per project.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { log } from './log.js';
import { record } from './audit.js';
import * as vault from './vault.js';
import * as live from './live.js';
import * as services from './services.js';
import * as dockerMgr from './docker.js';
import * as alerts from './alerts.js';
import { client as s3client } from './s3.js';

const run = promisify(execFile);
const file = path.join(config.state, 'backups.json');
const tmpDir = path.join(config.state, 'backup-tmp');
const projectsDir = path.join(config.root, 'Projects');
const DEFAULT_KEEP = 14;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
function load() { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { projects: {} }; } }
function save(c) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file); }

// ---------- storage ----------

function storageItem() {
    return vault.list().find(i => i.provider === 'backup-storage' && i.scope === 'general' && !i.incomplete?.length) || null;
}
export function storage() {
    const it = storageItem();
    if (!it) return null;
    const v = vault.valuesOf(it.id);
    const f = v?.fields || {};
    return { id: it.id, name: it.name, bucket: f.bucket, region: f.region || 'eu-west-2', prefix: (f.prefix || '').replace(/^\/+|\/+$/g, ''), accessKeyId: f.accessKeyId, secretAccessKey: f.secretAccessKey, endpoint: f.endpoint || null };
}
function s3() {
    const st = storage();
    if (!st) throw httpError(412, 'Add "Backup storage (S3)" to the Vault first (More → Vault): access key, secret, bucket, region.');
    return { st, c: s3client(st) };
}
const keyFor = (st, project, name) => `${st.prefix ? st.prefix + '/' : ''}${project}/${name}`;

export function settings() {
    const c = load();
    const st = storageItem();
    return { storage: st ? { name: st.name, bucket: st.fields.find(f => f.name === 'bucket')?.hint || '', region: st.fields.find(f => f.name === 'region')?.hint || '' } : null, keep: Number(c.keep) || DEFAULT_KEEP, daily: c.daily ?? null, projects: c.projects || {} };
}
export function configure(body = {}) {
    const c = load();
    if ('keep' in body) { const n = Number(body.keep); if (!(n >= 1 && n <= 365)) throw httpError(400, 'Keep: 1 to 365 archives.'); c.keep = n; }
    if ('daily' in body) { if (body.daily === null) c.daily = null; else { const h = Number(body.daily); if (!(Number.isInteger(h) && h >= 0 && h <= 23)) throw httpError(400, 'Daily: an hour 0-23, or null.'); c.daily = h; } }
    if (body.project && typeof body.project === 'object') { c.projects = c.projects || {}; const p = c.projects[body.project.name] || {}; if ('daily' in body.project) p.daily = !!body.project.daily; c.projects[body.project.name] = p; }
    save(c);
    return settings();
}
export async function check() { const { st, c } = s3(); await c.check(); return { ok: true, bucket: st.bucket, region: st.region }; }

// ---------- what a project backs up ----------

function projectOf(name) {
    const p = live.projects().find(x => x.name === name);
    if (!p) throw httpError(404, `No project "${name}" with a PORTHOLE.md.`);
    return p;
}
// Folders relative to the project root: backup.paths from the file, plus every container volume (rw), deduplicated.
export function pathsOf(p) {
    const out = new Set();
    for (const x of Array.isArray(p.data?.backup?.paths) ? p.data.backup.paths : []) { const r = String(x).replace(/^\/+|\/+$/g, ''); if (r && !r.split('/').includes('..')) out.add(r); }
    for (const s of Object.values(p.data?.services || {})) for (const v of Array.isArray(s?.volumes) ? s.volumes : []) { const m = String(v).match(/^([^:]+):\/[^:]*(?::(ro|rw))?$/); if (m && m[2] !== 'ro') { const r = m[1].replace(/^\/+|\/+$/g, ''); if (r && !r.split('/').includes('..')) out.add(r); } }
    return [...out].filter(r => fs.existsSync(path.join(p.root, r)));
}

// Freeze the project's running services while the files are read: SIGSTOP the process groups, docker pause.
async function frozen(p, fn) {
    const regs = (await services.list().catch(() => [])).filter(r => r.alive && r.live?.project === p.name);
    const undo = [];
    for (const r of regs) {
        if (r.runAs === 'container') { try { await dockerMgr.action(r.slug, 'pause'); undo.push(() => dockerMgr.action(r.slug, 'unpause')); } catch { /* not running */ } }
        else if (r.pid) { try { process.kill(-r.pid, 'SIGSTOP'); undo.push(() => { process.kill(-r.pid, 'SIGCONT'); }); } catch { /* gone */ } }
    }
    try { return await fn(regs.map(r => r.slug)); }
    finally { for (const u of undo.reverse()) { try { await u(); } catch { /* best effort */ } } }
}

let busy = new Set();
export async function backup(project, { who = 'phone' } = {}) {
    const p = projectOf(project);
    if (busy.has(project)) throw httpError(409, 'A backup of this project is already running.');
    busy.add(project);
    const started = Date.now();
    try {
        const { st, c } = s3();
        const rels = pathsOf(p);
        if (!rels.length) throw httpError(400, 'Nothing to back up: add backup.paths to PORTHOLE.md or a container volume.');
        for (const tool of ['tar', 'zstd']) { try { await run('sh', ['-c', `command -v ${tool}`]); } catch { throw httpError(500, `${tool} is not installed on this box; run the Porthole update (it installs it).`); } }
        fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
        const stamp = new Date(started).toISOString().replace(/[:]/g, '-').replace(/\.\d{3}Z$/, 'Z');
        const name = `${stamp}.tar.zst`;
        const tmp = path.join(tmpDir, `${project}-${name}`);
        const frozenFor = await frozen(p, async slugs => {
            const t0 = Date.now();
            await new Promise((ok, no) => {
                const tar = spawn('tar', ['--create', '--numeric-owner', '--acls', '--xattrs', '--sparse', '--warning=no-file-changed', '-C', p.root, ...rels], { stdio: ['ignore', 'pipe', 'pipe'] });
                const z = spawn('zstd', ['-T0', '-6', '-q', '-o', tmp, '-f'], { stdio: ['pipe', 'ignore', 'pipe'] });
                tar.stdout.pipe(z.stdin);
                let err = '';
                tar.on('error', e => no(new Error(`tar: ${e.message}`))); z.on('error', e => no(new Error(`zstd: ${e.message}`)));   // a missing tool must fail the backup, never the server
                tar.stderr.on('data', d => err += d); z.stderr.on('data', d => err += d);
                z.on('exit', code => code === 0 || code === null ? ok() : no(new Error(`zstd exit ${code}: ${err.slice(0, 200)}`)));
                tar.on('exit', code => { if (code && code !== 1) no(new Error(`tar exit ${code}: ${err.slice(0, 200)}`)); });   // 1 = a file changed while reading
            });
            return { slugs, ms: Date.now() - t0 };
        });
        const size = fs.statSync(tmp).size;
        await c.putFile(keyFor(st, project, name), tmp, 'application/zstd');
        fs.rmSync(tmp, { force: true });
        const pruned = await prune(project, c, st).catch(() => []);
        const entry = { at: started, name, size, paths: rels, ms: Date.now() - started, frozenMs: frozenFor.ms, frozen: frozenFor.slugs };
        const cfg = load(); cfg.projects = cfg.projects || {}; cfg.projects[project] = { ...(cfg.projects[project] || {}), last: entry, lastError: null }; save(cfg);
        record('activity', 'backup', { project, actor: who, via: 'backup', what: `${name} · ${(size / 1048576).toFixed(1)} MB · ${rels.join(', ')}${pruned.length ? ` · pruned ${pruned.length}` : ''}` });
        log('backup', `${project}: ${name} ${(size / 1048576).toFixed(1)} MB in ${entry.ms} ms (frozen ${frozenFor.ms} ms)${pruned.length ? `, pruned ${pruned.length}` : ''}`);
        return { ...entry, pruned, bucket: st.bucket };
    } catch (e) {
        const cfg = load(); cfg.projects = cfg.projects || {}; cfg.projects[project] = { ...(cfg.projects[project] || {}), lastError: { at: Date.now(), message: String(e.message).slice(0, 300) } }; save(cfg);
        record('activity', 'backup-failed', { project, actor: who, via: 'backup', what: String(e.message).slice(0, 200) });
        alerts.notify('backup', `Backup of ${project} failed\n${String(e.message).slice(0, 300)}`, { key: project, quietMs: 6 * 3600_000 });
        throw e;
    } finally { busy.delete(project); }
}

async function prune(project, c, st) {
    const keep = Number(load().keep) || DEFAULT_KEEP;
    const all = (await c.list(keyFor(st, project, ''))).filter(o => /\.tar\.zst$/.test(o.key)).sort((a, b) => a.key.localeCompare(b.key));
    const extra = all.slice(0, Math.max(0, all.length - keep));
    for (const o of extra) await c.remove(o.key);
    return extra.map(o => o.key);
}

export async function list(project) {
    projectOf(project);
    const { st, c } = s3();
    const all = (await c.list(keyFor(st, project, ''))).filter(o => /\.tar\.zst$/.test(o.key)).sort((a, b) => b.key.localeCompare(a.key));
    return all.map(o => ({ name: o.key.slice(o.key.lastIndexOf('/') + 1), size: o.size, at: o.at, key: o.key }));
}

// Stop the project's services, put the archived folders back exactly (what is there now goes to .porthole/restore-undo),
// start the services again. Only names that came from list() are accepted.
export async function restore(project, name, { who = 'phone' } = {}) {
    const p = projectOf(project);
    if (!/^\d{4}-\d{2}-\d{2}T[\d-]+Z\.tar\.zst$/.test(String(name))) throw httpError(400, 'Pick an archive from the list.');
    if (busy.has(project)) throw httpError(409, 'A backup of this project is running; try again in a moment.');
    busy.add(project);
    try {
        const { st, c } = s3();
        fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
        const tmp = path.join(tmpDir, `${project}-restore-${name}`);
        await c.getToFile(keyFor(st, project, name), tmp);
        const listed = (await run('bash', ['-lc', `zstd -dc ${JSON.stringify(tmp)} | tar -t | cut -d/ -f1 | sort -u`], { maxBuffer: 1024 * 1024 })).stdout.split('\n').map(s => s.trim()).filter(Boolean);
        if (listed.some(x => x.startsWith('..') || x.startsWith('/') || x === '.porthole')) throw httpError(400, 'The archive holds paths outside the project; refusing.');
        const running = (await services.list().catch(() => [])).filter(r => r.alive && r.live?.project === project);
        for (const r of running) await live.stop(project, r.live.key).catch(() => {});
        const undoDir = path.join(p.root, '.porthole', `restore-undo-${Date.now()}`);
        fs.mkdirSync(undoDir, { recursive: true, mode: 0o700 });
        for (const top of listed) { const cur = path.join(p.root, top); if (fs.existsSync(cur)) fs.renameSync(cur, path.join(undoDir, top)); }
        await run('bash', ['-lc', `zstd -dc ${JSON.stringify(tmp)} | tar -x --numeric-owner --acls --xattrs -C ${JSON.stringify(p.root)}`], { maxBuffer: 1024 * 1024, timeout: 3600_000 });
        fs.rmSync(tmp, { force: true });
        const restarted = [];
        for (const r of running) { try { await live.start(project, r.live.key); restarted.push(r.live.key); } catch (e) { log('backup', `restore ${project}: could not start ${r.live.key}: ${e.message}`); } }
        record('activity', 'restore', { project, actor: who, via: 'backup', what: `${name} → ${listed.join(', ')}; previous copy in ${path.relative(p.root, undoDir)}${restarted.length ? `; restarted ${restarted.join(', ')}` : ''}` });
        log('backup', `${project}: restored ${name} (${listed.join(', ')}); previous copy in ${undoDir}`);
        return { name, restored: listed, undo: path.relative(p.root, undoDir), restarted };
    } finally { busy.delete(project); }
}

// Daily run: at the chosen hour (box local time) for every project switched on. Checked every minute.
let lastDay = '';
export async function tick() {
    const c = load();
    if (c.daily === null || c.daily === undefined) return;
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getHours() !== Number(c.daily) || lastDay === day) return;
    lastDay = day;
    for (const [name, p] of Object.entries(c.projects || {})) {
        if (!p.daily) continue;
        try { await backup(name, { who: 'schedule' }); } catch (e) { log('backup', `daily ${name}: ${e.message}`); }
        await sleep(2000);
    }
}
export const hostname = () => os.hostname();
