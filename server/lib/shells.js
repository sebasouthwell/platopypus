// Shells: tmux sessions the user opens from the phone. Kind is "claude" (runs Claude Code in the
// folder) or "shell" (plain login shell). Metadata lives in state/shells.json; the tmux server is
// the source of truth for what is actually alive.

import fs from 'node:fs';
import path from 'node:path';
import pty from 'node-pty';
import { config } from './config.js';
import { tmux, tmuxBase, listSessions, hasSession, newSession, killSession, capture, validName } from './tmux.js';
import { resolveInRoot } from './files.js';
import { envFor } from './vault.js';
import * as agents from './agents.js';
import crypto from 'node:crypto';
import * as agentUser from './agentuser.js';
import * as secProfile from './profile.js';
import { trustFolder } from './trust.js';
import { tmux as tmuxCmd } from './tmux.js';
import { log } from './log.js';

const metaFile = path.join(config.state, 'shells.json');
let meta = {};
try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { /* first run */ }

function persist() {
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), { mode: 0o600 });
}

const RESERVED_PREFIXES = ['tunnel-', 'svc-', 'zoned-'];

export async function list() {
    const live = await listSessions();
    const shells = [];
    for (const s of live) {
        if (RESERVED_PREFIXES.some(p => s.name.startsWith(p))) continue;
        const m = meta[s.name] || {};
        let preview = [];
        try { preview = await capture(s.name, 3); } catch { /* racing a kill */ }
        shells.push({
            name: s.name,
            kind: m.kind === 'claude' ? 'agent' : (m.kind || 'shell'),
            agent: m.agent || (m.kind === 'claude' ? 'claude' : null),
            yolo: !!m.yolo, resume: !!m.resume, profile: m.profile || null, scratch: !!m.scratch, runAs: m.runAs || 'root', session: m.session || null, security: m.security || null,
            cwd: m.cwd || config.root,
            created: m.created || s.created,
            attached: s.attached,
            preview,
        });
    }
    // Forget metadata for sessions that no longer exist.
    const liveNames = new Set(live.map(s => s.name));
    let dirty = false;
    for (const name of Object.keys(meta)) {
        if (!liveNames.has(name)) { delete meta[name]; dirty = true; }
    }
    if (dirty) persist();
    shells.sort((a, b) => b.created - a.created);
    return shells;
}

export const scratchRoot = path.join(config.home, 'scratch');

export async function create({ name, kind = 'shell', cwd = '', agent, yolo = false, resume = false, profile = 'default', login = false, scratch = false, runAs = 'root', session = null, firstPrompt = null }) {
    if (firstPrompt !== null && (typeof firstPrompt !== 'string' || firstPrompt.length > 20000)) throw httpError(400, 'firstPrompt: text up to 20 000 characters.');
    if (!['root', 'agent'].includes(runAs)) throw httpError(400, 'runAs: root or agent.');
    if (session !== null && !['control', 'project'].includes(session)) throw httpError(400, 'session: control or project.');
    if (!validName(name)) throw httpError(400, 'Name: letters, numbers, dash or underscore, up to 40 characters.');
    if (RESERVED_PREFIXES.some(p => name.startsWith(p))) throw httpError(400, `Names starting with ${RESERVED_PREFIXES.map(p => `"${p}"`).join(', ')} are reserved.`);
    if (await hasSession(name)) throw httpError(409, 'A shell with that name already exists.');
    if (kind === 'claude') { kind = 'agent'; agent = agent || 'claude'; }   // backwards compatible
    if (!['shell', 'agent', 'remote-control'].includes(kind)) throw httpError(400, 'Unknown shell kind.');

    // Scratch: a throwaway folder that is deleted when the shell ends.
    let dir;
    if (scratch) {
        dir = path.join(scratchRoot, `${new Date().toISOString().slice(0, 10)}-${name}`);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } else {
        // No folder given → the home folder (not the files root, which may be "/").
        dir = !cwd || cwd === '.' ? config.home : resolveInRoot(cwd);
    }
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw httpError(400, 'That folder does not exist.');

    let command, agentEnv = {}, agentInfo = null;
    if (kind === 'agent') {
        const built = agents.command({ agent, yolo: !!yolo, resume: !!resume, profile, login: !!login });
        command = built.cmd; agentEnv = built.env;
        agentInfo = { agent, yolo: !!yolo, resume: !!resume, profile: profile || 'default' };
        // First message: Claude Code and Codex take it as an argument (from the environment, so no quoting issues);
        // Antigravity gets it typed in once it is up.
        if (firstPrompt && firstPrompt.trim() && !login) { agentEnv.PORTHOLE_FIRST_PROMPT = firstPrompt.trim(); if (agent === 'claude' || agent === 'codex') command += ' "$PORTHOLE_FIRST_PROMPT"'; }
    }
    if (kind === 'remote-control') {
        command = 'claude remote-control';
        if (profile && profile !== 'default') agentEnv.CLAUDE_CONFIG_DIR = agents.profileDir(profile);
    }

    // Session type and security brief (agents read $PORTHOLE_SECURITY_FILE first; see deploy/AGENT.global.md).
    let sessionEnv = {}, security = null;
    if (kind === 'agent' && session) {
        if (session === 'control') { security = 'control'; sessionEnv = { PORTHOLE_SESSION: 'control', PORTHOLE_SECURITY_LEVEL: 'control', PORTHOLE_SECURITY_FILE: secProfile.controlDoc() }; }
        else {
            const g = secProfile.get(dir);
            if (g.root && !g.profile) { const e = httpError(428, `Choose a security level for ${g.name} first.`); e.needProfile = true; throw e; }
            security = g.profile?.key || null;
            sessionEnv = { PORTHOLE_SESSION: 'project', ...(g.profile ? { PORTHOLE_SECURITY_LEVEL: g.profile.key, PORTHOLE_SECURITY_FILE: g.securityFile, PORTHOLE_PROJECT_ROOT: g.root } : {}) };
        }
    }

    // Agent user: no root, its own API token, project folder made group-writable.
    let tokenHash = null, shellEnv = {};
    if (runAs === 'agent') {
        if (kind === 'remote-control') throw httpError(400, 'Remote Control runs as root for now.');
        await agentUser.prepareFolder(dir);
        const token = crypto.randomBytes(24).toString('base64url');
        tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        shellEnv = { PORTHOLE_TOKEN: token, PORTHOLE_RUN_AS: 'agent' };
        if (agentEnv.CLAUDE_CONFIG_DIR) delete agentEnv.CLAUDE_CONFIG_DIR; // root profiles are not readable; stage 2 moves them
        command = agentUser.wrap(command || '');
    }
    // Skip each agent's "trust this folder?" prompt for the folder the user picked here.
    if (kind === 'agent' || kind === 'remote-control') {
        const a = runAs === 'agent' ? agentUser.info() : null;
        trustFolder(kind === 'remote-control' ? 'claude' : agent, dir, { home: a ? a.home : config.home, configDir: runAs === 'agent' ? null : (agentEnv.CLAUDE_CONFIG_DIR || null), owner: a ? { uid: a.uid, gid: a.gid } : null });
    }
    // General-scope vault tokens become environment variables; project credentials: `vault get` from the project folder.
    const secrets = await envFor(dir, { project: 'none' });
    await newSession(name, dir, command, { TERM: 'xterm-256color', COLORTERM: 'truecolor', PORTHOLE_SHELL_NAME: name, ...secrets, ...agentEnv, ...sessionEnv, ...shellEnv });
    if (Object.keys(secrets).length) log('vault', `exported ${Object.keys(secrets).join(', ')} into shell "${name}"`);
    if (agent === 'antigravity' && agentEnv.PORTHOLE_FIRST_PROMPT) {
        const text = agentEnv.PORTHOLE_FIRST_PROMPT;
        setTimeout(() => { tmuxCmd('send-keys', '-t', `${name}:`, '-l', text).then(() => tmuxCmd('send-keys', '-t', `${name}:`, 'Enter')).catch(() => {}); }, 9000);
    }
    meta[name] = { kind, cwd: dir, created: Date.now(), scratch: !!scratch, runAs, ...(session ? { session } : {}), ...(security ? { security } : {}), ...(tokenHash ? { tokenHash } : {}), ...(agentInfo || {}) };
    persist();
    log('shell', `created ${kind}${agentInfo ? ` (${agentInfo.agent}${agentInfo.yolo ? ', auto-approve' : ''}${agentInfo.resume ? ', resume' : ''}${agentInfo.profile !== 'default' ? ', profile ' + agentInfo.profile : ''})` : ''} "${name}" in ${dir}`);
    return { name, kind, cwd: dir, created: meta[name].created, runAs, ...(agentInfo || {}) };
}

// Which live agent-user shell a token belongs to (null for anything else).
export async function shellForToken(token) {
    if (!token || typeof token !== 'string') return null;
    const h = crypto.createHash('sha256').update(token).digest('hex');
    for (const [name, m] of Object.entries(meta)) {
        if (m.tokenHash && m.tokenHash.length === h.length && crypto.timingSafeEqual(Buffer.from(m.tokenHash), Buffer.from(h))) return (await hasSession(name)) ? { name, ...m } : null;
    }
    return null;
}
export function shellMeta(name) { return meta[name] || null; }
export async function panePid(name) { try { return Number((await tmux('display-message', '-p', '-t', `${name}:`, '#{pane_pid}')).trim()) || null; } catch { return null; } }

export async function kill(name, { deleteScratch = true } = {}) {
    if (!validName(name)) throw httpError(400, 'Bad shell name.');
    if (!(await hasSession(name))) throw httpError(404, 'No such shell.');
    await killSession(name);
    const m = meta[name];
    delete meta[name];
    persist();
    log('shell', `killed "${name}"`);
    // Scratch shells take their folder with them (only ever under ~/scratch).
    if (m?.scratch && deleteScratch && m.cwd && m.cwd.startsWith(scratchRoot + path.sep)) {
        fs.rmSync(m.cwd, { recursive: true, force: true });
        log('shell', `deleted scratch folder ${m.cwd}`);
    }
}

// Attach a pty to a tmux session for a WebSocket client. Returns the pty process.
export async function attach(name, cols, rows) {
    if (!validName(name)) throw httpError(400, 'Bad shell name.');
    if (!(await hasSession(name))) throw httpError(404, 'No such shell.');
    const proc = pty.spawn('tmux', [...tmuxBase, 'attach-session', '-t', `=${name}`], {
        name: 'xterm-256color',
        cols: clampInt(cols, 20, 500, 80),
        rows: clampInt(rows, 5, 300, 24),
        cwd: config.root,
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: process.env.LANG || 'C.UTF-8' },
    });
    return proc;
}

// Per-shell tmux mouse mode. Off = the browser selects text and apps that want the mouse (vim, htop) still
// get it; on = wheel scrolls tmux history and clicks go to tmux.
export async function mouse(name, on) {
    if (!validName(name)) throw httpError(400, 'Bad shell name.');
    if (!(await hasSession(name))) throw httpError(404, 'No such shell.');
    // Note: set-option/show-options do not accept the "=name" exact-match target (tmux 3.4: "no such session"); "name:" does.
    if (typeof on === 'boolean') await tmux('set-option', '-t', `${name}:`, 'mouse', on ? 'on' : 'off');
    const out = await tmux('show-options', '-t', `${name}:`, '-v', 'mouse');
    return { mouse: out.trim() === 'on' };
}

// Full scrollback of a session as plain text (joined wrapped lines), for the phone's copy view.
export async function scrollback(name, lines = 2000) {
    if (!validName(name)) throw httpError(400, 'Bad shell name.');
    if (!(await hasSession(name))) throw httpError(404, 'No such shell.');
    const n = clampInt(lines, 50, 20000, 2000);
    const out = await tmux('capture-pane', '-p', '-J', '-t', `${name}:`, '-S', `-${n}`);
    return out.replace(/\s+$/, '') + '\n';
}

export function clampInt(v, min, max, fallback) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

export function httpError(status, message) {
    const e = new Error(message);
    e.status = status;
    return e;
}

export { tmux };
