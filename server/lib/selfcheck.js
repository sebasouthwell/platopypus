// Self-check: what is live on the box, what it is built from, and what is known to be wrong with it; then agents that
// fix it, and a log of what they changed.
//
// Scan (PlatOpypus itself, no agent): every project with a live service or a registered server, PlatOpypus's own
// packages, and the box's tooling (nginx, certbot and the certificates, OpenSSL, Node.js, Docker, git, sudo, tmux,
// cloudflared, code-server, the agent CLIs and their MCP servers, Ubuntu security updates). Packages are checked
// against OSV.dev (GitHub advisories, PyPI, RubyGems, Go, crates, Ubuntu, and the OpenSSF malicious-packages feed);
// tools against their latest releases. Only package names and versions leave the box.
//
// Fix (one agent run per target, one at a time, auto-approved and therefore always as the agent user):
//   project   on a new branch plato/remediate-<time>; the agent commits there and runs the tests; services of that
//             project that were running are restarted on the branch; a failed restart is reverted (git revert) and
//             restarted again. Merging the branch back is the user's step (or Roll back = git revert).
//   plato     on a staged copy of PlatOpypus in the agent user's home. PlatOpypus checks the diff against a drift
//             limit (dependencies plus small advisory-tied patches; never auth, vault, elevation, install or update
//             code), then applies it with a snapshot, a health check and automatic rollback (bin/plato-selffix).
//             The patch is kept as a note for PlatOpypus developers; a later update replaces it.
//   box       the agent holds an elevation grant for its run and uses `elevate` for package upgrades, certificate
//             renewal and nginx reloads; /etc/nginx is snapshotted first. It never starts a stopped service.
// Schedule: scan on a cron line; alert on new findings; optionally fix pre-ticked targets on their own.
// State: <state>/selfcheck/{settings,scan,drift}.json, runs/<id>.json, osv-cache.json, snapshots/.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { log } from './log.js';
import { record } from './audit.js';
import * as live from './live.js';
import * as servicesMgr from './services.js';
import * as agentUser from './agentuser.js';
import * as elevate from './elevate.js';
import * as alerts from './alerts.js';
import * as kit from './kit/tools.js';
import { nextRun } from './schedules.js';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
export const APP = path.resolve(here, '..', '..');
const DIR = path.join(config.state, 'selfcheck');
const RUNS = path.join(DIR, 'runs');
const f = n => path.join(DIR, n);
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
function readJ(file, dflt) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; } }
function writeJ(file, v) { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const t = `${file}.tmp`; fs.writeFileSync(t, JSON.stringify(v, null, 1), { mode: 0o600 }); fs.renameSync(t, file); }
const sh = async (cmd, args, opt = {}) => { try { const r = await run(cmd, args, { timeout: 15_000, maxBuffer: 16 * 1024 * 1024, ...opt }); return { ok: true, out: `${r.stdout || ''}${r.stderr || ''}` }; } catch (e) { return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}`, code: e.code }; } };
const SEV = ['info', 'low', 'moderate', 'high', 'critical'];
const sevN = s => Math.max(0, SEV.indexOf(s));

// ---------- settings ----------
const DEFAULTS = { enabled: true, cron: '0 6 * * *', alert: true, alertSeverity: 'high', autoTargets: [], autoSeverity: 'high', autoRoot: false, autoApply: false, agent: 'claude', model: '' };
export function settings() { return { ...DEFAULTS, ...readJ(f('settings.json'), {}) }; }
export function setSettings(b = {}) {
    const s = settings();
    if (b.enabled !== undefined) s.enabled = !!b.enabled;
    if (b.alert !== undefined) s.alert = !!b.alert;
    if (b.cron !== undefined) { const c = String(b.cron).trim(); if (!nextRun(c)) throw httpError(400, 'Schedule: a cron line, e.g. "0 6 * * *" (06:00 every day).'); s.cron = c; }
    for (const k of ['alertSeverity', 'autoSeverity']) if (b[k] !== undefined) { if (!SEV.includes(b[k])) throw httpError(400, `${k}: ${SEV.join(', ')}.`); s[k] = b[k]; }
    if (b.autoTargets !== undefined) s.autoTargets = (Array.isArray(b.autoTargets) ? b.autoTargets : []).map(String).filter(t => /^(plato|box|p:[\w.-]{1,80})$/.test(t)).slice(0, 50);
    if (b.agent !== undefined) { if (!['claude', 'codex', 'antigravity'].includes(b.agent)) throw httpError(400, 'Agent: claude, codex or antigravity.'); s.agent = b.agent; }
    if (b.model !== undefined) s.model = String(b.model).slice(0, 60);
    if (b.autoRoot !== undefined) s.autoRoot = !!b.autoRoot;
    if (b.autoApply !== undefined) s.autoApply = !!b.autoApply;
    writeJ(f('settings.json'), s); return s;
}

// ---------- versions ----------
export function cmpVer(a, b) {
    const norm = v => String(v || '').replace(/^v/, '').replace(/^\d+:/, '');
    const pa = norm(a).split(/[^0-9A-Za-z]+/), pb = norm(b).split(/[^0-9A-Za-z]+/);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] ?? '', y = pb[i] ?? ''; if (x === y) continue;
        if (x === '') return -1; if (y === '') return 1;
        const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
        if (nx && ny) return Number(x) - Number(y) || 0;
        if (nx) return 1; if (ny) return -1; return x < y ? -1 : 1;
    }
    return 0;
}

// ---------- inventories: what each target is built from ----------
const SKIP = new Set(['node_modules', '.git', 'venv', '.venv', 'env', 'vendor', 'dist', 'build', '__pycache__', '.platopypus', '.porthole', '.next', 'target', 'site-packages', '.cache']);
function findFiles(root, names, depth = 4) {
    const out = []; const walk = (d, n) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) { if (n < depth && !SKIP.has(e.name) && !e.name.startsWith('.')) walk(p, n + 1); } else if (names.some(x => (x instanceof RegExp ? x.test(e.name) : x === e.name))) out.push(p); } };
    walk(root, 0); return out.slice(0, 40);
}
const pk = (ecosystem, name, version, file, dev = false) => ({ ecosystem, name, version: String(version).replace(/^[=v~^]+/, ''), file, dev });
function parseLock(file) {
    const base = path.basename(file); let t = ''; try { t = fs.readFileSync(file, 'utf8'); } catch { return []; } if (t.length > 30 * 1024 * 1024) return [];
    const out = [];
    try {
        if (base === 'package-lock.json') {
            const j = JSON.parse(t);
            if (j.packages) for (const [k, v] of Object.entries(j.packages)) { if (!k || !v?.version || v.link) continue; const name = v.name || k.slice(k.lastIndexOf('node_modules/') + 13); out.push(pk('npm', name, v.version, file, !!v.dev)); }
            else { const walk = deps => { for (const [n, v] of Object.entries(deps || {})) { if (v.version) out.push(pk('npm', n, v.version, file, !!v.dev)); walk(v.dependencies); } }; walk(j.dependencies); }
        } else if (base === 'yarn.lock') {
            let cur = null; for (const line of t.split('\n')) { const h = line.match(/^"?(@?[^@\s"]+)@/); if (h && !line.startsWith(' ')) cur = h[1]; const v = line.match(/^\s+version:?\s+"?([^"\s]+)"?/); if (v && cur) { out.push(pk('npm', cur, v[1], file)); cur = null; } }
        } else if (/^requirements.*\.txt$/.test(base)) {
            for (const line of t.split('\n')) { const m = line.replace(/#.*/, '').trim().match(/^([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*==\s*([A-Za-z0-9_.+!*-]+)/); if (m && /^\d+(\.\d+)*[A-Za-z0-9.+!-]*$/.test(m[2]) && !m[2].endsWith('.')) out.push(pk('PyPI', m[1], m[2], file)); }
        } else if (base === 'Pipfile.lock') {
            const j = JSON.parse(t); for (const [sec, dev] of [['default', false], ['develop', true]]) for (const [n, v] of Object.entries(j[sec] || {})) if (v.version) out.push(pk('PyPI', n, v.version.replace(/^==/, ''), file, dev));
        } else if (base === 'poetry.lock' || base === 'Cargo.lock' || base === 'uv.lock') {
            const eco = base === 'Cargo.lock' ? 'crates.io' : 'PyPI';
            for (const blk of t.split(/\[\[package\]\]/).slice(1)) { const n = blk.match(/\nname = "([^"]+)"/), v = blk.match(/\nversion = "([^"]+)"/); if (n && v) out.push(pk(eco, n[1], v[1], file)); }
        } else if (base === 'Gemfile.lock') {
            let inSpecs = false; for (const line of t.split('\n')) { if (/^ {2}specs:/.test(line)) { inSpecs = true; continue; } if (/^\S/.test(line)) inSpecs = false; const m = inSpecs && line.match(/^ {4}([A-Za-z0-9_.-]+) \(([^)\s]+)\)/); if (m) out.push(pk('RubyGems', m[1], m[2].replace(/-.*/, ''), file)); }
        } else if (base === 'go.mod') {
            for (const m of t.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]{2,}\/[^\s]+)\s+v([0-9][^\s]*)/gm)) out.push(pk('Go', m[1], m[2], file));
        }
    } catch { /* unreadable lockfile: skipped */ }
    return out;
}
const LOCKS = ['package-lock.json', 'yarn.lock', /^requirements.*\.txt$/, 'Pipfile.lock', 'poetry.lock', 'uv.lock', 'Cargo.lock', 'Gemfile.lock', 'go.mod'];
function inventory(root) {
    const files = findFiles(root, LOCKS); const seen = new Set(); const out = [];
    for (const file of files) for (const p of parseLock(file)) { const k = `${p.ecosystem}|${p.name}|${p.version}`; if (!seen.has(k)) { seen.add(k); out.push(p); } }
    return { files: files.map(x => path.relative(root, x)), packages: out.slice(0, 5000) };
}
// PlatOpypus: what is really installed (node_modules), not only what the lockfile says.
function installedNodeModules(dir) {
    const out = []; const seen = new Set();
    const visit = (nm, n, top = null) => { let es = []; try { es = fs.readdirSync(nm, { withFileTypes: true }); } catch { return; } for (const e of es) { if (!e.isDirectory() || e.name.startsWith('.')) continue; if (e.name.startsWith('@')) { visit(path.join(nm, e.name), n, top); continue; } const pd = path.join(nm, e.name); const j = readJ(path.join(pd, 'package.json'), null); if (j?.name && j.version) { const k = `${j.name}@${j.version}@${top || ''}`; if (!seen.has(k)) { seen.add(k); out.push({ ...pk('npm', j.name, j.version, path.join(dir, 'package-lock.json')), top: top || null }); } } if (n < 6) visit(path.join(pd, 'node_modules'), n + 1, top || j?.name || null); } };
    visit(path.join(dir, 'node_modules'), 0); return out;
}

// ---------- OSV ----------
const cache = () => readJ(f('osv-cache.json'), { vulns: {} });
async function osvBatch(pkgs) {
    const res = []; for (let i = 0; i < pkgs.length; i += 900) {
        const chunk = pkgs.slice(i, i + 900);
        const r = await fetch('https://api.osv.dev/v1/querybatch', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'platopypus-selfcheck' }, body: JSON.stringify({ queries: chunk.map(p => ({ package: { name: p.name, ecosystem: p.ecosystem }, version: p.version })) }), signal: AbortSignal.timeout(60_000) });
        if (!r.ok) throw new Error(`OSV ${r.status}`);
        const j = await r.json(); (j.results || []).forEach((x, n) => res.push({ p: chunk[n], ids: (x.vulns || []).map(v => ({ id: v.id, modified: v.modified })) }));
    }
    return res;
}
async function osvDetails(list) {
    const c = cache(); const need = list.filter(v => !c.vulns[v.id] || c.vulns[v.id].modified !== v.modified).slice(0, 400);
    for (let i = 0; i < need.length; i += 10) await Promise.all(need.slice(i, i + 10).map(async v => { try { const r = await fetch(`https://api.osv.dev/v1/vulns/${encodeURIComponent(v.id)}`, { signal: AbortSignal.timeout(20_000) }); if (r.ok) { const d = await r.json(); c.vulns[v.id] = { modified: v.modified, summary: d.summary || (d.details || '').slice(0, 300), aliases: d.aliases || [], severity: osvSeverity(d), affected: (d.affected || []).map(a => ({ name: a.package?.name, ecosystem: a.package?.ecosystem, fixed: (a.ranges || []).flatMap(r2 => (r2.events || []).filter(e => e.fixed).map(e => e.fixed)) })), refs: (d.references || []).slice(0, 4).map(x => x.url) }; } } catch { /* left out of this scan */ } }));
    const keys = Object.keys(c.vulns); if (keys.length > 6000) for (const k of keys.slice(0, keys.length - 6000)) delete c.vulns[k];
    writeJ(f('osv-cache.json'), c); return c.vulns;
}
function osvSeverity(d) {
    if (/^MAL-/.test(d.id)) return 'critical';
    const ds = String(d.database_specific?.severity || '').toLowerCase(); if (ds) return ds === 'moderate' || ds === 'medium' ? 'moderate' : SEV.includes(ds) ? ds : 'moderate';
    for (const s of d.severity || []) { if (s.type === 'Ubuntu') { const u = String(s.score).toLowerCase(); return u === 'negligible' ? 'low' : u === 'medium' ? 'moderate' : SEV.includes(u) ? u : 'moderate'; } }
    for (const a of d.affected || []) { const u = String(a.ecosystem_specific?.severity || a.database_specific?.severity || '').toLowerCase(); if (u) return u === 'medium' ? 'moderate' : SEV.includes(u) ? u : 'moderate'; }
    return 'moderate';
}
// Findings for a package list: one per package, its advisories, and the smallest fixed version above what is installed.
async function packageFindings(target, pkgs) {
    if (!pkgs.length) return [];
    const hits = (await osvBatch(pkgs)).filter(h => h.ids.length);
    const details = await osvDetails(hits.flatMap(h => h.ids));
    return hits.map(h => {
        const adv = h.ids.map(v => ({ id: v.id, ...(details[v.id] || { summary: '', aliases: [], severity: 'moderate', affected: [] }) }));
        // Per advisory, the smallest fixed version above what is installed (advisories list a fix per release line);
        // the version that fixes them all is the highest of those.
        const fixes = adv.map(a => (a.affected || []).filter(x => (!x.name || x.name === h.p.name) && (!x.ecosystem || x.ecosystem === h.p.ecosystem)).flatMap(x => x.fixed).filter(v => cmpVer(v, h.p.version) > 0).sort(cmpVer)[0]).filter(Boolean).sort(cmpVer);
        const kevHit = adv.some(isKev);
        const sev = kevHit ? 'critical' : adv.reduce((m, a) => (sevN(a.severity) > sevN(m) ? a.severity : m), 'info');
        const malicious = adv.some(a => /^MAL-/.test(a.id));
        return finding(target, { area: 'package', ecosystem: h.p.ecosystem, name: h.p.name, version: h.p.version, fixed: fixes.length ? fixes[fixes.length - 1] : null, severity: h.p.dev && !malicious && sev !== 'critical' ? SEV[Math.max(1, sevN(sev) - 1)] : sev, dev: h.p.dev, malicious, file: h.p.file, kev: kevHit, advisories: adv.map(a => ({ id: a.id, aliases: (a.aliases || []).filter(x => /^CVE-/.test(x)).slice(0, 3), summary: String(a.summary || '').slice(0, 240), severity: a.severity, kev: isKev(a) })).sort((x, y) => (y.kev - x.kev) || sevN(y.severity) - sevN(x.severity)), note: malicious ? 'Known malicious package: remove it and check what it may have done.' : kevHit ? 'Actively exploited (CISA KEV).' : null });
    });
}
function finding(target, o) { const id = crypto.createHash('sha1').update(`${target}|${o.area}|${o.ecosystem || ''}|${o.name}|${o.version || ''}`).digest('hex').slice(0, 12); return { id, target, ...o }; }

// Direct dependencies with newer releases: within the same major version it is a routine update (low); a new major
// version is information only (it is a change of code, not a fix).
async function outdatedDirect(target, dir, installed) {
    const pj = readJ(path.join(dir, 'package.json'), {}); const out = [];
    for (const name of Object.keys(pj.dependencies || {})) {
        const have = installed.find(p => p.name === name && fs.existsSync(path.join(dir, 'node_modules', name, 'package.json')) && readJ(path.join(dir, 'node_modules', name, 'package.json'), {}).version === p.version)?.version; if (!have) continue;
        let meta = null; try { const r = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}`, { headers: { Accept: 'application/vnd.npm.install-v1+json' }, signal: AbortSignal.timeout(15_000) }); if (r.ok) meta = await r.json(); } catch { continue; }
        const vs = Object.keys(meta?.versions || {}).filter(v => /^\d+\.\d+\.\d+$/.test(v)); const latest = meta?.['dist-tags']?.latest;
        const sameMajor = vs.filter(v => major(v) === major(have) && cmpVer(v, have) > 0).sort(cmpVer).pop();
        if (sameMajor) out.push(finding(target, { area: 'package', ecosystem: 'npm', name, version: have, latest: sameMajor, fixed: sameMajor, severity: 'low', note: `Update available within ${major(have)}.x (${sameMajor}).`, outdated: true }));
        else if (latest && major(latest) !== major(have) && cmpVer(latest, have) > 0) out.push(finding(target, { area: 'package', ecosystem: 'npm', name, version: have, latest, severity: 'info', note: `${latest} is a new major version: for a release, not a local fix.`, outdated: true }));
    }
    return out;
}

// ---------- the box's tooling ----------
const firstVer = s => { const t = String(s); return (t.match(/(?:^|[\s(v/])(\d+\.\d+\.\d+)(?![.\d])/) || t.match(/(?:^|[\s(v/])(\d+\.\d+)(?![.\d])/) || [])[1] || null; };
// The part of a version that signals breaking changes: the major, or for 0.x the minor too (semver).
const major = v => { const p = String(v || '').replace(/^v/, '').split('.'); return p[0] === '0' ? `0.${p[1]}` : p[0]; };
async function latestNpm(name) { try { const r = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}/latest`, { signal: AbortSignal.timeout(15_000) }); return r.ok ? (await r.json()).version : null; } catch { return null; } }
async function latestGithub(repo) { try { const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { 'User-Agent': 'platopypus-selfcheck', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15_000) }); return r.ok ? String((await r.json()).tag_name || '').replace(/^v/, '') : null; } catch { return null; } }
const TOOLS = [
    { name: 'nginx', cmd: ['nginx', ['-v']], apt: 'nginx' },
    { name: 'certbot', cmd: ['certbot', ['--version']], apt: 'certbot' },
    { name: 'OpenSSL', cmd: ['openssl', ['version']], apt: 'openssl' },
    { name: 'OpenSSH server', cmd: ['dpkg-query', ['-W', '-f=${Version}', 'openssh-server']], apt: 'openssh-server' },
    { name: 'sudo', cmd: ['sudo', ['-V']], apt: 'sudo' },
    { name: 'git', cmd: ['git', ['--version']], apt: 'git' },
    { name: 'tmux', cmd: ['tmux', ['-V']], apt: 'tmux' },
    { name: 'Python', cmd: ['python3', ['--version']], apt: 'python3' },
    { name: 'Docker', cmd: ['docker', ['version', '--format', '{{.Server.Version}}']], apt: 'docker-ce' },
    { name: 'runc', cmd: ['runc', ['--version']], apt: 'runc' },
    { name: 'Node.js', cmd: ['node', ['-v']], node: true },
    { name: 'npm', cmd: ['npm', ['-v']], npm: 'npm', osv: true },
    { name: 'cloudflared', cmd: ['cloudflared', ['--version']], gh: 'cloudflare/cloudflared' },
    { name: 'Tailscale', cmd: ['tailscale', ['version']], apt: 'tailscale' },
    { name: 'code-server', cmd: ['code-server', ['--version']], gh: 'coder/code-server' },
    { name: 'Claude Code', cmd: ['claude', ['--version']], npm: '@anthropic-ai/claude-code', osv: true, agent: true },
    { name: 'Codex CLI', cmd: ['codex', ['--version']], npm: '@openai/codex', osv: true, agent: true },
    { name: 'Antigravity CLI', cmd: ['agy', ['--version']], agent: true },
];
// Agent CLIs are installed per user (root's and the agent user's native installs are separate copies), so each copy
// found is checked on its own and named "(root)", "(agent user)" or "(system)".
async function toolVariants() {
    const out = []; const a = agentUser.info();
    for (const t of TOOLS) {
        if (!t.agent) { out.push(t); continue; }
        const bin = t.cmd[0]; const cands = [];
        const w = await sh('which', [bin]); if (w.ok && w.out.trim()) cands.push(w.out.trim().split('\n')[0]);
        for (const d of [path.join(config.home, '.local', 'bin'), '/usr/local/bin', '/usr/bin', ...(a ? [path.join(a.home, '.local', 'bin'), path.join(a.home, '.npm-global', 'bin')] : [])]) cands.push(path.join(d, bin));
        const seen = new Set(); const found = [];
        for (const c of cands) { let real; try { real = fs.realpathSync(c); if (!fs.statSync(real).isFile()) continue; } catch { continue; } if (seen.has(real)) continue; seen.add(real); found.push(c); }
        const label = c => (a && c.startsWith(a.home + path.sep) ? 'agent user' : c.startsWith(config.home + path.sep) ? 'root' : 'system');
        for (const c of found) out.push({ ...t, name: found.length > 1 ? `${t.name} (${label(c)})` : t.name, cmd: [c, t.cmd[1]], where: c });
        if (!found.length) out.push(t);
    }
    return out;
}
async function aptState() {
    const st = readJ(f('apt.json'), {});
    if (!st.updatedAt || Date.now() - st.updatedAt > 12 * 3600_000) { const r = await sh('apt-get', ['update', '-qq'], { timeout: 180_000 }); st.updatedAt = Date.now(); st.updateOk = r.ok; writeJ(f('apt.json'), st); }
    const up = await sh('apt', ['list', '--upgradable'], { timeout: 60_000, env: { ...process.env, LANG: 'C' } });
    const list = []; for (const line of up.out.split('\n')) { const m = line.match(/^([^/\s]+)\/(\S+)\s+(\S+)\s+\S+\s+\[upgradable from: ([^\]]+)\]/); if (m) list.push({ pkg: m[1], pocket: m[2], to: m[3], from: m[4], security: /-security/.test(m[2]) }); }
    const src = await sh('dpkg-query', ['-W', '-f=${binary:Package} ${source:Package} ${Version}\n'], { timeout: 30_000 });
    const map = new Map(); for (const l of src.out.split('\n')) { const [b, s, v] = l.split(' '); if (b) map.set(b.replace(/:.*/, ''), { source: s || b, version: v }); }
    return { list, map, reboot: fs.existsSync('/var/run/reboot-required'), updateOk: st.updateOk !== false };
}
async function boxFindings() {
    const out = []; const T = 'box'; const tools = [];
    const apt = await aptState().catch(() => ({ list: [], map: new Map(), reboot: false, updateOk: false }));
    let nodeIndex = null;
    for (const t of await toolVariants()) {
        const r = await sh(t.cmd[0], t.cmd[1], { timeout: 10_000 }); if (!r.ok && !r.out) continue;
        const version = t.cmd[0] === 'dpkg-query' ? r.out.trim() : firstVer(r.out); if (!version) continue;
        const row = { name: t.name, version, latest: null, agent: !!t.agent }; tools.push(row);
        if (t.apt) { const u = apt.list.find(x => x.pkg === t.apt); if (u) { row.latest = u.to; out.push(finding(T, { area: 'tool', name: t.name, version: u.from, latest: u.to, fixed: u.to, apt: t.apt, severity: u.security ? 'high' : 'low', note: u.security ? `Ubuntu security update (${u.pocket}).` : 'A newer package is available.' })); } else row.latest = version; }
        if (t.node) {
            try { nodeIndex ||= await (await fetch('https://nodejs.org/dist/index.json', { signal: AbortSignal.timeout(15_000) })).json(); } catch { nodeIndex = []; }
            const major = version.split('.')[0]; const line = nodeIndex.filter(x => x.version.slice(1).split('.')[0] === major); const newest = line[0]?.version.slice(1);
            const sec = line.filter(x => x.security && cmpVer(x.version, version) > 0);
            row.latest = newest || null; const eol = line.length && !line[0].lts && Number(major) % 2 === 1;
            if (sec.length) out.push(finding(T, { area: 'tool', name: 'Node.js', version, latest: newest, fixed: newest, severity: 'high', note: `${sec.length} security release${sec.length === 1 ? '' : 's'} in Node.js ${major} since this one (latest ${newest}).` }));
            else if (newest && cmpVer(newest, version) > 0) out.push(finding(T, { area: 'tool', name: 'Node.js', version, latest: newest, fixed: newest, severity: 'low', note: `Node.js ${newest} is out.` }));
            if (eol) out.push(finding(T, { area: 'tool', name: 'Node.js', version: `${major}.x`, severity: 'moderate', note: 'An odd-numbered (non-LTS) Node.js line: it gets no long-term security fixes.' }));
        }
        if (t.npm || t.gh) {
            const latest = t.npm ? await latestNpm(t.npm) : await latestGithub(t.gh); row.latest = latest;
            if (latest && cmpVer(latest, version) > 0) { const jump = major(latest) !== major(version) && !t.agent; out.push(finding(T, { area: t.agent ? 'agent' : 'tool', name: t.name, version, latest, fixed: jump ? null : latest, npm: t.npm || null, severity: t.agent ? 'moderate' : jump ? 'info' : 'low', note: t.agent ? 'AI agent CLIs fix prompt-injection and sandbox escapes often: keep them current.' : jump ? `${latest} is a new major version: upgrade it deliberately, not as a fix.` : `${latest} is out.` })); }
        }
        if (t.osv && t.npm) out.push(...(await packageFindings(T, [pk('npm', t.npm, version, t.name)]).catch(() => [])).map(x => ({ ...x, area: t.agent ? 'agent' : 'tool' })));
    }
    // Everything running on the box, and the base PlatOpypus runs on: the installed version of each one's Ubuntu
    // package against OSV, whether or not a fixed package exists yet (a fresh disclosure has none for days).
    const live = await liveSystem(apt).catch(e => { log('selfcheck', `live services: ${e.message}`); return { packages: [], services: [] }; });
    const covered = new Set();
    if (live.packages.length) {
        let osv = []; try { osv = await packageFindings(T, live.packages.map(p => pk('Ubuntu:24.04:LTS', p.source, p.version, 'dpkg'))); } catch (e) { log('selfcheck', `OSV (Ubuntu): ${e.message}`); }
        const http2 = await nginxHttp2();
        for (const o of osv) {
            const p = live.packages.find(x => x.source === o.name); if (!p) continue;
            const kevHit = (o.advisories || []).some(a => a.kev);
            const worst = o.severity; const fixable = !!o.fixed;
            // Unfixed low/negligible CVEs are background noise on any distro: kept only when they matter.
            if (!kevHit && !fixable && sevN(worst) < sevN('high')) continue;
            if (!kevHit && fixable && sevN(worst) < sevN('moderate') && !p.core) continue;
            covered.add(p.source);
            const up = apt.list.find(u => apt.map.get(u.pkg)?.source === p.source && u.security);
            const why = [p.core ? 'PlatOpypus runs on it' : null, p.listening?.length ? `listening on ${p.listening.slice(0, 3).join(', ')}` : null, p.units?.length ? `used by ${p.units.slice(0, 3).join(', ')}` : null].filter(Boolean).join('; ');
            const h2 = p.source === 'nginx' && http2.length && (o.advisories || []).some(a => /HTTP\/?2/i.test(a.summary)) ? ` HTTP/2 is on in ${http2.slice(0, 3).join(', ')}.` : '';
            out.push({ ...finding(T, { area: 'service', ecosystem: 'Ubuntu', name: p.label || p.source, version: p.version, fixed: o.fixed, apt: p.binaries.join(' '), severity: kevHit ? 'critical' : worst, kev: kevHit, core: !!p.core, advisories: o.advisories,
                note: `${kevHit ? 'Actively exploited (CISA KEV). ' : ''}${fixable ? (up ? 'Ubuntu has a fixed package.' : 'Ubuntu has a fixed package (refresh apt to see it).') : 'No Ubuntu fix yet: apply the advisory\'s workaround until there is one.'}${h2}${why ? ` (${why}.)` : ''}` }) });
        }
    }
    for (let i = out.length - 1; i >= 0; i--) { const x = out[i]; if (x.area === 'tool' && x.apt && covered.has(apt.map.get(x.apt)?.source || x.apt)) out.splice(i, 1); }
    const patched = await recentlyPatched(live.packages.filter(p => p.core)).catch(() => []);
    // Ubuntu security updates for anything else installed, with their CVEs from OSV by source package.
    const secUp = apt.list.filter(u => u.security && !TOOLS.some(t => t.apt === u.pkg) && !covered.has(apt.map.get(u.pkg)?.source || u.pkg));
    if (secUp.length) {
        const bySrc = new Map(); for (const u of secUp) { const s = apt.map.get(u.pkg)?.source || u.pkg; if (!bySrc.has(s)) bySrc.set(s, { source: s, pkgs: [], from: apt.map.get(u.pkg)?.version || u.from, to: u.to }); bySrc.get(s).pkgs.push(u.pkg); }
        let osv = []; try { osv = await packageFindings(T, [...bySrc.values()].map(b => pk('Ubuntu:24.04:LTS', b.source, b.from, 'apt'))); } catch { /* severity unknown */ }
        for (const b of bySrc.values()) { const o = osv.find(x => x.name === b.source); out.push(finding(T, { area: 'os', ecosystem: 'Ubuntu', name: b.source, version: b.from, fixed: b.to, apt: b.pkgs.join(' '), severity: o?.severity && o.severity !== 'info' ? o.severity : 'moderate', advisories: o?.advisories || [], note: `Ubuntu security update for ${b.pkgs.slice(0, 6).join(', ')}${b.pkgs.length > 6 ? '…' : ''}.` })); }
    }
    if (!apt.updateOk) out.push(finding(T, { area: 'os', name: 'apt', severity: 'low', note: 'Could not refresh the package lists (apt-get update failed), so Ubuntu updates may be missing here.' }));
    // Processes still running code an upgrade replaced (their executable or a library is "(deleted)" on disk): the fix
    // is installed but not in use until they restart. PlatOpypus and Docker are left to the user (restarting them
    // interrupts PlatOpypus and its containers).
    const stale = staleProcesses(live.services);
    if (stale.length) out.push(finding(T, { area: 'os', name: 'restart needed', version: stale.map(x => x.name).join(', ').slice(0, 120), severity: stale.some(x => x.core) ? 'moderate' : 'low', services: stale, note: `Running the code from before an upgrade (installed fixes are not in use yet): ${stale.map(x => `${x.name}${x.core ? ' (restart from the phone when it suits you)' : ''}`).join(', ')}. A reboot also does it.` }));
    if (apt.reboot) out.push(finding(T, { area: 'os', name: 'reboot', severity: 'moderate', note: 'A reboot is needed to finish installed updates (kernel or core libraries). Not done automatically: reboot from the AWS console or `sudo reboot` when it suits you.' }));
    // Let's Encrypt certificates and their renewal timer.
    let certs = []; try { certs = fs.readdirSync('/etc/letsencrypt/live').filter(d => !d.startsWith('README')); } catch { /* none */ }
    for (const d of certs) { const r = await sh('openssl', ['x509', '-enddate', '-noout', '-in', `/etc/letsencrypt/live/${d}/cert.pem`]); const m = r.out.match(/notAfter=(.+)/); if (!m) continue; const days = Math.floor((new Date(m[1]).getTime() - Date.now()) / 86400_000); tools.push({ name: `Certificate ${d}`, version: `${days} days left`, latest: null }); if (days < 21) out.push(finding(T, { area: 'cert', name: d, version: `${days} days left`, severity: days < 7 ? 'critical' : 'high', note: 'Certificate expires soon; certbot renew has not renewed it.' })); }
    if (certs.length) { const t1 = await sh('systemctl', ['is-active', 'certbot.timer']); const t2 = await sh('systemctl', ['is-active', 'snap.certbot.renew.timer']); if (!/^active/.test(t1.out) && !/^active/.test(t2.out)) out.push(finding(T, { area: 'cert', name: 'certbot timer', severity: 'moderate', note: 'No certbot renewal timer is active, so certificates will not renew on their own.' })); }
    if (tools.some(t => t.name === 'nginx')) { const r = await sh('nginx', ['-t']); if (!r.ok) out.push(finding(T, { area: 'tool', name: 'nginx config', severity: 'high', note: `nginx -t fails: ${r.out.trim().split('\n').slice(-1)[0]}` })); }
    // Everything installed outside apt: global npm, pip/pipx, gems, cargo, Go binaries, Java jars, standalone binaries.
    const other = await installedElsewhere().catch(e => { log('selfcheck', `installed software: ${e.message}`); return { packages: [], bins: [], jars: 0 }; });
    if (other.packages.length) {
        let f2 = []; try { f2 = await packageFindings(T, other.packages); } catch (e) { log('selfcheck', `OSV (installed): ${e.message}`); }
        for (const x of f2) { const origins = other.packages.filter(y => y.ecosystem === x.ecosystem && y.name === x.name && y.version === x.version).map(y => y.origin); out.push({ ...x, area: 'installed', origin: origins[0] || null, note: [x.note, origins.length ? `Installed by ${origins.slice(0, 2).join('; ')}${origins.length > 2 ? '…' : ''}` : null].filter(Boolean).join(' ') }); }
    }
    const bf = await binaryFindings(other.bins).catch(() => ({ findings: [], rows: [] })); out.push(...bf.findings);
    const byKind = {}; for (const p2 of other.packages) { const k = p2.origin.split(' ')[0] === 'npm' ? 'npm global' : p2.origin.startsWith('pip') ? 'pip' : p2.origin.startsWith('jar') ? 'Java (jars)' : p2.origin.startsWith('Go') ? 'Go modules in binaries' : p2.origin; byKind[k] = (byKind[k] || 0) + 1; }
    out.push(...await mcpFindings());
    return { findings: out, tools, services: live.services, patched, installed: { counts: { 'Ubuntu packages': apt.map.size, ...byKind }, binaries: bf.rows, jars: other.jars } };
}
// The base PlatOpypus runs on (Ubuntu source packages). Always checked, running or not.
const CORE = { nginx: 'nginx', openssl: 'OpenSSL', openssh: 'OpenSSH', sudo: 'sudo', systemd: 'systemd', glibc: 'glibc', nodejs: 'Node.js', 'docker.io': 'Docker', containerd: 'containerd', runc: 'runc', tmux: 'tmux', git: 'git', iptables: 'iptables', 'python-certbot': 'certbot', certbot: 'certbot', curl: 'curl', zlib: 'zlib', 'ca-certificates': 'CA certificates', 'unattended-upgrades': 'unattended-upgrades', polkit: 'polkit', 'dbus': 'D-Bus', 'util-linux': 'util-linux', bash: 'bash', libxml2: 'libxml2', expat: 'expat', 'python3.12': 'Python 3.12' };
// What is live: every running systemd service and every process listening on a port, traced to its executable and
// from there to the Ubuntu package it came from. Plus the core above and the running kernel.
async function liveSystem(apt) {
    const srcOf = new Map(); for (const [bin, v] of apt.map) { const s = v.source; if (!srcOf.has(s)) srcOf.set(s, { source: s, version: v.version, binaries: [] }); srcOf.get(s).binaries.push(bin); }
    const procs = new Map();   // pid -> { exe, units: Set, listening: Set, names: Set }
    const add = (pid, k, v) => { if (!procs.has(pid)) { let exe; try { exe = fs.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, ''); } catch { return; } procs.set(pid, { exe, units: new Set(), listening: new Set(), names: new Set() }); } procs.get(pid)[k].add(v); };
    const units = (await sh('systemctl', ['list-units', '--type=service', '--state=running', '--no-legend', '--plain'])).out.split('\n').map(l => l.split(/\s+/)[0]).filter(u => u.endsWith('.service'));
    // systemctl show prints one block per unit (blank line between) with its properties in its own order.
    if (units.length) { const sp = await sh('systemctl', ['show', '-p', 'Id', '-p', 'MainPID', ...units], { timeout: 30_000 }); for (const blk of sp.out.split(/\n\s*\n/)) { const id = blk.match(/^Id=(.+)$/m)?.[1]; const pid = Number(blk.match(/^MainPID=(\d+)$/m)?.[1] || 0); if (id && pid > 0) add(String(pid), 'units', id.replace(/\.service$/, '')); } }
    const ssr = await sh('ss', ['-tulnpH'], { timeout: 15_000 });
    for (const l of ssr.out.split('\n')) { const cols = l.trim().split(/\s+/); if (cols.length < 5) continue; const addr = cols[4]; for (const m of l.matchAll(/\("([^"]+)",pid=(\d+)/g)) { add(m[2], 'listening', `${cols[0]} ${addr}`); add(m[2], 'names', m[1]); } }
    const paths = [...new Set([...procs.values()].map(x => x.exe))]; const owner = new Map();
    if (paths.length) { const d = await sh('dpkg', ['-S', ...paths], { timeout: 30_000 }); for (const l of d.out.split('\n')) { const m = l.match(/^([^:\s,]+)(?::[a-z0-9]+)?(?:, [^:]+)*: (\/.+)$/); if (m) owner.set(m[2], m[1]); } }
    const pkgs = new Map(); const services = [];
    const want = (src, extra = {}) => { const s = srcOf.get(src); if (!s) return null; if (!pkgs.has(src)) pkgs.set(src, { ...s, label: CORE[src] || null, core: !!CORE[src], units: [], listening: [] }); const p = pkgs.get(src); for (const k of ['units', 'listening']) for (const v of extra[k] || []) if (!p[k].includes(v)) p[k].push(v); if (extra.label && !p.label) p.label = extra.label; return p; };
    for (const src of Object.keys(CORE)) want(src);
    const kr = (await sh('uname', ['-r'])).out.trim(); const kbin = [...apt.map.keys()].find(b => b === `linux-image-${kr}` || b === `linux-image-unsigned-${kr}`);
    if (kbin) { const p = want(apt.map.get(kbin).source, { label: `Linux kernel ${kr}` }); if (p) { p.core = true; p.version = apt.map.get(kbin).version; } }
    for (const [pid, v] of procs) {
        const exe = v.exe; const bin = owner.get(exe) || owner.get(exe.replace(/^\/usr/, '')); const src = bin ? apt.map.get(bin.replace(/:.*/, ''))?.source : null;
        const row = { pid: Number(pid), exe, name: [...v.names][0] || path.basename(exe), units: [...v.units], listening: [...v.listening], package: bin || null, source: src || null, version: src ? srcOf.get(src)?.version : null };
        services.push(row); if (src) want(src, { units: row.units, listening: row.listening });
    }
    services.sort((a, b) => b.listening.length - a.listening.length || a.name.localeCompare(b.name));
    return { packages: [...pkgs.values()], services: services.slice(0, 80) };
}
// ---------- everything else installed outside apt ----------
// Global npm, pip/pipx, gems, Go binaries, cargo installs and Java jars (the box and the agent user's home), as
// packages for OSV; and standalone binaries, with their versions and latest releases where the tool is known.
function homes() { const h = [config.home]; const a = agentUser.info(); if (a && a.home !== config.home) h.push(a.home); return h; }
function globDirs(base, rel) { try { return fs.readdirSync(base).filter(d => !rel || new RegExp(rel).test(d)).map(d => path.join(base, d)).filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } }); } catch { return []; } }
function sitePackages() {
    const out = [];
    for (const b of ['/usr/local/lib', ...homes().map(h => path.join(h, '.local', 'lib'))]) for (const py of globDirs(b, '^python3')) for (const sp of ['dist-packages', 'site-packages']) if (fs.existsSync(path.join(py, sp))) out.push(path.join(py, sp));
    for (const h of homes()) for (const v of globDirs(path.join(h, '.local', 'share', 'pipx', 'venvs'))) for (const py of globDirs(path.join(v, 'lib'), '^python3')) out.push(path.join(py, 'site-packages'));
    return out;
}
function pyDistInfo(dir, label) { const out = []; let es = []; try { es = fs.readdirSync(dir); } catch { return out; } for (const e of es) { const m = e.match(/^(.+?)-(\d[^-]*)\.(dist|egg)-info$/); if (m) out.push({ ...pk('PyPI', m[1].replace(/_/g, '-'), m[2], label), origin: label }); } return out; }
const SAFE_BIN = /^[\w./+-]+$/;
async function installedElsewhere() {
    const pkgs = []; const addAll = (list, origin) => { for (const p of list) pkgs.push({ ...p, origin }); };
    // npm global (system and per-user prefixes)
    const npmDirs = ['/usr/lib/node_modules', '/usr/local/lib/node_modules', ...homes().flatMap(h => [path.join(h, '.npm-global', 'lib', 'node_modules'), path.join(h, '.local', 'lib', 'node_modules')])];
    for (const d of npmDirs.filter(x => fs.existsSync(x))) for (const p of installedNodeModules(path.dirname(d))) pkgs.push({ ...p, file: d, origin: p.top && p.top !== p.name ? `npm global ${p.top} (bundled; update ${p.top})` : `npm global ${p.name}` });
    // Python outside apt
    for (const sp of sitePackages()) addAll(pyDistInfo(sp, sp), `pip (${sp})`);
    // Ruby gems
    const gem = await sh('gem', ['list', '--local', '--no-details'], { timeout: 30_000 });
    if (gem.ok) for (const l of gem.out.split('\n')) { const m = l.match(/^([A-Za-z0-9_.-]+) \(([^)]+)\)/); if (m) for (const v of m[2].replace(/default: /g, '').split(/,\s*/)) if (/^\d/.test(v)) pkgs.push({ ...pk('RubyGems', m[1], v, 'gem'), origin: 'gem' }); }
    // cargo install
    for (const h of homes()) { try { const t = fs.readFileSync(path.join(h, '.cargo', '.crates.toml'), 'utf8'); for (const m of t.matchAll(/^"([A-Za-z0-9_-]+) ([0-9][^ ]*) /gm)) pkgs.push({ ...pk('crates.io', m[1], m[2], path.join(h, '.cargo')), origin: 'cargo install' }); } catch { /* none */ } }
    // Java: Maven coordinates inside jars (pom.properties), in the usual places
    const jars = []; const walkJ = (d, n) => { if (jars.length >= 400) return; let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory() && n < 6 && !SKIP.has(e.name) && !e.name.startsWith('.')) walkJ(p, n + 1); else if (e.isFile() && e.name.endsWith('.jar')) jars.push(p); } };
    for (const d of ['/opt', '/usr/local', '/usr/share/java', '/srv', ...homes()]) walkJ(d, 0);
    if (jars.length && (await sh('unzip', ['-v'])).ok) for (const j of jars) { const r = await sh('unzip', ['-p', j, 'META-INF/maven/*/*/pom.properties'], { timeout: 10_000 }); const blocks = r.out.split(/(?=#Generated|#Created)/); for (const b of blocks.length ? blocks : [r.out]) { const g = b.match(/^groupId=(.+)$/m), a = b.match(/^artifactId=(.+)$/m), v = b.match(/^version=(.+)$/m); if (g && a && v) pkgs.push({ ...pk('Maven', `${g[1].trim()}:${a[1].trim()}`, v[1].trim(), j), origin: `jar ${j}` }); } }
    // Go binaries: their module list (go version -m), when Go is on the box
    const bins = standaloneBinaries();
    if ((await sh('go', ['version'])).ok) for (const b of bins) { const r = await sh('go', ['version', '-m', b.path], { timeout: 10_000 }); if (!r.ok) continue; b.go = true; for (const m of r.out.matchAll(/^\s+(?:dep|mod)\s+(\S+)\s+v(\S+)/gm)) pkgs.push({ ...pk('Go', m[1], m[2], b.path), origin: `Go binary ${b.path}` }); }
    const seen = new Set(); return { packages: pkgs.filter(p => { const k = `${p.ecosystem}|${p.name}|${p.version}|${p.origin}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 8000), bins, jars: jars.length };
}
// Executables not owned by a package: what someone downloaded or built and put on the PATH.
function standaloneBinaries() {
    const dirs = ['/usr/local/bin', '/usr/local/sbin', ...globDirs('/opt').map(d => path.join(d, 'bin')), ...homes().flatMap(h => [path.join(h, '.local', 'bin'), path.join(h, 'go', 'bin'), path.join(h, '.cargo', 'bin'), path.join(h, 'bin')])];
    const out = []; const seen = new Set();
    for (const d of dirs) { let es = []; try { es = fs.readdirSync(d); } catch { continue; } for (const e of es) { const p = path.join(d, e); let real; try { real = fs.realpathSync(p); const st = fs.statSync(real); if (!st.isFile() || !(st.mode & 0o111) || st.size < 200_000) continue; } catch { continue; } if (seen.has(real)) continue; seen.add(real); if (real.startsWith(APP)) continue; out.push({ name: e, path: p, real }); } }
    return out.slice(0, 200);
}
// Tools that commonly arrive as standalone binaries: how to read their version and where the latest comes from.
const KNOWN_BINS = {
    terraform: { args: ['version'], latest: async () => { try { const r = await fetch('https://checkpoint-api.hashicorp.com/v1/check/terraform', { signal: AbortSignal.timeout(15_000) }); return r.ok ? (await r.json()).current_version : null; } catch { return null; } } },
    tofu: { args: ['version'], gh: 'opentofu/opentofu' }, packer: { args: ['version'], hc: 'packer' }, vault: { args: ['version'], hc: 'vault' }, consul: { args: ['version'], hc: 'consul' }, nomad: { args: ['version'], hc: 'nomad' },
    kubectl: { args: ['version', '--client'], gh: 'kubernetes/kubernetes' }, helm: { args: ['version', '--short'], gh: 'helm/helm' }, k9s: { args: ['version', '--short'], gh: 'derailed/k9s' },
    aws: { args: ['--version'], gh: 'aws/aws-cli', tags: true }, gh: { args: ['--version'], gh: 'cli/cli' }, go: { args: ['version'], go: true }, java: { args: ['-version'] }, mvn: { args: ['-v'] }, gradle: { args: ['--version'] },
    'docker-compose': { args: ['version', '--short'], gh: 'docker/compose' }, trivy: { args: ['--version'], gh: 'aquasecurity/trivy' }, caddy: { args: ['version'], gh: 'caddyserver/caddy' }, deno: { args: ['--version'], gh: 'denoland/deno' }, bun: { args: ['--version'], gh: 'oven-sh/bun' },
    rclone: { args: ['version'], gh: 'rclone/rclone' }, restic: { args: ['version'], gh: 'restic/restic' }, ngrok: { args: ['version'] }, jq: { args: ['--version'], gh: 'jqlang/jq' }, yq: { args: ['--version'], gh: 'mikefarah/yq' }, uv: { args: ['--version'], gh: 'astral-sh/uv' }, ollama: { args: ['--version'], gh: 'ollama/ollama' },
};
async function latestHashicorp(p) { try { const r = await fetch(`https://checkpoint-api.hashicorp.com/v1/check/${p}`, { signal: AbortSignal.timeout(15_000) }); return r.ok ? (await r.json()).current_version : null; } catch { return null; } }
async function binaryFindings(bins) {
    const out = []; const rows = [];
    for (const b of bins) {
        const k = KNOWN_BINS[b.name] ? b.name : Object.keys(KNOWN_BINS).find(n => b.real.endsWith(`/${n}`));
        if (TOOLS.some(t => t.cmd[0] === b.name) || /\.old$|\.bak$|selfcheck-old$/.test(b.name)) continue;   // checked with the tools above, or a kept old copy
        if (!k) { rows.push({ name: b.name, version: b.go ? 'Go binary' : 'unrecognised', path: b.path, unknown: true }); continue; }
        if (TOOLS.some(t => t.cmd[0] === k)) continue;   // already checked above
        const def = KNOWN_BINS[k]; if (!SAFE_BIN.test(b.path)) continue;
        const r = await sh(b.path, def.args, { timeout: 10_000 }); const version = firstVer(r.out); if (!version) { rows.push({ name: k, version: '?', path: b.path }); continue; }
        let latest = null; try { latest = def.latest ? await def.latest() : def.hc ? await latestHashicorp(def.hc) : def.gh ? await latestGithub(def.gh) : null; } catch { /* unknown */ }
        latest = latest ? firstVer(latest) || latest : null; rows.push({ name: k, version, latest, path: b.path });
        if (latest && cmpVer(latest, version) > 0) { const jump = major(latest) !== major(version); out.push(finding('box', { area: 'binary', name: k, version, latest, fixed: jump ? null : latest, file: b.path, severity: jump ? 'info' : 'low', note: `${b.path}: ${latest} is out${jump ? ' (a new major version: upgrade deliberately)' : ''}. Not from apt, so nothing updates it unless someone does.` })); }
    }
    return { findings: out, rows };
}

// Serious advisories from the last 45 days for the base packages that the installed version already fixes: so a
// headline CVE (nginx, OpenSSL, OpenSSH, sudo, the kernel…) can be seen to have been checked, not just absent.
async function recentlyPatched(pkgs) {
    const out = []; const since = Date.now() - 45 * 86400_000;
    for (const p of pkgs.slice(0, 40)) {
        let vulns = []; try { const r = await fetch('https://api.osv.dev/v1/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ package: { name: p.source, ecosystem: 'Ubuntu:24.04:LTS' } }), signal: AbortSignal.timeout(30_000) }); if (r.ok) vulns = (await r.json()).vulns || []; } catch { continue; }
        for (const v of vulns) {
            if (new Date(v.published || v.modified).getTime() < since) continue;
            const sev = osvSeverity(v); if (sevN(sev) < sevN('high') && !isKev(v)) continue;
            const fixed = (v.affected || []).filter(a => a.package?.ecosystem === 'Ubuntu:24.04:LTS' && a.package?.name === p.source).flatMap(a => (a.ranges || []).flatMap(r => (r.events || []).filter(e => e.fixed).map(e => e.fixed)))[0];
            if (fixed && cmpVer(p.version, fixed) >= 0) out.push({ package: p.label || p.source, cve: String(v.id).replace(/^UBUNTU-/, ''), severity: isKev(v) ? 'critical' : sev, fixedIn: fixed, installed: p.version, summary: String(v.summary || v.details || '').slice(0, 160) });
        }
    }
    return out.sort((a, b) => sevN(b.severity) - sevN(a.severity)).slice(0, 40);
}

// Live processes whose executable or a mapped library was replaced on disk since they started.
const LEAVE_TO_USER = /^(platopypus|porthole|docker|containerd|ssh|sshd|amazon-ssm-agent|snap\.amazon-ssm-agent.*)$/;
function staleProcesses(services) {
    const out = []; const seen = new Set();
    for (const s of services) {
        if (!s.pid) continue; let maps = ''; try { maps = fs.readFileSync(`/proc/${s.pid}/maps`, 'utf8'); } catch { continue; }
        let exeGone = false; try { exeGone = / \(deleted\)$/.test(fs.readlinkSync(`/proc/${s.pid}/exe`)); } catch { /* gone */ }
        const libs = [...new Set(maps.split('\n').filter(l => / \(deleted\)$/.test(l) && /\/(usr|lib)/.test(l)).map(l => l.replace(/^.* (\/\S+) \(deleted\)$/, '$1')))];
        if (!exeGone && !libs.length) continue;
        const name = s.units[0] || s.name; if (seen.has(name)) continue; seen.add(name);
        out.push({ name, pid: s.pid, core: LEAVE_TO_USER.test(name), exe: exeGone ? s.exe : null, libs: libs.slice(0, 6) });
    }
    return out;
}

// Findings an agent marked as waiting on an upstream release: kept out of fixing until that package or tool has a
// newer version (npm is looked up; others are offered again after 30 days).
async function markWaiting(ts) {
    const w = readJ(f('upstream.json'), {}); const latest = new Map(); let changed = false;
    for (const [id, e] of Object.entries(w)) {
        let gone = Date.now() - e.at > (e.ecosystem === 'npm' ? 90 : 30) * 86400_000;
        if (!gone && e.ecosystem === 'npm') { if (!latest.has(e.on)) latest.set(e.on, await latestNpm(e.on)); const now = latest.get(e.on); if (now && cmpVer(now, e.version) > 0) gone = true; }
        if (gone) { delete w[id]; changed = true; }
    }
    if (changed) writeJ(f('upstream.json'), w);
    for (const t of ts) { for (const x of t.findings) if (w[x.id]) x.waiting = { on: w[x.id].on, version: w[x.id].version, why: w[x.id].why, since: w[x.id].at }; t.waiting = t.findings.filter(x => x.waiting).length; }
}
// Agent CLIs a project carries in its own dependencies (an SDK embeds its CLI): checked like the box's agent CLIs.
const AGENT_PKGS = { '@anthropic-ai/claude-code': 'Claude Code', '@anthropic-ai/claude-agent-sdk': 'Claude Agent SDK', '@openai/codex': 'Codex CLI', '@openai/codex-sdk': 'Codex SDK', '@google/gemini-cli': 'Gemini CLI' };
async function embeddedAgents(target, pkgs) {
    const out = []; const seen = new Set();
    for (const p of pkgs.filter(x => x.ecosystem === 'npm' && AGENT_PKGS[x.name])) {
        if (seen.has(p.name)) continue; seen.add(p.name);
        const latest = await latestNpm(p.name); if (!latest || cmpVer(latest, p.version) <= 0) continue;
        const jump = major(latest) !== major(p.version);
        out.push(finding(target, { area: 'agent', ecosystem: 'npm', name: p.name, version: p.version, latest, fixed: jump ? null : latest, file: p.file, severity: jump ? 'low' : 'moderate', note: `${AGENT_PKGS[p.name]} inside this project (its own copy of the agent, separate from the box's). AI agent releases often fix prompt-injection and sandbox escapes: update it here.` }));
    }
    return out;
}

// nginx server blocks that speak HTTP/2 (several nginx advisories only apply with it on).
async function nginxHttp2() {
    const files = []; const read = d => { let es = []; try { es = fs.readdirSync(d); } catch { return; } for (const e of es) { const p = path.join(d, e); try { const t = fs.readFileSync(p, 'utf8'); if (/^\s*listen\s[^;]*\bhttp2\b|^\s*http2\s+on\s*;/m.test(t)) files.push(p); } catch { /* unreadable */ } } };
    read('/etc/nginx/sites-enabled'); read('/etc/nginx/conf.d'); try { if (/^\s*http2\s+on\s*;/m.test(fs.readFileSync('/etc/nginx/nginx.conf', 'utf8'))) files.push('/etc/nginx/nginx.conf'); } catch { /* none */ }
    return files;
}
// CISA's Known Exploited Vulnerabilities: a CVE in it is being used in attacks now. Refreshed twice a day.
let kevSet = new Set();
async function loadKev() {
    const c = readJ(f('kev.json'), null); if (c && Date.now() - c.at < 12 * 3600_000) { kevSet = new Set(c.ids); return; }
    try { const r = await fetch('https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json', { headers: { 'User-Agent': 'platopypus-selfcheck' }, signal: AbortSignal.timeout(30_000) }); if (r.ok) { const ids = ((await r.json()).vulnerabilities || []).map(v => v.cveID); writeJ(f('kev.json'), { at: Date.now(), ids }); kevSet = new Set(ids); return; } } catch { /* keep the last copy */ }
    kevSet = new Set(c?.ids || []);
}
const isKev = a => kevSet.has(String(a.id).replace(/^UBUNTU-/, '')) || (a.aliases || []).some(x => kevSet.has(x));

// MCP servers agents start: an unpinned `npx pkg` runs whatever was published last (the supply-chain route new AI
// attacks use); pinned ones are checked against OSV like any package. PlatOpypus's own servers are left out.
async function mcpFindings() {
    const homes = [config.home]; const a = agentUser.info(); if (a) homes.push(a.home);
    const files = homes.flatMap(h => [path.join(h, '.claude.json'), path.join(h, '.gemini', 'config', 'mcp_config.json'), path.join(h, '.cursor', 'mcp.json')]);
    for (const p of live.projects()) files.push(path.join(p.root, '.mcp.json'));
    const servers = []; const own = /^(plato-mcp|sleuth-mcp|research-mcp|lab-mcp|porthole-mcp)$/;
    for (const file of files) {
        const j = readJ(file, null); if (!j) continue;
        const blocks = [j.mcpServers, ...Object.values(j.projects || {}).map(p => p?.mcpServers)].filter(Boolean);
        for (const b of blocks) for (const [name, s] of Object.entries(b)) if (s?.command && !own.test(path.basename(String(s.command)))) servers.push({ name, file, command: String(s.command), args: (s.args || []).map(String) });
    }
    const out = []; const pinned = [];
    for (const s of servers) {
        if (!/^(npx|bunx|pnpm|uvx|pipx)$/.test(path.basename(s.command))) continue;
        const pkgArg = s.args.find(x => !x.startsWith('-') && x !== 'dlx' && x !== 'run'); if (!pkgArg) continue;
        const m = pkgArg.match(/^(@?[^@]+)(?:@(.+))?$/); if (!m) continue;
        const eco = /uvx|pipx/.test(s.command) ? 'PyPI' : 'npm';
        if (!m[2] || m[2] === 'latest') out.push(finding('box', { area: 'agent', ecosystem: eco, name: `MCP server ${s.name} (${m[1]})`, severity: 'moderate', file: s.file, note: `Runs ${m[1]} unpinned: every start fetches whatever was published last. Pin a version you have checked (${m[1]}@<version>).` }));
        else pinned.push(pk(eco, m[1], m[2], s.file));
    }
    if (pinned.length) out.push(...(await packageFindings('box', pinned).catch(() => [])).map(x => ({ ...x, area: 'agent', note: x.note || 'An MCP server agents start.' })));
    return out;
}
// Containers: how old each running image is (nothing on the box scans images, so age is the signal).
async function containerAges() {
    const r = await sh('docker', ['ps', '--format', '{{.Names}}|{{.Image}}']); if (!r.ok) return [];
    const out = []; for (const line of r.out.trim().split('\n').filter(Boolean)) { const [name, image] = line.split('|'); const c = await sh('docker', ['image', 'inspect', '--format', '{{.Created}}', image]); const days = c.ok ? Math.floor((Date.now() - new Date(c.out.trim()).getTime()) / 86400_000) : null; out.push({ name, image, days }); }
    return out;
}

// ---------- targets ----------
async function targets() {
    const out = [{ id: 'plato', kind: 'plato', name: 'PlatOpypus itself', path: APP, running: [{ slug: 'platopypus', title: 'PlatOpypus', running: true }] }, { id: 'box', kind: 'box', name: 'The box: tooling and system packages', path: '/', running: [] }];
    let lv = []; try { lv = await live.list(); } catch { /* none */ }
    for (const p of lv) out.push({ id: `p:${p.project}`, kind: 'project', name: p.name || p.project, project: p.project, path: p.root, running: p.services.map(s => ({ slug: s.slug, key: s.key, title: s.title, running: s.running, image: s.image })) });
    let regs = []; try { regs = await servicesMgr.list(); } catch { /* none */ }
    for (const r of regs) {
        if (!r.cwd || r.live || out.some(t => t.path && (r.cwd === t.path || r.cwd.startsWith(t.path + path.sep)) && t.kind === 'project')) continue;
        const root = gitRoot(r.cwd) || r.cwd; const id = `p:${path.basename(root)}`;
        const t = out.find(x => x.id === id); const svc = { slug: r.slug, title: r.name || r.slug, running: !!r.alive, registered: true };
        if (t) t.running.push(svc); else out.push({ id, kind: 'project', name: path.basename(root), path: root, running: [svc] });
    }
    return out;
}
function gitRoot(dir) { let d = dir; for (let i = 0; i < 8 && d && d !== '/'; i++) { if (fs.existsSync(path.join(d, '.git'))) return d; d = path.dirname(d); } return null; }

// ---------- scan ----------
let scanning = null;
export function scanStatus() { return scanning ? { running: true, started: scanning.started, step: scanning.step } : { running: false }; }
export async function scan(trigger = 'manual') {
    if (scanning) throw httpError(409, 'A scan is already running.');
    scanning = { started: Date.now(), step: 'Listing what is live' };
    const prev = readJ(f('scan.json'), null); const errors = [];
    try {
        await loadKev(); const ts = await targets(); const containers = await containerAges().catch(() => []);
        for (const t of ts) {
            scanning.step = `Checking ${t.name}`;
            try {
                if (t.kind === 'plato') { const pkgs = installedNodeModules(path.join(APP, 'server')); t.packages = pkgs.length; t.lockfiles = ['server/node_modules']; t.findings = [...await packageFindings(t.id, pkgs), ...await outdatedDirect(t.id, path.join(APP, 'server'), pkgs)]; t.version = readJ(path.join(APP, 'server', 'package.json'), {}).version; }
                else if (t.kind === 'box') { const b = await boxFindings(); t.findings = b.findings; t.tools = b.tools; t.services = b.services; t.installed = b.installed; t.patched = b.patched; }
                else {
                    const inv = inventory(t.path); t.packages = inv.packages.length; t.lockfiles = inv.files; t.git = !!gitRoot(t.path);
                    t.findings = [...await packageFindings(t.id, inv.packages), ...await embeddedAgents(t.id, inv.packages)];
                    for (const s of t.running.filter(s => s.image)) { const c = containers.find(x => x.image === s.image); if (c?.days > 120) t.findings.push(finding(t.id, { area: 'container', name: s.image, version: `${c.days} days old`, severity: c.days > 365 ? 'moderate' : 'low', note: 'The image has not been rebuilt or pulled for a long time; pull a newer tag of it.' })); }
                }
            } catch (e) { errors.push(`${t.name}: ${e.message}`); t.findings ||= []; t.error = e.message; }
            t.findings.sort((a, b) => sevN(b.severity) - sevN(a.severity) || String(a.name).localeCompare(String(b.name)));
            t.counts = Object.fromEntries(SEV.map(s => [s, t.findings.filter(x => x.severity === s).length]));
        }
        const others = containers.filter(c => !ts.some(t => t.running?.some(s => s.image === c.image)));
        const box = ts.find(t => t.id === 'box'); for (const c of others) if (c.days > 180) box.findings.push(finding('box', { area: 'container', name: `${c.name} (${c.image})`, version: `${c.days} days old`, severity: 'low', note: 'A container whose image is old; pull a newer tag.' }));
        const prevIds = new Set((prev?.targets || []).flatMap(t => (t.findings || []).map(x => x.id)));
        for (const t of ts) for (const x of t.findings) x.new = !!prev && !prevIds.has(x.id);
        scanning.step = 'Checking what waits on upstream releases'; await markWaiting(ts);
        const sc = { at: Date.now(), took: Date.now() - scanning.started, trigger, targets: ts, errors, drift: drift().filter(d => d.state === 'applied').length };
        writeJ(f('scan.json'), sc);
        recordResolved(prev, sc);
        const total = ts.reduce((n, t) => n + t.findings.length, 0);
        log('selfcheck', `scan (${trigger}): ${total} findings across ${ts.length} targets${errors.length ? `, ${errors.length} errors` : ''}`);
        record('selfcheck', 'scan', { actor: trigger, what: `${total} findings: ${ts.reduce((n, t) => n + t.counts.critical, 0)} critical, ${ts.reduce((n, t) => n + t.counts.high, 0)} high` });
        return sc;
    } finally { scanning = null; if (rescanWanted) { rescanWanted = false; rescanSoon(); } }
}
export function lastScan() { return readJ(f('scan.json'), null); }

// ---------- remediation runs ----------
const runFile = id => path.join(RUNS, `${id}.json`);
export function getRun(id) { if (!/^r[0-9a-z]{6,20}$/.test(id)) throw httpError(400, 'Bad run id.'); const r = readJ(runFile(id), null); if (!r) throw httpError(404, 'No such run.'); return r; }
function saveRun(r) { writeJ(runFile(r.id), r); }
export function runs(limit = 40) {
    let fs2 = []; try { fs2 = fs.readdirSync(RUNS).filter(x => x.endsWith('.json')); } catch { return []; }
    return fs2.map(x => readJ(path.join(RUNS, x), null)).filter(Boolean).sort((a, b) => b.created - a.created).slice(0, limit).map(r => ({ ...r, diff: undefined, hasDiff: !!r.diff, log: (r.log || []).slice(-8) }));
}
function addLog(r, line, by = 'plato') { r.log = [...(r.log || []), { at: Date.now(), by, line: String(line).slice(0, 1000) }].slice(-400); saveRun(r); }
const queue = []; let draining = false; let runner = null;
export function setRunner(fn) { runner = fn; }
// Defaults for both come from settings (autoRoot, autoApply): scheduled runs use them, the Fix dialog starts from them.
// grantRoot: the box agent's root commands run without asking (an elevation grant for its run); otherwise each waits
// for approval on the phone. autoApply: a PlatOpypus fix is applied once it passes the drift limit; otherwise it waits.
export function fix(targetIds, { trigger = 'manual', minSeverity = 'low', grantRoot = false, autoApply = false } = {}) {
    const sc = lastScan(); if (!sc) throw httpError(409, 'Scan first.');
    const ids = [...new Set((Array.isArray(targetIds) ? targetIds : []).map(String))]; if (!ids.length) throw httpError(400, 'Tick at least one target.');
    const made = [];
    for (const id of ids) {
        const t = sc.targets.find(x => x.id === id); if (!t) throw httpError(404, `Not in the last scan: ${id}.`);
        const fx = t.findings.filter(x => sevN(x.severity) >= sevN(minSeverity) && !x.waiting && x.area !== 'container' && !(x.area === 'os' && x.name === 'reboot'));
        if (!fx.length) continue;
        if (queue.some(q => q.target === id) || runs(100).some(r => r.target === id && ['queued', 'running', 'applying', 'approval'].includes(r.status))) continue;
        const r = { id: `r${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`, target: id, kind: t.kind, name: t.name, path: t.path, trigger, grantRoot: !!grantRoot && t.kind === 'box', autoApply: !!autoApply && t.kind === 'plato', status: 'queued', created: Date.now(), findings: fx, running: (t.running || []).filter(s => s.running && t.kind === 'project'), log: [] };
        saveRun(r); queue.push(r.id); made.push(r.id); addLog(r, `Queued (${trigger}) with ${fx.length} finding${fx.length === 1 ? '' : 's'}.`);
    }
    drain(); return { queued: made };
}
async function drain() {
    if (draining || !runner) return; draining = true;
    try { while (queue.length) { const id = queue.shift(); try { await runOne(getRun(id)); } catch (e) { try { const r = getRun(id); r.status = 'failed'; r.error = e.message; addLog(r, `Stopped: ${e.message}`); } catch { /* gone */ } } } }
    finally { draining = false; }
}
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
async function asAgent(cmd, args, opt = {}) { const a = agentUser.info(); if (!a) return sh(cmd, args, opt); return sh('/usr/sbin/runuser', ['-u', a.user, '--', cmd, ...args], { ...opt, env: { ...process.env, HOME: a.home } }); }
const git = (dir, ...args) => asAgent('git', ['-c', 'safe.directory=*', '-C', dir, ...args], { timeout: 120_000 });
function waitShell(name, ms = 60 * 60_000) { const fl = path.join(config.state, 'oneshot', `${name}.json`); const t0 = Date.now(); return new Promise(ok => { const t = setInterval(() => { if (fs.existsSync(fl) || Date.now() - t0 > ms) { clearInterval(t); ok(fs.existsSync(fl)); } }, 5000); }); }

async function runOne(r) {
    r.status = 'running'; r.started = Date.now(); saveRun(r);
    if (r.kind === 'project') return runProject(r);
    if (r.kind === 'plato') return runPlato(r);
    return runBox(r);
}
async function startAgent(r, cwd, prompt) {
    const s = settings(); r.cwd = cwd; saveRun(r);
    const name = await runner({ prompt, cwd, base: `fix-${r.kind === 'project' ? r.target.slice(2).replace(/[^a-z0-9]/gi, '').slice(0, 14).toLowerCase() || 'project' : r.kind}`, agent: s.agent, model: s.model });
    r.shell = name; saveRun(r); addLog(r, `Agent ${s.agent} started in ${cwd} (shell ${name}).`);
    return name;
}
const FINDINGS_HELP = 'selfcheck_findings lists them (package or tool, installed version, the version that fixes it, advisories). Use selfcheck_log for a line on each step (the user reads it). Findings only an upstream release can fix (bundled in a tool already at its latest version, no fixed release yet): mark them with selfcheck_waiting rather than leaving the run partial; if everything else is fixed, your status is fixed. Finish with selfcheck_report.';

async function runProject(r) {
    const root = gitRoot(r.path);
    if (!root) { addLog(r, 'Not a git repository: fixes would have no branch and no rollback, so this project is skipped. Make it a repo (Files → the folder → Git) to include it.'); r.status = 'skipped'; return saveRun(r); }
    try { await agentUser.prepareFolder(root); } catch (e) { addLog(r, `Could not give the agent user this folder: ${e.message}`); }
    const head = await git(root, 'rev-parse', 'HEAD'); const br = await git(root, 'rev-parse', '--abbrev-ref', 'HEAD');
    if (!head.ok) { r.status = 'skipped'; addLog(r, 'The repository has no commits yet; skipped.'); return saveRun(r); }
    r.base = head.out.trim(); r.origBranch = br.out.trim(); r.branch = `plato/remediate-${stamp()}`; r.repo = root;
    const co = await git(root, 'checkout', '-b', r.branch); if (!co.ok) { r.status = 'failed'; addLog(r, `Could not make branch ${r.branch}: ${co.out.trim()}`); return saveRun(r); }
    addLog(r, `On new branch ${r.branch} (from ${r.origBranch} @ ${r.base.slice(0, 7)}).`);
    const prompt = `Fix the security findings PlatOpypus's self-check found in the project in this folder (${r.name}). You are on a new git branch, ${r.branch}; commit your fixes there in small commits whose messages name the advisory ids. ${FINDINGS_HELP}\n` +
        `1. For each finding, move to the version that fixes it, keeping the same major version where one does (npm install pkg@x.y.z so the lockfile changes; edit the pin in requirements files and reinstall; bundle update --conservative <gem>; go get mod@vX; cargo update -p). If only a new major version fixes it, do it only if the project's tests still pass, otherwise leave it and say why. A known malicious package: remove it and replace it with the real one if it was a typo.\n` +
        `2. Install, so the code that runs uses the new versions (npm ci, the project's own venv's pip, bundle install).\n` +
        `3. Run the project's tests or build (package.json scripts, Makefile, pytest, rails test, go test). Fix what the upgrade broke, nothing else.\n` +
        `4. Rules: do not change behaviour beyond what the fix needs; leave files you did not change alone, including changes that were already uncommitted; never push; never start a service; do not switch branches.\n` +
        `End with selfcheck_report (status fixed, partial, failed or nothing-to-do; what you fixed; what is left and why; the test result).`;
    const name = await startAgent(r, root, prompt); const finished = await waitShell(name);
    r = getRun(r.id); if (!finished) addLog(r, 'The agent ran past an hour; checking what it did.');
    const commits = await git(root, 'log', '--oneline', `${r.base}..HEAD`); r.commits = commits.out.trim().split('\n').filter(Boolean);
    const diff = await git(root, 'diff', `${r.base}..HEAD`, '--stat', '--patch', '--', '.', ':(exclude)*.lock', ':(exclude)package-lock.json'); r.diff = diff.out.slice(0, 400_000);
    const stat = await git(root, 'diff', '--shortstat', `${r.base}..HEAD`); r.stat = stat.out.trim();
    if (!r.commits.length) { r.status = r.report?.status === 'nothing-to-do' ? 'done' : 'failed'; addLog(r, r.status === 'done' ? 'Nothing needed changing.' : 'The agent made no commits.'); await git(root, 'checkout', r.origBranch); await git(root, 'branch', '-D', r.branch); r.branch = null; r.finished = Date.now(); return saveRun(r); }
    addLog(r, `${r.commits.length} commit${r.commits.length === 1 ? '' : 's'} on ${r.branch} (${r.stat}).`);
    const ok = await restartServices(r);
    if (!ok) {
        addLog(r, 'A service did not come back after the restart: reverting the fix commits.');
        const rv = await git(root, 'revert', '--no-edit', `${r.base}..HEAD`); addLog(r, rv.ok ? 'Reverted.' : `Revert failed: ${rv.out.trim()}`);
        await restartServices(r); r.status = 'rolled-back';
    } else r.status = r.report?.status === 'failed' ? 'failed' : 'done';
    r.finished = Date.now(); saveRun(r); afterRun(r);
}
async function restartServices(r) {
    let all = true;
    for (const s of r.running || []) {
        try { if (s.registered) await servicesMgr.restart(s.slug); else await live.restart(r.target.slice(2), s.key); addLog(r, `Restarted ${s.title}.`); }
        catch (e) { addLog(r, `Restart of ${s.title} failed: ${e.message}`); all = false; continue; }
        await new Promise(ok => setTimeout(ok, 8000));
        const now = (await servicesMgr.list().catch(() => [])).find(x => x.slug === s.slug);
        if (!now?.alive) { addLog(r, `${s.title} is not running 8 s after the restart.`); all = false; }
    }
    return all;
}
export async function mergeRun(id) {
    const r = getRun(id); if (r.kind !== 'project' || !r.branch) throw httpError(409, 'Nothing to merge.');
    if (r.merged) throw httpError(409, 'Already merged.');
    const c1 = await git(r.repo, 'checkout', r.origBranch); if (!c1.ok) throw httpError(409, `Could not switch back to ${r.origBranch}: ${c1.out.trim()}`);
    const m = await git(r.repo, 'merge', '--no-ff', '--no-edit', '-m', `Merge ${r.branch}: self-check fixes`, r.branch);
    if (!m.ok) { await git(r.repo, 'merge', '--abort'); await git(r.repo, 'checkout', r.branch); throw httpError(409, `Merge failed (left on ${r.branch}): ${m.out.trim().slice(0, 300)}`); }
    r.merged = Date.now(); addLog(r, `Merged ${r.branch} into ${r.origBranch}.`, 'phone'); await restartServices(r); saveRun(r);
    record('selfcheck', 'merge', { actor: 'phone', cwd: r.repo, what: `merged ${r.branch}` }); return r;
}
export async function rollbackRun(id) {
    const r = getRun(id);
    if (r.kind === 'project') {
        if (!r.base || !r.commits?.length) throw httpError(409, 'Nothing to roll back.');
        const cur = (await git(r.repo, 'rev-parse', '--abbrev-ref', 'HEAD')).out.trim();
        const range = r.merged ? null : `${r.base}..${r.branch}`;
        const rv = range && cur === r.branch ? await git(r.repo, 'revert', '--no-edit', range) : r.merged ? await git(r.repo, 'revert', '--no-edit', '-m', '1', 'HEAD') : { ok: false, out: `Switch to ${r.branch} first.` };
        if (!rv.ok) throw httpError(409, `Revert failed: ${rv.out.trim().slice(0, 300)}`);
        addLog(r, 'Rolled back with git revert.', 'phone'); await restartServices(r);
    } else if (r.kind === 'plato') {
        if (r.status !== 'done' || !r.snapshot) throw httpError(409, 'Nothing applied to roll back.');
        await applyPlato(r, { rollback: true });
        addLog(r, 'Roll back started: the snapshot is being put back and PlatOpypus restarts.', 'phone');
    } else {
        const snap = r.snapshot; if (!snap || !fs.existsSync(snap)) throw httpError(409, 'No nginx snapshot for this run.');
        const x = await sh('tar', ['-xzf', snap, '-C', '/'], { timeout: 60_000 }); const t = await sh('nginx', ['-t']);
        if (x.ok && t.ok) await sh('systemctl', ['reload', 'nginx']);
        addLog(r, x.ok && t.ok ? 'nginx configuration restored from the snapshot and reloaded. Package upgrades stay (apt cannot safely go back).' : `Restore failed: ${(x.out + t.out).trim().slice(0, 300)}`, 'phone');
    }
    r.status = 'rolled-back'; r.rolledBack = Date.now(); saveRun(r); record('selfcheck', 'rollback', { actor: 'phone', what: `rolled back ${r.target}`, cwd: r.path }); return r;
}

// ----- PlatOpypus itself: a staged copy, a drift limit, then apply with snapshot + health check + rollback -----
const NEVER = [/^server\/lib\/(auth|totp|vault|elevate|agentuser|svcuser|egress|trust|credentials|sharedcreds|update|migrate|selfcheck|config)\.js$/, /^install\.sh$/, /^bin\/(plato-update|porthole-update|plato-selffix|elevate|vault)$/, /^deploy\//, /^scripts\//, /^server\/migrations\//, /^docs\/SECURITY/];
const DEP_FILES = /^server\/package(-lock)?\.json$/;
const LIMIT = { files: 6, lines: 150 };
function stageDir(r) { const a = agentUser.info(); const base = a ? path.join(a.home, 'selfcheck') : path.join(config.home, 'selfcheck'); return path.join(base, `plato-${r.id}`); }
async function runPlato(r) {
    const a = agentUser.info(); const st = stageDir(r);
    fs.mkdirSync(path.dirname(st), { recursive: true, mode: 0o750 });
    const cp = await sh('cp', ['-a', APP, st], { timeout: 300_000 }); if (!cp.ok) throw new Error(`Could not stage a copy: ${cp.out.trim()}`);
    fs.writeFileSync(path.join(st, '.gitignore'), 'node_modules/\n*.log\n');
    if (a) await sh('chown', ['-R', `${a.uid}:${a.gid}`, path.dirname(st)], { timeout: 120_000 });
    for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=PlatOpypus', '-c', 'user.email=plato@localhost', 'commit', '-qm', 'installed copy']]) await git(st, ...args);
    r.stage = st; r.fromVersion = readJ(path.join(APP, 'server', 'package.json'), {}).version; saveRun(r); addLog(r, `Staged a copy of PlatOpypus ${r.fromVersion} at ${st}.`);
    const prompt = `Fix the security findings in PlatOpypus's own dependencies. This folder is a staged copy of the installed PlatOpypus (a git repo; commit your change). PlatOpypus applies it to the real install itself, with a snapshot and a health check. ${FINDINGS_HELP}\n` +
        `Allowed: dependency upgrades in server/package.json and server/package-lock.json (cd server; npm install pkg@version, or npm audit fix without --force), and, only when an advisory needs it and no upgrade covers it, a small code patch (at most ${LIMIT.files} files and ${LIMIT.lines} changed lines in all). Never touch the security core: authentication, two-step codes, the Vault, elevation, the agent and service users, the firewall, install.sh, the updater, deploy/, scripts/ or migrations; a change there is refused and nothing is applied.\n` +
        `Check: cd server && npm ls --omit=dev (no missing or invalid); node --check server.js and every file you changed; and import each upgraded package on its own (node -e "import('ws').then(m => console.log(Object.keys(m)))"). Do not run or import server.js or anything under lib/: that starts PlatOpypus as you, which writes state into your home. PlatOpypus health-checks the real start itself after applying.\n` +
        `For every code change (not version bumps) write in selfcheck_report's notes_for_developers: the file, what changed, why (advisory ids), so the PlatOpypus developers can put it into the next release. End with selfcheck_report.`;
    const name = await startAgent(r, st, prompt); await waitShell(name); r = getRun(r.id);
    await git(st, 'add', '-A'); await git(st, '-c', 'user.name=PlatOpypus', '-c', 'user.email=plato@localhost', 'commit', '-qm', 'uncommitted agent changes');
    const first = (await git(st, 'rev-list', '--max-parents=0', 'HEAD')).out.trim();
    const names = (await git(st, 'diff', '--name-only', first, 'HEAD')).out.trim().split('\n').filter(Boolean);
    const numstat = (await git(st, 'diff', '--numstat', first, 'HEAD')).out.trim().split('\n').filter(Boolean).map(l => { const [ad, de, file] = l.split('\t'); return { file, lines: (Number(ad) || 0) + (Number(de) || 0) }; });
    r.diff = (await git(st, 'diff', first, 'HEAD')).out.slice(0, 400_000); r.files = names;
    if (!names.length) { r.status = r.report?.status === 'nothing-to-do' ? 'done' : 'failed'; addLog(r, 'The agent changed nothing.'); r.finished = Date.now(); saveRun(r); cleanStage(r); return; }
    const forbidden = names.filter(n => NEVER.some(re => re.test(n)));
    const code = numstat.filter(x => !DEP_FILES.test(x.file));
    const codeLines = code.reduce((n, x) => n + x.lines, 0);
    if (forbidden.length || code.length > LIMIT.files || codeLines > LIMIT.lines) {
        r.status = 'blocked'; r.blocked = forbidden.length ? `It changed protected files: ${forbidden.join(', ')}.` : `Too much code changed for a local fix (${code.length} files, ${codeLines} lines; the limit is ${LIMIT.files} files and ${LIMIT.lines} lines). That belongs in a release.`;
        addLog(r, `Not applied. ${r.blocked} The patch is kept below for the developers.`); r.devNote = devNote(r, code); r.finished = Date.now(); saveRun(r); afterRun(r); return;
    }
    r.devNote = devNote(r, code); r.depsChanged = names.some(n => DEP_FILES.test(n)); saveRun(r);
    // Applying is a root change to PlatOpypus outside elevate, so it waits for the user unless they allowed it up front.
    if (!r.autoApply) { r.status = 'approval'; saveRun(r); addLog(r, `Passed the drift limit (${names.length} file${names.length === 1 ? '' : 's'}: ${names.join(', ')}). Waiting for you to apply it: read "What changed", then Apply or Discard.`); afterRun(r); return; }
    addLog(r, `Passed the drift limit (${names.length} file${names.length === 1 ? '' : 's'}: ${names.join(', ')}). Applying with a snapshot and a health check (you allowed this without asking).`);
    await applyPlato(r);
}
// The user's decision on a PlatOpypus fix waiting for approval.
export async function approveRun(id, { apply }) {
    const r = getRun(id); if (r.kind !== 'plato' || r.status !== 'approval') throw httpError(409, 'Nothing waiting for approval.');
    if (!r.stage || !fs.existsSync(r.stage)) { r.status = 'failed'; addLog(r, 'The staged copy is gone; run the fix again.'); throw httpError(409, 'The staged copy is gone; run the fix again.'); }
    record('selfcheck', apply ? 'plato-approved' : 'plato-discarded', { actor: 'phone', what: (r.files || []).join(', ') });
    if (!apply) { r.status = 'discarded'; r.finished = Date.now(); addLog(r, 'Discarded: nothing was applied. The patch stays here for the developers.', 'phone'); saveRun(r); cleanStage(r); return r; }
    addLog(r, 'You approved it: applying with a snapshot and a health check.', 'phone'); await applyPlato(r); return getRun(id);
}
function devNote(r, code) {
    const fixed = (r.report?.fixed || []).join('; ');
    return [`PlatOpypus self-remediation — ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC — installed version ${r.fromVersion}`,
        `Findings: ${r.findings.map(x => `${x.name} ${x.version || ''}${x.fixed ? ` → ${x.fixed}` : ''} (${(x.advisories || []).map(a => a.aliases?.[0] || a.id).slice(0, 3).join(', ') || x.severity})`).join('; ')}`,
        fixed ? `Fixed: ${fixed}` : '', r.report?.summary ? `Agent summary: ${r.report.summary}` : '', r.report?.notes_for_developers ? `Notes for developers: ${r.report.notes_for_developers}` : '',
        code.length ? `Code changes (not version bumps): ${code.map(x => `${x.file} (${x.lines} lines)`).join(', ')}` : 'Dependency versions only.',
        '', 'Patch (git apply from the repository root):', r.diff || ''].filter(x => x !== '').join('\n');
}
async function applyPlato(r, { rollback = false } = {}) {
    const script = path.join(APP, 'bin', 'plato-selffix'); if (!fs.existsSync(script)) throw new Error('bin/plato-selffix is missing.');
    const snap = r.snapshot || path.join(DIR, 'snapshots', `plato-${r.id}.tgz`); fs.mkdirSync(path.dirname(snap), { recursive: true, mode: 0o700 });
    const result = path.join(DIR, 'apply', `${r.id}.json`); fs.mkdirSync(path.dirname(result), { recursive: true, mode: 0o700 });
    r.status = 'applying'; r.snapshot = snap; saveRun(r);
    const env = { ...process.env, PLATO_APP: APP, PLATO_STATE: config.state, SELFFIX_STAGE: r.stage || '', SELFFIX_FILES: (r.files || []).join('|'), SELFFIX_SNAPSHOT: snap, SELFFIX_RESULT: result, SELFFIX_DEPS: r.depsChanged ? '1' : '', SELFFIX_MODE: rollback ? 'rollback' : 'apply', SELFFIX_RUN: r.id };
    const out = fs.openSync(path.join(DIR, 'apply.log'), 'a');
    let child; try { await run('systemd-run', ['--version'], { timeout: 3000 }); child = spawn('systemd-run', ['--unit', `platopypus-selffix-${Date.now()}`, '--collect', ...Object.entries(env).filter(([k]) => k.startsWith('SELFFIX_') || k.startsWith('PLATO_')).map(([k, v]) => `--setenv=${k}=${v}`), 'bash', script], { stdio: ['ignore', out, out], detached: true }); }
    catch { child = spawn('setsid', ['bash', script], { env, stdio: ['ignore', out, out], detached: true }); }
    child.unref(); record('selfcheck', rollback ? 'plato-rollback' : 'plato-apply', { actor: r.trigger, what: (r.files || []).join(', ') });
}
// After a restart: pick up the applier's result.
export function finishApplies() {
    let fl = []; try { fl = fs.readdirSync(path.join(DIR, 'apply')); } catch { return; }
    for (const x of fl.filter(n => n.endsWith('.json'))) {
        const res = readJ(path.join(DIR, 'apply', x), null); const id = x.replace('.json', ''); fs.rmSync(path.join(DIR, 'apply', x), { force: true });
        let r; try { r = getRun(id); } catch { continue; }
        if (res?.mode === 'rollback') { r.status = 'rolled-back'; addLog(r, res.ok ? 'PlatOpypus restored from the snapshot.' : `Rollback: ${res.message}`); markDrift(r, 'rolled-back'); }
        else if (res?.ok) { r.status = 'done'; r.applied = res.at; addLog(r, `Applied and healthy: ${res.message}`); markDrift(r, 'applied'); }
        else { r.status = 'rolled-back'; addLog(r, `Not kept: ${res?.message || 'no result'}`); }
        r.finished = Date.now(); saveRun(r); cleanStage(r); afterRun(r);
    }
}
function cleanStage(r) { if (r.stage && r.stage.includes(`${path.sep}selfcheck${path.sep}plato-`)) fs.rmSync(r.stage, { recursive: true, force: true }); }
// Local fixes on top of a release: listed until an update replaces the code they changed.
export function drift() { return readJ(f('drift.json'), []); }
function markDrift(r, state) { const d = drift().filter(x => x.run !== r.id); if (state === 'applied') d.unshift({ run: r.id, at: Date.now(), version: r.fromVersion, files: r.files, state }); writeJ(f('drift.json'), d.slice(0, 50)); }
export function checkDriftAfterUpdate() {
    const v = readJ(path.join(APP, 'server', 'package.json'), {}).version; const d = drift(); let changed = false;
    for (const x of d) if (x.state === 'applied' && x.version !== v) { x.state = 'replaced'; x.replacedBy = v; changed = true; }
    if (changed) { writeJ(f('drift.json'), d); log('selfcheck', `update to ${v} replaced local self-check fixes; rescanning`); setTimeout(() => scan('after-update').catch(() => {}), 90_000); }
}

// ----- the box: elevation for the run, nginx snapshot first -----
async function runBox(r) {
    const snap = path.join(DIR, 'snapshots', `box-${r.id}.tgz`); fs.mkdirSync(path.dirname(snap), { recursive: true, mode: 0o700 });
    if (fs.existsSync('/etc/nginx')) { const t = await sh('tar', ['-czf', snap, '-C', '/', 'etc/nginx', ...(fs.existsSync('/etc/letsencrypt/renewal') ? ['etc/letsencrypt/renewal'] : [])], { timeout: 60_000 }); if (t.ok) { r.snapshot = snap; addLog(r, 'Snapshotted /etc/nginx before any change.'); } }
    const before = await sh('dpkg-query', ['-W', '-f=${binary:Package} ${Version}\n'], { timeout: 30_000 }); r.pkgsBefore = before.out.length < 2_000_000 ? before.out : '';
    const run0 = await sh('systemctl', ['list-units', '--type=service', '--state=running', '--no-legend', '--plain'], { timeout: 15_000 }); r.servicesBefore = run0.out.split('\n').map(l => l.split(/\s+/)[0]).filter(Boolean);
    saveRun(r);
    const prompt = `Fix the box-level findings PlatOpypus's self-check found (system packages, nginx, certbot and certificates, Node.js, agent CLIs, MCP servers). ${FINDINGS_HELP}\n` +
        `You are the agent user. Run anything that needs root with \`elevate -- <command>\`. ${r.grantRoot ? 'You hold an elevation grant for this run, so it runs without asking; every command is in the audit log.' : 'Each one asks the user on their phone first and waits up to 10 minutes: batch what you can into few commands (one apt-get install for all packages), give each a clear --reason, and if one is refused or times out, report it instead of retrying.'}\n` +
        `Allowed: apt-get install -y --only-upgrade <the packages named in the findings> (after elevate -- apt-get update); certbot renew; nginx -t then systemctl reload nginx; restarting a service that is running now and was just upgraded; restarting services named in a "restart needed" finding (systemctl restart <unit>), except PlatOpypus, docker, containerd, dbus, systemd-logind and other systemd-* units, ssh/sshd and the SSM agent: those stay for the user; updating global npm packages (npm install -g <pkg>@<fixed version>; npm itself may move to a newer major version if that release supports the installed Node.js major, since that is how npm ships fixes to what it bundles; a finding marked "bundled; update X" is fixed by updating X, and if X is already at its latest release, report it as waiting on X upstream), pip packages outside apt (pip install --upgrade in the same prefix it was installed in, or pipx upgrade), gems (gem update <gem>) and cargo installs named in the findings; updating the agent CLIs named (npm install -g <pkg>@latest, claude update); agent CLIs exist per user, so update the copy the finding names: "(root)" with elevate -- <path> update (or elevate -- npm install -g), "(agent user)" as yourself; replacing a standalone binary named in the findings with the vendor's official release for this architecture, only after checking the vendor's published SHA-256 checksum (keep the old one as <path>.selfcheck-old); pinning an MCP server's package to a checked version.\n` +
        `When a finding says there is no fixed package yet, apply the workaround its advisory documents if it is a configuration change (for example turning HTTP/2 off in nginx listen lines for an nginx HTTP/2 flaw): copy the file to <file>.selfcheck-${r.id} first, change only what the workaround needs, run the service's config test (nginx -t), reload, check the service still answers (curl -sI https://127.0.0.1 -k for nginx), and say in the report exactly what to undo once the fixed package arrives. A finding inside a Java jar or another app's bundle: report which app ships it; do not edit the app.\n` +
        `Never: start a service that is stopped, stop or break one PlatOpypus needs (nginx, its own service, docker, tmux, ssh/ssm), reboot, change the firewall, SSH, users, sudoers or PlatOpypus itself (/opt/platopypus), remove packages, or upgrade Node.js across a major version. Always run nginx -t before any nginx reload and stop if it fails. If a reboot is needed, say so in the report instead.\n` +
        `End with selfcheck_report (what you upgraded with before → after versions, what you left and why).`;
    const name = await startAgent(r, agentUser.info()?.home || config.home, prompt);
    if (r.grantRoot) { elevate.grant(name, 90); addLog(r, `You allowed root without asking: elevation granted to ${name} for 90 minutes (this run only).`); }
    else addLog(r, 'Root commands wait for your approval on the phone (elevate), one by one.');
    await waitShell(name, 90 * 60_000); if (r.grantRoot) elevate.grant(name, 0); r = getRun(r.id);
    const after = await sh('dpkg-query', ['-W', '-f=${binary:Package} ${Version}\n'], { timeout: 30_000 });
    const b = new Map((r.pkgsBefore || '').split('\n').map(l => l.split(' '))); r.upgraded = after.out.split('\n').map(l => l.split(' ')).filter(([p, v]) => p && b.has(p) && b.get(p) !== v).map(([p, v]) => `${p} ${b.get(p)} → ${v}`).slice(0, 300); delete r.pkgsBefore;
    const nt = fs.existsSync('/etc/nginx') ? await sh('nginx', ['-t']) : { ok: true };
    const run1 = await sh('systemctl', ['list-units', '--type=service', '--state=running', '--no-legend', '--plain'], { timeout: 15_000 }); const now = run1.out.split('\n').map(l => l.split(/\s+/)[0]).filter(Boolean);
    r.stopped = (r.servicesBefore || []).filter(s => !now.includes(s) && !/^(run-|user@|session-)/.test(s)); delete r.servicesBefore;
    addLog(r, `${r.upgraded.length} package${r.upgraded.length === 1 ? '' : 's'} changed.${r.stopped.length ? ` Not running any more: ${r.stopped.join(', ')}.` : ''}`);
    if (!nt.ok && r.snapshot) { addLog(r, `nginx -t fails after the run: restoring /etc/nginx. ${nt.out.trim().split('\n').slice(-1)[0]}`); await sh('tar', ['-xzf', r.snapshot, '-C', '/'], { timeout: 60_000 }); if ((await sh('nginx', ['-t'])).ok) await sh('systemctl', ['reload', 'nginx']); r.status = 'rolled-back'; }
    else r.status = r.report?.status === 'failed' ? 'failed' : 'done';
    r.finished = Date.now(); saveRun(r); afterRun(r);
}
// After a fix run: scan again so what it fixed leaves the list straight away (once the queue is empty; if a scan is
// running, straight after it).
let rescanTimer = null, rescanWanted = false;
function rescanSoon() {
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => { if (queue.length || draining) return; if (scanning) { rescanWanted = true; return; } scan('after-fix').catch(e => log('selfcheck', `scan after fix failed: ${e.message}`)); }, 15_000);
}
// Findings that were in the previous scan and are not in this one: kept 30 days with what resolved them (the fix run
// that had them, or "outside self-check": an apt upgrade, someone's own change). Targets missing from either scan, or
// that failed to scan, are left out (absence there is not a fix).
function recordResolved(prev, sc) {
    if (!prev) return;
    const list = readJ(f('resolved.json'), []).filter(x => Date.now() - x.at < 30 * 86400_000);
    const done = runs(100).filter(r => (r.finished || 0) >= prev.at && r.status === 'done');
    for (const pt of prev.targets || []) {
        const ct = sc.targets.find(t => t.id === pt.id); if (!ct || ct.error || pt.error) continue;
        const now = new Set(ct.findings.map(x => x.id));
        for (const x of pt.findings || []) {
            if (now.has(x.id) || x.severity === 'info' || list.some(y => y.id === x.id && y.at >= prev.at)) continue;
            const by = done.find(r => r.target === pt.id && (r.findings || []).some(y => y.id === x.id));
            list.unshift({ id: x.id, target: pt.id, targetName: pt.name, name: x.name, version: x.version || null, fixed: x.fixed || null, severity: x.severity, area: x.area, advisories: (x.advisories || []).slice(0, 4).map(a => a.aliases?.[0] || a.id), at: Date.now(), by: by ? { run: by.id, name: by.name } : null });
        }
    }
    writeJ(f('resolved.json'), list.slice(0, 400));
}
function afterRun(r) {
    const txt = `${r.name}: ${r.status === 'done' ? 'fixed' : r.status}${r.report?.summary ? ` — ${String(r.report.summary).slice(0, 160)}` : ''}`;
    try { alerts.notify('selfcheck', `Self-check fix · ${txt}`, { key: `sc-${r.id}`, quietMs: 0 }); } catch { /* alerts off */ }
    log('selfcheck', `run ${r.id} (${r.target}) ${r.status}`);
    if (['done', 'rolled-back', 'failed'].includes(r.status)) rescanSoon();
}

// ---------- agent tools (kit) ----------
function activeRun(shell) { const all = runs(100).filter(r => r.status === 'running' && r.cwd && shell?.cwd && (shell.cwd === r.cwd || shell.cwd.startsWith(r.cwd + path.sep))); if (!all.length) throw httpError(403, 'Self-check tools work only in a self-check fix run.'); return getRun(all[0].id); }
kit.registerApp('selfcheck', {
    context(shell) { if (shell?.session !== 'selfcheck') throw httpError(403, 'Self-check tools work only in a self-check fix run.'); return { run: activeRun(shell) }; },
    tools: [
        { name: 'selfcheck_findings', description: 'The findings this run is to fix: package or tool, ecosystem, installed version, the version that fixes it, severity, advisories (ids, CVEs, summaries), and the lockfile it came from.', inputSchema: kit.obj({}),
            run: c => c.run.findings.map(x => `${x.id} [${x.severity}${x.malicious ? ', MALICIOUS' : ''}${x.dev ? ', dev only' : ''}] ${x.area}: ${x.ecosystem ? `${x.ecosystem} ` : ''}${x.name}${x.version ? ` ${x.version}` : ''}${x.fixed ? ` → fixed in ${x.fixed}` : ''}${x.apt ? ` (apt: ${x.apt})` : ''}${x.file ? ` · ${String(x.file).replace(c.run.path, '.')}` : ''}${x.note ? `\n    ${x.note}` : ''}${(x.advisories || []).map(a => `\n    ${a.id}${a.aliases?.length ? ` (${a.aliases.join(', ')})` : ''}: ${a.summary}`).join('')}`).join('\n') },
        { name: 'selfcheck_log', description: 'Add a line to the run\'s log, which the user reads (what you are doing, what you found).', inputSchema: kit.obj({ line: kit.str('One line') }, ['line']), run: (c, a) => { addLog(c.run, a.line, 'agent'); return 'ok'; } },
        { name: 'selfcheck_waiting', description: 'Mark findings that only an upstream release can fix (e.g. a vulnerable package bundled inside a tool that is already at its latest version). They stop being offered for fixing until that tool publishes a newer version. Do not count them against your status.', inputSchema: kit.obj({ ids: kit.arr('Finding ids (from selfcheck_findings)'), on: kit.str('The package or tool whose next release is needed, e.g. "cline" or "npm"'), ecosystem: kit.str('Its ecosystem: npm, PyPI, RubyGems, Ubuntu … (npm is re-checked automatically)'), version: kit.str('Its latest version now, which does not fix it'), why: kit.str('One line') }, ['ids', 'on', 'version']),
            run: (c, a) => { const ids = (a.ids || []).map(String).filter(id => c.run.findings.some(x => x.id === id)); if (!ids.length) throw httpError(400, 'None of those ids are in this run.'); const w = readJ(f('upstream.json'), {}); for (const id of ids) w[id] = { on: String(a.on).slice(0, 120), ecosystem: String(a.ecosystem || 'npm').slice(0, 40), version: String(a.version).slice(0, 60), why: String(a.why || '').slice(0, 300), at: Date.now(), run: c.run.id }; writeJ(f('upstream.json'), w); c.run.waiting = [...new Set([...(c.run.waiting || []), ...ids])]; addLog(c.run, `Waiting on ${a.on} ${a.version} upstream: ${ids.length} finding${ids.length === 1 ? '' : 's'}.`, 'agent'); return `Marked ${ids.length}; they are not offered again until ${a.on} releases a version after ${a.version}.`; } },
        { name: 'selfcheck_report', description: 'Finish: the outcome of this run.', inputSchema: kit.obj({ status: kit.str('fixed | partial | failed | nothing-to-do'), summary: kit.str('Two or three sentences'), fixed: kit.arr('What you fixed, e.g. "ws 8.17.0 → 8.17.1 (GHSA-…)"'), remaining: kit.arr('What is left, and why'), tests: kit.str('What you ran to check, and the result'), notes_for_developers: kit.str('PlatOpypus runs: every code change (file, what, why) for the developers') }, ['status', 'summary']),
            run: (c, a) => { const r = getRun(c.run.id); r.report = { status: ['fixed', 'partial', 'failed', 'nothing-to-do'].includes(a.status) ? a.status : 'partial', summary: String(a.summary || '').slice(0, 4000), fixed: (a.fixed || []).map(x => String(x).slice(0, 800)).slice(0, 80), remaining: (a.remaining || []).map(x => String(x).slice(0, 800)).slice(0, 80), tests: String(a.tests || '').slice(0, 4000), notes_for_developers: String(a.notes_for_developers || '').slice(0, 6000), at: Date.now() }; addLog(r, `Report: ${r.report.status}. ${r.report.summary}`, 'agent'); return 'Recorded. You can stop now.'; } },
    ],
});
export const TOOLS_FOR_AGENT = ['selfcheck_findings', 'selfcheck_log', 'selfcheck_report'];

// ---------- schedule ----------
export function nextAt() { const s = settings(); if (!s.enabled) return null; try { return nextRun(s.cron, Date.now()); } catch { return null; } }
let lastTick = Date.now();
export function tick() {
    const s = settings(); if (!s.enabled) { lastTick = Date.now(); return; }
    const due = nextRun(s.cron, lastTick); const now = Date.now(); if (!due || due > now) return; lastTick = now;
    scan('schedule').then(sc => {
        const fresh = sc.targets.flatMap(t => t.findings.filter(x => x.new && sevN(x.severity) >= sevN(s.alertSeverity)));
        if (s.alert && fresh.length) try { alerts.notify('selfcheck', `Self-check: ${fresh.length} new finding${fresh.length === 1 ? '' : 's'} (${[...new Set(fresh.map(x => x.severity))].join(', ')}): ${fresh.slice(0, 4).map(x => x.name).join(', ')}${fresh.length > 4 ? '…' : ''}`, { key: 'selfcheck-scan', quietMs: 0 }); } catch { /* alerts off */ }
        const auto = s.autoTargets.filter(id => sc.targets.find(t => t.id === id)?.findings.some(x => !x.waiting && sevN(x.severity) >= sevN(s.autoSeverity)));
        if (auto.length) fix(auto, { trigger: 'schedule', minSeverity: s.autoSeverity, grantRoot: s.autoRoot, autoApply: s.autoApply });
    }).catch(e => log('selfcheck', `scheduled scan failed: ${e.message}`));
}
export function start(runnerFn) {
    setRunner(runnerFn); finishApplies(); checkDriftAfterUpdate();
    // runs that were in flight when PlatOpypus stopped
    for (const r of runs(100)) if (r.status === 'queued') queue.push(r.id); else if (r.status === 'running') { const x = getRun(r.id); x.status = 'failed'; addLog(x, 'PlatOpypus restarted during this run.'); }
    drain();
    // Results of a PlatOpypus fix arrive after the restart (the health check takes up to 45 s), so look every 15 s.
    setInterval(() => { try { finishApplies(); } catch (e) { log('selfcheck', `apply result: ${e.message}`); } }, 15_000);
    setInterval(() => { try { tick(); } catch (e) { log('selfcheck', `tick: ${e.message}`); } }, 60_000);
}
export function overview() {
    const sc = lastScan();
    return { resolved: readJ(f('resolved.json'), []), settings: settings(), next: nextAt(), scan: sc ? { ...sc, targets: sc.targets.map(t => ({ ...t, findings: t.findings })) } : null, status: scanStatus(), runs: runs(), drift: drift() };
}
