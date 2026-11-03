// Live services: projects describe how they run in PORTHOLE.md (YAML front matter, see docs/LIVE.md) and Porthole
// runs, exposes and operates them from the phone. A live service runs through the servers registry (services.js)
// under the slug live-<project>-<key>, gets its environment from the manifest plus the Vault (general + that
// project's scope), and its hostname through zoned.js (nginx + Let's Encrypt, with a "coming up" page whenever the
// service is not answering).

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { config } from './config.js';
import * as servicesMgr from './services.js';
import * as zoned from './zoned.js';
import { envFor } from './vault.js';
import { log } from './log.js';

const run = promisify(execFile);
const projectsDir = path.join(config.root, 'Projects');
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const STRATEGIES = ['full', 'preserve-data', 'patch'];

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const slugOf = (project, key) => servicesMgr.slugify(`live ${project} ${key}`);

// ---- manifest ----
export function manifestPath(root) {
    for (const rel of ['PORTHOLE.md', 'docs/PORTHOLE.md']) { const p = path.join(root, rel); if (fs.existsSync(p)) return p; }
    return null;
}

export function parseManifest(text) {
    const m = String(text).match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
    if (!m) return { data: null, errors: ['No YAML front matter: the file must start with a --- block.'] };
    let data;
    try { data = parseYaml(m[1]) || {}; } catch (e) { return { data: null, errors: [`YAML: ${e.message.split('\n')[0]}`] }; }
    const errors = [], warnings = [];
    if (data.porthole !== undefined && Number(data.porthole) !== 1) warnings.push(`porthole: ${data.porthole} is newer than this Porthole understands (1).`);
    const svcs = data.services && typeof data.services === 'object' ? data.services : {};
    for (const [key, s] of Object.entries(svcs)) {
        const where = `services.${key}`;
        if (!KEY_RE.test(key)) errors.push(`${where}: key must be lowercase letters, digits and dashes.`);
        if (!s || typeof s !== 'object') { errors.push(`${where}: must be a mapping.`); continue; }
        if (typeof s.start !== 'string' || !s.start.trim()) errors.push(`${where}.start: required (the command that runs it).`);
        if (s.port !== undefined && !(Number.isInteger(Number(s.port)) && Number(s.port) > 0 && Number(s.port) < 65536)) errors.push(`${where}.port: 1-65535.`);
        if (Number(s.port) === config.port) errors.push(`${where}.port: that is Porthole's own port.`);
        if (s.hostname !== undefined && !/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(String(s.hostname).toLowerCase())) errors.push(`${where}.hostname: a full name like app.example.com.`);
        if (s.hostname && !s.port) errors.push(`${where}.hostname: needs a port to serve.`);
        if (s.update !== undefined && !STRATEGIES.includes(s.update)) errors.push(`${where}.update: one of ${STRATEGIES.join(', ')}.`);
        if (s.update === 'patch' && !s.patch) warnings.push(`${where}: update is patch but no patch command is given.`);
        if (s.cwd !== undefined && (path.isAbsolute(String(s.cwd)) || String(s.cwd).split(/[\\/]/).includes('..'))) errors.push(`${where}.cwd: a folder inside the project.`);
        for (const [i, a] of (Array.isArray(s.actions) ? s.actions : []).entries()) if (!a?.label || !a?.run) errors.push(`${where}.actions[${i}]: needs label and run.`);
        if (s.actions !== undefined && !Array.isArray(s.actions)) errors.push(`${where}.actions: a list.`);
        if (Array.isArray(s.expose) && s.expose.length) warnings.push(`${where}.expose: raw ports only open on a service's own host; this box admits only Cloudflare on 80/443.`);
        if (!s.port) warnings.push(`${where}: no port — runs as a worker here; consider its own host.`);
        for (const c of Array.isArray(s.credentials) ? s.credentials : []) for (const [k, v] of Object.entries(c || {})) if (k !== 'label' && typeof v === 'string' && !v.startsWith('$') && /pass|secret|token|key/i.test(k)) errors.push(`${where}.credentials: "${k}" holds a literal secret; reference a Vault name like $${k.toUpperCase()}.`);
    }
    return { data, errors, warnings };
}

function readProject(root) {
    const file = manifestPath(root);
    if (!file) return null;
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
    const { data, errors, warnings } = parseManifest(text);
    return { root, name: path.basename(root), file, data: data || {}, errors, warnings: warnings || [] };
}

export function projects() {
    let entries = [];
    try { entries = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch { return []; }
    return entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => readProject(path.join(projectsDir, e.name))).filter(Boolean);
}

function findService(project, key) {
    const p = projects().find(x => x.name === project);
    if (!p) throw httpError(404, `No project "${project}" with a PORTHOLE.md.`);
    if (p.errors.length) throw httpError(422, `PORTHOLE.md has errors: ${p.errors[0]}`);
    const s = p.data.services?.[key];
    if (!s) throw httpError(404, `No service "${key}" in ${project}/PORTHOLE.md.`);
    return { p, s };
}

async function commitOf(root) {
    try { return (await run('git', ['-C', root, 'log', '-1', '--format=%h %s'], { timeout: 5000 })).stdout.trim().slice(0, 80) || null; } catch { return null; }
}

function credView(c) {
    const fields = Object.entries(c || {}).filter(([k]) => k !== 'label').map(([k, v]) => {
        const ref = typeof v === 'string' && v.startsWith('$') ? v.slice(1) : null;
        const secret = !!ref || /pass|secret|token|key/i.test(k);
        return { label: k, ref, secret, value: ref ? null : String(v) };
    });
    return { label: c?.label || 'Credentials', fields };
}

// ---- public API ----
export async function list() {
    const [regs, hosts] = await Promise.all([servicesMgr.list().catch(() => []), zoned.list().catch(() => [])]);
    const out = [];
    for (const p of projects()) {
        const commit = await commitOf(p.root);
        const svcs = Object.entries(p.data.services || {}).map(([key, s]) => {
            const slug = slugOf(p.name, key);
            const reg = regs.find(r => r.slug === slug);
            const host = s.hostname ? hosts.find(h => h.hostname === String(s.hostname).toLowerCase()) : (s.port ? hosts.find(h => h.port === Number(s.port)) : null);
            return {
                key, slug, title: s.title || key, port: s.port ? Number(s.port) : null, worker: !s.port,
                running: !!reg?.alive, listening: reg ? reg.listening : null, pid: reg?.pid || null, startedAt: reg?.alive ? reg.created : null,
                hostname: s.hostname ? String(s.hostname).toLowerCase() : null,
                host: host ? { hostname: host.hostname, url: host.url, live: !!host.connected, mode: host.mode, slug: host.slug } : null,
                update: s.update || null,
                actions: (Array.isArray(s.actions) ? s.actions : []).map((a, i) => ({ i, label: String(a.label), confirm: !!a.confirm })),
                links: (Array.isArray(s.links) ? s.links : []).map(l => ({ label: String(l.label || l.path), path: String(l.path || '/') })),
                credentials: (Array.isArray(s.credentials) ? s.credentials : []).map(credView),
                needs: Array.isArray(s.needs) ? s.needs.map(String) : [],
                expose: Array.isArray(s.expose) ? s.expose : [],
            };
        });
        out.push({ project: p.name, root: p.root, file: path.relative(p.root, p.file), name: p.data.name || p.name, summary: p.data.summary || '', commit, errors: p.errors, warnings: p.warnings, services: svcs });
    }
    return out;
}

async function envForService(p, s) {
    const vaultEnv = await envFor(p.root, { project: 'exact' });
    const missing = (Array.isArray(s.needs) ? s.needs : []).filter(n => !(n in vaultEnv));
    const fixed = Object.fromEntries(Object.entries(s.env || {}).map(([k, v]) => [String(k), String(v)]));
    return { env: { ...vaultEnv, ...fixed, PORTHOLE_PROJECT: p.name }, missing };
}

export async function start(project, key) {
    const { p, s } = findService(project, key);
    const { env, missing } = await envForService(p, s);
    if (missing.length) throw httpError(412, `Add ${missing.join(', ')} to the Vault (project ${project} or general) first.`);
    const cwd = path.resolve(p.root, s.cwd || '.');
    if (!cwd.startsWith(p.root)) throw httpError(400, 'cwd must stay inside the project.');
    const reg = await servicesMgr.runServer({ name: `live ${p.name} ${key}`, port: s.port || null, cwd, cmd: ['bash', '-lc', s.start], project: p.name, env });
    log('live', `started ${project}/${key}`);
    return reg;
}

export async function stop(project, key) {
    findService(project, key);
    const slug = slugOf(project, key);
    // Stop the process but keep a hostname in place: nginx shows the coming-up page until it is started again.
    const db = await servicesMgr.list();
    if (!db.some(r => r.slug === slug)) throw httpError(409, 'Not running.');
    const r = await servicesMgr.stop(slug, { keepTunnel: true });
    log('live', `stopped ${project}/${key}`);
    return r;
}

export async function action(project, key, index) {
    const { p, s } = findService(project, key);
    const a = (Array.isArray(s.actions) ? s.actions : [])[Number(index)];
    if (!a) throw httpError(404, 'No such action.');
    const { env } = await envForService(p, s);
    const cwd = path.resolve(p.root, s.cwd || '.');
    const started = Date.now();
    let out = '', code = 0;
    try {
        const r = await run('bash', ['-lc', String(a.run)], { cwd, env: { ...process.env, ...env }, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
        out = (r.stdout || '') + (r.stderr ? `\n${r.stderr}` : '');
    } catch (e) {
        code = e.code ?? 1; out = (e.stdout || '') + (e.stderr ? `\n${e.stderr}` : '') + (e.killed ? '\n[stopped after 120 s]' : '');
    }
    log('live', `action "${a.label}" on ${project}/${key} → exit ${code}`);
    // Keep a record in the service log when there is one.
    try { const reg = await servicesMgr.get(slugOf(project, key)); if (reg.log) fs.appendFileSync(reg.log, `\n[action ${new Date().toISOString()}] ${a.label} → exit ${code}\n${out.slice(-20000)}\n`); } catch { /* not running yet */ }
    return { label: a.label, code, ms: Date.now() - started, output: out.slice(-60000) };
}

// Reveal one credential block: literal values plus Vault references resolved for this project's scope.
export async function credentials(project, key, index) {
    const { p, s } = findService(project, key);
    const c = (Array.isArray(s.credentials) ? s.credentials : [])[Number(index)];
    if (!c) throw httpError(404, 'No such credential.');
    const vaultEnv = await envFor(p.root, { project: 'exact' });
    const view = credView(c);
    view.fields = view.fields.map(f => ({ ...f, value: f.ref ? (vaultEnv[f.ref] ?? null) : f.value, missing: !!f.ref && !(f.ref in vaultEnv) }));
    log('live', `revealed credentials "${view.label}" of ${project}/${key}`);
    return view;
}

export async function putOnHostname(project, key) {
    const { s } = findService(project, key);
    if (!s.port) throw httpError(400, 'A worker has no port to serve.');
    if (!s.hostname) throw httpError(400, 'Set hostname: in PORTHOLE.md first (or use Share on your domain).');
    return zoned.create({ port: Number(s.port), hostname: String(s.hostname).toLowerCase(), name: s.title || `${project} ${key}` });
}

export function check(root) {
    const p = readProject(path.resolve(root));
    if (!p) return { ok: false, file: null, errors: ['No PORTHOLE.md or docs/PORTHOLE.md here.'], warnings: [], services: [] };
    return { ok: !p.errors.length, file: p.file, errors: p.errors, warnings: p.warnings, services: Object.keys(p.data.services || {}) };
}
