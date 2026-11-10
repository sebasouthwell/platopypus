// Security Lab: test your own domains, services and applications, wherever they are hosted.
//
// An engagement is a folder /Lab/<name>/ with a scope (the targets you may test), runs (each tool run: the command,
// its full output and a short summary), findings and evidence. Every run, from the app or from an agent, goes through
// here: the tool must be on the list, every target in its arguments must be in scope, and it runs in the run's own
// folder. The scanning tools themselves are root-only on the box (the add-on makes them so), so an agent shell cannot
// run them except through `lab run`, which asks this file.
//
// In scope: a domain you verified with a DNS TXT record (or declared you are authorised to test) and its subdomains;
// an IP or range you declared; an IP that one of your verified domains resolves to.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { record } from './audit.js';
import * as agentUser from './agentuser.js';

export const ROOT = path.join(config.root, 'Lab');
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); };
const exists = f => { try { fs.accessSync(f); return true; } catch { return false; } };
const share = f => { const a = agentUser.info(); try { if (a && process.getuid?.() === 0) fs.chownSync(f, 0, a.gid); fs.chmodSync(f, fs.statSync(f).isDirectory() ? 0o2775 : 0o664); } catch { /* best effort */ } };

export function enginePath(slug) {
    if (!SLUG.test(String(slug))) throw httpError(400, 'Bad engagement name.');
    const p = path.join(ROOT, slug); if (!exists(path.join(p, '.platopypus', 'lab.json'))) throw httpError(404, 'No such engagement.'); return p;
}
export function engagementOf(dir) {
    const rel = path.relative(ROOT, path.resolve(String(dir || ''))); if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const slug = rel.split(path.sep)[0]; return SLUG.test(slug) && exists(path.join(ROOT, slug, '.platopypus', 'lab.json')) ? slug : null;
}

// ---------- engagements ----------
export function create({ title }) {
    const t = String(title || '').trim(); if (t.length < 3 || t.length > 100) throw httpError(400, 'Give the engagement a name (3 to 100 characters).');
    const base = t.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 44) || `lab-${Date.now().toString(36)}`;
    let slug = base; for (let i = 2; exists(path.join(ROOT, slug)); i++) slug = `${base.slice(0, 40)}-${i}`;
    const dir = path.join(ROOT, slug);
    for (const d of ['runs', 'evidence', 'reports', '.platopypus']) fs.mkdirSync(path.join(dir, d), { recursive: true });
    writeJson(path.join(dir, '.platopypus', 'lab.json'), { title: t, created: Date.now() });
    writeJson(path.join(dir, '.platopypus', 'scope.json'), { targets: [] });
    fs.writeFileSync(path.join(dir, 'findings.md'), `# Findings: ${t}\n\n`);
    let brief = ''; try { brief = fs.readFileSync(path.resolve(here, '..', '..', 'deploy', 'lab', 'brief.md'), 'utf8'); } catch { brief = '# Security Lab session\n\nUse `lab run`; only targets in scope.\n'; }
    fs.writeFileSync(path.join(dir, '.platopypus', 'lab.md'), brief);
    agentUser.prepareFolder(dir).catch(() => {});
    record('activity', 'lab-new', { actor: 'phone', what: `${t} (/Lab/${slug})`, cwd: dir });
    return summary(slug);
}
function summary(slug) {
    const dir = path.join(ROOT, slug); const meta = readJson(path.join(dir, '.platopypus', 'lab.json'), {}); const sc = readJson(path.join(dir, '.platopypus', 'scope.json'), { targets: [] });
    let runs = 0; try { runs = fs.readdirSync(path.join(dir, 'runs')).length; } catch { /* none */ }
    return { slug, title: meta.title || slug, created: meta.created || 0, targets: sc.targets.length, verified: sc.targets.filter(x => x.status !== 'unverified').length, runs };
}
export function list() {
    let names = []; try { names = fs.readdirSync(ROOT).filter(n => SLUG.test(n) && exists(path.join(ROOT, n, '.platopypus', 'lab.json'))); } catch { /* none yet */ }
    return names.map(summary).sort((a, b) => b.created - a.created);
}
export function detail(slug) {
    const dir = enginePath(slug);
    let findings = ''; try { findings = fs.readFileSync(path.join(dir, 'findings.md'), 'utf8').slice(0, 60000); } catch { /* none */ }
    return { ...summary(slug), scope: scope(slug), runs: runs(slug), findings };
}
export function setFindings(slug, text) { const dir = enginePath(slug); fs.writeFileSync(path.join(dir, 'findings.md'), String(text || '').slice(0, 200000)); return { ok: true }; }
export function remove(slug, confirm) {
    const dir = enginePath(slug); const meta = readJson(path.join(dir, '.platopypus', 'lab.json'), {});
    if (String(confirm || '').trim() !== (meta.title || slug)) throw httpError(400, 'Type the engagement\'s name exactly to delete it.');
    const dest = path.join(config.state, 'trash', `${new Date().toISOString().replace(/[:.]/g, '-')}__Lab-${slug}`); fs.mkdirSync(path.dirname(dest), { recursive: true });
    try { fs.renameSync(dir, dest); } catch (e) { if (e.code !== 'EXDEV') throw e; fs.cpSync(dir, dest, { recursive: true }); fs.rmSync(dir, { recursive: true, force: true }); }
    record('activity', 'lab-delete', { actor: 'phone', what: `${meta.title || slug} → trash`, cwd: dest }); return { ok: true };
}

// ---------- scope ----------
const DOMAIN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
function normalise(v) {
    let s = String(v || '').trim().toLowerCase();
    if (/^https?:\/\//.test(s)) { try { s = new URL(s).hostname; } catch { /* keep */ } }
    s = s.replace(/^\*\./, '').replace(/\.$/, '');
    if (net.isIP(s)) return { value: s, kind: 'ip' };
    const c = s.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/); if (c && net.isIPv4(c[1]) && +c[2] >= 16 && +c[2] <= 32) return { value: s, kind: 'range' };
    if (DOMAIN.test(s)) return { value: s, kind: 'domain' };
    throw httpError(400, 'A target is a domain (example.com), an IP address, or an IPv4 range no wider than /16.');
}
const scopeFile = slug => path.join(enginePath(slug), '.platopypus', 'scope.json');
const tokenFor = (slug, value) => crypto.createHash('sha256').update(`${slug}:${value}:${fs.readFileSync(path.join(ROOT, slug, '.platopypus', 'lab.json'), 'utf8')}`).digest('hex').slice(0, 20);
export function scope(slug) { const s = readJson(scopeFile(slug), { targets: [] }); return s.targets.map(t => ({ ...t, record: t.kind === 'domain' ? `platopypus-verify=${tokenFor(slug, t.value)}` : null })); }
export function addTarget(slug, { value, authorised = false, note = '' }) {
    const t = normalise(value); const f = scopeFile(slug); const s = readJson(f, { targets: [] });
    if (s.targets.some(x => x.value === t.value)) throw httpError(409, `${t.value} is already in scope.`);
    if (t.kind !== 'domain' && !authorised) throw httpError(400, 'For an IP or a range, confirm you own it or are authorised to test it.');
    s.targets.push({ ...t, status: authorised ? 'declared' : 'unverified', added: Date.now(), note: String(note).slice(0, 200) }); writeJson(f, s);
    record('activity', 'lab-scope-add', { actor: 'phone', what: `${slug}: ${t.value} (${authorised ? 'declared authorised' : 'to verify'})` });
    return scope(slug);
}
export function removeTarget(slug, value) { const f = scopeFile(slug); const s = readJson(f, { targets: [] }); s.targets = s.targets.filter(x => x.value !== String(value).toLowerCase()); writeJson(f, s); return scope(slug); }
// Look for platopypus-verify=<code> in TXT records of the domain or of _platopypus.<domain>.
export async function verify(slug, value) {
    const f = scopeFile(slug); const s = readJson(f, { targets: [] }); const t = s.targets.find(x => x.value === String(value).toLowerCase());
    if (!t || t.kind !== 'domain') throw httpError(404, 'No such domain in scope.');
    const want = `platopypus-verify=${tokenFor(slug, t.value)}`; let found = false;
    for (const name of [t.value, `_platopypus.${t.value}`]) { try { const recs = await dns.resolveTxt(name); if (recs.some(r => r.join('') === want)) found = true; } catch { /* no record */ } }
    if (found) { t.status = 'verified'; t.verified = Date.now(); writeJson(f, s); record('activity', 'lab-scope-verified', { actor: 'phone', what: `${slug}: ${t.value}` }); }
    return { verified: found, record: want, scope: scope(slug) };
}
const ipToInt = ip => ip.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0;
const inRange = (ip, range) => { const [base, bits] = range.split('/'); const mask = bits === '0' ? 0 : (~0 << (32 - Number(bits))) >>> 0; return net.isIPv4(ip) && (ipToInt(ip) & mask) === (ipToInt(base) & mask); };
// Is this host (a name, an IP, or a URL) in scope?
export async function inScope(slug, target) {
    let h = String(target || '').trim().toLowerCase(); if (/^https?:\/\//.test(h)) { try { h = new URL(h).hostname.replace(/^\[|\]$/g, ''); } catch { return false; } }
    h = h.replace(/:\d+$/, '').replace(/\.$/, '');
    const ok = readJson(scopeFile(slug), { targets: [] }).targets.filter(x => x.status !== 'unverified');
    if (net.isIP(h)) {
        if (ok.some(x => (x.kind === 'ip' && x.value === h) || (x.kind === 'range' && inRange(h, x.value)))) return true;
        for (const d of ok.filter(x => x.kind === 'domain')) { for (const fam of ['resolve4', 'resolve6']) { try { if ((await dns[fam](d.value)).includes(h)) return true; } catch { /* none */ } } }
        return false;
    }
    return ok.some(x => x.kind === 'domain' && (h === x.value || h.endsWith(`.${x.value}`)));
}

// ---------- tools and runs ----------
// Each tool: the program, and how a preset builds its arguments for one target. `free` tools take your own arguments
// (checked: no file paths, every host-like argument in scope). `local` tools look at this box, not at a target.
export const TOOLS = {
    nmap: { bin: 'nmap', title: 'Port scan (nmap)', presets: { quick: t => ['-Pn', '-T4', '--top-ports', '100', '-sV', '--version-light', '-oX', 'scan.xml', t], full: t => ['-Pn', '-T4', '-p-', '-sV', '-oX', 'scan.xml', t] }, free: true },
    testssl: { bin: 'testssl', alt: 'testssl.sh', title: 'TLS check (testssl.sh)', presets: { default: t => ['--quiet', '--color', '0', '--warnings', 'off', '--jsonfile', 'testssl.json', t] }, free: true },
    sslscan: { bin: 'sslscan', title: 'TLS ciphers (sslscan)', presets: { default: t => ['--no-colour', t] }, free: true },
    whatweb: { bin: 'whatweb', title: 'Web technologies (whatweb)', presets: { default: t => ['--color=never', '-a', '1', '--log-json=whatweb.json', t] }, free: true },
    nikto: { bin: 'nikto', title: 'Web server scan (nikto)', presets: { default: t => ['-h', t, '-nointeractive', '-maxtime', '900s', '-Tuning', 'x6'] }, free: true, minutes: 20 },
    dig: { bin: 'dig', title: 'DNS records (dig)', presets: { default: t => ['+noall', '+answer', t, 'ANY', t, 'A', t, 'AAAA', t, 'MX', t, 'NS', t, 'TXT', t, 'CAA'] }, free: true },
    dnsrecon: { bin: 'dnsrecon', title: 'DNS enumeration (dnsrecon)', presets: { default: t => ['-d', t, '-t', 'std', '-j', 'dnsrecon.json'] }, free: true },
    dnstwist: { bin: 'dnstwist', title: 'Lookalike domains (dnstwist)', presets: { default: t => ['--registered', '--format', 'json', t] }, free: true },
    whois: { bin: 'whois', title: 'Registration (whois)', presets: { default: t => [t] }, free: true },
    mtr: { bin: 'mtr', title: 'Route (mtr)', presets: { default: t => ['-r', '-w', '-c', '5', t] }, free: true },
    traceroute: { bin: 'traceroute', title: 'Route (traceroute)', presets: { default: t => [t] }, free: true },
    lynis: { bin: 'lynis', title: 'This box: security audit (lynis)', presets: { default: () => ['audit', 'system', '--quick', '--no-colors'] }, local: true, minutes: 15 },
    rkhunter: { bin: 'rkhunter', title: 'This box: rootkit check (rkhunter)', presets: { default: () => ['--check', '--sk', '--nocolors', '--rwo'] }, local: true },
    chkrootkit: { bin: 'chkrootkit', title: 'This box: rootkit check (chkrootkit)', presets: { default: () => ['-q'] }, local: true },
    sqlmap: { bin: 'sqlmap', title: 'SQL injection scanner (sqlmap)', presets: { default: t => ['--batch', '--risk=3', '--level=5', '-u', t] }, free: true },
    nuclei: { bin: 'nuclei', title: 'Vulnerability scanner (nuclei)', presets: { default: t => ['-u', t, '-timeout', '10s', '-c', '10'] }, free: true },
    burpsuite: { bin: 'burpsuite', title: 'Web proxy (burpsuite)', presets: { default: () => [] }, local: true },
    metasploit: { bin: 'msfconsole', title: 'Exploitation framework (metasploit)', presets: { default: () => ['-r', 'exploit.rb'] }, local: true },
    ffuf: { bin: 'ffuf', title: 'Fuzzing tool (ffuf)', presets: { default: t => ['-u', t, '-w', 'wordlist.txt'] }, free: true },
    feroxbuster: { bin: 'feroxbuster', title: 'Web scanner (feroxbuster)', presets: { default: t => ['-u', t, '--quiet'] }, free: true },
    netexec: { bin: 'netexec', title: 'Network execution tool (netexec)', presets: { default: t => ['--target', t] }, free: true },
    impacket: { bin: 'impacket', title: 'Python-based network tools (impacket)', presets: { default: () => [] }, local: true },
    bloodhound: { bin: 'bloodhound', title: 'Active Directory analysis (bloodhound)', presets: { default: () => [] }, local: true },
    certipy: { bin: 'certipy', title: 'Certificate manipulation tool (certipy)', presets: { default: () => [] }, free: true },
    bettercap: { bin: 'bettercap', title: 'Network capture and manipulation (bettercap)', presets: { default: () => [] }, local: true },
    aircrack: { bin: 'aircrack-ng', title: 'WiFi security auditing (aircrack-ng)', presets: { default: () => [] }, free: true },
    hashcat: { bin: 'hashcat', title: 'Password cracking tool (hashcat)', presets: { default: () => [] }, local: true },
    john: { bin: 'john', title: 'Password cracker (john)', presets: { default: () => [] }, local: true },
};
const runsDir = slug => path.join(enginePath(slug), 'runs');
export function runs(slug) {
    let ids = []; try { ids = fs.readdirSync(runsDir(slug)).filter(n => /^r\d{3,5}$/.test(n)); } catch { /* none */ }
    return ids.map(id => readJson(path.join(runsDir(slug), id, 'run.json'))).filter(Boolean).sort((a, b) => b.started - a.started).slice(0, 200);
}
export function getRun(slug, id) {
    if (!/^r\d{3,5}$/.test(String(id))) throw httpError(400, 'Bad run id.'); const d = path.join(runsDir(slug), id); const r = readJson(path.join(d, 'run.json')); if (!r) throw httpError(404, 'No such run.');
    let out = ''; try { out = fs.readFileSync(path.join(d, 'out.txt'), 'utf8'); } catch { /* none */ }
    let sum = ''; try { sum = fs.readFileSync(path.join(d, 'summary.md'), 'utf8'); } catch { /* none */ }
    return { ...r, output: out.slice(-200000), summary: sum, files: fs.readdirSync(d).filter(f => !['run.json', 'out.txt', 'summary.md'].includes(f)) };
}
// A file name the run writes in its folder (scan.xml, testssl.json) is not a host.
const FILEISH = /\.(xml|json|txt|csv|html?|log|pcapng|pcap|gnmap|nmap|md)$/i;
const HOSTLIKE = a => /^https?:\/\//i.test(a) || net.isIP(a) || /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(a) || (!FILEISH.test(a) && /^([a-z0-9-]+\.)+[a-z]{2,63}(:\d+)?$/i.test(a));
async function checkArgs(slug, tool, args) {
    if (args.length > 60) throw httpError(400, 'Too many arguments.');
    for (const a of args) {
        const s = String(a); if (s.length > 400 || /[\u0000-\u001f]/.test(s)) throw httpError(400, 'An argument is not allowed.');
        // no file paths: output stays in the run's folder, nothing is read from or written to the rest of the box
        if (s.includes('/') && !/^https?:\/\//i.test(s) && !/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(s)) throw httpError(400, `File paths are not allowed in a run (${s.slice(0, 60)}). Outputs are kept in the run's folder.`);
        if (s.startsWith('..')) throw httpError(400, 'An argument is not allowed.');
        if (HOSTLIKE(s) && !TOOLS[tool].local && !(await inScope(slug, s))) throw httpError(403, `${s} is not in this engagement's scope. Add it (and verify it) on the Scope page first.`);
    }
}
let busy = 0;
export async function run(slug, { tool, preset = null, target = null, args = null, by = 'phone' }) {
    const T = TOOLS[tool]; if (!T) throw httpError(400, `Unknown tool. Tools: ${Object.keys(TOOLS).join(', ')}.`);
    const dir = enginePath(slug);
    let argv;
    if (args) { if (!T.free && !T.local) throw httpError(400, 'That tool only runs its preset.'); argv = args.map(String); }
    else { const p = T.presets[preset || Object.keys(T.presets)[0]]; if (!p) throw httpError(400, 'Unknown preset.'); if (!T.local && !target) throw httpError(400, 'Choose a target.'); argv = p(target ? String(target).trim() : ''); }
    await checkArgs(slug, tool, argv);
    if (!T.local && !argv.some(HOSTLIKE)) throw httpError(400, 'A run needs a target from the scope.');
    if (busy >= 3) throw httpError(429, 'Three runs are going already. Wait for one to finish.');
    const ids = fs.readdirSync(path.join(dir, 'runs')).filter(n => /^r\d+$/.test(n)).map(n => +n.slice(1)); const id = `r${String((ids.length ? Math.max(...ids) : 0) + 1).padStart(3, '0')}`;
    const rd = path.join(dir, 'runs', id); fs.mkdirSync(rd, { recursive: true });
    const bin = T.alt && !(await which(T.bin)) ? T.alt : T.bin;
    const meta = { id, tool, title: T.title, preset, target, args: argv, cmd: [bin, ...argv].join(' '), by, started: Date.now(), status: 'running' };
    writeJson(path.join(rd, 'run.json'), meta); share(rd);
    record('activity', 'lab-run', { actor: by, what: `${slug}: ${meta.cmd.slice(0, 300)}`, cwd: dir });
    const out = fs.openSync(path.join(rd, 'out.txt'), 'w'); busy++;
    const child = spawn(bin, argv, { cwd: rd, stdio: ['ignore', out, out], env: { ...process.env, PATH: `${process.env.PATH || ''}:/usr/local/sbin:/usr/sbin:/sbin`, TERM: 'dumb', NO_COLOR: '1' } });
    const limit = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } }, (T.minutes || 10) * 60_000);
    const finish = code => {
        clearTimeout(limit); try { fs.closeSync(out); } catch { /* closed */ } busy = Math.max(0, busy - 1);
        meta.status = code === 0 ? 'done' : 'failed'; meta.code = code; meta.finished = Date.now();
        try { meta.headline = summarise(tool, rd); } catch (e) { meta.headline = `(no summary: ${e.message})`; }
        writeJson(path.join(rd, 'run.json'), meta); for (const f of fs.readdirSync(rd)) share(path.join(rd, f));
    };
    child.on('close', finish); child.on('error', e => { fs.appendFileSync(path.join(rd, 'out.txt'), `\n${e.message}\n`); finish(-1); });
    return meta;
}
async function which(b) { return new Promise(ok => { const c = spawn('which', [b]); c.on('close', code => ok(code === 0)); c.on('error', () => ok(false)); }); }

// ---------- summaries: the few lines worth reading, written next to the full output ----------
function summarise(tool, rd) {
    const out = (() => { try { return fs.readFileSync(path.join(rd, 'out.txt'), 'utf8'); } catch { return ''; } })();
    const file = n => { try { return fs.readFileSync(path.join(rd, n), 'utf8'); } catch { return ''; } };
    let lines = [], head = '';
    if (tool === 'nmap') {
        const x = file('scan.xml'); const hosts = x.split('<host ').slice(1);
        for (const h of hosts) {
            const addr = (h.match(/<address addr="([^"]+)"/) || [])[1]; const name = (h.match(/<hostname name="([^"]+)"/) || [])[1];
            const ports = [...h.matchAll(/<port protocol="(\w+)" portid="(\d+)"><state state="(open)"[^>]*\/>(?:<service name="([^"]*)"(?: product="([^"]*)")?(?: version="([^"]*)")?)?/g)].map(m => `${m[2]}/${m[1]} ${m[4] || ''} ${[m[5], m[6]].filter(Boolean).join(' ')}`.trim());
            lines.push(`**${name || addr}** (${addr}): ${ports.length ? ports.length + ' open' : 'no open ports found'}`, ...ports.map(p => `- ${p}`));
        }
        head = hosts.length ? lines[0].replace(/\*\*/g, '') : 'No hosts answered.';
    } else if (tool === 'testssl') {
        let j = []; try { j = JSON.parse(file('testssl.json') || '[]'); } catch { /* none */ }
        const bad = j.filter(f => ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(f.severity));
        const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }; bad.sort((a, b) => order[a.severity] - order[b.severity]);
        lines = bad.slice(0, 40).map(f => `- **${f.severity}** ${f.id}: ${String(f.finding).slice(0, 200)}`);
        const c = s => bad.filter(f => f.severity === s).length; head = bad.length ? `${c('CRITICAL')} critical, ${c('HIGH')} high, ${c('MEDIUM')} medium, ${c('LOW')} low` : 'No TLS problems reported.';
    } else if (tool === 'whatweb') {
        let j = []; try { j = file('whatweb.json').trim().split('\n').filter(Boolean).flatMap(l => { try { const v = JSON.parse(l); return Array.isArray(v) ? v : [v]; } catch { return []; } }); } catch { /* none */ }
        for (const r of j) { const plug = Object.entries(r.plugins || {}).map(([k, v]) => `${k}${v.version ? ` ${[].concat(v.version).join(',')}` : ''}`); lines.push(`**${r.target}** (${r.http_status}): ${plug.join(', ')}`); }
        head = lines.length ? `${j.length} page${j.length === 1 ? '' : 's'}, ${Object.keys(j[0]?.plugins || {}).length} technologies` : 'Nothing identified.';
    } else if (tool === 'dnstwist') {
        let j = []; try { j = JSON.parse(out); } catch { /* none */ }
        const reg = j.filter(d => d.fuzzer !== '*original'); lines = reg.slice(0, 60).map(d => `- ${d.domain} (${d.fuzzer})${d.dns_a ? ` → ${[].concat(d.dns_a).join(', ')}` : ''}${d.dns_mx ? ' · has mail' : ''}`);
        head = `${reg.length} registered lookalike domain${reg.length === 1 ? '' : 's'}`;
    } else if (tool === 'sslscan') {
        lines = out.split('\n').filter(l => /(SSLv[23]|TLSv1\.0|TLSv1\.1)\s+enabled|Preferred|Heartbleed|Subject:|Altnames:|Not valid after|weak|insecure/i.test(l)).map(l => `- ${l.trim()}`).slice(0, 40);
        const old = out.split('\n').filter(l => /(SSLv[23]|TLSv1\.[01])\s+enabled/i.test(l)).length; head = old ? `${old} old protocol${old === 1 ? '' : 's'} enabled` : 'No old protocols enabled.';
    } else if (tool === 'lynis') {
        const idx = (out.match(/Hardening index\s*:\s*(\d+)/) || [])[1]; const warn = out.split('\n').filter(l => /^\s*!|\bWarning\b/.test(l));
        lines = [`Hardening index: ${idx || '?'}`, ...warn.slice(0, 30).map(l => `- ${l.trim()}`)]; head = `Hardening index ${idx || '?'}, ${warn.length} warning${warn.length === 1 ? '' : 's'}`;
    } else {
        const all = out.split('\n').filter(l => l.trim()); lines = all.slice(-40); head = all.length ? `${all.length} line${all.length === 1 ? '' : 's'} of output` : 'No output.';
    }
    fs.writeFileSync(path.join(rd, 'summary.md'), `# ${TOOLS[tool].title}\n\n${head}\n\n${lines.join('\n')}\n`);
    return head;
}
