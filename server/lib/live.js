// Live services: projects describe how they run in PORTHOLE.md (YAML front matter, see docs/LIVE.md) and PlatOpypus
// runs, exposes and operates them from the phone. A live service runs through the servers registry (services.js)
// under the slug live-<project>-<key>, gets its environment from the manifest plus the Vault (general + that
// project's scope), and its hostname through zoned.js (nginx + Let's Encrypt, with a "coming up" page whenever the
// service is not answering).

import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { config } from './config.js';
import * as servicesMgr from './services.js';
import * as zoned from './zoned.js';
import * as agentUser from './agentuser.js';
import * as svcUser from './svcuser.js';
import * as dockerMgr from './docker.js';
import crypto from 'node:crypto';
import { envFor } from './vault.js';
import { log } from './log.js';
import { folderIcon, relative as relToRoot } from './files.js';
import { recordRun } from './quick.js';
import { record } from './audit.js';
import { tmux, switchSocket } from './tmux.js';

const run = promisify(execFile);
const projectsDir = path.join(config.root, 'Projects');
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const STRATEGIES = ['full', 'preserve-data', 'patch'];
const INPUT_TYPES = ['string', 'integer', 'number', 'boolean', 'choice'];
const INPUT_NAME_RE = /^[a-z][a-z0-9_]{0,30}$/;
const approvalsFile = path.join(config.state, 'live-approvals.json');
const MEM_RE = /^\d{1,5}[mMgG]$/;
// "<folder in the project>:<path in the container>[:ro]"
function parseVolume(v) {
    const m = String(v || '').match(/^([^:]+):(\/[^:]*)(?::(ro|rw))?$/);
    if (!m) return null;
    const host = m[1].replace(/\/+$/, '');
    if (!host || path.isAbsolute(host) || host.split(/[\\/]/).includes('..') || host.startsWith('.porthole')) return null;
    return { host, cont: m[2].replace(/\/+$/, '') || '/', ro: m[3] === 'ro' };
}
const isContainer = s => typeof s?.image === 'string';
const containerName = (p, key) => slugOf(p.name, key);

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const slugOf = (project, key) => servicesMgr.slugify(`live ${project} ${key}`);

// ---- manifest ----
export function manifestPath(root) {
    for (const rel of ['PLATOPYPUS.md', 'docs/PLATOPYPUS.md', 'PORTHOLE.md', 'docs/PORTHOLE.md']) { const p = path.join(root, rel); if (fs.existsSync(p)) return p; }
    return null;
}

export function parseManifest(text) {
    const m = String(text).match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
    if (!m) return { data: null, errors: ['No YAML front matter: the file must start with a --- block.'] };
    let data;
    try { data = parseYaml(m[1]) || {}; } catch (e) { return { data: null, errors: [`YAML: ${e.message.split('\n')[0]}`] }; }
    const errors = [], warnings = [];
    if (data.porthole !== undefined && Number(data.porthole) !== 1) warnings.push(`porthole: ${data.porthole} is newer than this PlatOpypus understands (1).`);
    const svcs = data.services && typeof data.services === 'object' ? data.services : {};
    for (const [key, s] of Object.entries(svcs)) {
        const where = `services.${key}`;
        if (!KEY_RE.test(key)) errors.push(`${where}: key must be lowercase letters, digits and dashes.`);
        if (!s || typeof s !== 'object') { errors.push(`${where}: must be a mapping.`); continue; }
        if (isContainer(s)) {
            if (!dockerMgr.IMAGE_RE.test(s.image)) errors.push(`${where}.image: e.g. docker.n8n.io/n8nio/n8n:latest.`);
            if (s.start !== undefined) errors.push(`${where}: image and start cannot both be set (an image has its own start command; use command: to change it).`);
            if (s.run_as !== undefined) errors.push(`${where}.run_as: does not apply to a container (it runs as the project's account inside the container).`);
            if (s.container_port !== undefined && !(Number.isInteger(Number(s.container_port)) && Number(s.container_port) > 0 && Number(s.container_port) < 65536)) errors.push(`${where}.container_port: 1-65535.`);
            if (s.volumes !== undefined && !Array.isArray(s.volumes)) errors.push(`${where}.volumes: a list like "data:/home/node/.n8n".`);
            for (const [i, v] of (Array.isArray(s.volumes) ? s.volumes : []).entries()) if (!parseVolume(v)) errors.push(`${where}.volumes[${i}]: "<folder in the project>:<path in the container>[:ro]".`);
            if (s.command !== undefined && !(typeof s.command === 'string' || (Array.isArray(s.command) && s.command.every(x => typeof x === 'string' || typeof x === 'number')))) errors.push(`${where}.command: a string or a list.`);
            if (s.memory !== undefined && !MEM_RE.test(String(s.memory))) errors.push(`${where}.memory: like 512m or 1g.`);
            if (s.user !== undefined && !['service', 'image'].includes(s.user)) errors.push(`${where}.user: service (the default: the project's account) or image (whatever the image runs as).`);
        } else if (typeof s.start !== 'string' || !s.start.trim()) errors.push(`${where}.start: required (the command that runs it), or image: for a container.`);
        if (s.port !== undefined && !(Number.isInteger(Number(s.port)) && Number(s.port) > 0 && Number(s.port) < 65536)) errors.push(`${where}.port: 1-65535.`);
        if (Number(s.port) === config.port) errors.push(`${where}.port: that is PlatOpypus's own port.`);
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
        if (s.groups !== undefined && !Array.isArray(s.groups)) errors.push(`${where}.groups: a list.`);
        for (const [gi, g] of (Array.isArray(s.groups) ? s.groups : []).entries()) {
            const gw = `${where}.groups[${gi}]`;
            if (!g?.label || typeof g?.list !== 'string' || !g.list.trim()) { errors.push(`${gw}: needs label and list (a command that prints one id per line, or JSON).`); continue; }
            if (!Array.isArray(g.actions) || !g.actions.length) errors.push(`${gw}.actions: at least one action for an item.`);
            for (const [i, a] of (Array.isArray(g.actions) ? g.actions : []).entries()) {
                if (!a?.label || !a?.run) errors.push(`${gw}.actions[${i}]: needs label and run.`);
                for (const e of inputErrors(a?.inputs)) errors.push(`${gw}.actions[${i}].inputs${e}`);
                if (a?.run && !/GROUP_ITEM/.test(String(a.run))) warnings.push(`${gw}.actions[${i}]: run does not use $GROUP_ITEM, so every item does the same thing.`);
            }
        }
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

// ---- running as root: only with an approval pinned to the exact commands AND the code they run ----
// The code part hashes every file the project ships: with git, every tracked and untracked-but-not-ignored file
// as it is on disk now (so uncommitted edits count); without git, every file except node_modules, .git and the
// manifest's backup paths. Ignored and data folders are left out so the app's own writes do not void it.
const CODE_LIMIT = { files: 20000, bytes: 200 * 1024 * 1024 };
function codeFingerprint(root, data = []) {
    let list = null;
    try { list = execFileSync('git', ['-C', root, 'ls-files', '-z', '-c', '-o', '--exclude-standard'], { encoding: 'utf8', timeout: 20_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean); } catch { /* not a git repo */ }
    if (!list) {
        list = [];
        const skip = new Set(['node_modules', '.git', ...data.map(d => String(d).replace(/\/+$/, ''))]);
        const walk = (dir, rel) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (skip.has(r) || skip.has(e.name) && e.isDirectory()) continue; if (e.isDirectory()) walk(path.join(dir, e.name), r); else if (e.isFile()) list.push(r); if (list.length > CODE_LIMIT.files) throw httpError(413, 'Too many files to fingerprint for a root approval.'); } };
        walk(root, '');
    }
    list = [...new Set(list)].filter(f => !f.startsWith('.porthole/')).sort();
    if (list.length > CODE_LIMIT.files) throw httpError(413, 'Too many files to fingerprint for a root approval.');
    const h = crypto.createHash('sha256'); let bytes = 0;
    for (const f of list) {
        let buf; try { buf = fs.readFileSync(path.join(root, f)); } catch { continue; }
        bytes += buf.length; if (bytes > CODE_LIMIT.bytes) throw httpError(413, 'The project is too large to fingerprint for a root approval.');
        h.update(f).update('\0').update(crypto.createHash('sha256').update(buf).digest()).update('\0');
    }
    return { hash: h.digest('hex'), files: list.length };
}
function rootFingerprint(p, s) {
    const what = { start: s.start, cwd: s.cwd || '.', patch: s.patch || null, actions: (Array.isArray(s.actions) ? s.actions : []).map(a => a?.run || ''), ...(Array.isArray(s.groups) && s.groups.length ? { groups: s.groups.map(g => ({ list: g?.list || '', actions: (Array.isArray(g?.actions) ? g.actions : []).map(a => a?.run || '') })) } : {}), code: codeFingerprint(p.root, p.data?.backup?.paths || []).hash };
    return crypto.createHash('sha256').update(JSON.stringify(what)).digest('hex');
}
function loadApprovals() { try { return JSON.parse(fs.readFileSync(approvalsFile, 'utf8')); } catch { return {}; } }
function rootState(p, key, s) {
    if (isContainer(s)) return { runAs: 'container', account: svcUser.userFor(p.name), wantsRoot: false, rootApproved: false };
    if (s.run_as !== 'root') return { runAs: 'service', account: svcUser.userFor(p.name), wantsRoot: false, rootApproved: false };
    let ok = false; try { ok = loadApprovals()[slugOf(p.name, key)] === rootFingerprint(p, s); } catch { ok = false; }
    return { runAs: ok ? 'root' : 'blocked', account: ok ? 'root' : null, wantsRoot: true, rootApproved: ok };
}
export function approveRoot(project, key) {
    const { p, s } = findService(project, key);
    if (s.run_as !== 'root') throw httpError(400, 'This service does not ask to run as root.');
    const a = loadApprovals(); a[slugOf(project, key)] = rootFingerprint(p, s);
    const tmp = approvalsFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(a, null, 2), { mode: 0o600 }); fs.renameSync(tmp, approvalsFile);
    record('elevate', 'root-approved', { project, actor: 'phone', what: `${project}/${key}`, decidedBy: 'phone', cmd: String(s.start || '') });
    log('live', `approved ${project}/${key} to run as root (fingerprint ${a[slugOf(project, key)].slice(0, 12)})`);
    return { ok: true };
}
export function revokeRoot(project, key) {
    const a = loadApprovals(); delete a[slugOf(project, key)];
    const tmp = approvalsFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(a, null, 2), { mode: 0o600 }); fs.renameSync(tmp, approvalsFile);
    log('live', `revoked root for ${project}/${key}`);
    record('elevate', 'root-revoked', { project, actor: 'phone', what: `${project}/${key}` });
    return { ok: true };
}
// The project's own account, with access to this project folder only (ACL); agent shells keep porthole-dev access.
export async function prepareAccount(p) {
    try { await agentUser.prepareFolder(p.root); } catch (e) { log('live', `could not make ${p.root} group-writable: ${e.message}`); }
    await svcUser.retireShared();
    const a = await svcUser.ensure(p.name, p.root);
    return a.user;
}
// PlatOpypus's own environment minus anything secret: an action never sees the box token or PlatOpypus's settings.
function actionBaseEnv() {
    const keep = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TERM'];
    return Object.fromEntries(keep.filter(k => process.env[k]).map(k => [k, process.env[k]]));
}
function mustRun(p, key, s) {
    const st = rootState(p, key, s);
    if (st.runAs === 'blocked') throw httpError(403, `This service asks to run as root (run_as: root). Approve it on its page first; the approval covers its commands and the project's code as they are now, and lapses when either changes.`);
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
                update: s.update || null, image: isContainer(s) ? String(s.image) : null,
                ...rootState(p, key, s),
                firewall: svcUser.firewallState(),
                vaultNames: Array.isArray(s.needs) ? s.needs.map(String) : [],
                actions: (Array.isArray(s.actions) ? s.actions : []).map((a, i) => ({ i, label: String(a.label), confirm: !!a.confirm, restarts: !!(a.restart || a.stop_first), inputs: (Array.isArray(a.inputs) ? a.inputs : []).map(inputView) })),
                groups: (Array.isArray(s.groups) ? s.groups : []).filter(g => g?.label && g?.list).map((g, gi) => ({ i: gi, label: String(g.label), hint: g.hint ? String(g.hint) : null, item: g.item ? String(g.item) : 'item', actions: (Array.isArray(g.actions) ? g.actions : []).map((a, i) => ({ i, label: String(a.label), confirm: !!a.confirm, restarts: !!(a.restart || a.stop_first), all: a.all !== false, inputs: (Array.isArray(a.inputs) ? a.inputs : []).map(inputView) })) })),
                links: (Array.isArray(s.links) ? s.links : []).map(l => ({ label: String(l.label || l.path), path: String(l.path || '/') })),
                credentials: (Array.isArray(s.credentials) ? s.credentials : []).map(credView),
                needs: Array.isArray(s.needs) ? s.needs.map(String) : [],
                expose: Array.isArray(s.expose) ? s.expose : [],
            };
        });
        let icon = null; try { const ic = await folderIcon(p.root, fs.statSync(p.root).mtimeMs); if (ic) icon = relToRoot(path.join(p.root, ic)); } catch { /* none */ }
        out.push({ project: p.name, root: p.root, icon, file: path.relative(p.root, p.file), name: p.data.name || p.name, summary: p.data.summary || '', commit, errors: p.errors, warnings: p.warnings, services: svcs });
    }
    return out;
}

// Least privilege: a service gets only the Vault names it lists under needs:, never the rest of the Vault.
async function envForService(p, s) {
    const vaultEnv = await envFor(p.root, { project: 'exact' });
    const needs = (Array.isArray(s.needs) ? s.needs : []).map(String);
    const missing = needs.filter(n => !(n in vaultEnv));
    const granted = Object.fromEntries(needs.filter(n => n in vaultEnv).map(n => [n, vaultEnv[n]]));
    const fixed = Object.fromEntries(Object.entries(s.env || {}).map(([k, v]) => [String(k), String(v)]));
    const names = { PLATO_PROJECT: p.name, PORTHOLE_PROJECT: p.name, ...(s.__key ? { PLATO_SERVICE: slugOf(p.name, s.__key), PORTHOLE_SERVICE: slugOf(p.name, s.__key) } : {}) };
    return { env: { ...granted, ...fixed, ...names }, missing };
}

export async function start(project, key) {
    const { p, s } = findService(project, key);
    mustRun(p, key, s);
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
    const runAs = mustRun(p, key, s);
    const account = runAs !== 'root' ? await prepareAccount(p) : null;
    const cmd = runAs === 'container' ? await containerArgv(p, key, s, account, env, port) : ['bash', '-lc', s.start];
    const reg = await servicesMgr.runServer({ name: `live ${p.name} ${key}`, port, cwd, cmd, project: p.name, env, runAs, account, live: { project: p.name, key, title: s.title || key } });
    const given = (Array.isArray(s.needs) ? s.needs : []).map(String).filter(n => n in env);
    if (given.length) record('credential', 'service-start', { project: p.name, actor: 'PlatOpypus', via: `live service (${account || runAs})`, what: `${p.name}/${key}`, names: given });
    if (runAs === 'root') record('elevate', 'root-start', { project: p.name, actor: 'PlatOpypus', via: 'live service', what: `${p.name}/${key}`, cmd: String(s.start) });
    log('live', `started ${project}/${key}`);
    return tookOver ? { ...reg, tookOver } : reg;
}

export async function restart(project, key) {
    const { p, s } = findService(project, key);
    const slug = slugOf(project, key);
    if ((await servicesMgr.list()).some(r => r.slug === slug && r.alive)) { await stopContainer(p, key, s); await servicesMgr.stop(slug, { keepTunnel: true }); }
    return start(project, key);
}

// ---- container services: image: instead of start: ----
// The pane runs `docker run` (attached, --rm) as PlatOpypus, so the service registry, log, stop and hostname work as for
// any process. argv is composed here from checked fields, never from free text in the file, so nothing an agent writes
// runs as root. Inside, the app runs as the project's account; it sees its project folders only, bound to loopback.
// Vault values go in by name (-e NAME) from the pane's environment: they are never on the command line.
async function containerArgv(p, key, s, account, env, port) {
    const name = containerName(p, key);
    const a = svcUser.info(account); if (!a) throw httpError(500, `No account ${account}.`);
    await dockerMgr.remove(name).catch(() => {});   // a leftover from a hard stop or a reboot
    const asImage = s.user === 'image';
    const args = ['run', '--rm', '--name', name, '--init', '--log-driver', 'none', '--security-opt', 'no-new-privileges'];
    if (!asImage) args.push('--user', `${a.uid}:${a.gid}`, '--cap-drop', 'ALL');
    if (port) args.push('-p', `127.0.0.1:${port}:${Number(s.container_port || port)}`);
    if (s.memory) args.push('--memory', String(s.memory));
    for (const v of Array.isArray(s.volumes) ? s.volumes : []) {
        const pv = parseVolume(v); if (!pv) throw httpError(400, `Bad volume "${v}".`);
        const host = path.resolve(p.root, pv.host);
        if (host !== p.root && !host.startsWith(p.root + path.sep)) throw httpError(400, 'Volumes must stay inside the project.');
        fs.mkdirSync(host, { recursive: true });
        // The app writes as the account: hand it the folder (once; restored data is usually root's).
        if (!asImage && !pv.ro) { try { if (fs.statSync(host).uid !== a.uid) await run('chown', ['-R', `${a.uid}:${a.gid}`, host], { timeout: 120_000 }); } catch (e) { log('live', `chown ${host}: ${e.message}`); } }
        args.push('-v', `${host}:${pv.cont}${pv.ro ? ':ro' : ''}`);
    }
    // Settings from the file (not secret) go in by value; Vault values and PlatOpypus's names by name only, so they are
    // taken from the pane's environment and never appear on the command line. PATH stays the image's own.
    const fixed = s.env && typeof s.env === 'object' ? s.env : {};
    for (const k of Object.keys(env)) { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || k === 'PATH') continue; args.push('-e', k in fixed ? `${k}=${env[k]}` : k); }
    args.push(String(s.image));
    const extra = Array.isArray(s.command) ? s.command.map(String) : typeof s.command === 'string' && s.command.trim() ? s.command.trim().split(/\s+/) : [];
    return ['docker', ...args, ...extra];
}
async function stopContainer(p, key, s) {
    if (!isContainer(s)) return;
    // A clean stop (SIGTERM, then 15 s) before the pane's process group is killed: the container is what holds data.
    await dockerMgr.stop(containerName(p, key), 15).catch(() => {});
}

// Pull the image again; a running service is restarted when the image changed.
export async function pull(project, key) {
    const { p, s } = findService(project, key);
    if (!isContainer(s)) throw httpError(400, 'This service runs a command, not an image.');
    const before = await dockerMgr.imageId(s.image).catch(() => null);
    await dockerMgr.pull(s.image);
    const after = await dockerMgr.imageId(s.image).catch(() => null);
    const changed = before !== after;
    const running = (await servicesMgr.list()).some(r => r.slug === slugOf(p.name, key) && r.alive);
    if (running && changed) await restart(project, key);
    log('live', `pulled ${s.image} for ${project}/${key}: ${changed ? 'new image' : 'no change'}${running && changed ? ', restarted' : ''}`);
    return { image: s.image, changed, restarted: running && changed, id: after ? after.replace(/^sha256:/, '').slice(0, 12) : null };
}

// 2.0: move from the `porthole` tmux socket to `plato`. Live services are stopped and started again on the new
// server; every other session on the old server (shells, plain servers, quick links) ends with it, which is why
// this is a step the user takes, not something an update does.
export async function finishRename() {
    if (!config.renamePending) return { done: true, restarted: [], note: 'already on the plato socket' };
    const regs = await servicesMgr.list().catch(() => []);
    const liveUp = regs.filter(r => r.alive && r.live).map(r => r.live);
    for (const l of liveUp) await stop(l.project, l.key).catch(() => {});
    try { await tmux('kill-server'); } catch { /* already gone */ }
    switchSocket('plato');
    const restarted = [];
    for (const l of liveUp) { try { await start(l.project, l.key); restarted.push(`${l.project}/${l.key}`); } catch (e) { log('live', `finish rename: ${l.project}/${l.key}: ${e.message}`); } }
    log('live', `rename finished: tmux on the plato socket; restarted ${restarted.join(', ') || 'nothing'}`);
    return { done: true, restarted };
}

// After a reboot: live services that were running (not stopped by anyone) are started again.
export async function autostart() {
    const regs = await servicesMgr.list().catch(() => []);
    const done = [];
    for (const r of regs) {
        if (!r.live || r.alive || r.stoppedAt) continue;
        try { await start(r.live.project, r.live.key); done.push(r.slug); } catch (e) { log('live', `autostart ${r.slug}: ${e.message}`); }
    }
    if (done.length) log('live', `started again after boot: ${done.join(', ')}`);
    return done;
}

// Restart by registry slug (svc restart live-..., or an action that restarts its own service).
export async function restartSlug(slug) {
    const it = await servicesMgr.get(slug);
    if (it.live) return restart(it.live.project, it.live.key);
    for (const p of projects()) for (const key of Object.keys(p.data.services || {})) if (slugOf(p.name, key) === slug) return restart(p.name, key);
    throw httpError(404, 'That live service is no longer in its PORTHOLE.md.');
}

export async function stop(project, key) {
    const { p, s } = findService(project, key);
    const slug = slugOf(project, key);
    await stopContainer(p, key, s);
    // Stop the process but keep a hostname in place: nginx shows the coming-up page until it is started again.
    const db = await servicesMgr.list();
    if (!db.some(r => r.slug === slug)) throw httpError(409, 'Not running.');
    const r = await servicesMgr.stop(slug, { keepTunnel: true });
    log('live', `stopped ${project}/${key}`);
    return r;
}

// Runs one action command for a service, as its account (or root when approved), with restart/stop_first handling.
async function runAction(p, project, key, s, a, extraEnv, what) {
    const runAs = mustRun(p, key, s);
    const account = runAs === 'service' ? await prepareAccount(p) : null;
    const { env: baseEnv } = await envForService(p, s);
    const env = { ...baseEnv, ...extraEnv };
    const cwd = path.resolve(p.root, s.cwd || '.');
    const slug = slugOf(project, key);
    const started = Date.now();
    const wasRunning = (await servicesMgr.list()).some(r => r.slug === slug && r.alive);
    let out = '', code = 0;
    // stop_first: the service is stopped while the command runs (so it cannot write its old state back), then started.
    if (a.stop_first && wasRunning) { await servicesMgr.stop(slug, { keepTunnel: true }); out += '[stopped the service]\n'; }
    try {
        // As the service account unless root was approved: the command text comes from a file agents can edit.
        const [bin, args] = runAs === 'service' ? svcUser.argv(account, String(a.run), env) : ['bash', ['-lc', String(a.run)]];
        const r = await run(bin, args, { cwd, env: { ...actionBaseEnv(), ...env }, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
        out += (r.stdout || '') + (r.stderr ? `\n${r.stderr}` : '');
    } catch (e) {
        code = e.code ?? 1; out += (e.stdout || '') + (e.stderr ? `\n${e.stderr}` : '') + (e.killed ? '\n[stopped after 120 s]' : '');
    }
    if ((a.stop_first && wasRunning) || (a.restart && code === 0)) {
        try { await (a.stop_first ? start(project, key) : restart(project, key)); out += `\n[${a.stop_first ? 'started' : 'restarted'} the service]`; }
        catch (e) { code = code || 1; out += `\n[could not start the service: ${e.message}]`; }
    } else if (a.restart) out += '\n[not restarted: the command failed]';
    const names = Object.keys(extraEnv).filter(n => n.startsWith('INPUT_'));
    log('live', `action "${what}" on ${project}/${key} as ${account || runAs}${names.length ? ` with ${names.join(', ')}` : ''} → exit ${code}`);
    // Keep a record in the service log when there is one.
    try { const reg = await servicesMgr.get(slug); if (reg.log) fs.appendFileSync(reg.log, `\n[action ${new Date().toISOString()}] ${what} → exit ${code}\n${out.slice(-20000)}\n`); } catch { /* not running yet */ }
    return { label: what, code, ms: Date.now() - started, output: out.slice(-60000) };
}

export async function action(project, key, index, values = {}) {
    const { p, s } = findService(project, key);
    const a = (Array.isArray(s.actions) ? s.actions : [])[Number(index)];
    if (!a) throw httpError(404, 'No such action.');
    const inputs = inputEnv(a.inputs, values && typeof values === 'object' ? values : {});
    const r = await runAction(p, project, key, s, a, inputs, String(a.label));
    recordRun({ kind: 'action', project, key, action: a.label }, { code: r.code });
    return r;
}

// Groups: a list command names the items (rooms, sessions, users…), and each item gets the group's actions with
// GROUP_ITEM set to its id. The list runs as the service would, so it sees exactly what the service sees.
const ITEM_ID_RE = /^[\w.:@+\-=/]{1,128}$/;
const MAX_ITEMS = 300;
function findGroup(project, key, gi) {
    const { p, s } = findService(project, key);
    const g = (Array.isArray(s.groups) ? s.groups : [])[Number(gi)];
    if (!g?.list) throw httpError(404, 'No such group.');
    return { p, s, g };
}
export function parseItems(text) {
    const t = String(text || '').trim();
    let raw = null;
    if (/^[[{]/.test(t)) { try { const j = JSON.parse(t); raw = Array.isArray(j) ? j : Array.isArray(j?.items) ? j.items : null; } catch { raw = null; } }
    if (!raw) raw = t.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const [id, ...rest] = l.split(/\t| {2,}/); return { id, label: rest.join(' ').trim() || null }; });
    const seen = new Set(), items = [];
    for (const r of raw) {
        const it = typeof r === 'object' && r ? r : { id: r };
        const id = String(it.id ?? '').trim();
        if (!ITEM_ID_RE.test(id) || seen.has(id)) continue;
        seen.add(id);
        items.push({ id, label: it.label ? String(it.label).slice(0, 120) : null, sub: it.sub ? String(it.sub).slice(0, 200) : null });
        if (items.length >= MAX_ITEMS) break;
    }
    return items;
}
export async function groupItems(project, key, gi) {
    const { p, s, g } = findGroup(project, key, gi);
    const runAs = mustRun(p, key, s);
    const account = runAs === 'service' ? await prepareAccount(p) : null;
    const { env } = await envForService(p, s);
    const cwd = path.resolve(p.root, s.cwd || '.');
    const [bin, args] = runAs === 'service' ? svcUser.argv(account, String(g.list), env) : ['bash', ['-lc', String(g.list)]];
    try {
        const r = await run(bin, args, { cwd, env: { ...actionBaseEnv(), ...env }, timeout: 20_000, maxBuffer: 1024 * 1024 });
        return { label: String(g.label), items: parseItems(r.stdout), error: null };
    } catch (e) {
        return { label: String(g.label), items: parseItems(e.stdout), error: `${String(e.stderr || e.message || 'list failed').trim().split('\n').slice(-3).join(' ').slice(0, 300)}${e.killed ? ' (stopped after 20 s)' : ''}` };
    }
}
// item: one id, or '*' for every item the list prints now. Ids must come from the list, not from the caller.
export async function groupAction(project, key, gi, ai, item, values = {}) {
    const { p, s, g } = findGroup(project, key, gi);
    const a = (Array.isArray(g.actions) ? g.actions : [])[Number(ai)];
    if (!a) throw httpError(404, 'No such action.');
    const inputs = inputEnv(a.inputs, values && typeof values === 'object' ? values : {});
    const { items, error } = await groupItems(project, key, gi);
    let targets;
    if (item === '*') {
        if (a.all === false) throw httpError(400, `"${a.label}" runs on one ${g.item || 'item'} at a time.`);
        targets = items;
        if (!targets.length) throw httpError(409, error ? `The list failed: ${error}` : `No ${g.item || 'item'}s right now.`);
    } else {
        targets = items.filter(i => i.id === String(item));
        if (!targets.length) throw httpError(404, `${String(item).slice(0, 60)} is not in ${g.label} any more.`);
    }
    const many = targets.length > 1;
    const results = [];
    for (const t of targets) {
        const r = await runAction(p, project, key, s, { ...a, restart: many ? false : a.restart, stop_first: many ? false : a.stop_first }, { ...inputs, GROUP: String(g.label), GROUP_ITEM: t.id }, `${a.label} · ${t.id}`);
        results.push({ id: t.id, code: r.code, ms: r.ms, output: r.output.slice(-8000) });
    }
    // Several items: restart once at the end rather than once per item.
    let tail = '';
    if (many && (a.restart || a.stop_first) && results.every(r => r.code === 0)) { try { await restart(project, key); tail = '\n[restarted the service]'; } catch (e) { tail = `\n[could not restart: ${e.message}]`; } }
    const failed = results.filter(r => r.code !== 0).length;
    recordRun(item === '*' ? { kind: 'group', project, key, group: g.label, action: a.label } : { kind: 'item', project, key, group: g.label, action: a.label, item: targets[0].id, itemLabel: targets[0].label }, { code: failed ? 1 : 0 });
    return {
        label: a.label, items: results.length, failed, code: failed ? 1 : 0, ms: results.reduce((n, r) => n + r.ms, 0),
        output: (results.length === 1 ? results[0].output : results.map(r => `-- ${r.id} · exit ${r.code}\n${r.output.trim()}`).join('\n\n')) + tail,
    };
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
    record('credential', 'service-revealed', { project, actor: 'phone', what: `${view.label} · ${project}/${key}`, names: view.fields.filter(f => f.ref).map(f => f.ref) });
    return view;
}

export async function putOnHostname(project, key, { takeOver = false } = {}) {
    const { s } = findService(project, key);
    if (!s.port) throw httpError(400, 'A worker has no port to serve.');
    if (!s.hostname) throw httpError(400, 'Set hostname: in PORTHOLE.md first (or use Share on your domain).');
    const r = await zoned.create({ port: Number(s.port), hostname: String(s.hostname).toLowerCase(), name: s.title || `${project} ${key}`, takeOver });
    if (takeOver) record('activity', 'hostname-moved', { project, actor: 'phone', what: `${String(s.hostname).toLowerCase()} → this box` });
    return r;
}

export function check(root) {
    const p = readProject(path.resolve(root));
    if (!p) return { ok: false, file: null, errors: ['No PORTHOLE.md or docs/PORTHOLE.md here.'], warnings: [], services: [] };
    return { ok: !p.errors.length, file: p.file, errors: p.errors, warnings: p.warnings, services: Object.keys(p.data.services || {}) };
}
