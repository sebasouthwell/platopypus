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
import * as agentUser from './agentuser.js';
import * as svcUser from './svcuser.js';
import crypto from 'node:crypto';
import { envFor } from './vault.js';
import { log } from './log.js';

const run = promisify(execFile);
const projectsDir = path.join(config.root, 'Projects');
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const STRATEGIES = ['full', 'preserve-data', 'patch'];
const INPUT_TYPES = ['string', 'integer', 'number', 'boolean', 'choice'];
const INPUT_NAME_RE = /^[a-z][a-z0-9_]{0,30}$/;
const approvalsFile = path.join(config.state, 'live-approvals.json');

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
        for (const [i, a] of (Array.isArray(s.actions) ? s.actions : []).entries()) {
            if (!a?.label || !a?.run) errors.push(`${where}.actions[${i}]: needs label and run.`);
            if (a?.restart && a?.stop_first) warnings.push(`${where}.actions[${i}]: stop_first already starts the service again; restart is not needed.`);
            if (/\bsvc\s+restart\b/.test(String(a?.run || ''))) warnings.push(`${where}.actions[${i}]: use restart: true (or stop_first: true) instead of calling svc restart.`);
        }
        if (s.actions !== undefined && !Array.isArray(s.actions)) errors.push(`${where}.actions: a list.`);
        for (const [i, a] of (Array.isArray(s.actions) ? s.actions : []).entries()) for (const e of inputErrors(a?.inputs)) errors.push(`${where}.actions[${i}].inputs${e}`);
        if (s.run_as !== undefined && !['service', 'root'].includes(s.run_as)) errors.push(`${where}.run_as: service (the default) or root.`);
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
    Object.defineProperty(s, '__key', { value: key, enumerable: false });
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


// ---- action inputs: typed values the phone asks for; they reach the command as INPUT_<NAME> env vars only ----
function inputErrors(inputs) {
    if (inputs === undefined) return [];
    if (!Array.isArray(inputs)) return [': a list.'];
    const out = []; const seen = new Set();
    for (const [j, f] of inputs.entries()) {
        const w = `[${j}]`;
        if (!f || typeof f !== 'object') { out.push(`${w}: must be a mapping.`); continue; }
        if (!INPUT_NAME_RE.test(String(f.name || ''))) out.push(`${w}.name: lowercase letters, digits and _ (it becomes INPUT_${String(f.name || 'NAME').toUpperCase()}).`);
        if (seen.has(f.name)) out.push(`${w}.name: "${f.name}" is used twice.`); seen.add(f.name);
        const type = f.type || 'string';
        if (!INPUT_TYPES.includes(type)) out.push(`${w}.type: one of ${INPUT_TYPES.join(', ')}.`);
        if (type === 'choice' && !(Array.isArray(f.choices) && f.choices.length)) out.push(`${w}.choices: a list of allowed values.`);
        for (const k of ['min', 'max']) if (f[k] !== undefined && !Number.isFinite(Number(f[k]))) out.push(`${w}.${k}: a number.`);
        if (f.pattern !== undefined) { try { new RegExp(String(f.pattern)); } catch { out.push(`${w}.pattern: not a valid regular expression.`); } }
        if (f.default !== undefined && type !== 'choice' && checkValue(f, f.default).error) out.push(`${w}.default: ${checkValue(f, f.default).error}`);
    }
    return out;
}
function inputView(f) {
    return { name: f.name, label: String(f.label || f.name), type: f.type || 'string', min: f.min ?? null, max: f.max ?? null, pattern: f.pattern ?? null,
        choices: Array.isArray(f.choices) ? f.choices.map(String) : null, default: f.default ?? null, required: f.required !== false, hint: f.hint ? String(f.hint) : null };
}
// Returns { value } as the string the command will see, or { error }.
function checkValue(f, raw) {
    const type = f.type || 'string';
    const label = f.label || f.name;
    const empty = raw === undefined || raw === null || String(raw) === '';
    if (empty) return f.required === false ? { value: '' } : { error: `${label} is required.` };
    let v = raw;
    if (type === 'integer') { if (!/^-?\d{1,15}$/.test(String(v).trim())) return { error: `${label} must be a whole number.` }; v = Number(String(v).trim()); }
    else if (type === 'number') { if (!/^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(String(v).trim())) return { error: `${label} must be a number.` }; v = Number(String(v).trim()); if (!Number.isFinite(v)) return { error: `${label} must be a number.` }; }
    else if (type === 'boolean') { if (![true, false, 'true', 'false', '1', '0'].includes(v)) return { error: `${label} must be true or false.` }; return { value: [true, 'true', '1'].includes(v) ? 'true' : 'false' }; }
    else if (type === 'choice') { const c = (f.choices || []).map(String); if (!c.includes(String(v))) return { error: `${label} must be one of ${c.join(', ')}.` }; return { value: String(v) }; }
    else { v = String(v); if (v.length > (Number(f.max_length) || 500)) return { error: `${label} is too long.` }; if (/[\0\r\n]/.test(v) && !f.multiline) return { error: `${label} must be one line.` }; }
    if (typeof v === 'number') {
        if (f.min !== undefined && v < Number(f.min)) return { error: `${label} must be at least ${f.min}.` };
        if (f.max !== undefined && v > Number(f.max)) return { error: `${label} must be at most ${f.max}.` };
    }
    if (f.pattern !== undefined) { const re = new RegExp(`^(?:${f.pattern})$`); if (!re.test(String(v))) return { error: `${label} does not match the required format${f.hint ? ` (${f.hint})` : ''}.` }; }
    return { value: String(v) };
}
export function inputEnv(inputs, values = {}) {
    const env = {}; const errors = [];
    for (const f of Array.isArray(inputs) ? inputs : []) {
        const raw = values[f.name] !== undefined ? values[f.name] : f.default;
        const r = checkValue(f, raw);
        if (r.error) errors.push(r.error); else env[`INPUT_${String(f.name).toUpperCase()}`] = r.value;
    }
    if (errors.length) throw httpError(400, errors.join(' '));
    return env;
}

// ---- running as root: only with an approval pinned to the exact commands ----
function rootFingerprint(s) {
    const what = { start: s.start, cwd: s.cwd || '.', patch: s.patch || null, actions: (Array.isArray(s.actions) ? s.actions : []).map(a => a?.run || '') };
    return crypto.createHash('sha256').update(JSON.stringify(what)).digest('hex');
}
function loadApprovals() { try { return JSON.parse(fs.readFileSync(approvalsFile, 'utf8')); } catch { return {}; } }
function rootState(project, key, s) {
    if (s.run_as !== 'root') return { runAs: 'service', wantsRoot: false, rootApproved: false };
    const ok = loadApprovals()[slugOf(project, key)] === rootFingerprint(s);
    return { runAs: ok ? 'root' : 'blocked', wantsRoot: true, rootApproved: ok };
}
export function approveRoot(project, key) {
    const { s } = findService(project, key);
    if (s.run_as !== 'root') throw httpError(400, 'This service does not ask to run as root.');
    const a = loadApprovals(); a[slugOf(project, key)] = rootFingerprint(s);
    const tmp = approvalsFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(a, null, 2), { mode: 0o600 }); fs.renameSync(tmp, approvalsFile);
    log('live', `approved ${project}/${key} to run as root (fingerprint ${a[slugOf(project, key)].slice(0, 12)})`);
    return { ok: true };
}
export function revokeRoot(project, key) {
    const a = loadApprovals(); delete a[slugOf(project, key)];
    const tmp = approvalsFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(a, null, 2), { mode: 0o600 }); fs.renameSync(tmp, approvalsFile);
    log('live', `revoked root for ${project}/${key}`);
    return { ok: true };
}
// The service account reaches the project through the porthole-dev group (same change as "Make agent-ready").
async function readyFolder(root) {
    try { await agentUser.prepareFolder(root); } catch (e) { log('live', `could not make ${root} group-writable: ${e.message}`); }
}
// Porthole's own environment minus anything secret: an action never sees the box token or Porthole's settings.
function actionBaseEnv() {
    const keep = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TERM'];
    return Object.fromEntries(keep.filter(k => process.env[k]).map(k => [k, process.env[k]]));
}
function mustRun(project, key, s) {
    const st = rootState(project, key, s);
    if (st.runAs === 'blocked') throw httpError(403, `This service asks to run as root (run_as: root). Approve it on its page first; the approval covers these exact commands and lapses when PORTHOLE.md changes them.`);
    return st.runAs;
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
                ...rootState(p.name, key, s),
                actions: (Array.isArray(s.actions) ? s.actions : []).map((a, i) => ({ i, label: String(a.label), confirm: !!a.confirm, restarts: !!(a.restart || a.stop_first), inputs: (Array.isArray(a.inputs) ? a.inputs : []).map(inputView) })),
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
    return { env: { ...vaultEnv, ...fixed, PORTHOLE_PROJECT: p.name, ...(s.__key ? { PORTHOLE_SERVICE: slugOf(p.name, s.__key) } : {}) }, missing };
}

export async function start(project, key) {
    const { p, s } = findService(project, key);
    mustRun(p.name, key, s);
    const { env, missing } = await envForService(p, s);
    if (missing.length) throw httpError(412, `Add ${missing.join(', ')} to the Vault (project ${project} or general) first.`);
    const cwd = path.resolve(p.root, s.cwd || '.');
    if (!cwd.startsWith(p.root)) throw httpError(400, 'cwd must stay inside the project.');
    const port = s.port ? Number(s.port) : null;
    const slug = slugOf(p.name, key);
    let tookOver = null;
    if (port) {
        const h = await servicesMgr.portHolder(port, slug);
        // The same app started earlier as a plain server (an agent testing it) gives way to the live service.
        const inside = d => { const r = path.resolve(d || '/'); return r === p.root || r.startsWith(p.root + path.sep); };
        if (h?.slug && !h.live && inside(h.cwd)) { await servicesMgr.remove(h.slug); tookOver = h.name; log('live', `${project}/${key} took over :${port} from server "${h.slug}"`); }
        else if (h?.slug) throw httpError(409, `Port ${port} is used by the server "${h.name}". Stop it first.`);
        else if (h) throw httpError(409, `Port ${port} is already in use${h.cmdline ? ` by ${h.cmdline}` : ''}.`);
    }
    const runAs = mustRun(p.name, key, s);
    if (runAs === 'service') await readyFolder(p.root);
    const reg = await servicesMgr.runServer({ name: `live ${p.name} ${key}`, port, cwd, cmd: ['bash', '-lc', s.start], project: p.name, env, runAs, live: { project: p.name, key, title: s.title || key } });
    log('live', `started ${project}/${key}`);
    return tookOver ? { ...reg, tookOver } : reg;
}

export async function restart(project, key) {
    findService(project, key);
    const slug = slugOf(project, key);
    if ((await servicesMgr.list()).some(r => r.slug === slug && r.alive)) await servicesMgr.stop(slug, { keepTunnel: true });
    return start(project, key);
}

// Restart by registry slug (svc restart live-..., or an action that restarts its own service).
export async function restartSlug(slug) {
    const it = await servicesMgr.get(slug);
    if (it.live) return restart(it.live.project, it.live.key);
    for (const p of projects()) for (const key of Object.keys(p.data.services || {})) if (slugOf(p.name, key) === slug) return restart(p.name, key);
    throw httpError(404, 'That live service is no longer in its PORTHOLE.md.');
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

export async function action(project, key, index, values = {}) {
    const { p, s } = findService(project, key);
    const a = (Array.isArray(s.actions) ? s.actions : [])[Number(index)];
    if (!a) throw httpError(404, 'No such action.');
    const runAs = mustRun(p.name, key, s);
    if (runAs === 'service') { await svcUser.ensure(); await readyFolder(p.root); }
    const inputs = inputEnv(a.inputs, values && typeof values === 'object' ? values : {});
    const { env: baseEnv } = await envForService(p, s);
    const env = { ...baseEnv, ...inputs };
    const cwd = path.resolve(p.root, s.cwd || '.');
    const slug = slugOf(project, key);
    const started = Date.now();
    const wasRunning = (await servicesMgr.list()).some(r => r.slug === slug && r.alive);
    let out = '', code = 0;
    // stop_first: the service is stopped while the command runs (so it cannot write its old state back), then started.
    if (a.stop_first && wasRunning) { await servicesMgr.stop(slug, { keepTunnel: true }); out += '[stopped the service]\n'; }
    try {
        // As porthole-svc unless root was approved: the command text comes from a file agents can edit.
        const [bin, args] = runAs === 'service' ? svcUser.argv(String(a.run), env) : ['bash', ['-lc', String(a.run)]];
        const r = await run(bin, args, { cwd, env: { ...actionBaseEnv(), ...env }, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
        out += (r.stdout || '') + (r.stderr ? `\n${r.stderr}` : '');
    } catch (e) {
        code = e.code ?? 1; out += (e.stdout || '') + (e.stderr ? `\n${e.stderr}` : '') + (e.killed ? '\n[stopped after 120 s]' : '');
    }
    if ((a.stop_first && wasRunning) || (a.restart && code === 0)) {
        try { await (a.stop_first ? start(project, key) : restart(project, key)); out += `\n[${a.stop_first ? 'started' : 'restarted'} the service]`; }
        catch (e) { code = code || 1; out += `\n[could not start the service: ${e.message}]`; }
    } else if (a.restart) out += '\n[not restarted: the command failed]';
    log('live', `action "${a.label}" on ${project}/${key} as ${runAs}${Object.keys(inputs).length ? ` with ${Object.keys(inputs).join(', ')}` : ''} → exit ${code}`);
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
