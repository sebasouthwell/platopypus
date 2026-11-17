// Conspiracy: rabbit-hole investigations into how things really work, for research and journalism.
//
// A case is a folder /Cases/<name>/ around one big question ("Is this minister tied to the firms that won the
// contracts?", "Who is behind this token?", "Why did this deal happen?"). It holds a pinboard (board.json): cards for
// people in public roles, organisations, public bodies, assets, wallets, money flows, deals, documents, events and
// addresses, joined by strings. Every card and string can cite sources, and every string says how well it is
// supported: documented, reported or alleged. There are also open questions, notes, and probes.
//
// A probe is a zero-trust sub-agent: it is asked one question about one subject and sees nothing else (no case, no
// board, no folder), with web search and nothing more, once (consult.zeroTrust). The orchestrating agent, or you, pins
// what it brings back.
//
// Addresses: only from public records (company registers, filings, declarations, court records). They connect things,
// for example companies registered at a public figure's home. A residential address is masked on the board and left out
// of exports; it is never something to go looking for on its own.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { record } from './audit.js';
import * as agentUser from './agentuser.js';
import * as consult from './consult.js';
import * as prompts from './prompts.js';

export const ROOT = path.join(config.root, 'Cases');
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(v, null, 2)); fs.renameSync(t, f); share(f); };
const exists = f => { try { fs.accessSync(f); return true; } catch { return false; } };
const share = f => { const a = agentUser.info(); try { if (a && process.getuid?.() === 0) fs.chownSync(f, 0, a.gid); fs.chmodSync(f, fs.statSync(f).isDirectory() ? 0o2775 : 0o664); } catch { /* best effort */ } };
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const id6 = () => crypto.randomBytes(3).toString('hex');

export const KINDS = { people: 'Power and influence', markets: 'Markets and deals', crypto: 'On-chain trail', general: 'Open question' };
export const NODE_TYPES = {
    person: 'Person (public role)', org: 'Company or organisation', gov: 'Public body', asset: 'Stock, fund or asset', wallet: 'Wallet or account',
    money: 'Payment or transaction', deal: 'Deal or contract', document: 'Document or filing', event: 'Event or meeting', address: 'Address (from public records)', claim: 'Claim to test',
};
export const STRENGTH = ['documented', 'reported', 'alleged'];
const NODE_STATUS = ['lead', 'confirmed', 'disputed', 'dead-end'];
const LIMITS = { nodes: 600, links: 2000, sources: 3000, questions: 400, theories: 30 };
export const RELIABILITY = ['primary', 'reputable', 'other'];   // an official record or filing; established reporting; anything else
const DATE = v => { const t = clip(v, 40); return /^\d{4}(-\d{2}(-\d{2})?)?$/.test(t) ? t : ''; };
const AMOUNT = v => { if (v === undefined || v === null || v === '') return null; const n = Number(String(v).replace(/[, _]/g, '')); return Number.isFinite(n) ? n : null; };

export function casePath(slug) {
    if (!SLUG.test(String(slug))) throw httpError(400, 'Bad case name.');
    const p = path.join(ROOT, slug); if (!exists(path.join(p, '.platopypus', 'case.json'))) throw httpError(404, 'No such case.'); return p;
}
export function caseOf(dir) {
    const rel = path.relative(ROOT, path.resolve(String(dir || ''))); if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const slug = rel.split(path.sep)[0]; return SLUG.test(slug) && exists(path.join(ROOT, slug, '.platopypus', 'case.json')) ? slug : null;
}
const boardFile = slug => path.join(casePath(slug), 'board.json');
const emptyBoard = () => ({ nodes: [], links: [], sources: [], questions: [], theories: [] });
function board(slug) { const b = readJson(boardFile(slug), null) || emptyBoard(); for (const k of ['nodes', 'links', 'sources', 'questions', 'theories']) if (!Array.isArray(b[k])) b[k] = []; return b; }

// ---------- cases ----------
export function create({ title, question = '', kind = 'general' }) {
    const t = clip(title, 100); if (t.length < 3) throw httpError(400, 'Give the case a name (3 to 100 characters).');
    const q = clip(question, 600); if (!KINDS[kind]) kind = 'general';
    fs.mkdirSync(ROOT, { recursive: true });
    const base = t.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 44) || `case-${Date.now().toString(36)}`;
    let slug = base; for (let i = 2; exists(path.join(ROOT, slug)); i++) slug = `${base.slice(0, 40)}-${i}`;
    const dir = path.join(ROOT, slug);
    for (const d of ['probes', 'files', '.platopypus']) fs.mkdirSync(path.join(dir, d), { recursive: true });
    writeJson(path.join(dir, '.platopypus', 'case.json'), { title: t, question: q, kind, created: Date.now(), depth: 3, budget: 40 });
    writeJson(path.join(dir, 'board.json'), emptyBoard());
    fs.writeFileSync(path.join(dir, 'notes.md'), `# ${t}\n\n${q ? `**The question:** ${q}\n\n` : ''}## What the evidence shows\n\n## What is still open\n\n`);
    let brief = prompts.text('case-brief') || '# Conspiracy case\n\nUse `sleuth`; cite every claim.\n';
    fs.writeFileSync(path.join(dir, '.platopypus', 'case.md'), `${brief.trim()}\n\n## This case\n\n- Name: ${t}\n- Kind: ${KINDS[kind]}\n- The question: ${q || '(not set yet; ask the user)'}\n`);
    for (const f of [dir, path.join(dir, 'probes'), path.join(dir, 'files'), path.join(dir, 'notes.md')]) share(f);
    agentUser.prepareFolder(dir).catch(() => {});
    record('activity', 'case-new', { actor: 'phone', what: `${t} (/Cases/${slug})`, cwd: dir });
    logEvent(slug, { kind: 'case', by: 'phone', what: `Case opened: ${q || t}` });
    return summary(slug);
}
function summary(slug) {
    const dir = path.join(ROOT, slug); const meta = readJson(path.join(dir, '.platopypus', 'case.json'), {}); const b = readJson(path.join(dir, 'board.json'), emptyBoard()) || emptyBoard();
    let probes = 0; try { probes = fs.readdirSync(path.join(dir, 'probes')).filter(f => f.endsWith('.json')).length; } catch { /* none */ }
    return { slug, title: meta.title || slug, question: meta.question || '', kind: meta.kind || 'general', created: meta.created || 0, depth: meta.depth ?? 3, budget: meta.budget ?? 40, probeAgent: meta.probeAgent || 'claude', probeModel: meta.probeModel || '', askAgent: meta.askAgent || '', askModel: meta.askModel || '',
        nodes: (b.nodes || []).length, links: (b.links || []).length, sources: (b.sources || []).length, open: (b.questions || []).filter(q => q.status !== 'answered').length, probes };
}
export function list() {
    let names = []; try { names = fs.readdirSync(ROOT).filter(n => SLUG.test(n) && exists(path.join(ROOT, n, '.platopypus', 'case.json'))); } catch { /* none yet */ }
    return names.map(summary).sort((a, b) => b.created - a.created);
}
export function detail(slug) {
    const dir = casePath(slug); let notes = ''; try { notes = fs.readFileSync(path.join(dir, 'notes.md'), 'utf8').slice(0, 200000); } catch { /* none */ }
    const bd = board(slug);
    return { ...summary(slug), board: bd, depths: depths(bd), notes, probes: probes(slug), asks: asks(slug), types: NODE_TYPES, kinds: KINDS };
}
const AGENTS = ['claude', 'codex', 'antigravity', 'cline'];
const MODEL_OK = /^[A-Za-z0-9][A-Za-z0-9._:\/\[\]@-]{0,99}$/;
const cleanModel = m => { const v = String(m || '').trim(); if (v && !MODEL_OK.test(v)) throw httpError(400, 'That model name is not valid.'); return v; };
export function setMeta(slug, { title, question, kind, depth, budget, probeAgent, probeModel, askAgent, askModel }) {
    const f = path.join(casePath(slug), '.platopypus', 'case.json'); const m = readJson(f, {});
    if (title !== undefined) { const t = clip(title, 100); if (t.length < 3) throw httpError(400, 'Name: 3 to 100 characters.'); m.title = t; }
    if (question !== undefined) m.question = clip(question, 600);
    if (kind !== undefined && KINDS[kind]) m.kind = kind;
    if (depth !== undefined) { const d = Math.round(+depth); if (!(d >= 1 && d <= 8)) throw httpError(400, 'Depth: 1 to 8 links from the start.'); m.depth = d; }
    if (budget !== undefined) { const v = Math.round(+budget); if (!(v >= 0 && v <= 1000)) throw httpError(400, 'Probe budget: 0 to 1000.'); m.budget = v; }
    // Which agent and model answer probes and Ask questions (any of the four; empty model = the agent's own default).
    if (probeAgent !== undefined) { if (!AGENTS.includes(probeAgent)) throw httpError(400, `Probe agent: ${AGENTS.join(', ')}.`); m.probeAgent = probeAgent; }
    if (probeModel !== undefined) m.probeModel = cleanModel(probeModel);
    if (askAgent !== undefined) { if (askAgent && !AGENTS.includes(askAgent)) throw httpError(400, `Ask agent: ${AGENTS.join(', ')} or automatic.`); m.askAgent = askAgent || ''; }
    if (askModel !== undefined) m.askModel = cleanModel(askModel);
    writeJson(f, m); return summary(slug);
}
export function setNotes(slug, text) { const f = path.join(casePath(slug), 'notes.md'); fs.writeFileSync(f, String(text ?? '').slice(0, 400000)); share(f); return { ok: true }; }
export function remove(slug, confirm) {
    const dir = casePath(slug); const meta = readJson(path.join(dir, '.platopypus', 'case.json'), {});
    if (String(confirm || '').trim() !== (meta.title || slug)) throw httpError(400, 'Type the case\'s name exactly to delete it.');
    const dest = path.join(config.state, 'trash', `${new Date().toISOString().replace(/[:.]/g, '-')}__Cases-${slug}`); fs.mkdirSync(path.dirname(dest), { recursive: true });
    try { fs.renameSync(dir, dest); } catch (e) { if (e.code !== 'EXDEV') throw e; fs.cpSync(dir, dest, { recursive: true }); fs.rmSync(dir, { recursive: true, force: true }); }
    record('activity', 'case-delete', { actor: 'phone', what: `${meta.title || slug} → trash`, cwd: dest }); return { ok: true };
}

// ---------- the board ----------
// ---------- the log: oversight for the user, not input for agents ----------
// One line per event in /Cases/<name>/log.jsonl: what started, what finished, how long it took, who did it.
export function logEvent(slug, ev) {
    try { const f = path.join(ROOT, slug, 'log.jsonl'); fs.appendFileSync(f, JSON.stringify({ t: Date.now(), ...ev }) + '\n'); share(f); } catch { /* the case may be gone */ }
}
export function readLog(slug, { limit = 500 } = {}) {
    const f = path.join(casePath(slug), 'log.jsonl'); let lines = [];
    try { lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).slice(-limit); } catch { /* none yet */ }
    const out = []; for (const l of lines) { try { out.push(JSON.parse(l)); } catch { /* skip a torn line */ } }
    return { events: out.reverse(), agents: [...agentsOn.entries()].filter(([, a]) => a.slug === slug).map(([name, a]) => ({ name, ...a })), probesRunning: probes(slug).filter(p => p.status === 'running').map(p => ({ id: p.id, subject: p.subject, at: p.at, agent: p.agent, model: p.model })) };
}
// Agents working a case: noted when their shell starts, and logged as finished when the shell is gone.
const agentsOn = new Map();   // shell name -> { slug, label, at }
export function agentStarted(slug, name, label) { agentsOn.set(name, { slug, label, at: Date.now() }); logEvent(slug, { kind: 'agent-start', by: `shell "${name}"`, what: `${label} started on the case` }); }
export function sweepAgents(liveNames) {
    for (const [name, a] of agentsOn) if (!liveNames.has(name)) { agentsOn.delete(name); logEvent(a.slug, { kind: 'agent-end', by: `shell "${name}"`, what: `${a.label} finished`, ms: Date.now() - a.at }); }
}

// Names are matched loosely, so "Rolls-Royce Holdings plc (RR.L)" and "Rolls-Royce Holdings PLC" are one card.
const normName = t => String(t || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\b(plc|ltd|limited|inc|incorporated|llc|corp|corporation|co|the|sa|ag|gmbh|nv|bv)\b/g, ' ').replace(/\s+/g, ' ').trim();
// Words agents use for card types, mapped onto the board's types.
const TYPE_ALIASES = { company: 'org', business: 'org', firm: 'org', organisation: 'org', organization: 'org', charity: 'org', fund: 'asset', stock: 'asset', share: 'asset', shares: 'asset', ticker: 'asset', security: 'asset', token: 'asset', coin: 'asset', crypto: 'asset', government: 'gov', agency: 'gov', council: 'gov', ministry: 'gov', regulator: 'gov', department: 'gov', individual: 'person', official: 'person', politician: 'person', executive: 'person', director: 'person', address_: 'address', account: 'wallet', payment: 'money', transaction: 'money', transfer: 'money', donation: 'money', contract: 'deal', tender: 'deal', acquisition: 'deal', merger: 'deal', filing: 'document', report: 'document', doc: 'document', record: 'document', meeting: 'event', allegation: 'claim', hypothesis: 'claim' };
export const cardType = t => { const k = String(t || '').trim().toLowerCase(); return NODE_TYPES[k] ? k : TYPE_ALIASES[k] || null; };

// One writer at a time per case (agents and the phone both change it).
const locks = new Map();
async function mutate(slug, fn) {
    const prev = locks.get(slug) || Promise.resolve(); let release; const mine = new Promise(r => { release = r; }); locks.set(slug, prev.then(() => mine));
    await prev; try { const b = board(slug); const out = fn(b); writeJson(boardFile(slug), b); return out; } finally { release(); if (locks.get(slug) === mine) locks.delete(slug); }
}
const findNode = (b, ref) => {
    const r = String(ref || '').trim(); const low = r.toLowerCase(); const nn = normName(r);
    const hit = b.nodes.find(n => n.id === r) || b.nodes.find(n => n.label.toLowerCase() === low) || (nn && b.nodes.find(n => normName(n.label) === nn));
    if (hit || !nn) return hit || null;
    const starts = b.nodes.filter(n => normName(n.label).startsWith(nn) || nn.startsWith(normName(n.label)));   // a unique partial match
    return starts.length === 1 ? starts[0] : null;
};
// "documented" means a primary record says so; "reported" means reputable reporting (or better) says so.
function checkStrength(b, strength, ids) {
    if (strength === 'alleged') return;
    const rel = ids.map(id => b.sources.find(s => s.id === id)?.reliability);
    if (!ids.length) throw httpError(400, `A ${strength} string needs a source. Without one it can only be "alleged".`);
    if (strength === 'documented' && !rel.includes('primary')) throw httpError(400, `"documented" needs a primary source (an official register, filing, court record, exchange or chain data). ${ids.join(', ')} ${ids.length === 1 ? 'is' : 'are'} rated ${[...new Set(rel)].join('/')}: use --strength reported${rel.includes('reputable') ? '' : ' (with a reputable source) or alleged'}, or cite a primary source.`);
    if (strength === 'reported' && !rel.some(r => r === 'primary' || r === 'reputable')) throw httpError(400, `"reported" needs a reputable or primary source. ${ids.join(', ')} ${ids.length === 1 ? 'is' : 'are'} rated other: use --strength alleged, or cite a better source.`);
}
function sourceRefs(b, refs) {
    const list = Array.isArray(refs) ? refs : String(refs || '').split(',').map(s => s.trim()).filter(Boolean);
    const out = []; for (const r of list) { const s = b.sources.find(x => x.id === r); if (!s) throw httpError(400, `No source ${r}. Add it first (sleuth source …).`); if (!out.includes(s.id)) out.push(s.id); }
    return out;
}
const URL_OK = u => { try { const x = new URL(u); return /^https?:$/.test(x.protocol); } catch { return false; } };
// A first guess at a source's reliability from its website: official registers, filings, courts, regulators, exchanges
// and chain data are primary; established news organisations are reputable; anything else stays "other" until checked.
const PRIMARY_HOSTS = /(^|\.)(gov\.uk|gov|parliament\.uk|legislation\.gov\.uk|company-information\.service\.gov\.uk|find-and-update\.company-information\.service\.gov\.uk|sec\.gov|europa\.eu|judiciary\.uk|bailii\.org|courtlistener\.com|fca\.org\.uk|londonstockexchange\.com|investegate\.co\.uk|etherscan\.io|blockchain\.com|blockstream\.info|opencorporates\.com|electoralcommission\.org\.uk|contractsfinder\.service\.gov\.uk|find-tender\.service\.gov\.uk|ted\.europa\.eu)$/i;
const REPUTABLE_HOSTS = /(^|\.)(reuters\.com|apnews\.com|bbc\.co\.uk|bbc\.com|ft\.com|theguardian\.com|thetimes\.co\.uk|telegraph\.co\.uk|bloomberg\.com|wsj\.com|nytimes\.com|economist\.com|cnbc\.com|forbes\.com|propublica\.org|occrp\.org|icij\.org|private-eye\.co\.uk|sky\.com|channel4\.com|politico\.eu|politico\.com|independent\.co\.uk)$/i;
export function guessReliability(url) {
    let h = ''; try { h = new URL(url).hostname.replace(/^www\./, ''); } catch { return 'other'; }
    if (PRIMARY_HOSTS.test(h) || /(^|\.)investors?\.|\/investors?\/|annual-?report/i.test(url)) return 'primary';
    return REPUTABLE_HOSTS.test(h) ? 'reputable' : 'other';
}
export function addSource(slug, body, by = 'phone') {
    return mutate(slug, b => {
        if (b.sources.length >= LIMITS.sources) throw httpError(409, 'This case has the most sources it can hold.');
        const url = clip(body.url, 1000); const title = clip(body.title, 300) || url;
        if (!title) throw httpError(400, 'A source needs a title or a link.');
        if (url && !URL_OK(url)) throw httpError(400, 'A link starts with http:// or https://');
        const dupe = url && b.sources.find(s => s.url === url); if (dupe) return dupe;
        const n = b.sources.reduce((m, s) => Math.max(m, Number(String(s.id).slice(1)) || 0), 0) + 1;
        const s = { id: `S${n}`, title, url, publisher: clip(body.publisher, 120), date: clip(body.date, 40), kind: clip(body.kind, 40), reliability: RELIABILITY.includes(body.reliability) ? body.reliability : (url ? guessReliability(url) : 'other'), quote: clip(body.quote, 1200), by, at: Date.now() };
        b.sources.push(s); logEvent(slug, { kind: 'source', by, what: `Added source ${s.id}: ${title}${s.reliability !== 'other' ? ` (${s.reliability})` : ''}` }); return s;
    });
}
export function addNode(slug, body, by = 'phone') {
    return mutate(slug, b => {
        if (b.nodes.length >= LIMITS.nodes) throw httpError(409, 'The board is full.');
        const type = cardType(body.type); if (!type) throw httpError(400, `Card type: ${Object.keys(NODE_TYPES).join(', ')} (or a word like company, stock, contract).`);
        const label = clip(body.label, 120); if (label.length < 2) throw httpError(400, 'A card needs a name.');
        const same = b.nodes.find(n => n.type === type && (n.label.toLowerCase() === label.toLowerCase() || normName(n.label) === normName(label)));
        if (same) { // the same card again: add what is new to it
            if (body.note) same.note = clip(`${same.note ? same.note + ' ' : ''}${body.note}`, 2000);
            for (const s of sourceRefs(b, body.sources)) if (!same.sources.includes(s)) same.sources.push(s);
            return same;
        }
        const node = { id: `n${id6()}`, type, label, note: clip(body.note, 2000), status: NODE_STATUS.includes(body.status) ? body.status : 'lead', sources: sourceRefs(b, body.sources), by, at: Date.now() };
        if (type === 'address') node.residential = body.residential !== false && body.residential !== 'false';   // assume someone lives there unless told it is an office
        const when = DATE(body.when); if (when) node.when = when;
        if (body.origin) node.origin = true;   // where the rabbit hole starts: depth is counted from here
        logEvent(slug, { kind: 'pin', by, what: `Pinned ${NODE_TYPES[type]}: ${type === 'address' && node.residential ? '[residential address]' : label}${node.sources.length ? ` · ${node.sources.join(', ')}` : ' · no source yet'}` });
        if (Number.isFinite(+body.x) && Number.isFinite(+body.y)) { node.x = Math.round(+body.x); node.y = Math.round(+body.y); }
        b.nodes.push(node); return node;
    });
}
export function updateNode(slug, ref, body) {
    return mutate(slug, b => {
        const n = findNode(b, ref); if (!n) throw httpError(404, 'No such card.');
        if (body.label !== undefined) { const l = clip(body.label, 120); if (l.length < 2) throw httpError(400, 'A card needs a name.'); n.label = l; }
        if (body.note !== undefined) n.note = clip(body.note, 2000);
        if (body.status !== undefined) { if (!NODE_STATUS.includes(body.status)) throw httpError(400, `Status: ${NODE_STATUS.join(', ')}.`); n.status = body.status; }
        if (body.type !== undefined && NODE_TYPES[body.type]) n.type = body.type;
        if (body.residential !== undefined && n.type === 'address') n.residential = !!body.residential;
        if (body.sources !== undefined) n.sources = sourceRefs(b, body.sources);
        if (body.addSources !== undefined) for (const s of sourceRefs(b, body.addSources)) if (!n.sources.includes(s)) n.sources.push(s);
        if (body.x !== undefined && body.y !== undefined && Number.isFinite(+body.x) && Number.isFinite(+body.y)) { n.x = Math.round(+body.x); n.y = Math.round(+body.y); }
        if (body.pinned !== undefined) n.pinned = !!body.pinned;
        if (body.when !== undefined) { const w = DATE(body.when); if (w) n.when = w; else delete n.when; }
        if (body.origin !== undefined) { if (body.origin) n.origin = true; else delete n.origin; }
        return n;
    });
}
export function removeNode(slug, ref) {
    return mutate(slug, b => { const n = findNode(b, ref); if (!n) throw httpError(404, 'No such card.'); b.nodes = b.nodes.filter(x => x !== n); b.links = b.links.filter(l => l.from !== n.id && l.to !== n.id); for (const q of b.questions) if (q.node === n.id) q.node = null; return { removed: n.id }; });
}
export function addLink(slug, body, by = 'phone') {
    return mutate(slug, b => {
        if (b.links.length >= LIMITS.links) throw httpError(409, 'The board has the most strings it can hold.');
        const a = findNode(b, body.from), c = findNode(b, body.to); if (!a || !c) throw httpError(404, `No card ${!a ? body.from : body.to}.`); if (a === c) throw httpError(400, 'A string joins two different cards.');
        const label = clip(body.label, 160); if (!label) throw httpError(400, 'Say what joins them (director of, paid, owns…).');
        const strength = STRENGTH.includes(body.strength) ? body.strength : 'alleged';
        const sources = sourceRefs(b, body.sources);
        checkStrength(b, strength, sources);
        const same = b.links.find(l => l.from === a.id && l.to === c.id && l.label.toLowerCase() === label.toLowerCase());
        if (same) { for (const s of sources) if (!same.sources.includes(s)) same.sources.push(s); if (STRENGTH.indexOf(strength) < STRENGTH.indexOf(same.strength)) same.strength = strength; return same; }
        const l = { id: `l${id6()}`, from: a.id, to: c.id, label, strength, sources, note: clip(body.note, 1000), when: DATE(body.when), amount: AMOUNT(body.amount), currency: clip(body.currency, 10).toUpperCase(), by, at: Date.now() };
        const nm = n => (n.type === 'address' && n.residential ? '[residential address]' : n.label);
        logEvent(slug, { kind: 'link', by, what: `Connected ${nm(a)} → ${label} → ${nm(c)} (${strength})` });
        b.links.push(l); return l;
    });
}
export function updateLink(slug, lid, body) {
    return mutate(slug, b => {
        const l = b.links.find(x => x.id === lid); if (!l) throw httpError(404, 'No such string.');
        if (body.label !== undefined) { const v = clip(body.label, 160); if (!v) throw httpError(400, 'Say what joins them.'); l.label = v; }
        if (body.note !== undefined) l.note = clip(body.note, 1000);
        if (body.when !== undefined) l.when = DATE(body.when);
        if (body.amount !== undefined) l.amount = AMOUNT(body.amount);
        if (body.currency !== undefined) l.currency = clip(body.currency, 10).toUpperCase();
        if (body.sources !== undefined) l.sources = sourceRefs(b, body.sources);
        if (body.strength !== undefined) { if (!STRENGTH.includes(body.strength)) throw httpError(400, `Strength: ${STRENGTH.join(', ')}.`); checkStrength(b, body.strength, l.sources); l.strength = body.strength; }
        return l;
    });
}
export function removeLink(slug, lid) { return mutate(slug, b => { const n = b.links.length; b.links = b.links.filter(l => l.id !== lid); if (b.links.length === n) throw httpError(404, 'No such string.'); return { removed: lid }; }); }
export function removeSource(slug, sid) {
    return mutate(slug, b => { const n = b.sources.length; b.sources = b.sources.filter(s => s.id !== sid); if (b.sources.length === n) throw httpError(404, 'No such source.'); for (const x of [...b.nodes, ...b.links, ...b.questions]) x.sources = (x.sources || []).filter(s => s !== sid); for (const t of b.theories) delete t.evidence[sid]; for (const l of b.links) if (l.strength !== 'alleged' && !l.sources.length) l.strength = 'alleged'; return { removed: sid }; });
}
export function addQuestion(slug, body, by = 'phone') {
    return mutate(slug, b => {
        if (b.questions.length >= LIMITS.questions) throw httpError(409, 'Too many questions on this case.');
        const text = clip(body.text, 400); if (text.length < 5) throw httpError(400, 'Write the question.');
        const node = body.node ? findNode(b, body.node)?.id || null : null;
        const q = { id: `Q${b.questions.reduce((m, x) => Math.max(m, Number(String(x.id).slice(1)) || 0), 0) + 1}`, text, node, status: 'open', answer: '', by, at: Date.now() };
        logEvent(slug, { kind: 'question', by, what: `Open question ${q.id}: ${text}` });
        b.questions.push(q); return q;
    });
}
export function answerQuestion(slug, qid, body) {
    return mutate(slug, b => {
        const q = b.questions.find(x => x.id === qid); if (!q) throw httpError(404, 'No such question.');
        if (body.answer !== undefined) { q.answer = clip(body.answer, 3000); q.status = q.answer ? 'answered' : 'open'; }
        if (body.status !== undefined && ['open', 'answered', 'dropped'].includes(body.status)) q.status = body.status;
        if (body.sources !== undefined) q.sources = sourceRefs(b, body.sources);
        return q;
    });
}

// ---------- theories (competing explanations) ----------
// Each theory is weighed against the evidence: a source or a string marked as supporting it, contradicting it, or
// neither. Seeing the evidence against every theory side by side keeps a rabbit hole honest.
export function addTheory(slug, body, by = 'phone') {
    return mutate(slug, b => {
        if (b.theories.length >= LIMITS.theories) throw httpError(409, 'Too many theories on this case.');
        const text = clip(body.text, 300); if (text.length < 5) throw httpError(400, 'Write the theory.');
        const t = { id: `T${b.theories.reduce((m, x) => Math.max(m, Number(String(x.id).slice(1)) || 0), 0) + 1}`, text, evidence: {}, by, at: Date.now() };
        logEvent(slug, { kind: 'theory', by, what: `Theory ${t.id}: ${text}` });
        b.theories.push(t); return t;
    });
}
export function weigh(slug, tid, { ref, verdict, text }) {
    return mutate(slug, b => {
        const t = b.theories.find(x => x.id === tid); if (!t) throw httpError(404, 'No such theory.');
        if (text !== undefined) { const v = clip(text, 300); if (v.length < 5) throw httpError(400, 'Write the theory.'); t.text = v; }
        if (ref !== undefined) {
            if (!b.sources.some(s => s.id === ref) && !b.links.some(l => l.id === ref)) throw httpError(404, `No source or string ${ref}.`);
            if (['supports', 'contradicts', 'neutral'].includes(verdict)) t.evidence[ref] = verdict; else if (verdict === null || verdict === 'none') delete t.evidence[ref]; else throw httpError(400, 'Verdict: supports, contradicts, neutral or none.');
        }
        return t;
    });
}
export function removeTheory(slug, tid) { return mutate(slug, b => { const n = b.theories.length; b.theories = b.theories.filter(t => t.id !== tid); if (b.theories.length === n) throw httpError(404, 'No such theory.'); return { removed: tid }; }); }

// ---------- reading the board ----------
// Every chain of strings between two cards, shortest first (strings count both ways), up to `max` links long.
export function paths(slug, fromRef, toRef, { max = 6, limit = 8 } = {}) {
    const b = board(slug); const a = findNode(b, fromRef), c = findNode(b, toRef); if (!a || !c) throw httpError(404, `No card ${!a ? fromRef : toRef}.`);
    const adj = new Map(b.nodes.map(n => [n.id, []])); for (const l of b.links) { adj.get(l.from)?.push([l.to, l]); adj.get(l.to)?.push([l.from, l]); }
    const out = []; const queue = [[a.id, [], new Set([a.id])]];
    while (queue.length && out.length < limit) {
        const [at, via, seen] = queue.shift();
        if (at === c.id) { out.push(via); continue; }
        if (via.length >= max) continue;
        for (const [next, l] of adj.get(at) || []) if (!seen.has(next)) queue.push([next, [...via, l.id], new Set([...seen, next])]);
        if (queue.length > 20000) break;
    }
    return { from: a.id, to: c.id, paths: out };
}
// How many strings each card is from the starting card(s).
export function depths(b) {
    const start = b.nodes.filter(n => n.origin).map(n => n.id); const d = new Map(start.map(id => [id, 0])); const q = [...start];
    const adj = new Map(b.nodes.map(n => [n.id, []])); for (const l of b.links) { adj.get(l.from)?.push(l.to); adj.get(l.to)?.push(l.from); }
    while (q.length) { const x = q.shift(); for (const y of adj.get(x) || []) if (!d.has(y)) { d.set(y, d.get(x) + 1); q.push(y); } }
    return Object.fromEntries(d);
}

// ---------- probes: zero-trust sub-agents ----------
const probeDir = slug => path.join(casePath(slug), 'probes');
const probeRunning = new Map(); // slug → count
const probeRecent = [];
export function probes(slug) {
    try { return fs.readdirSync(probeDir(slug)).filter(f => /^p\d+\.json$/.test(f)).map(f => readJson(path.join(probeDir(slug), f))).filter(Boolean).sort((a, b) => b.at - a.at); } catch { return []; }
}
export function getProbe(slug, pid) { if (!/^p\d{1,5}$/.test(pid)) throw httpError(400, 'Bad probe.'); const p = readJson(path.join(probeDir(slug), `${pid}.json`)); if (!p) throw httpError(404, 'No such probe.'); return p; }
export async function probe(slug, { subject, question, agent = null, model = null, web = true, node = null }, by = 'phone') {
    const dir = probeDir(slug);
    const subj = clip(subject, 200), q = String(question || '').trim().slice(0, 4000);
    if (subj.length < 2) throw httpError(400, 'Say who or what the probe is about.');
    if (q.length < 8) throw httpError(400, 'Write the question for the probe.');
    const meta0 = summary(slug); agent = agent || meta0.probeAgent; model = cleanModel(model ?? meta0.probeModel);
    if (!AGENTS.includes(agent)) throw httpError(400, `Probes run on ${AGENTS.join(', ')}.`);
    if ((probeRunning.get(slug) || 0) >= 4) throw httpError(429, 'Four probes are already running on this case. Wait for one to finish.');
    const now = Date.now(); while (probeRecent.length && now - probeRecent[0] > 3600_000) probeRecent.shift(); if (probeRecent.length >= 120) throw httpError(429, '120 probes in the last hour already.');
    const meta = summary(slug); if (meta.probes >= meta.budget) throw httpError(409, `This case has used its probe budget (${meta.budget}). The user can raise it on the Briefing page.`);
    const status = await consult.available('case'); const av = status.agents.find(a => a.key === agent);
    const localCodex = agent === 'codex' && /^oss:/.test(model);   // Codex on your Ollama server needs no OpenAI sign-in
    if (!av?.installed || (!av.signedIn && !localCodex)) throw httpError(409, `${av?.title || agent} is not ${av?.installed ? 'signed in' : 'installed'} on this box, so it cannot probe.`);
    const n = probes(slug).reduce((m, p) => Math.max(m, Number(String(p.id).slice(1)) || 0), 0) + 1;
    const p = { id: `p${n}`, subject: subj, question: q, agent, model, web: consult.WEB_AGENTS.includes(agent) && web !== false, node: node || null, status: 'running', answer: '', by, at: now };
    const f = path.join(dir, `${p.id}.json`); writeJson(f, p);
    probeRecent.push(now); probeRunning.set(slug, (probeRunning.get(slug) || 0) + 1);
    record('activity', 'case-probe', { actor: by, what: `${slug}: probe ${p.id} on ${subj}${p.web ? ' (web search)' : ''}: ${q.slice(0, 160)}` });
    logEvent(slug, { kind: 'probe-start', by, what: `Probe ${p.id} started on ${subj}: ${q.slice(0, 200)}`, agent, model, web: p.web, id: p.id });
    // The probe sees the subject and the question, nothing about the case or the board.
    const asked = `Subject: ${subj}\n\nQuestion: ${q}`;
    const done = consult.zeroTrust({ target: agent, question: asked, web: p.web, title: av.title, system: prompts.text('case-probe'), model })
        .then(answer => { p.status = 'done'; p.answer = answer; })
        .catch(e => { p.status = 'failed'; p.answer = e.message; })
        .finally(() => { p.finished = Date.now(); try { if (exists(dir)) writeJson(f, p); } catch { /* case deleted */ } probeRunning.set(slug, Math.max(0, (probeRunning.get(slug) || 1) - 1));
            const links = (String(p.answer).match(/https?:\/\/[^\s)\]>"'`]+/g) || []).length;
            logEvent(slug, { kind: p.status === 'done' ? 'probe-end' : 'probe-fail', by, what: `Probe ${p.id} ${p.status === 'done' ? `finished: ${links} link${links === 1 ? '' : 's'} in its answer` : `failed: ${String(p.answer).slice(0, 160)}`}`, ms: p.finished - p.at, agent, model, id: p.id }); });
    done.catch(() => {});
    return p;
}

// ---------- Ask: questions answered from the case file only ----------
// The case file (cards, strings, sources, theories, questions, notes) goes to one agent with no tools and nothing
// else, which answers only from it, citing source and string ids, and says what the board cannot answer. Residential
// addresses are left out. Unlike a probe it sees the case, because the case is the question.
function caseFile(slug) {
    const d = detail(slug); const b = d.board; const nm = new Map(b.nodes.map(n => [n.id, n]));
    const name = n => (n ? (n.type === 'address' && n.residential ? '[residential address]' : n.label) : '?');
    const lines = [`CASE: ${d.title}`, `QUESTION: ${d.question || '(none)'}`, '', 'CARDS:'];
    for (const n of b.nodes) lines.push(`- ${n.id} [${n.type}] ${name(n)} (${n.status}${n.origin ? ', start' : ''}${n.when ? `, ${n.when}` : ''})${n.note && !(n.type === 'address' && n.residential) ? `: ${n.note}` : ''}${n.sources.length ? ` {${n.sources.join(',')}}` : ''}`);
    lines.push('', 'STRINGS:');
    for (const l of b.links) lines.push(`- ${l.id}: ${name(nm.get(l.from))} -> ${l.label} -> ${name(nm.get(l.to))} (${l.strength}${l.when ? `, ${l.when}` : ''}${l.amount !== null && l.amount !== undefined ? `, ${l.amount} ${l.currency || ''}` : ''})${l.sources.length ? ` {${l.sources.join(',')}}` : ''}`);
    lines.push('', 'SOURCES:');
    for (const s of b.sources) lines.push(`- ${s.id} (${s.reliability}) ${s.title}${s.publisher ? `, ${s.publisher}` : ''}${s.date ? `, ${s.date}` : ''}${s.quote ? ` | quote: "${s.quote}"` : ''}`);
    if (b.theories.length) { lines.push('', 'THEORIES:'); for (const t of b.theories) lines.push(`- ${t.id} ${t.text} | ${Object.entries(t.evidence).map(([k, v]) => `${k}:${v}`).join(', ') || 'not weighed'}`); }
    if (b.questions.length) { lines.push('', 'QUESTIONS:'); for (const q of b.questions) lines.push(`- ${q.id} [${q.status}] ${q.text}${q.answer ? ` | answer: ${q.answer}` : ''}`); }
    lines.push('', 'NOTES:', d.notes.slice(0, 8000));
    return lines.join('\n').slice(0, 90000);
}
const askDir = slug => path.join(casePath(slug), 'asks');
const askRunning = new Map();
export function asks(slug) {
    try { return fs.readdirSync(askDir(slug)).filter(f => /^a\d+\.json$/.test(f)).map(f => readJson(path.join(askDir(slug), f))).filter(Boolean).sort((a, b) => b.at - a.at); } catch { return []; }
}
export async function ask(slug, { question, agent = null, model = null }, by = 'phone') {
    const q = String(question || '').trim().slice(0, 2000); if (q.length < 4) throw httpError(400, 'Ask a question.');
    if ((askRunning.get(slug) || 0) >= 2) throw httpError(429, 'Two questions are already being answered on this case.');
    const st = await consult.available('case'); const ready = k => st.agents.find(a => a.key === k && a.installed && (a.signedIn || (k === 'codex' && /^oss:/.test(String(model ?? summary(slug).askModel ?? '')))));
    const meta0 = summary(slug); agent = agent || meta0.askAgent || null; model = cleanModel(model ?? (agent === meta0.askAgent ? meta0.askModel : ''));
    if (agent && !ready(agent)) throw httpError(409, `${agent} is not ready on this box to answer.`);
    const pick = agent || ['claude', 'codex', 'antigravity', 'cline'].find(k => ready(k)) || null;
    if (!pick) throw httpError(409, 'No agent is signed in on this box to answer (Claude, Codex, Gemini or Cline).');
    const dir = askDir(slug); fs.mkdirSync(dir, { recursive: true }); share(dir);
    const n = asks(slug).reduce((m, a) => Math.max(m, Number(String(a.id).slice(1)) || 0), 0) + 1;
    const a = { id: `a${n}`, question: q, agent: pick, status: 'running', answer: '', by, at: Date.now() };
    const f = path.join(dir, `${a.id}.json`); writeJson(f, a);
    askRunning.set(slug, (askRunning.get(slug) || 0) + 1);
    record('activity', 'case-ask', { actor: by, what: `${slug}: ${q.slice(0, 160)}` });
    logEvent(slug, { kind: 'ask-start', by, what: `Asked: ${q.slice(0, 200)}`, agent: pick, model });
    a.model = model;
    consult.zeroTrust({ target: pick, question: `${caseFile(slug)}\n\n---\nQUESTION ABOUT THIS CASE: ${q}`, web: false, title: pick, system: prompts.text('case-ask'), model })
        .then(t => { a.status = 'done'; a.answer = t; }).catch(e => { a.status = 'failed'; a.answer = e.message; })
        .finally(() => logEvent(slug, { kind: a.status === 'done' ? 'ask-end' : 'ask-fail', by, what: `Answer to “${q.slice(0, 80)}” ${a.status === 'done' ? 'ready' : 'failed'}`, ms: Date.now() - a.at, agent: pick, model }))
        .finally(() => { a.finished = Date.now(); try { if (exists(dir)) writeJson(f, a); } catch { /* case deleted */ } askRunning.set(slug, Math.max(0, (askRunning.get(slug) || 1) - 1)); });
    return a;
}

// ---------- helpers that make the loop easy for agents ----------
// Turn the links in a probe's answer into sources (reliability "other" until checked), and say which ids they got.
export async function adopt(slug, pid, { reliability = null } = {}, by = 'phone') {
    const p = getProbe(slug, pid); if (p.status !== 'done') throw httpError(409, `Probe ${pid} has ${p.status === 'running' ? 'not come back yet' : 'failed'}.`);
    const urls = [...new Set((String(p.answer).match(/https?:\/\/[^\s)\]>"'`]+/g) || []).map(u => u.replace(/[.,;:]+$/, '')))].slice(0, 40);
    if (!urls.length) throw httpError(409, `Probe ${pid}'s answer has no links to add.`);
    const out = [];
    for (const u of urls) { let host = u; try { host = new URL(u).hostname.replace(/^www\./, ''); } catch { continue; } const src = await addSource(slug, { title: `${host}: from probe ${pid} on ${p.subject}`, url: u, publisher: host, reliability: RELIABILITY.includes(reliability) ? reliability : guessReliability(u) }, by); out.push({ id: src.id, url: u, reliability: src.reliability }); }
    return { probe: pid, sources: out };
}
// Add a line to notes.md, under "What the evidence shows" unless another heading is named.
export function appendNote(slug, text, by = 'phone') {
    const t = String(text || '').trim().slice(0, 4000); if (t.length < 3) throw httpError(400, 'Write the note.');
    const f = path.join(casePath(slug), 'notes.md'); let n = ''; try { n = fs.readFileSync(f, 'utf8'); } catch { /* new */ }
    const line = `- ${t}\n`; const h = '## What the evidence shows\n';
    const i = n.indexOf(h); if (i >= 0) { const j = n.indexOf('\n## ', i + h.length); n = j >= 0 ? `${n.slice(0, j).replace(/\n*$/, '\n')}${line}\n${n.slice(j + 1)}` : `${n.replace(/\n*$/, '\n')}${line}`; } else n = `${n.replace(/\n*$/, '\n')}${line}`;
    fs.writeFileSync(f, n); share(f); logEvent(slug, { kind: 'note', by, what: `Note: ${t.slice(0, 200)}` });
    return { ok: true };
}
// What is left undone, so an agent (or you) always has an obvious next step.
export function todo(slug) {
    const d = detail(slug); const b = d.board; const have = new Set(b.sources.map(s => s.url));
    const unadopted = d.probes.filter(p => p.status === 'done' && (String(p.answer).match(/https?:\/\/[^\s)\]>"'`]+/g) || []).some(u => !have.has(u.replace(/[.,;:]+$/, '')))).map(p => p.id);
    const items = [];
    if (unadopted.length) items.push(`Probes back with links not added as sources: ${unadopted.join(', ')} (sleuth adopt ${unadopted[0]})`);
    const noSrc = b.nodes.filter(n => !n.sources.length && !n.origin); if (noSrc.length) items.push(`Cards with no source: ${noSrc.slice(0, 6).map(n => `"${n.label}"`).join(', ')}`);
    if (b.nodes.length > 1 && !b.links.length) items.push('No strings yet: connect cards (sleuth link "A" "B" "what joins them" …)');
    if (!b.theories.length && b.sources.length >= 3) items.push('No theories yet: add two competing explanations (sleuth theory "…")');
    if (/## What the evidence shows\n\n## What is still open/.test(d.notes)) items.push('notes.md is empty: write what the evidence shows (sleuth note "…")');
    if (d.probes.length < d.budget && !d.probes.length) items.push(`No probes yet (${d.budget} allowed): send a narrow one about the starting card`);
    return items;
}

// ---------- export ----------
// A readable dossier: the question, the notes, the cards and strings with their sources. Residential addresses are
// replaced by "[residential address]".
export function exportMarkdown(slug) {
    const d = detail(slug); const b = d.board; const nm = new Map(b.nodes.map(n => [n.id, n]));
    const label = n => (n.type === 'address' && n.residential ? '[residential address]' : n.label);
    const cite = ids => (ids || []).length ? ` [${ids.join(', ')}]` : '';
    let out = `${d.notes.trim()}\n\n---\n\n## Board\n\n`;
    for (const [t, title] of Object.entries(NODE_TYPES)) { const ns = b.nodes.filter(n => n.type === t); if (!ns.length) continue; out += `### ${title}\n\n${ns.map(n => `- **${label(n)}** (${n.status})${n.note && !(n.type === 'address' && n.residential) ? `: ${n.note}` : ''}${cite(n.sources)}`).join('\n')}\n\n`; }
    if (b.links.length) out += `### Connections\n\n${b.links.map(l => `- ${label(nm.get(l.from) || { label: '?' })} → ${l.label} → ${label(nm.get(l.to) || { label: '?' })} (${l.strength})${cite(l.sources)}`).join('\n')}\n\n`;
    const weighed = t => { const e = Object.entries(t.evidence).filter(([, x]) => x !== 'neutral'); const n = v => e.filter(([, x]) => x === v).length; return `- ${t.text}: ${n('supports')} for, ${n('contradicts')} against${e.length ? ` [${e.map(([k, x]) => `${k} ${x === 'supports' ? '+' : '−'}`).join(', ')}]` : ''}`; };
    if (b.theories.length) out += `### Theories weighed\n\n${b.theories.map(weighed).join('\n')}\n\n`;
    const open = b.questions.filter(q => q.status === 'open'); if (open.length) out += `### Open questions\n\n${open.map(q => `- ${q.text}`).join('\n')}\n\n`;
    if (b.sources.length) out += `## Sources\n\n${b.sources.map(s => `- **${s.id}** ${s.title}${s.publisher ? `, ${s.publisher}` : ''}${s.date ? ` (${s.date})` : ''}${s.url ? ` <${s.url}>` : ''}`).join('\n')}\n`;
    return { name: `${slug}.md`, text: out };
}

// The add-on's setup: small command-line helpers for reading filings and data (root, from the Apps tab).
export function setupCommand() { return ['node', [path.resolve(here, '..', '..', 'bin', 'sleuth'), 'setup']]; }
