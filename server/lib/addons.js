// Apps: optional parts of PlatOpypus that bring their own tools. Nothing is installed with the box; an app's packages
// are installed when you add it from the Apps tab, and its screens appear then. Removing an app hides it again and
// keeps its data and packages (system packages may be shared, so they are left alone).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { log } from './log.js';
import { record } from './audit.js';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const stateFile = path.join(config.state, 'apps.json');
const logDir = path.join(config.state, 'apps');
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const load = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } };
const save = s => { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(s, null, 2), { mode: 0o600 }); };

export const CATALOG = [
    {
        id: 'research', title: 'Research', icon: 'file-text',
        blurb: 'Papers written from real sources: a LaTeX editor with citations you can check, sources from PDFs, web pages and videos, and agents that research with you.',
        installs: ['LaTeX (TeX Live, with latexmk)', 'PDF tools (Poppler)', 'ffmpeg', 'OCR (Tesseract)', 'Spell checking (aspell, English and French)', 'yt-dlp', 'Whisper speech to text (faster-whisper)'],
        size: 'about 2 GB', time: 'about 5 to 10 minutes',
        command: () => ['node', [path.resolve(here, '..', '..', 'bin', 'research'), 'setup']],
        // Ready when its tools are there. A box that already had them (or has topics) counts as added.
        ready: async () => { const T = await import('./researchtools.js'); const d = await T.doctor(); return Object.values(d).every(v => v.path); },
        hasData: () => { try { return fs.readdirSync(path.join(config.root, 'Research')).some(n => fs.existsSync(path.join(config.root, 'Research', n, '.platopypus', 'research.json'))); } catch { return false; } },
    },
    {
        id: 'lab', title: 'Security Lab', icon: 'shield',
        blurb: 'Test your own domains, services and applications, wherever they are hosted: port and TLS checks, web and DNS scans, lookalike domains, forensics tools, and agents that test with you, always inside a scope you verify.',
        installs: ['nmap, nikto, sslscan, testssl.sh, whatweb', 'dnsutils, whois, dnsrecon, dnstwist', 'mtr, traceroute, iperf3, arp-scan, netdiscover, net-tools', 'tcpdump, tshark', 'sleuthkit, autopsy, binwalk, foremost, exiftool, yara', 'lynis, rkhunter, chkrootkit (checks of this box)', 'radare2, sqlite3, sqlite-web, jq'],
        size: 'about 600 MB', time: 'about 3 to 6 minutes',
        command: () => ['node', [path.resolve(here, '..', '..', 'bin', 'lab'), 'setup']],
        ready: async () => false,                 // never assumed: only added from the Apps tab
        hasData: () => { try { return fs.readdirSync(path.join(config.root, 'Lab')).length > 0; } catch { return false; } },
    },
];

const jobs = new Map();   // id → { running, started, code, finished }
const logFile = id => path.join(logDir, `${id}.log`);

async function stateOf(app) {
    const s = load()[app.id] || {}; const job = jobs.get(app.id) || null;
    let added = s.added;
    if (added === undefined) { added = app.hasData() || (await app.ready().catch(() => false)); if (added) { const all = load(); all[app.id] = { added: true, at: Date.now(), how: 'already on this box' }; save(all); } }
    return { id: app.id, title: app.title, icon: app.icon, blurb: app.blurb, installs: app.installs, size: app.size, time: app.time, added: !!added, installing: !!job?.running, lastJob: job ? { started: job.started, finished: job.finished || null, code: job.code ?? null } : (s.lastJob || null) };
}
export async function list() { return Promise.all(CATALOG.map(stateOf)); }
export async function isAdded(id) { const app = CATALOG.find(a => a.id === id); return app ? (await stateOf(app)).added : false; }
export function logTail(id, bytes = 6000) { try { const t = fs.readFileSync(logFile(id), 'utf8'); return t.slice(-bytes); } catch { return ''; } }

// Install the app's tools (in the background, its output to state/apps/<id>.log), then mark it added.
export async function add(id) {
    const app = CATALOG.find(a => a.id === id); if (!app) throw httpError(404, 'No such app.');
    if (jobs.get(id)?.running) throw httpError(409, `${app.title} is already being added.`);
    if (process.getuid?.() !== 0) throw httpError(412, 'Adding an app installs system packages, which needs PlatOpypus to run as root.');
    fs.mkdirSync(logDir, { recursive: true }); const out = fs.openSync(logFile(id), 'w');
    const [cmd, args] = app.command();
    const job = { running: true, started: Date.now() }; jobs.set(id, job);
    const child = spawn(cmd, args, { stdio: ['ignore', out, out], env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } });
    record('activity', 'app-add', { actor: 'phone', what: `${app.title}: installing its tools` });
    child.on('close', code => {
        fs.closeSync(out); job.running = false; job.code = code; job.finished = Date.now();
        const all = load(); all[id] = { ...(all[id] || {}), lastJob: { started: job.started, finished: job.finished, code } };
        if (code === 0) { all[id].added = true; all[id].at = Date.now(); all[id].how = 'added from the Apps tab'; }
        save(all); log('apps', `${id}: install ${code === 0 ? 'done' : `failed (${code})`}`);
        record('activity', code === 0 ? 'app-added' : 'app-add-failed', { actor: 'phone', what: `${app.title}${code === 0 ? '' : `: install stopped with code ${code}`}` });
    });
    child.on('error', e => { job.running = false; job.code = -1; job.finished = Date.now(); fs.appendFileSync(logFile(id), `\n${e.message}\n`); });
    return stateOf(app);
}
export async function remove(id) {
    const app = CATALOG.find(a => a.id === id); if (!app) throw httpError(404, 'No such app.');
    if (jobs.get(id)?.running) throw httpError(409, 'Wait for it to finish being added.');
    const all = load(); all[id] = { ...(all[id] || {}), added: false, removedAt: Date.now() }; save(all);
    record('activity', 'app-removed', { actor: 'phone', what: `${app.title}: hidden (its data and packages are kept)` });
    return stateOf(app);
}
