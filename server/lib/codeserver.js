// code-server (VS Code in the browser), run natively on the box — never started unless asked.
// Binds to 127.0.0.1 with its own generated password; "share" puts it behind a Cloudflare quick tunnel,
// which makes it a public URL guarded only by that password. The UI warns before doing so.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { hasSession, newSession, killSession, capture } from './tmux.js';
import { resolveInRoot } from './files.js';
import * as tunnels from './tunnels.js';
import * as dockerMgr from './docker.js';
import { log } from './log.js';

export const SHARE_MINUTES = 20;      // public links to an editor are short-lived by design
const PROJECT_IMAGE = 'codercom/code-server:latest';
const PROJECT_PREFIX = 'code-';

const run = promisify(execFile);
const SESSION = 'code-server';
const PORT = 8443;
const stateFile = path.join(config.state, 'code-server.json');

function httpError(status, message) {
    const e = new Error(message);
    e.status = status;
    return e;
}
function load() { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } }
function save(s) { fs.writeFileSync(stateFile, JSON.stringify(s, null, 2), { mode: 0o600 }); }

async function installed() {
    try { await run('bash', ['-lc', 'command -v code-server'], { timeout: 5000 }); return true; } catch { return false; }
}

function password() {
    const s = load();
    if (!s.password) { s.password = crypto.randomBytes(18).toString('base64url'); save(s); log('code-server', 'generated password'); }
    return s.password;
}

export async function status() {
    const running = await hasSession(SESSION);
    const s = load();
    const tl = await tunnels.list().catch(() => []);
    const t = tl.find(x => x.port === PORT) || null;
    let tail = [];
    if (running) { try { tail = await capture(SESSION, 2); } catch { /* racing */ } }
    return {
        installed: await installed(),
        running, port: PORT, folder: s.folder || null, startedAt: s.startedAt || null,
        shared: !!t, url: t?.url || null, expires: t?.expires || null,
        passwordHint: s.password ? `••••${s.password.slice(-4)}` : null,
        shareMinutes: SHARE_MINUTES,
        tail,
        projects: await projectList(tl),
    };
}

// ---------- project editors: code-server in Docker, one folder mounted ----------

function slug(folder) { return path.basename(folder).toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40) || 'project'; }

async function projectList(tl) {
    const s = load(); s.projects = s.projects || {};
    let containers = [];
    try { if (await dockerMgr.available()) containers = await dockerMgr.containers(); } catch { /* docker down */ }
    const out = [];
    for (const c of containers) {
        if (!c.name.startsWith(PROJECT_PREFIX)) continue;
        const meta = s.projects[c.name] || {};
        const port = c.ports[0]?.host ?? null;
        const t = port ? tl.find(x => x.port === port) : null;
        out.push({ name: c.name, folder: meta.folder || null, port, running: c.state === 'running', status: c.status, shared: !!t, url: t?.url || null, expires: t?.expires || null, passwordHint: meta.password ? `••••${meta.password.slice(-4)}` : null });
    }
    return out;
}

export async function startProject(folderRel) {
    if (!folderRel) throw httpError(400, 'Choose a project folder.');
    const folder = resolveInRoot(folderRel);
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw httpError(400, 'That folder does not exist.');
    if (!(await dockerMgr.available())) throw httpError(503, 'Docker is not running on the box.');
    const name = PROJECT_PREFIX + slug(folder);
    const existing = (await dockerMgr.containers()).find(c => c.name === name);
    const s = load(); s.projects = s.projects || {};
    const meta = s.projects[name] || {};
    if (!meta.password) meta.password = crypto.randomBytes(18).toString('base64url');
    meta.folder = folder;
    s.projects[name] = meta; save(s);
    if (existing) {
        if (existing.state !== 'running') await dockerMgr.action(name, 'start');
    } else {
        const port = await dockerMgr.freePortNear(8450);
        // Root inside the container so the mounted folder (owned by the box user) is writable; scope is the mount, not the uid.
        await dockerMgr.quickRunWithVolumes({ image: PROJECT_IMAGE, name, ports: [{ host: port, container: 8080 }], env: { PASSWORD: meta.password, DOCKER_USER: 'root' }, restart: 'unless-stopped', command: ['--auth', 'password', '--disable-telemetry', '--disable-update-check', '/home/coder/project'] }, [`${folder}:/home/coder/project`], ['-u', '0:0']);
        log('code-server', `project editor ${name} started on 127.0.0.1:${port} for ${folder}`);
    }
    return status();
}

function checkName(name) { if (!/^code-[a-z0-9_.-]{1,40}$/.test(String(name || ''))) throw httpError(400, 'Bad editor name.'); }

export async function stopProject(name) {
    checkName(name);
    const c = (await dockerMgr.containers()).find(x => x.name === name);
    if (!c) throw httpError(404, 'No such editor.');
    const port = c.ports[0]?.host;
    if (port) await tunnels.close(port).catch(() => {});
    await dockerMgr.action(name, 'remove');
    log('code-server', `project editor ${name} removed`);
    return status();
}

export async function shareProject(name) {
    checkName(name);
    const c = (await dockerMgr.containers()).find(x => x.name === name && x.state === 'running');
    if (!c || !c.ports[0]) throw httpError(409, 'Start the editor first.');
    const port = c.ports[0].host;
    if (!(await tunnels.list()).some(t => t.port === port)) {
        await tunnels.create({ port, name: `VS Code · ${name.slice(PROJECT_PREFIX.length)}`, host: config.dockerHost, ttlMinutes: SHARE_MINUTES });
        log('code-server', `project editor ${name} SHARED via public tunnel (${SHARE_MINUTES} min)`);
    }
    return status();
}

export async function unshareProject(name) {
    checkName(name);
    const c = (await dockerMgr.containers()).find(x => x.name === name);
    if (c?.ports[0]) await tunnels.close(c.ports[0].host).catch(() => {});
    return status();
}

export function revealProjectPassword(name, who) {
    checkName(name);
    const s = load(); const meta = s.projects?.[name];
    if (!meta) throw httpError(404, 'No such editor.');
    log('code-server', `project editor ${name} password REVEALED to ${who}`);
    return { password: meta.password };
}

export async function start(folderRel) {
    if (!(await installed())) throw httpError(503, 'code-server is not installed on the box (install.sh installs it).');
    if (await hasSession(SESSION)) throw httpError(409, 'code-server is already running.');
    const folder = folderRel ? resolveInRoot(folderRel) : config.home;
    const pw = password();
    const cmd = `code-server --bind-addr 127.0.0.1:${PORT} --auth password --disable-telemetry --disable-update-check ${shellQuote(folder)}`;
    await newSession(SESSION, folder, cmd, { PASSWORD: pw });
    const s = load(); s.folder = folder; s.startedAt = Date.now(); save(s);
    log('code-server', `started on 127.0.0.1:${PORT} in ${folder}`);
    return status();
}

export async function stop() {
    if (await hasSession(SESSION)) await killSession(SESSION);
    const t = (await tunnels.list().catch(() => [])).find(x => x.port === PORT);
    if (t) await tunnels.close(PORT).catch(() => {});
    log('code-server', 'stopped');
    return status();
}

export async function share() {
    if (!(await hasSession(SESSION))) throw httpError(409, 'Start code-server first.');
    const existing = (await tunnels.list().catch(() => [])).find(x => x.port === PORT);
    if (existing) return status();
    await tunnels.create({ port: PORT, name: 'VS Code (box editor)', host: '127.0.0.1', ttlMinutes: SHARE_MINUTES });
    log('code-server', `SHARED via public tunnel (${SHARE_MINUTES} min)`);
    return status();
}

export async function unshare() {
    await tunnels.close(PORT).catch(() => {});
    return status();
}

export function revealPassword(who) {
    log('code-server', `password REVEALED to ${who}`);
    return { password: password() };
}

export function rotatePassword() {
    const s = load(); s.password = crypto.randomBytes(18).toString('base64url'); save(s);
    log('code-server', 'password rotated (restart code-server to apply)');
    return { ok: true };
}

function shellQuote(x) { return `'${String(x).replace(/'/g, `'\\''`)}'`; }
