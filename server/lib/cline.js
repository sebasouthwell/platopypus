// Cline, the fourth agent, runs on an Ollama server you choose. Cline's own "ollama" provider only knows this machine,
// so it is pointed at that server's OpenAI-compatible API (<address>/v1), which every Ollama serves.
// PlatOpypus keeps the address, the model and an optional Ollama API key (sent as a bearer token; encrypted),
// and writes Cline's provider settings for whichever user runs it, just before it starts.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as agentsLib from './agents.js';
import path from 'node:path';
import { config } from './config.js';
import { record } from './audit.js';
import * as vault from './vault.js';

const file = path.join(config.state, 'cline.json');
const MODEL_OK = /^[A-Za-z0-9][A-Za-z0-9._:\/\[\]-]{0,99}$/;
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
const base = s => String(s || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');

export function settings() { const c = load(); return { endpoint: c.endpoint || '', model: c.model || '', hasKey: !!c.key, ready: !!(c.endpoint && c.model) }; }
export function configure(body = {}) {
    const c = load();
    if (body.endpoint !== undefined) {
        const e = base(body.endpoint);
        if (e) { let u; try { u = new URL(e); } catch { throw httpError(400, 'The server address should look like http://10.0.0.20:11434'); } if (!/^https?:$/.test(u.protocol)) throw httpError(400, 'The server address starts with http:// or https://'); }
        c.endpoint = e;
    }
    if (body.model !== undefined) { const m = String(body.model || '').trim(); if (m && !MODEL_OK.test(m)) throw httpError(400, 'That model name is not valid.'); c.model = m; }
    if (body.key !== undefined) { const k = String(body.key || '').trim(); if (k) c.key = vault.encrypt(k); else delete c.key; }
    fs.writeFileSync(file, JSON.stringify(c, null, 2), { mode: 0o600 });
    record('activity', 'cline-settings', { actor: 'phone', what: `Cline: ${c.endpoint || 'no server'}${c.model ? ` · ${c.model}` : ''}` });
    return settings();
}
// The models the server has (Ollama's own list, else the OpenAI-style one), to choose from.
export async function models(endpoint) {
    const e = base(endpoint || load().endpoint); if (!e) throw httpError(400, 'Set the Ollama server address first.');
    const c = load(); const headers = c.key ? { Authorization: `Bearer ${vault.decrypt(c.key)}` } : {};
    try {
        const r = await fetch(`${e}/api/tags`, { headers, signal: AbortSignal.timeout(8000) });
        if (r.ok) { const d = await r.json(); return { endpoint: e, models: (d.models || []).map(m => ({ name: m.name, size: m.size || null, family: m.details?.family || '' })) }; }
    } catch { /* try the other one */ }
    try {
        const r = await fetch(`${e}/v1/models`, { headers, signal: AbortSignal.timeout(8000) });
        if (r.ok) { const d = await r.json(); return { endpoint: e, models: (d.data || []).map(m => ({ name: m.id })) }; }
        throw httpError(502, `The server answered ${r.status}.`);
    } catch (err) { if (err.status) throw err; throw httpError(502, `Could not reach ${e} from the box (${err.cause?.code || err.message}).`); }
}
// Write Cline's provider settings into <home>/.cline for the user who will run it (keeps any other providers there).
export function prepare(home, owner = null) {
    const c = load(); if (!c.endpoint || !c.model) throw httpError(412, 'Cline needs an Ollama server: set it on More → AI agents.');
    const dir = path.join(home, '.cline', 'data', 'settings'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const f = path.join(dir, 'providers.json'); let cur = {}; try { cur = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* new */ }
    const next = { version: 1, modes: {}, ...cur, lastUsedProvider: 'openai-compatible', providers: { ...(cur.providers || {}), 'openai-compatible': { settings: { provider: 'openai-compatible', apiKey: c.key ? vault.decrypt(c.key) : 'ollama', model: c.model, baseUrl: `${c.endpoint}/v1` }, updatedAt: new Date().toISOString(), tokenSource: 'manual' } } };
    fs.writeFileSync(f, JSON.stringify(next, null, 2), { mode: 0o600 });
    if (owner) { for (const p of [path.join(home, '.cline'), path.join(home, '.cline', 'data'), dir, f]) { try { fs.chownSync(p, owner.uid, owner.gid); } catch { /* best effort */ } } }
    return { model: c.model };
}
// The other agents are told "read $PORTHOLE_SECURITY_FILE first"; a small local model rarely goes and reads it. Cline
// puts every file in $CLINE_DIR/rules into its system prompt, so each Cline shell gets its own config folder whose
// rules hold this session's brief word for word. The global instructions (~/.agents/AGENTS.md) are still read.
//
// Each Cline shell also gets its own data folder and its own hub port. Cline runs commands through a background "hub"
// that it starts once and then reuses; with a shared data folder and the fixed default port, a second Cline shell ran
// its commands inside the first shell's hub, with that shell's environment (its PlatOpypus token and session type).
// Separate folders and ports keep every shell's commands its own; the hub is stopped when its shell ends (sweepHubs).
const BRIEF_MAX = 60_000;
export function sessionRules(home, shell, env = {}, owner = null) {
    const root = path.join(home, '.cline', 'shells');
    // Folders of shells that ended long ago.
    try { for (const d of fs.readdirSync(root)) { const p = path.join(root, d); if (Date.now() - fs.statSync(p).mtimeMs > 14 * 86400_000) fs.rmSync(p, { recursive: true, force: true }); } } catch { /* none yet */ }
    const safe = String(shell).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'shell';
    const dir = path.join(root, safe), rules = path.join(dir, 'rules');
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(rules, { recursive: true, mode: 0o700 });
    let brief = '';
    if (env.PORTHOLE_SECURITY_FILE) { try { brief = fs.readFileSync(env.PORTHOLE_SECURITY_FILE, 'utf8').slice(0, BRIEF_MAX); } catch { /* not there */ } }
    const facts = [
        `- Session type: ${env.PORTHOLE_SESSION || 'plain shell'}`,
        env.PORTHOLE_SECURITY_LEVEL ? `- Security level: ${env.PORTHOLE_SECURITY_LEVEL}` : '',
        env.PORTHOLE_PROJECT_ROOT ? `- Project root: ${env.PORTHOLE_PROJECT_ROOT}` : '',
        `- Shell name: ${shell}`,
    ].filter(Boolean).join('\n');
    const text = `# This PlatOpypus session\n\nYou are running in a PlatOpypus agent shell. These facts and the brief below apply to everything you do in it; the general instructions about this box (the platopypus block) also apply.\n\n${facts}\n\n${brief ? `## Session brief (the file $PORTHOLE_SECURITY_FILE, included here so you do not need to read it)\n\n${brief.trim()}\n` : 'There is no separate brief for this session.\n'}`;
    const f = path.join(rules, 'platopypus-session.md'); fs.writeFileSync(f, text, { mode: 0o600 });
    const data = isolate(home, dir, owner, { session: env.PORTHOLE_SESSION });
    if (owner) { for (const p of [path.join(home, '.cline'), root, dir, rules, f]) { try { fs.chownSync(p, owner.uid, owner.gid); } catch { /* best effort */ } } }
    return { CLINE_DIR: dir, ...data };
}
// A data folder of its own (with the provider settings copied in) and a hub port no other shell uses.
const HUB_PORTS = [26000, 29999];
export function isolate(home, dir, owner = null, { session = null } = {}) {
    const data = path.join(dir, 'data'), settings = path.join(data, 'settings');
    fs.mkdirSync(settings, { recursive: true, mode: 0o700 });
    for (const n of ['providers.json', 'global-settings.json']) { const src = path.join(home, '.cline', 'data', 'settings', n); try { if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(settings, n)); fs.chmodSync(path.join(settings, n), 0o600); } } catch { /* not there */ } }
    const taken = new Set(); try { for (const d of fs.readdirSync(path.join(home, '.cline', 'shells'))) { const pf = path.join(home, '.cline', 'shells', d, 'hub.port'); if (path.join(home, '.cline', 'shells', d) !== dir && fs.existsSync(pf)) taken.add(Number(fs.readFileSync(pf, 'utf8'))); } } catch { /* none */ }
    let port; do { port = HUB_PORTS[0] + Math.floor(Math.random() * (HUB_PORTS[1] - HUB_PORTS[0])); } while (taken.has(port));
    fs.writeFileSync(path.join(dir, 'hub.port'), String(port));
    // A case or research shell: its tools as an MCP server, approved (PlatOpypus and the research command check every call).
    const m = agentsLib.MCP_FOR[session];
    if (m) fs.writeFileSync(path.join(settings, 'cline_mcp_settings.json'), JSON.stringify({ mcpServers: { [m.name]: { command: m.command, args: [], disabled: false, timeout: 900, autoApprove: m.tools } } }, null, 2), { mode: 0o600 });
    if (owner) { for (const p of [data, settings, ...fs.readdirSync(settings).map(n => path.join(settings, n)), path.join(dir, 'hub.port')]) { try { fs.chownSync(p, owner.uid, owner.gid); } catch { /* best effort */ } } }
    return { CLINE_DATA_DIR: data, CLINE_HUB_PORT: String(port) };
}
// Stop the hub that a Cline data folder started (its pid is in the hub's discovery file).
export function stopHub(dataDir) {
    try { const d = JSON.parse(fs.readFileSync(path.join(dataDir, 'locks', 'hub', 'production.json'), 'utf8')); if (Number.isInteger(d.pid) && d.pid > 1) { process.kill(d.pid, 'SIGTERM'); return d.pid; } } catch { /* no hub, or already gone */ }
    return null;
}
// Cline keeps running after its shell is closed (it outlives the terminal). Find the Cline processes that still carry
// the ended shell's name in their environment and stop them. Their environment is read as their own user when root
// may not (containers without ptrace rights).
function shellProcs(name, uid) {
    const want = `PORTHOLE_SHELL_NAME=${name}\0`; const out = [];
    let pids = []; try { pids = fs.readdirSync('/proc').filter(p => /^\d+$/.test(p)); } catch { return out; }
    for (const pid of pids) {
        try {
            const st = fs.readFileSync(`/proc/${pid}/status`, 'utf8'); if (uid !== undefined && !new RegExp(`^Uid:\\s+${uid}\\b`, 'm').test(st)) continue;
            if (!/cline/.test(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'))) continue;
            let env = ''; try { env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8'); } catch { const user = st.match(/^Uid:\s+(\d+)/m)?.[1]; const r = spawnSync('/usr/sbin/runuser', ['-u', uidName(user), '--', 'cat', `/proc/${pid}/environ`], { encoding: 'utf8' }); env = r.stdout || ''; }
            if (env.includes(want)) out.push(Number(pid));
        } catch { /* gone */ }
    }
    return out;
}
const uidName = uid => { try { return fs.readFileSync('/etc/passwd', 'utf8').split('\n').find(l => l.split(':')[2] === String(uid))?.split(':')[0] || 'nobody'; } catch { return 'nobody'; } };
// Shells that have ended: stop their Cline and its hub. Called every few seconds with the names of the shells still running.
export function sweepHubs(home, liveNames, uid) {
    const root = path.join(home, '.cline', 'shells'); let names = []; try { names = fs.readdirSync(root); } catch { return; }
    for (const n of names) {
        if (liveNames.has(n)) continue; const dir = path.join(root, n);
        if (!fs.existsSync(path.join(dir, 'hub.port'))) continue;
        stopHub(path.join(dir, 'data'));
        for (const pid of shellProcs(n, uid)) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
        fs.rmSync(path.join(dir, 'hub.port'), { force: true });
    }
}
