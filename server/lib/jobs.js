// Job Hunt: an autonomous job board around one person. Everything lives in /Jobs on the box (never pushed anywhere):
//
//   .platopypus/jobs.json   settings: what to look for, where, salary floor, money assumptions
//   me.json                 "Me": every project, role, skill, qualification and achievement, with levels and evidence
//   board.json              jobs found (from job-site APIs and agents), each with its match against Me and a money line
//   cvs/                    CV files, cvs.json: their categories and which is the default for each
//   applications/<id>/      one folder per application (CV used, cover letter, notes, correspondence); applications.json
//   log.jsonl               what was found, scored, applied for, and by whom
//
// Matching: the box ranks Me items against a job's requirements (words in common); an agent then judges each
// requirement (level, evidence, gaps) and stores the result. Money: the agent works it out (take-home, living costs,
// what is left) and stores the figures with its assumptions; a rough UK estimate is offered as a starting point.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { record } from './audit.js';
import * as agentUser from './agentuser.js';
import * as vault from './vault.js';
import * as ws from './kit/workspaces.js';
import * as prompts from './prompts.js';

export const ROOT = path.join(config.root, 'Jobs');
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const share = f => { const a = agentUser.info(); try { if (a && process.getuid?.() === 0) fs.chownSync(f, 0, a.gid); fs.chmodSync(f, fs.statSync(f).isDirectory() ? 0o2770 : 0o660); } catch { /* best effort */ } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(v, null, 2)); fs.renameSync(t, f); share(f); };
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const id6 = (p) => `${p}${crypto.randomBytes(3).toString('hex')}`;
const P = (...x) => path.join(ROOT, ...x);
export const ready = () => fs.existsSync(P('.platopypus', 'jobs.json'));
export function inJobs(dir) { const rel = path.relative(ROOT, path.resolve(String(dir || ''))); return !rel.startsWith('..') && !path.isAbsolute(rel) && ready(); }

// ---------- set up and settings ----------
const DEFAULTS = { keywords: '', locations: '', countries: 'gb', nationality: '', remote: true, salaryMin: null, currency: 'GBP', exclude: '', sources: ['remotive', 'arbeitnow', 'adzuna', 'reed'], money: { region: 'England', studentLoan: 'plan2', pension: 5, notes: '' }, home: '', created: null };
export function setup() {
    for (const d of ['.platopypus', 'cvs', 'applications', 'files']) fs.mkdirSync(P(d), { recursive: true });
    if (!ready()) writeJson(P('.platopypus', 'jobs.json'), { ...DEFAULTS, created: Date.now() });
    for (const [f, v] of [['me.json', { items: [], gaps: [] }], ['board.json', { jobs: [] }], ['cvs', null], ['applications.json', { apps: [] }]]) if (v && !fs.existsSync(P(f))) writeJson(P(f), v);
    if (!fs.existsSync(P('cvs', 'cvs.json'))) writeJson(P('cvs', 'cvs.json'), { cvs: [] });
    writeBrief();
    for (const d of [ROOT, P('.platopypus'), P('cvs'), P('applications'), P('files')]) share(d);
    agentUser.prepareFolder(ROOT).catch(() => {});
    return settings();
}
export function settings() {
    const s = { ...DEFAULTS, ...(readJson(P('.platopypus', 'jobs.json'), {}) || {}) };
    return { ...s, keys: keyStatus(), ready: ready() };
}
export function setSettings(b = {}) {
    if (!ready()) setup();
    const s = readJson(P('.platopypus', 'jobs.json'), {}) || {};
    for (const k of ['keywords', 'locations', 'countries', 'nationality', 'exclude', 'home', 'currency', 'agent', 'model']) if (b[k] !== undefined) s[k] = clip(b[k], 400);
    if (b.remote !== undefined) s.remote = !!b.remote; if (b.autoCpd !== undefined) s.autoCpd = !!b.autoCpd; if (b.autoAssess !== undefined) s.autoAssess = !!b.autoAssess; if (b.autoAssessPerDay !== undefined) s.autoAssessPerDay = Math.max(0, Math.min(50, Math.round(Number(b.autoAssessPerDay) || 0)));
    if (b.salaryMin !== undefined) { const n = Number(b.salaryMin); s.salaryMin = Number.isFinite(n) && n > 0 ? Math.round(n) : null; }
    if (Array.isArray(b.sources)) s.sources = b.sources.filter(x => SOURCES[x]);
    if (b.money && typeof b.money === 'object') s.money = { ...DEFAULTS.money, ...(s.money || {}), ...Object.fromEntries(Object.entries(b.money).map(([k, v]) => [k, typeof v === 'number' ? v : clip(v, 200)])) };
    writeJson(P('.platopypus', 'jobs.json'), s); log({ kind: 'settings', by: 'phone', what: 'Search settings changed' });
    return settings();
}

// ---------- job-site keys (in the Vault) ----------
// Each source: the Vault fields it needs (none for the free ones) and how to fetch a page of jobs.
const SOURCES = {
    remotive: { title: 'Remotive (remote jobs, no key)', keys: [] },
    arbeitnow: { title: 'Arbeitnow (no key)', keys: [] },
    adzuna: { title: 'Adzuna', keys: ['ADZUNA_APP_ID', 'ADZUNA_APP_KEY'], signup: 'https://developer.adzuna.com/' },
    reed: { title: 'Reed (UK)', keys: ['REED_API_KEY'], signup: 'https://www.reed.co.uk/developers' },
    jooble: { title: 'Jooble', keys: ['JOOBLE_API_KEY'], signup: 'https://jooble.org/api/about' },
};
async function keyValues() { try { return await vault.envFor(ROOT, { project: 'none' }); } catch { return {}; } }
function keyStatus() {
    let names = new Set(); try { for (const it of vault.list()) for (const f of it.fields || []) if (f.env && !f.missing) names.add(f.env); } catch { /* vault locked or empty */ }
    return Object.fromEntries(Object.entries(SOURCES).map(([k, s]) => [k, { title: s.title, needs: s.keys, signup: s.signup || null, ready: s.keys.every(n => names.has(n)) }]));
}
export const sources = () => keyStatus();

// ---------- the log ----------
export function log(ev) { try { fs.appendFileSync(P('log.jsonl'), JSON.stringify({ t: Date.now(), ...ev }) + '\n'); share(P('log.jsonl')); } catch { /* not set up */ } }
export function readLog(limit = 300) { try { return fs.readFileSync(P('log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse(); } catch { return []; } }

// ---------- Me ----------
export const ME_KINDS = { project: 'Project', role: 'Job or role', skill: 'Skill', education: 'Education', cert: 'Qualification or certificate', achievement: 'Achievement', interest: 'Interest' };
const LEVELS = ['aware', 'working', 'strong', 'expert'];
const meFile = () => P('me.json');
export function me() { const m = readJson(meFile(), { items: [], gaps: [] }) || { items: [], gaps: [] }; m.items ||= []; m.gaps ||= []; return m; }
function saveMe(m) { writeJson(meFile(), m); }
export function addMe(b, by = 'phone') {
    const m = me(); const kind = ME_KINDS[b.kind] ? b.kind : 'project'; const title = clip(b.title, 160); if (title.length < 2) throw httpError(400, 'Give it a title.');
    const same = m.items.find(i => i.kind === kind && i.title.toLowerCase() === title.toLowerCase());
    const it = same || { id: id6('m'), kind, title, created: Date.now(), by };
    const keep = b.proposed && same && same.status !== 'proposed';   // a confirmed item: proposals add evidence and sources, never rewrite it
    if (b.summary !== undefined && !(keep && it.summary)) it.summary = clip(b.summary, 3000);
    if (b.level !== undefined && !(keep && it.level)) it.level = LEVELS.includes(b.level) ? b.level : it.level;
    for (const k of ['org', 'from', 'to', 'where']) if (b[k] !== undefined) it[k] = clip(b[k], 120);
    if (b.tags !== undefined) it.tags = [...new Set((Array.isArray(b.tags) ? b.tags : String(b.tags).split(',')).map(t => clip(t, 40).toLowerCase()).filter(Boolean))].slice(0, 30);
    if (b.evidence !== undefined) { const ev = (Array.isArray(b.evidence) ? b.evidence : [b.evidence]).map(e => clip(e, 500)).filter(Boolean); it.evidence = (b.proposed && same ? [...new Set([...(same.evidence || []), ...ev])] : ev).slice(0, 30); }
    if (b.links !== undefined) it.links = (Array.isArray(b.links) ? b.links : String(b.links).split(',')).map(x => x.trim()).filter(x => m.items.some(i => i.id === x)).slice(0, 40);
    if (b.sources !== undefined) { const src = (Array.isArray(b.sources) ? b.sources : [b.sources]).map(x => (typeof x === 'string' ? { url: x } : x)).map(x => ({ url: clip(x.url, 600), title: clip(x.title, 200), note: clip(x.note, 400) })).filter(x => x.url || x.title); const all = b.proposed && same ? [...(same.sources || []), ...src] : src; it.sources = all.filter((x, i) => all.findIndex(y => y.url === x.url && y.title === x.title && y.note === x.note) === i).slice(0, 20); }
    // Proposed: found by an agent (in your CV, or online) and waiting for you to confirm. Only confirmed items count in matching.
    if (b.proposed) { if (same && same.status !== 'proposed') it.newEvidence = Date.now(); if (!same || same.status === 'proposed') { it.status = 'proposed'; it.why = clip(b.why, 600); it.confidence = ['high', 'medium', 'low'].includes(b.confidence) ? b.confidence : 'medium'; } }
    else if (by === 'phone') { delete it.status; delete it.confidence; }
    it.updated = Date.now();
    if (!same) m.items.push(it); saveMe(m); log({ kind: 'me', by, what: `${it.status === 'proposed' ? 'Proposed' : same ? 'Updated' : 'Added'} ${ME_KINDS[kind].toLowerCase()}: ${title}` });
    return it;
}
export function verifyMe(id, action) {
    const m = me(); const it = m.items.find(i => i.id === id); if (!it) throw httpError(404, 'No such item.');
    if (action === 'reject') { removeMe(id); log({ kind: 'me', by: 'phone', what: `Rejected: ${it.title}` }); return { removed: id }; }
    delete it.status; delete it.confidence; it.verified = Date.now(); saveMe(m); log({ kind: 'me', by: 'phone', what: `Confirmed: ${it.title}` }); return it;
}
export function removeMe(id) { const m = me(); const n = m.items.length; m.items = m.items.filter(i => i.id !== id); for (const i of m.items) i.links = (i.links || []).filter(x => x !== id); if (m.items.length === n) throw httpError(404, 'No such item.'); saveMe(m); return { removed: id }; }
// Gaps: what a job asked for that Me has no evidence of. The user answers (adds an example) or dismisses them.
export function addGap(b, by = 'phone') { const m = me(); const text = clip(b.text, 400); if (text.length < 4) throw httpError(400, 'Describe the gap.'); const g = m.gaps.find(x => x.text.toLowerCase() === text.toLowerCase() && x.status === 'open') || { id: id6('g'), text, job: b.job || null, status: 'open', by, at: Date.now() }; if (!m.gaps.includes(g)) m.gaps.push(g); saveMe(m); return g; }
export function closeGap(id, { answer = '', status = 'answered' } = {}) { const m = me(); const g = m.gaps.find(x => x.id === id); if (!g) throw httpError(404, 'No such gap.'); g.status = ['answered', 'dismissed'].includes(status) ? status : 'answered'; g.answer = clip(answer, 2000); g.closed = Date.now(); saveMe(m); return g; }

// ---------- matching ----------
const STOP = new Set('a an and the of to in for on with or as at by from is are be this that you your our we will can able experience years year work working team skills skill strong good knowledge understanding using use etc including within across role'.split(' '));
const words = t => String(t || '').toLowerCase().replace(/[^a-z0-9+#.\s-]/g, ' ').split(/\s+/).map(w => w.replace(/^[.-]+|[.-]+$/g, '')).filter(w => w.length > 1 && !STOP.has(w));
// For each requirement, the Me items sharing the most words with it (the agent judges the real fit).
export function candidates(requirements, { per = 4 } = {}) {
    const items = me().items.filter(i => i.status !== 'proposed').map(i => ({ i, w: new Set(words([i.title, i.summary, (i.tags || []).join(' '), i.org].join(' '))) }));
    return requirements.map(r => {
        const rw = words(r);
        const scored = items.map(({ i, w }) => ({ id: i.id, kind: i.kind, title: i.title, level: i.level || null, hits: rw.filter(x => w.has(x)) })).filter(x => x.hits.length).sort((a, b) => b.hits.length - a.hits.length).slice(0, per);
        return { requirement: r, candidates: scored };
    });
}

// ---------- the board ----------
const boardFile = () => P('board.json');
export function board() { const b = readJson(boardFile(), { jobs: [] }) || { jobs: [] }; b.jobs ||= []; return b; }
const saveBoard = b => writeJson(boardFile(), b);
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export const STATUSES = ['new', 'shortlisted', 'applying', 'applied', 'hidden'];
function upsertJob(b, j, by) {
    const url = clip(j.url, 800); const key = url || `${norm(j.title)}|${norm(j.company)}`;
    let it = b.jobs.find(x => (url && x.url === url) || `${norm(x.title)}|${norm(x.company)}` === `${norm(j.title)}|${norm(j.company)}`);
    const fresh = !it; if (!it) { it = { id: id6('j'), status: 'new', found: Date.now(), by }; b.jobs.push(it); }
    for (const k of ['title', 'company', 'location', 'salary', 'deadline', 'source', 'contract', 'posted']) if (j[k]) it[k] = clip(j[k], k === 'title' ? 200 : 160);
    if (url) it.url = url; if (j.description) it.description = String(j.description).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000);
    if (Number.isFinite(+j.salaryMin)) it.salaryMin = Math.round(+j.salaryMin); if (Number.isFinite(+j.salaryMax)) it.salaryMax = Math.round(+j.salaryMax);
    if (Array.isArray(j.requirements)) it.requirements = j.requirements.map(r => clip(r, 300)).filter(Boolean).slice(0, 30);
    if (j.category) it.category = clip(j.category, 60);
    it.key = key; it.updated = Date.now();
    return { it, fresh };
}
export function addJob(body, by = 'phone') {
    const b = board(); if (!clip(body.title, 10)) throw httpError(400, 'A job needs a title.');
    const { it, fresh } = upsertJob(b, body, by); saveBoard(b); if (fresh) queueAssess(it.id);
    if (fresh) log({ kind: 'job', by, what: `Found: ${it.title}${it.company ? ` at ${it.company}` : ''}${it.source ? ` (${it.source})` : ''}` });
    return it;
}
export function getJob(id) { const j = board().jobs.find(x => x.id === id); if (!j) throw httpError(404, 'No such job.'); return j; }
export function updateJob(id, body, by = 'phone') {
    const b = board(); const j = b.jobs.find(x => x.id === id); if (!j) throw httpError(404, 'No such job.');
    if (body.status !== undefined) { if (!STATUSES.includes(body.status)) throw httpError(400, `Status: ${STATUSES.join(', ')}.`); j.status = body.status; log({ kind: 'status', by, what: `${j.title}: ${body.status}` }); }
    for (const k of ['title', 'company', 'location', 'salary', 'deadline', 'category', 'notes']) if (body[k] !== undefined) j[k] = clip(body[k], k === 'notes' ? 3000 : 200);
    if (Array.isArray(body.requirements)) j.requirements = body.requirements.map(r => clip(r, 300)).filter(Boolean).slice(0, 30);
    j.updated = Date.now(); saveBoard(b); return j;
}
// The agent's judgement of fit: an overall score, a line per requirement, the evidence it used and the gaps.
export function setMatch(id, body, by = 'phone') {
    const b = board(); const j = b.jobs.find(x => x.id === id); if (!j) throw httpError(404, 'No such job.');
    const score = Math.round(Number(body.score)); if (!(score >= 0 && score <= 100)) throw httpError(400, 'Score: 0 to 100.');
    const ids = new Set(me().items.map(i => i.id));
    j.match = { score, summary: clip(body.summary, 1500), level: clip(body.level, 40), by, at: Date.now(),
        lines: (Array.isArray(body.lines) ? body.lines : []).slice(0, 30).map(l => ({ requirement: clip(l.requirement, 300), verdict: ['meets', 'partly', 'gap'].includes(l.verdict) ? l.verdict : 'partly', evidence: (Array.isArray(l.evidence) ? l.evidence : String(l.evidence || '').split(',')).map(x => x.trim()).filter(x => ids.has(x)).slice(0, 6), note: clip(l.note, 400) })),
        cv: body.cv ? clip(body.cv, 20) : null };
    for (const l of j.match.lines) if (l.verdict === 'gap') addGap({ text: l.requirement, job: j.id }, by);
    j.updated = Date.now(); saveBoard(b); log({ kind: 'match', by, what: `${j.title}${j.company ? ` at ${j.company}` : ''}: ${score}/100` });
    return j;
}
// Money: the agent's figures and assumptions (all yearly, in the job's currency).
export function setMoney(id, body, by = 'phone') {
    const b = board(); const j = b.jobs.find(x => x.id === id); if (!j) throw httpError(404, 'No such job.');
    const num = v => (v === undefined || v === null || v === '' ? null : Math.round(Number(v)));
    j.money = { currency: clip(body.currency || '', 8).toUpperCase() || null, gross: num(body.gross), takeHome: num(body.takeHome), living: num(body.living), left: num(body.left ?? (num(body.takeHome) !== null && num(body.living) !== null ? num(body.takeHome) - num(body.living) : null)), assumptions: clip(body.assumptions, 1200), by, at: Date.now() };
    j.updated = Date.now(); saveBoard(b); return j;
}
// A rough UK starting point (England, 2026/27 bands as published for 2025/26): income tax, NI, student loan, pension.
export function ukEstimate(gross, { studentLoan = 'plan2', pension = 5 } = {}) {
    const g = Math.max(0, Number(gross) || 0); const pen = g * (Number(pension) || 0) / 100; const taxable = g - pen;
    let pa = 12570; if (taxable > 100000) pa = Math.max(0, pa - (taxable - 100000) / 2);
    const band = (lo, hi, r) => Math.max(0, Math.min(taxable, hi) - lo) * r;
    const tax = band(pa, 50270, 0.2) + band(50270, 125140, 0.4) + band(125140, Infinity, 0.45);
    const ni = Math.max(0, Math.min(g, 50270) - 12570) * 0.08 + Math.max(0, g - 50270) * 0.02;
    const plans = { plan1: [26065, 0.09], plan2: [28470, 0.09], plan4: [32745, 0.09], plan5: [25000, 0.09], postgrad: [21000, 0.06], none: [Infinity, 0] };
    const [th, rate] = plans[studentLoan] || plans.plan2; const sl = Math.max(0, g - th) * rate;
    return { gross: Math.round(g), pension: Math.round(pen), tax: Math.round(tax), ni: Math.round(ni), studentLoan: Math.round(sl), takeHome: Math.round(g - pen - tax - ni - sl), assumptions: `Rough UK estimate (England): ${pension}% pension, student loan ${studentLoan}, standard tax code. Check the real figures.` };
}

// ---------- hunting: job-site APIs ----------
async function getJson(url, opts = {}) { const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'PlatOpypus-JobHunt/1.0', Accept: 'application/json', ...(opts.headers || {}) } }); if (!r.ok) throw new Error(`${r.status}`); return r.json(); }
const FETCH = {
    async remotive(q) { const d = await getJson(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(q.keywords)}&limit=40`); return (d.jobs || []).map(j => ({ title: j.title, company: j.company_name, location: j.candidate_required_location || 'Remote', salary: j.salary, url: j.url, description: j.description, posted: j.publication_date, category: j.category, source: 'Remotive' })); },
    async arbeitnow(q) { const d = await getJson('https://www.arbeitnow.com/api/job-board-api'); const kw = words(q.keywords); return (d.data || []).filter(j => !kw.length || kw.some(w => `${j.title} ${(j.tags || []).join(' ')}`.toLowerCase().includes(w))).slice(0, 40).map(j => ({ title: j.title, company: j.company_name, location: j.remote ? `${j.location} (remote)` : j.location, url: j.url, description: j.description, posted: j.created_at ? new Date(j.created_at * 1000).toISOString().slice(0, 10) : '', source: 'Arbeitnow' })); },
    async adzuna(q, k) { const where = q.location ? `&where=${encodeURIComponent(q.location)}` : ''; const cc = /^[a-z]{2}$/.test(q.country || '') ? q.country : 'gb'; const d = await getJson(`https://api.adzuna.com/v1/api/jobs/${cc}/search/1?app_id=${encodeURIComponent(k.ADZUNA_APP_ID)}&app_key=${encodeURIComponent(k.ADZUNA_APP_KEY)}&results_per_page=40&what=${encodeURIComponent(q.keywords)}${where}${q.salaryMin ? `&salary_min=${q.salaryMin}` : ''}&content-type=application/json`); return (d.results || []).map(j => ({ title: j.title, company: j.company?.display_name, location: j.location?.display_name, salaryMin: j.salary_min, salaryMax: j.salary_max, salary: j.salary_min ? `${cc === 'gb' ? '£' : ''}${Math.round(j.salary_min).toLocaleString()}${j.salary_max && j.salary_max !== j.salary_min ? `–${Math.round(j.salary_max).toLocaleString()}` : ''}${cc === 'gb' ? '' : ` (${cc.toUpperCase()} local currency)`}` : '', country: cc, url: j.redirect_url, description: j.description, posted: (j.created || '').slice(0, 10), contract: j.contract_time, category: j.category?.label, source: 'Adzuna' })); },
    async reed(q, k) { const d = await getJson(`https://www.reed.co.uk/api/1.0/search?keywords=${encodeURIComponent(q.keywords)}${q.location ? `&locationName=${encodeURIComponent(q.location)}` : ''}${q.salaryMin ? `&minimumSalary=${q.salaryMin}` : ''}&resultsToTake=40`, { headers: { Authorization: `Basic ${Buffer.from(`${k.REED_API_KEY}:`).toString('base64')}` } }); return (d.results || []).map(j => ({ title: j.jobTitle, company: j.employerName, location: j.locationName, salaryMin: j.minimumSalary, salaryMax: j.maximumSalary, salary: j.minimumSalary ? `£${Math.round(j.minimumSalary).toLocaleString()}${j.maximumSalary && j.maximumSalary !== j.minimumSalary ? `–£${Math.round(j.maximumSalary).toLocaleString()}` : ''}` : '', url: j.jobUrl, description: j.jobDescription, deadline: j.expirationDate, posted: j.date, source: 'Reed' })); },
    async jooble(q, k) { const d = await getJson(`https://jooble.org/api/${encodeURIComponent(k.JOOBLE_API_KEY)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keywords: q.keywords, location: q.location || '' }) }); return (d.jobs || []).slice(0, 40).map(j => ({ title: j.title, company: j.company, location: j.location, salary: j.salary, url: j.link, description: j.snippet, posted: (j.updated || '').slice(0, 10), source: 'Jooble' })); },
};
let hunting = null;
export async function hunt(by = 'phone') {
    if (hunting) throw httpError(409, 'A hunt is already running.');
    const s = settings(); if (!s.keywords.trim()) throw httpError(400, 'Set what to look for first (Setup: keywords).');
    const kv = await keyValues(); const ks = keyStatus();
    const locs = (s.locations || '').split(/[;,]/).map(x => x.trim()).filter(Boolean); const exclude = words(s.exclude); const want = words(s.keywords);
    hunting = { started: Date.now() }; const out = { found: 0, added: 0, bySource: {}, errors: {} }; const fresh_ids = [];
    try {
        const b = board();
        for (const src of s.sources) {
            if (!FETCH[src] || !ks[src]?.ready) continue;
            const countries = src === 'adzuna' ? (s.countries || 'gb').toLowerCase().split(/[\s,;]+/).filter(x => /^[a-z]{2}$/.test(x)) : [''];
            for (const country of (countries.length ? countries : ['gb'])) for (const location of (locs.length ? locs : [''])) {
                try {
                    const list = await FETCH[src]({ keywords: s.keywords, location, salaryMin: s.salaryMin, country }, kv);
                    for (const j of list) {
                        if (!j.title) continue; if (want.length && !want.some(w => `${j.title} ${j.category || ''}`.toLowerCase().includes(w))) continue; if (exclude.some(w => `${j.title} ${j.company || ''}`.toLowerCase().includes(w))) continue;
                        out.found++; const { it: nj, fresh } = upsertJob(b, j, `hunt (${src})`); if (fresh) { fresh_ids.push(nj.id); out.added++; out.bySource[src] = (out.bySource[src] || 0) + 1; }
                    }
                } catch (e) { out.errors[src] = e.message; }
                if (src === 'arbeitnow' || src === 'remotive') break;   // these do not take a location
            }
        }
        saveBoard(b); for (const fid of fresh_ids) queueAssess(fid);
        log({ kind: 'hunt', by, what: `Hunt: ${out.found} seen, ${out.added} new${Object.keys(out.errors).length ? `; errors: ${Object.entries(out.errors).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}`, ms: Date.now() - hunting.started });
        record('activity', 'jobs-hunt', { actor: by, what: `${out.added} new jobs (${out.found} seen)` });
        return out;
    } finally { hunting = null; }
}

// ---------- CVs ----------
const cvFile = () => P('cvs', 'cvs.json');
export function cvs() { return (readJson(cvFile(), { cvs: [] }) || { cvs: [] }).cvs; }
export function addCv({ name, file, data, categories = [], notes = '' }, by = 'phone') {
    const list = cvs(); const n = clip(name || file, 120); if (!n) throw httpError(400, 'Give the CV a name.');
    const ext = path.extname(String(file || '')).toLowerCase(); if (!['.pdf', '.docx', '.doc', '.md', '.txt', '.odt', '.tex'].includes(ext)) throw httpError(400, 'A CV is a PDF, Word, ODT, LaTeX, Markdown or text file.');
    const buf = Buffer.from(String(data || ''), 'base64'); if (!buf.length || buf.length > 15 * 1024 * 1024) throw httpError(400, 'The file is empty or over 15 MB.');
    const id = id6('c'); const f = `${id}${ext}`; fs.writeFileSync(P('cvs', f), buf); share(P('cvs', f));
    const cv = { id, name: n, file: f, original: clip(file, 160), categories: [...new Set((Array.isArray(categories) ? categories : String(categories).split(',')).map(x => clip(x, 40)).filter(Boolean))], notes: clip(notes, 1000), added: Date.now(), by };
    list.push(cv); writeJson(cvFile(), { cvs: list }); log({ kind: 'cv', by, what: `CV added: ${n}${cv.categories.length ? ` (${cv.categories.join(', ')})` : ''}` });
    return cv;
}
export function updateCv(id, b) {
    const list = cvs(); const cv = list.find(x => x.id === id); if (!cv) throw httpError(404, 'No such CV.');
    if (b.name !== undefined) cv.name = clip(b.name, 120); if (b.notes !== undefined) cv.notes = clip(b.notes, 1000);
    if (b.categories !== undefined) cv.categories = [...new Set((Array.isArray(b.categories) ? b.categories : String(b.categories).split(',')).map(x => clip(x, 40)).filter(Boolean))];
    if (b.defaultFor !== undefined) { const cat = clip(b.defaultFor, 40); for (const x of list) x.defaultFor = (x.defaultFor || []).filter(c => c !== cat); cv.defaultFor = [...new Set([...(cv.defaultFor || []), cat])]; }
    writeJson(cvFile(), { cvs: list }); return cv;
}
export function removeCv(id) { const list = cvs(); const cv = list.find(x => x.id === id); if (!cv) throw httpError(404, 'No such CV.'); fs.rmSync(P('cvs', cv.file), { force: true }); writeJson(cvFile(), { cvs: list.filter(x => x.id !== id) }); return { removed: id }; }
export async function cvText(id) { return fileText(cvPath(id).file); }
export async function fileText(f) {
    const ext = path.extname(f).toLowerCase(); const { execFile } = await import('node:child_process');
    const run = (cmd, args) => new Promise((ok, bad) => execFile(cmd, args, { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }, (e, so) => (e ? bad(e) : ok(String(so)))));
    try {
        if (['.md', '.txt', '.tex'].includes(ext)) return fs.readFileSync(f, 'utf8').slice(0, 200_000);
        if (ext === '.pdf') return (await run('pdftotext', ['-layout', f, '-'])).replace(/\f/g, '\n[page break]\n').slice(0, 300_000);
        if (ext === '.pptx') { const list = (await run('unzip', ['-Z1', f])).split('\n').filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0])); let out = ''; for (const n of list) out += `\n[slide ${n.match(/\d+/)[0]}]\n` + (await run('unzip', ['-p', f, n])).replace(/<\/a:p>/g, '\n').replace(/<[^>]+>/g, ''); return out.slice(0, 300_000); }
        if (ext === '.docx' || ext === '.odt') { const xml = await run('unzip', ['-p', f, ext === '.docx' ? 'word/document.xml' : 'content.xml']); return xml.replace(/<\/(w:p|text:p|text:h)>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/\n{3,}/g, '\n\n').slice(0, 200_000); }
    } catch { /* fall through */ }
    return `Could not extract text here (${ext}; pdftotext comes with the Research app, unzip for Word). The file is at ${f}: read it with your own tools.`;
}
export const cvPath = id => { const cv = cvs().find(x => x.id === id); if (!cv) throw httpError(404, 'No such CV.'); return { file: P('cvs', cv.file), name: cv.original || cv.file }; };

// ---------- applications ----------
export const STAGES = ['preparing', 'applied', 'assessment', 'interview', 'final', 'offer', 'accepted', 'rejected', 'withdrawn'];
const appFile = () => P('applications.json');
export function applications() { return (readJson(appFile(), { apps: [] }) || { apps: [] }).apps; }
const saveApps = apps => writeJson(appFile(), { apps });
export function createApplication({ job, cv = null, notes = '' }, by = 'phone') {
    const j = getJob(job); const apps = applications(); if (apps.some(a => a.job === j.id && !['rejected', 'withdrawn'].includes(a.stage))) throw httpError(409, 'There is already an application for this job.');
    const n = apps.reduce((m, a) => Math.max(m, a.n || 0), 0) + 1; const id = id6('a'); const dir = P('applications', `${String(n).padStart(3, '0')}-${(j.company || j.title).replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40)}`);
    for (const d of ['', 'CV & Cover Letter', 'Application', 'Notes']) { fs.mkdirSync(path.join(dir, d), { recursive: true }); share(path.join(dir, d)); }
    if (cv) { const c = cvPath(cv); fs.copyFileSync(c.file, path.join(dir, 'CV & Cover Letter', path.basename(c.name))); }
    fs.writeFileSync(path.join(dir, 'Notes', 'job.md'), `# ${j.title}${j.company ? ` · ${j.company}` : ''}\n\n${j.url ? `${j.url}\n\n` : ''}${j.location ? `Location: ${j.location}\n` : ''}${j.salary ? `Salary: ${j.salary}\n` : ''}${j.deadline ? `Deadline: ${j.deadline}\n` : ''}\n${j.description || ''}\n`);
    const a = { id, n, job: j.id, title: j.title, company: j.company || '', folder: dir, cv, stage: 'preparing', history: [{ stage: 'preparing', at: Date.now(), by }], next: '', nextDate: '', notes: clip(notes, 3000), priority: 'normal', created: Date.now() };
    apps.push(a); saveApps(apps); updateJob(j.id, { status: 'applying' }, by);
    log({ kind: 'application', by, what: `Application started: ${j.title}${j.company ? ` at ${j.company}` : ''}` });
    return a;
}
export function updateApplication(id, b, by = 'phone') {
    const apps = applications(); const a = apps.find(x => x.id === id); if (!a) throw httpError(404, 'No such application.');
    if (b.stage !== undefined && b.stage !== a.stage) { if (!STAGES.includes(b.stage)) throw httpError(400, `Stage: ${STAGES.join(', ')}.`); a.stage = b.stage; a.history.push({ stage: b.stage, at: Date.now(), by }); if (b.stage === 'applied') { try { updateJob(a.job, { status: 'applied' }, by); } catch { /* job gone */ } } log({ kind: 'stage', by, what: `${a.title}${a.company ? ` at ${a.company}` : ''}: ${b.stage}` }); }
    for (const k of ['next', 'nextDate', 'notes', 'priority', 'cv']) if (b[k] !== undefined) a[k] = clip(b[k], k === 'notes' ? 4000 : 200);
    saveApps(apps); return a;
}
export function appFiles(id) {
    const a = applications().find(x => x.id === id); if (!a) throw httpError(404, 'No such application.');
    const out = []; const walk = (d, rel = '') => { let l = []; try { l = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of l) { if (e.isDirectory()) walk(path.join(d, e.name), `${rel}${e.name}/`); else out.push({ path: `${rel}${e.name}`, size: fs.statSync(path.join(d, e.name)).size }); } };
    walk(a.folder); return { folder: a.folder, files: out };
}
const SAFE_SEG = /^[A-Za-z0-9 &()._,'-]{1,60}$/;
function safeSub(sub) { const segs = String(sub || 'Application').split('/').map(x => x.trim()).filter(Boolean); if (!segs.length || segs.length > 4 || segs.some(x => !SAFE_SEG.test(x) || x === '.' || x === '..')) throw httpError(400, 'Folder: up to 4 levels of letters, digits, spaces and . _ - & ( ).'); return segs.join('/'); }
export function saveAppFile(id, { name, data, sub = 'Application', event = null }) {
    const apps = applications(); const a = apps.find(x => x.id === id); if (!a) throw httpError(404, 'No such application.');
    const safe = String(name || '').replace(/[\\/:*?"<>|]+/g, '_').replace(/^\.+/, '').slice(0, 120); if (!safe) throw httpError(400, 'Name the file.');
    const folder = safeSub(sub); const buf = Buffer.from(String(data || ''), 'base64'); if (!buf.length || buf.length > 50 * 1024 * 1024) throw httpError(400, 'The file is empty or over 50 MB.');
    const dir = path.join(a.folder, folder); fs.mkdirSync(dir, { recursive: true }); let cur = a.folder; for (const seg of folder.split('/')) { cur = path.join(cur, seg); share(cur); }
    let f = path.join(dir, safe); for (let n = 2; fs.existsSync(f); n++) f = path.join(dir, safe.replace(/(\.[^.]*)?$/, m => ` (${n})${m}`));
    fs.writeFileSync(f, buf); share(f); const rel = path.relative(a.folder, f).split(path.sep).join('/');
    if (event) { const e = (a.events || []).find(x => x.id === event); if (e) { e.files = [...new Set([...(e.files || []), rel])]; saveApps(apps); } }
    return { saved: rel };
}
export function appFilePath(id, rel) {
    const a = applications().find(x => x.id === id); if (!a) throw httpError(404, 'No such application.');
    const f = path.resolve(a.folder, String(rel || '')); const r = path.relative(a.folder, f); if (!r || r.startsWith('..') || path.isAbsolute(r) || !fs.existsSync(f) || !fs.statSync(f).isFile()) throw httpError(404, 'No such file.');
    return f;
}
// Timeline: notes, tests, interviews, deadlines, emails, offers; each dated, with files attached.
export const EVENT_TYPES = { note: 'Note', test: 'Test', interview: 'Interview', deadline: 'Deadline', email: 'Email', call: 'Call', offer: 'Offer', other: 'Other' };
export function saveEvent(id, b, by = 'phone') {
    const apps = applications(); const a = apps.find(x => x.id === id); if (!a) throw httpError(404, 'No such application.'); a.events ||= [];
    let e = b.id ? a.events.find(x => x.id === b.id) : null; if (b.id && !e) throw httpError(404, 'No such event.');
    if (!e) { e = { id: id6('e'), created: Date.now(), by, files: [] }; a.events.push(e); }
    if (b.type !== undefined) e.type = EVENT_TYPES[b.type] ? b.type : 'note';
    e.type ||= 'note';
    for (const k of ['title', 'date', 'time', 'stage']) if (b[k] !== undefined) e[k] = clip(b[k], k === 'title' ? 200 : 40);
    if (b.text !== undefined) e.text = clip(b.text, 10000);
    if (b.done !== undefined) e.done = !!b.done;
    if (e.date && !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) throw httpError(400, 'Date: YYYY-MM-DD.');
    e.updated = Date.now(); saveApps(apps);
    if (!b.id) log({ kind: 'event', by, what: `${a.title}${a.company ? ` at ${a.company}` : ''}: ${EVENT_TYPES[e.type]}${e.title ? ` "${e.title}"` : ''}${e.date ? ` on ${e.date}` : ''}` });
    return e;
}
export function removeEvent(id, eid) { const apps = applications(); const a = apps.find(x => x.id === id); if (!a) throw httpError(404, 'No such application.'); a.events = (a.events || []).filter(x => x.id !== eid); saveApps(apps); return { removed: eid }; }
// What is coming up: dated events not done, next steps, and deadlines of jobs you are going for.
export function upcoming(days = 60) {
    const today = new Date().toISOString().slice(0, 10); const until = new Date(Date.now() + days * 864e5).toISOString().slice(0, 10); const out = [];
    for (const a of applications()) {
        if (['rejected', 'withdrawn', 'accepted'].includes(a.stage)) continue;
        for (const e of a.events || []) if (e.date && !e.done && e.date <= until) out.push({ date: e.date, time: e.time || '', what: `${EVENT_TYPES[e.type]}${e.title ? `: ${e.title}` : ''}`, app: a.id, title: a.title, company: a.company, late: e.date < today, event: e.id });
        if (a.nextDate && a.nextDate <= until) out.push({ date: a.nextDate, what: `Next: ${a.next || 'step'}`, app: a.id, title: a.title, company: a.company, late: a.nextDate < today });
    }
    for (const j of board().jobs) if (['shortlisted', 'applying'].includes(j.status) && j.deadline && j.deadline >= today && j.deadline <= until) out.push({ date: j.deadline, what: 'Application closes', job: j.id, title: j.title, company: j.company || '' });
    return out.sort((x, y) => `${x.date}${x.time || ''}`.localeCompare(`${y.date}${y.time || ''}`));
}

// ---------- overview ----------
export function overview() {
    const b = board(); const apps = applications(); const live = apps.filter(a => !['rejected', 'withdrawn', 'accepted'].includes(a.stage));
    const today = new Date().toISOString().slice(0, 10);
    return { settings: settings(), counts: { jobs: b.jobs.filter(j => j.status !== 'hidden').length, new: b.jobs.filter(j => j.status === 'new').length, shortlisted: b.jobs.filter(j => j.status === 'shortlisted').length, scored: b.jobs.filter(j => j.match).length,
        applied: apps.filter(a => a.history.some(h => h.stage === 'applied')).length, inProgress: live.filter(a => a.stage !== 'preparing').length, toApply: b.jobs.filter(j => ['shortlisted', 'applying'].includes(j.status) && (!j.deadline || j.deadline >= today)).length,
        me: me().items.length, gaps: me().gaps.filter(g => g.status === 'open').length, cvs: cvs().length }, upcoming: upcoming(30).slice(0, 8), eventTypes: EVENT_TYPES };
}

// ---------- My CV: a LaTeX template with swappable sections ----------
// The template is a .tex file whose sections are marked with comment lines:
//     % @section{Experience}
//     ...LaTeX...
//     % @end
// Each section keeps variants: "base" (what the template had), your own, and AI suggestions (tagged with the job they
// were written for). A version picks one variant per section (or leaves a section out) and builds to PDF with latexmk.
const CVD = (...x) => P('cv', ...x);
const SECTION_RE = /^%\s*@section\{([^}]+)\}\s*\n([\s\S]*?)^%\s*@end\s*$/gm;
export const DEFAULT_TEX = String.raw`\documentclass[10.5pt,a4paper]{article}
\usepackage[margin=1.6cm]{geometry}
\usepackage[hidelinks]{hyperref}
\usepackage{enumitem,titlesec}
\setlist{nosep,leftmargin=1.2em}
\titleformat{\section}{\large\bfseries}{}{0em}{}[\titlerule]
\titlespacing{\section}{0pt}{10pt}{5pt}
\pagestyle{empty}
\begin{document}
% @section{Header}
{\LARGE\bfseries Your Name}\\[2pt]
City \textbullet{} email@example.com \textbullet{} 07000 000000 \textbullet{} \href{https://github.com/you}{github.com/you}
% @end
% @section{Summary}
\section*{Profile}
One or two lines on who you are and what you are looking for.
% @end
% @section{Experience}
\section*{Experience}
\textbf{Role} \hfill Company \textbullet{} 2024--now
\begin{itemize}
  \item What you did, and what changed because of it.
\end{itemize}
% @end
% @section{Projects}
\section*{Projects}
\textbf{Project name} \hfill \href{https://example.com}{link}
\begin{itemize}
  \item What it does, what you built, what it uses.
\end{itemize}
% @end
% @section{Skills}
\section*{Skills}
Languages: \dots \\ Tools: \dots
% @end
% @section{Education}
\section*{Education}
\textbf{Degree} \hfill University \textbullet{} 2021--2025
% @end
\end{document}
`;
const cvState = () => readJson(CVD('cv.json'), null);
function parseTemplate(tex) {
    const sections = []; let m; SECTION_RE.lastIndex = 0;
    while ((m = SECTION_RE.exec(tex))) sections.push({ name: clip(m[1], 60), text: m[2].replace(/\s+$/, '') });
    if (!sections.length) throw httpError(400, 'No sections found. Mark each one with a line "% @section{Name}" before it and "% @end" after it.');
    if (new Set(sections.map(s => s.name.toLowerCase())).size !== sections.length) throw httpError(400, 'Two sections have the same name.');
    return sections;
}
export function cvTemplate() {
    const s = cvState(); if (!s) return { template: null };
    return { template: { name: s.name, updated: s.updated }, sections: s.sections.map(x => ({ name: x.name, variants: x.variants.map(v => ({ id: v.id, label: v.label, by: v.by, job: v.job || null, at: v.at, text: v.text })) })), versions: s.versions || [], hasLatex: hasLatex() };
}
export function setTemplate({ tex, name = 'My CV' }, by = 'phone') {
    const t = String(tex ?? DEFAULT_TEX); if (t.length > 300_000) throw httpError(400, 'That template is too large.');
    const parsed = parseTemplate(t); const old = cvState();
    const sections = parsed.map(p => { const prev = old?.sections.find(x => x.name.toLowerCase() === p.name.toLowerCase()); const base = { id: 'base', label: 'Original', text: p.text, by, at: Date.now() }; return { name: p.name, variants: prev ? [base, ...prev.variants.filter(v => v.id !== 'base')] : [base] }; });
    fs.mkdirSync(CVD('versions'), { recursive: true }); share(CVD()); share(CVD('versions'));
    fs.mkdirSync(CVD('paper'), { recursive: true }); share(CVD('paper')); fs.writeFileSync(CVD('paper', 'main.tex'), t); share(CVD('paper', 'main.tex'));
    writeJson(CVD('cv.json'), { name: clip(name, 80), updated: Date.now(), sections, versions: old?.versions || [] });
    log({ kind: 'cv', by, what: `CV template ${old ? 'replaced' : 'set'}: ${parsed.length} sections (${parsed.map(p => p.name).join(', ')})` });
    return cvTemplate();
}
export function addVariant(section, { label, text, job = null }, by = 'phone') {
    const s = cvState(); if (!s) throw httpError(409, 'Set up your CV template first.');
    const sec = s.sections.find(x => x.name.toLowerCase() === String(section).toLowerCase()); if (!sec) throw httpError(404, `No section "${section}". Sections: ${s.sections.map(x => x.name).join(', ')}.`);
    const t = String(text || '').replace(/\s+$/, ''); if (t.length < 3) throw httpError(400, 'The variant needs some LaTeX.'); if (t.length > 40_000) throw httpError(400, 'Keep a section under 40 000 characters.');
    if (/\\(input|include|write18|openout|immediate)\b/.test(t)) throw httpError(400, 'A section cannot read or write files (\\input, \\include, \\write18…).');
    const v = { id: id6('v'), label: clip(label || (job ? 'Suggested' : 'Mine'), 60), text: t, by, job: job || null, at: Date.now() };
    sec.variants.push(v); s.updated = Date.now(); writeJson(CVD('cv.json'), s);
    log({ kind: 'cv', by, what: `New ${sec.name} variant: ${v.label}${job ? ` (for a job)` : ''}` });
    return v;
}
export function removeVariant(section, id) { const s = cvState(); const sec = s?.sections.find(x => x.name.toLowerCase() === String(section).toLowerCase()); if (!sec) throw httpError(404, 'No such section.'); if (id === 'base') throw httpError(400, 'The original stays; replace the template to change it.'); sec.variants = sec.variants.filter(v => v.id !== id); writeJson(CVD('cv.json'), s); return { removed: id }; }
// Render a choice of variants ({section: variantId|null}) into a complete .tex document.
export function renderCv(choice = {}) {
    const s = cvState(); if (!s) throw httpError(409, 'Set up your CV template first.');
    const tex = fs.readFileSync(CVD('paper', 'main.tex'), 'utf8');
    return tex.replace(SECTION_RE, (all, name) => {
        const sec = s.sections.find(x => x.name.toLowerCase() === name.trim().toLowerCase()); if (!sec) return all;
        const pick = Object.prototype.hasOwnProperty.call(choice, sec.name) ? choice[sec.name] : 'base';
        if (pick === null || pick === 'off') return `% (${sec.name} left out)\n`;
        const v = sec.variants.find(x => x.id === pick) || sec.variants[0];
        return `% @section{${sec.name}}\n${v.text}\n% @end`;
    });
}
function hasLatex() { return ['/usr/bin/latexmk', '/usr/local/bin/latexmk'].some(f => fs.existsSync(f)); }
// The template is edited in the LaTeX editor (workspace "jobs-cv"). After a save, the "Original" variant of each section
// follows the file, sections that disappeared are dropped, and new ones appear.
export function syncTemplate() {
    const s = cvState(); if (!s) return; const parsed = parseTemplate(fs.readFileSync(CVD('paper', 'main.tex'), 'utf8'));
    s.sections = parsed.map(p => { const prev = s.sections.find(x => x.name.toLowerCase() === p.name.toLowerCase()); const base = { id: 'base', label: 'Original', text: p.text, by: 'phone', at: Date.now() }; return { name: p.name, variants: prev ? [base, ...prev.variants.filter(v => v.id !== 'base')] : [base] }; });
    s.updated = Date.now(); writeJson(CVD('cv.json'), s);
}
// Build a choice into <outDir>/<base>.pdf: rendered into a scratch paper folder, built as the agent user (LaTeX is code).
export async function buildCv(choice, outDir, base = 'CV') {
    const tex = renderCv(choice); fs.mkdirSync(outDir, { recursive: true }); share(outDir);
    const tf = path.join(outDir, `${base}.tex`); fs.writeFileSync(tf, tex); share(tf);
    if (!hasLatex()) return { tex: tf, pdf: null, note: 'LaTeX is not installed: the .tex is saved. Add the Research app to build PDFs.' };
    const scratch = CVD('.build', crypto.randomBytes(4).toString('hex'));
    fs.mkdirSync(path.join(scratch, 'paper'), { recursive: true }); for (const d of [CVD('.build'), scratch, path.join(scratch, 'paper')]) share(d);
    for (const f of fs.readdirSync(CVD('paper'))) if (/\.(cls|sty|png|jpg|jpeg|pdf|bib)$/i.test(f) && f !== 'main.pdf') { fs.copyFileSync(CVD('paper', f), path.join(scratch, 'paper', f)); share(path.join(scratch, 'paper', f)); }
    fs.writeFileSync(path.join(scratch, 'paper', 'main.tex'), tex); share(path.join(scratch, 'paper', 'main.tex'));
    try {
        const r = await ws.buildPaper(scratch); const pdf = path.join(scratch, 'paper', 'build', 'main.pdf');
        if (!r.ok || !fs.existsSync(pdf)) throw httpError(422, `The CV did not build: ${(r.errors || []).slice(0, 3).join(' ') || 'see the LaTeX log'}`);
        const out = path.join(outDir, `${base}.pdf`); fs.copyFileSync(pdf, out); share(out); return { tex: tf, pdf: out, pages: r.pages };
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
export async function saveVersion({ name, choice, categories = [] }, by = 'phone') {
    const s = cvState(); if (!s) throw httpError(409, 'Set up your CV template first.');
    const n = clip(name, 80); if (n.length < 2) throw httpError(400, 'Name the version.');
    const id = id6('cv'); const r = await buildCv(choice || {}, CVD('versions', id), 'CV');
    const v = { id, name: n, choice: choice || {}, categories: [...new Set((Array.isArray(categories) ? categories : String(categories).split(',')).map(x => clip(x, 40)).filter(Boolean))], pdf: !!r.pdf, at: Date.now(), by };
    s.versions = [...(s.versions || []), v]; writeJson(CVD('cv.json'), s); log({ kind: 'cv', by, what: `CV version saved: ${n}` });
    return { ...v, note: r.note || null };
}
export function versionFile(id, ext = 'pdf') { const f = CVD('versions', id, `CV.${ext === 'tex' ? 'tex' : 'pdf'}`); if (!/^cv[0-9a-f]{6}$/.test(id) || !fs.existsSync(f)) throw httpError(404, 'No such file.'); return f; }
export async function previewCv(choice) { const dir = CVD('preview'); const r = await buildCv(choice || {}, dir, 'preview'); return { pdf: !!r.pdf, note: r.note || null }; }
export const previewFile = () => { const f = CVD('preview', 'preview.pdf'); if (!fs.existsSync(f)) throw httpError(404, 'No preview yet.'); return f; };
// Put a tailored CV into an application's "CV & Cover Letter" folder.
export async function cvForApplication(appId, choice, by = 'phone') {
    const a = applications().find(x => x.id === appId); if (!a) throw httpError(404, 'No such application.');
    const r = await buildCv(choice || {}, path.join(a.folder, 'CV & Cover Letter'), 'CV');
    updateApplication(appId, { cv: 'tailored' }, by); log({ kind: 'cv', by, what: `Tailored CV made for ${a.title}${a.company ? ` at ${a.company}` : ''}` });
    return { tex: path.relative(a.folder, r.tex), pdf: r.pdf ? path.relative(a.folder, r.pdf) : null, note: r.note || null };
}

// ---------- keys: saved straight into the Vault (general scope) ----------
export function setKey(source, values) {
    const s = SOURCES[source]; if (!s || !s.keys.length) throw httpError(400, 'That source needs no key.');
    const items = vault.list();
    for (const env of s.keys) {
        const v = String(values?.[env] ?? '').trim(); if (!v) continue;
        for (const it of items) if (it.scope === 'general' && it.fields.some(f => f.env === env && !f.missing)) vault.remove(it.id);
        vault.create({ name: env.toLowerCase().replace(/_/g, ' '), provider: source, envName: env, value: v, scope: 'general', notes: 'Job Hunt' });
    }
    log({ kind: 'settings', by: 'phone', what: `Key saved for ${s.title}` }); return keyStatus();
}

// ---------- wishes, advice and company research (agents) ----------
// A wish ("a data job in Leeds or remote") goes to a one-shot agent shell in /Jobs that has the jobs tools: it sets
// the search, runs the hunt, adds jobs it finds on the web, and scores the best. Advice on a job fans out probes
// (company values and news, visa or sponsorship, what to say) and keeps the answers on the job.
import * as probesKit from './kit/probes.js';
export const ADVICE = [
    { tag: 'company', title: 'The company', q: j => `Research ${j.company || 'this employer'} for a job applicant: what they do, size, recent news, stated values and culture, what employees say, and anything an applicant should know. Cite sources.` },
    { tag: 'role', title: 'The role and what to say', q: j => `A job: "${j.title}" at ${j.company || 'an employer'}${j.location ? ` in ${j.location}` : ''}.\n${(j.description || '').slice(0, 2500)}\n\nWhat will they be looking for, what should an applicant emphasise in a CV, cover letter and interview, what questions are likely, and what should the applicant ask them?` },
    { tag: 'visa', title: 'Right to work, visa and moving', q: (j, s) => `A job: "${j.title}" at ${j.company || 'an employer'}${j.location ? ` in ${j.location}` : ''}.${s?.nationality ? ` The applicant holds: ${s.nationality}.` : ' The applicant\'s nationality is not given: cover the main cases (citizens of that country or bloc, and others).'} What does the applicant need to work there legally: is a permit or visa needed, which route applies (e.g. in the UK the Skilled Worker visa and whether the employer is on the Register of Licensed Sponsors for that route; in the EU the EU Blue Card or the country's national work permits, salary thresholds, recognition of qualifications), what the process involves, how long it takes and what it costs? Then what to know about relocating there: registering, tax ID, health insurance, bank account, language. Cite official government sources.` },
    { tag: 'pay', title: 'Pay, tax and cost of living', q: j => `A job: "${j.title}"${j.salary ? ` paying ${j.salary}` : ''}${j.location ? ` in ${j.location}` : ''}. What is typical pay for this role there? Work out the yearly take-home for a single person under that country's rules: income tax (national and local), social security contributions, mandatory pension or health insurance, church or other taxes that apply by default, and any expat or new-resident regimes (e.g. the Netherlands' 30% ruling). Then the yearly cost of living there for one person: rent, local taxes, utilities, food, transport. Show each figure, the currency, the tax year and sources.` },
];
export function adviceFor(id) { const dir = P('advice', id); return probesKit.list(dir); }
export async function askAdvice(id, { topics = ['company', 'role'], extra = '', agent, model } = {}, by = 'phone') {
    const j = getJob(id); const s = settings(); const dir = P('advice', id); fs.mkdirSync(dir, { recursive: true }); share(P('advice')); share(dir);
    const out = [];
    for (const t of ADVICE.filter(a => topics.includes(a.tag))) {
        out.push(await probesKit.start(dir, { subject: `${j.company || j.title} (${t.title})`, question: t.q(j, s) + (extra ? `\n\nAlso: ${clip(extra, 800)}` : ''), agent: agent || s.agent || 'claude', model: model ?? s.model ?? '', web: true, by, tag: t.tag,
            onDone: p => log({ kind: 'advice', by: p.agent, what: `${t.title} for ${j.title}: ${p.status}`, ms: p.finished - p.at }) }));
    }
    if (extra && !topics.length) out.push(await probesKit.start(dir, { subject: j.company || j.title, question: `About the job "${j.title}" at ${j.company || 'an employer'}: ${clip(extra, 2000)}`, agent: agent || s.agent || 'claude', model: model ?? s.model ?? '', web: true, by, tag: 'question' }));
    log({ kind: 'advice', by, what: `Advice asked for ${j.title}: ${out.map(p => p.tag).join(', ')}` });
    return out;
}
// Wishes are kept so the board can show what was asked and what came of it.
export function wishes() {
    const list = (readJson(P('wishes.json'), { wishes: [] }) || { wishes: [] }).wishes; let changed = false;
    for (const w of list) if (w.status === 'started' && fs.existsSync(path.join(config.state, 'oneshot', `wish-${w.id.slice(1)}.json`))) { w.status = 'ended'; w.summary = 'The agent finished without a summary. Its output is under Home → Temp → Results.'; w.finished = Date.now(); changed = true; }
    if (changed) writeJson(P('wishes.json'), { wishes: list });
    return list;
}
export function addWish(text, by = 'phone') {
    const t = clip(text, 600); if (t.length < 4) throw httpError(400, 'Say what kind of job you want.');
    const list = wishes(); const w = { id: id6('w'), text: t, at: Date.now(), by, status: 'started' }; list.unshift(w); writeJson(P('wishes.json'), { wishes: list.slice(0, 100) });
    log({ kind: 'wish', by, what: `Wish: ${t}` }); return w;
}
export function finishWish(id, { status = 'done', summary = '' } = {}) { const list = wishes(); const w = list.find(x => x.id === id); if (!w) throw httpError(404, 'No such wish.'); w.status = status; w.summary = clip(summary, 2000); w.finished = Date.now(); writeJson(P('wishes.json'), { wishes: list }); return w; }
export function importPrompt(cv, { template = false } = {}) {
    return `Build my Me map from my CV "${cv.name}" (CV file id ${cv.id}).\n1. read_cv (id ${cv.id}) and me_summary.\n2. For every project, job or role, qualification, education, skill and achievement in it, call propose_me with what the CV says (title, org, dates, a summary in my words, tags, evidence such as numbers and results, level only if the CV makes it clear) and sources [{"title": "CV: ${cv.name}"}]. Then link related items with link_me (skills and achievements to the role or project they came from). Do not invent or embellish; things the CV implies but does not state go in "why" with confidence "low".\n` +
        (template ? `3. If cv_sections says there is no template yet, write my CV as a clean one- or two-page LaTeX article (geometry, enumitem, titlesec, hyperref only; no other packages, no \\input) with each section marked by a line "% @section{Name}" before it and "% @end" after it, using exactly the CV's content, and save it with set_cv_template.\n` : '') +
        `Finish with a short summary: how many items you proposed, and anything you could not read. I will confirm each item on the Me tab.`;
}
export function findMePrompt({ name, links = '', hints = '' }) {
    return `Find what is publicly on record about my own work, to build my Me map for job hunting. I asked for this and it is about me.\n\nMy name: ${clip(name, 120)}\nMy profiles and links: ${clip(links, 1500) || '(none given)'}\nHints (where I studied or worked, topics): ${clip(hints, 1500) || '(none)'}\n\n` +
        `Search the web like a careful researcher. Start from the links I gave, then search my name together with the hints. Look for: code and repositories, projects and demos, publications and theses, talks, competition or CTF results, awards, certifications with public verification, articles I wrote, news mentioning my work, and public professional profiles.\n` +
        `For each finding call propose_me with: kind, title, summary, org, dates, tags, evidence, and sources [{url, title, note}] (every item needs at least one URL), "why" (how you know it is me), and confidence: high (my own linked profile or repo), medium (name plus a matching hint), low (name only). Anything that may be someone else with my name: confidence low, and say so in why.\n` +
        `Never collect private details: no home address, phone, family, date of birth, finances, health or private social accounts. Skip anything that is not about my work, study or achievements.\nRead me_summary first and do not duplicate items already there (you may propose extra sources and evidence for them with the same kind and title). Finish with a short summary of what you found and what is uncertain. I will confirm each item.`;
}
export function webHuntPrompt(s) {
    return `Search the web for jobs that match my search settings, beyond the job-site APIs: company career pages, sector job boards, graduate-scheme lists and recruiter sites.\nKeywords: ${s.keywords || '(read Me and infer suitable roles)'}\nPlaces: ${s.locations || 'anywhere'}${s.remote ? ' (and remote)' : ''}\nCountries: ${s.countries || 'gb'}\nLowest salary: ${s.salaryMin || 'not set'}\nRule out: ${s.exclude || 'nothing'}\n\n` +
        `Read me_summary first. Add each real, open job with add_job (title, company, location, salary, deadline, url of the actual advert, the advert text and requirements). Check the advert is still open and the link works; skip aggregator pages without a real advert. Aim for 10 to 20 good ones, then score the best 5 (compatibility, save_match, save_money). Finish with a short summary.`;
}
export function wishPrompt(w) {
    return `A job wish from the person this Job Hunt is for:\n\n"${w.text}"\n\nWish id: ${w.id}. Work it through with the jobs tools (MCP server "jobs", or the \`jobhunt\` command):\n` +
        `1. Read Me (me_summary) so you know who this is for.\n2. Set the search from the wish (set_search: keywords, locations, remote, salary floor) and run hunt.\n` +
        `3. Search the web too for strong matches the job sites miss, and add each with add_job (title, company, location, salary, url, requirements).\n` +
        `4. For the 5 to 10 best new jobs: list_jobs, show_job, compatibility, then save_match (per requirement: meets/partly/gap with Me evidence ids) and save_money (take-home, living, left over, with assumptions).\n` +
        `5. Finish with finish_wish (id ${w.id}) and a short summary: what you found, the best three and why, and gaps worth closing.\nNever invent experience the person does not have; gaps are useful.`;
}

// ---------- agent tools (one list: the jobs CLI and the jobs MCP server both come from it) ----------
import * as kit from './kit/tools.js';
const meLine = i => `${i.id} [${i.kind}${i.level ? `, ${i.level}` : ''}${i.status === 'proposed' ? ', UNVERIFIED' : ''}] ${i.title}${i.org ? ` (${i.org})` : ''}${i.from ? ` ${i.from}${i.to ? `–${i.to}` : ''}` : ''}`;
const jobLine = j => `${j.id} ${j.status === 'new' ? '' : `[${j.status}] `}${j.title}${j.company ? ` · ${j.company}` : ''}${j.location ? ` · ${j.location}` : ''}${j.salary ? ` · ${j.salary}` : ''}${j.match ? ` · match ${j.match.score}` : ''}`;
kit.registerApp('jobs', {
    context(shell) { if (!shell?.cwd || !inJobs(shell.cwd)) { const e = new Error('Job Hunt tools work from a shell in the Job Hunt folder.'); e.status = 403; throw e; } return {}; },
    tools: [
        { name: 'me_summary', description: 'Everything about the person: projects, roles, skills, education, qualifications, achievements (id, kind, level, dates). Read this first.', inputSchema: kit.obj({ kind: kit.str('Only this kind: project, role, skill, education, cert, achievement, interest') }),
            run: (c, a) => { const m = me(); const items = m.items.filter(i => !a.kind || i.kind === a.kind); const notes = (m.notes || []).map(n => `note ${n.id}${n.topic ? ` [${n.topic}]` : ''}: ${n.text}`); return items.length ? [...items.map(meLine), ...(notes.length ? ['', 'Notes:', ...notes] : [])].join('\n') : 'Me is empty: ask the person about their experience (add_me) before judging fit.'; } },
        { name: 'me_item', description: 'One Me item in full: summary, evidence, tags, links.', inputSchema: kit.obj({ id: kit.str('Me item id') }, ['id']), run: (c, a) => { const i = me().items.find(x => x.id === a.id); if (!i) throw httpError(404, 'No such item.'); return i; } },
        { name: 'add_me', description: 'Add or update a Me item (same kind and title updates it). Only what the person told you or what their files show.', inputSchema: kit.obj({ kind: kit.str('project | role | skill | education | cert | achievement | interest'), title: kit.str('Title'), summary: kit.str('What it was and what they did'), level: kit.str('aware | working | strong | expert'), org: kit.str('Company, university or client'), from: kit.str('Start (YYYY or YYYY-MM)'), to: kit.str('End, or "now"'), tags: kit.arr('Skills and tools it shows'), evidence: kit.arr('Concrete evidence: results, numbers, links, files'), links: kit.arr('Ids of related Me items') }, ['kind', 'title']),
            run: (c, a, by) => meLine(addMe(a, by)) },
        { name: 'propose_me', description: 'Propose a Me item you found (in the person\'s CV or online) for them to confirm. Needs sources; say in "why" how you know it is theirs, and how sure you are.', inputSchema: kit.obj({ kind: kit.str('project | role | skill | education | cert | achievement | interest'), title: kit.str('Title'), summary: kit.str('What it was and what they did'), level: kit.str('aware | working | strong | expert, only if clear'), org: kit.str('Company, university or client'), from: kit.str('Start'), to: kit.str('End, or now'), tags: kit.arr('Skills and tools it shows'), evidence: kit.arr('Concrete evidence'), links: kit.arr('Ids of related Me items'), sources: kit.arr('Where it comes from', kit.obj({ url: kit.str('Link'), title: kit.str('Title'), note: kit.str('What it shows') })), why: kit.str('How you know it is this person'), confidence: kit.str('high | medium | low') }, ['kind', 'title', 'sources']),
            run: (c, a, by) => meLine(addMe({ ...a, proposed: true }, by)) },
        { name: 'list_applications', description: 'Applications: stage, next step, and dated events.', inputSchema: kit.obj({}), run: () => applications().map(a => `${a.id} [${a.stage}] ${a.title}${a.company ? ` · ${a.company}` : ''} (job ${a.job})${a.next ? ` · next: ${a.next} ${a.nextDate || ''}` : ''}${(a.events || []).filter(e => !e.done && e.date).map(e => `\n    ${e.date} ${e.type}: ${e.title || ''}`).join('')}`).join('\n') || 'No applications.' },
        { name: 'add_event', description: 'Add a dated item to an application\'s timeline (a test to take, an interview, a deadline, a note). Only what the person told you or an email they shared shows.', inputSchema: kit.obj({ app: kit.str('Application id'), type: kit.str('note | test | interview | deadline | email | call | offer | other'), title: kit.str('Title'), date: kit.str('YYYY-MM-DD'), time: kit.str('HH:MM'), text: kit.str('Details') }, ['app', 'type']),
            run: (c, a, by) => { const e = saveEvent(a.app, a, by); return `Added ${e.type} ${e.date || ''}`; } },
        { name: 'list_frameworks', description: 'Assessment frameworks employers use (SFIA, Civil Service Success Profiles, DDaT, e-CF, ECSF, NICE, CIISec, NHS KSF, or the advert\'s own competencies).', inputSchema: kit.obj({}), run: () => frameworks().map(f => `${f.id}: ${f.title} (${f.region})`).join('\n') },
        { name: 'framework_info', description: 'One framework: its scale, levels, elements, how assessors score, and the official URL to read the real descriptions.', inputSchema: kit.obj({ id: kit.str('Framework id') }, ['id']), run: (c, a) => { const f = frameworks().find(x => x.id === a.id); if (!f) throw httpError(404, 'No such framework.'); return f; } },
        { name: 'detect_framework', description: 'Which framework a job\'s advert points to (by its wording: grades, bands, framework names).', inputSchema: kit.obj({ job: kit.str('Job id') }, ['job']), run: (c, a) => detectFrameworks(a.job) },
        { name: 'save_assessment', description: 'Save a framework assessment for a job: target grade or level, and per element the required level, the level the confirmed Me evidence supports (on the framework scale), the Me ids and a rationale. A blind second assessor then rates the same elements.', inputSchema: kit.obj({ job: kit.str('Job id'), framework: kit.str('Framework id'), target: kit.str('Grade, band or role level, e.g. "HEO", "SFIA 3", "DDaT associate"'), summary: kit.str('Likely sift outcome and why'), elements: kit.arr('Elements', kit.obj({ id: kit.str('Short id'), name: kit.str('Element name'), kind: kit.str('behaviour, skill, experience, technical…'), required: kit.str('Level required'), level: kit.num('Level the evidence supports'), evidence: kit.arr('Me ids'), rationale: kit.str('Why') })) }, ['job', 'framework', 'elements']),
            run: (c, a, by) => { const r = saveAssessment(a.job, a, by); return `Saved ${r.elements.length} elements; the blind review has started.`; } },
        { name: 'cpd_entries', description: 'The person\'s CPD log: what they did and learned, by date (new entries only unless all is true).', inputSchema: kit.obj({ all: kit.bool('Include entries already read into Me') }), run: (c, a) => cpd().filter(e => a.all || !e.processed).sort((x, y) => x.date.localeCompare(y.date)).map(e => `${e.id} ${e.date} [${e.type}${e.hours ? `, ${e.hours} h` : ''}]${e.project ? ` (${e.project}${e.meId ? ` = ${e.meId}` : ''})` : ''}${(e.tags || []).length ? ` #${e.tags.join(' #')}` : ''}: ${e.text}`).join('\n') || 'No new entries.' },
        { name: 'mark_cpd_processed', description: 'Mark CPD entries as read into Me.', inputSchema: kit.obj({ ids: kit.arr('Entry ids') }, ['ids']), run: (c, a) => markCpd(a.ids || []) },
        { name: 'add_me_note', description: 'Add a free note to Me: context that helps assessments (e.g. which example best shows a behaviour, what the person did in a group project). Not a level: levels are judged per job.', inputSchema: kit.obj({ text: kit.str('The note'), topic: kit.str('Short topic, e.g. "Delivering at Pace" or "SFIA: SCTY"') }, ['text']), run: (c, a, by) => addNote(a, by) },
        { name: 'previous_assessments', description: 'Earlier assessments of other jobs against a framework, with the Me version they used (the current Me version is given). For consistency: levels are per job, but the same evidence should be read the same way.', inputSchema: kit.obj({ framework: kit.str('Framework id') }, ['framework']),
            run: (c, a) => { const v = meVersion(); const out = board().jobs.flatMap(j => (j.assess || []).filter(x => x.framework === a.framework).map(x => `${j.title}${j.company ? ` · ${j.company}` : ''} [${x.target || ''}] Me ${x.meVersion === v ? 'unchanged' : 'changed since'}: ${x.elements.map(e => `${e.name} ${e.level ?? '–'}${e.blind !== undefined && e.blind !== null ? `/${e.blind}` : ''}`).join('; ')}`)); return `Current Me version ${v}\n${out.join('\n') || 'None yet.'}`; } },
        { name: 'link_me', description: 'Link Me items to each other (e.g. a skill to the project that shows it, an achievement to its role). Use after proposing, once both ids exist.', inputSchema: kit.obj({ id: kit.str('Me item id'), to: kit.arr('Ids to link it to') }, ['id', 'to']),
            run: (c, a) => { const m = me(); const it = m.items.find(i => i.id === a.id); if (!it) throw httpError(404, 'No such item.'); const ok = (a.to || []).filter(x => x !== a.id && m.items.some(i => i.id === x)); it.links = [...new Set([...(it.links || []), ...ok])].slice(0, 40); saveMe(m); return `${it.title}: ${it.links.length} links`; } },
        { name: 'doc_files', description: 'The person\'s own documents (reports, papers, theses, slides): id, name, kind, whether read into Me yet.', inputSchema: kit.obj({}), run: () => docs().map(x => `${x.id} ${x.name}${x.kind ? ` (${x.kind})` : ''}${x.read ? ' [read into Me]' : ''}`).join('\n') || 'No documents.' },
        { name: 'read_doc', description: 'The text of one of the person\'s documents (page breaks and slides marked).', inputSchema: kit.obj({ id: kit.str('Document id') }, ['id']), run: async (c, a) => docText(a.id) },
        { name: 'mark_doc_read', description: 'Mark a document as read into Me.', inputSchema: kit.obj({ id: kit.str('Document id') }, ['id']), run: (c, a) => { markDocRead(a.id); return 'ok'; } },
        { name: 'cv_files', description: 'The person\'s uploaded CV files (id, name, categories).', inputSchema: kit.obj({}), run: () => cvs().map(x => `${x.id} ${x.name} (${x.original})${x.categories.length ? ` [${x.categories.join(', ')}]` : ''}`).join('\n') || 'No CV files.' },
        { name: 'read_cv', description: 'The text of an uploaded CV file.', inputSchema: kit.obj({ id: kit.str('CV file id') }, ['id']), run: async (c, a) => cvText(a.id) },
        { name: 'set_cv_template', description: 'Create the person\'s LaTeX CV template (only when there is none yet). Mark each section with a line "% @section{Name}" before it and "% @end" after it.', inputSchema: kit.obj({ tex: kit.str('The whole .tex document'), name: kit.str('Name for it') }, ['tex']),
            run: (c, a, by) => { if (cvTemplate().template) throw httpError(409, 'There is already a template: suggest section variants instead.'); if (/\\(input|include|write18|openout|immediate)\b/.test(a.tex)) throw httpError(400, 'No \\input, \\include or \\write18.'); const t = setTemplate({ tex: a.tex, name: a.name || 'My CV' }, by); return `Template saved: ${t.sections.map(x => x.name).join(', ')}`; } },
        { name: 'set_search', description: 'Set what the hunt looks for.', inputSchema: kit.obj({ keywords: kit.str('Job-site search words'), locations: kit.str('Places, comma-separated'), remote: kit.bool('Include remote jobs'), salaryMin: kit.num('Lowest yearly salary'), exclude: kit.str('Words that rule a job out, comma-separated') }),
            run: (c, a) => { const s = setSettings(a); return `Search: "${s.keywords}" in ${s.locations || 'anywhere'}${s.remote ? ' (and remote)' : ''}${s.salaryMin ? `, from ${s.salaryMin}` : ''}`; } },
        { name: 'hunt', description: 'Run the job-site search now (Adzuna, Reed, Jooble when keys are set; Remotive, Arbeitnow always). New jobs land on the board.', inputSchema: kit.obj({}), run: async (c, a, by) => hunt(by) },
        { name: 'list_jobs', description: 'Jobs on the board.', inputSchema: kit.obj({ status: kit.str('new | shortlisted | applying | applied | hidden'), unscored: kit.bool('Only jobs without a match yet'), limit: kit.num('How many (default 40)') }),
            run: (c, a) => board().jobs.filter(j => (a.status ? j.status === a.status : j.status !== 'hidden') && (!a.unscored || !j.match)).sort((x, y) => y.found - x.found).slice(0, a.limit || 40).map(jobLine).join('\n') || 'No jobs.' },
        { name: 'show_job', description: 'One job in full (description, requirements, match, money).', inputSchema: kit.obj({ id: kit.str('Job id') }, ['id']), run: (c, a) => getJob(a.id) },
        { name: 'add_job', description: 'Add a job you found (the same url or title and company updates it).', inputSchema: kit.obj({ title: kit.str('Job title'), company: kit.str('Employer'), location: kit.str('Where'), salary: kit.str('As advertised'), salaryMin: kit.num('Yearly, low end'), salaryMax: kit.num('Yearly, high end'), deadline: kit.str('YYYY-MM-DD'), url: kit.str('Link to the advert'), description: kit.str('The advert text'), requirements: kit.arr('Each requirement, one per item'), category: kit.str('A short category, e.g. "Data", "Security"') }, ['title']),
            run: (c, a, by) => jobLine(addJob({ ...a, source: a.source || 'agent' }, by)) },
        { name: 'set_requirements', description: 'Store the requirements you read from a job advert (one per item).', inputSchema: kit.obj({ id: kit.str('Job id'), requirements: kit.arr('Requirements') }, ['id', 'requirements']), run: (c, a, by) => jobLine(updateJob(a.id, { requirements: a.requirements }, by)) },
        { name: 'compatibility', description: 'For each requirement of a job, the Me items most likely to be evidence (by shared words). Judge each yourself, open items with me_item, and ask the person for an example when nothing fits.', inputSchema: kit.obj({ id: kit.str('Job id'), requirements: kit.arr('Requirements to check, if the job has none stored') }, ['id']),
            run: (c, a) => { const j = getJob(a.id); const reqs = a.requirements?.length ? a.requirements : j.requirements || []; if (!reqs.length) return 'This job has no requirements stored: read the advert (show_job) and call set_requirements first.'; return candidates(reqs).map(r => `• ${r.requirement}\n${r.candidates.length ? r.candidates.map(x => `    ${x.id} ${x.title}${x.level ? ` (${x.level})` : ''} — shares: ${x.hits.join(', ')}`).join('\n') : '    (nothing in Me: a gap, or ask the person)'}`).join('\n'); } },
        { name: 'save_match', description: 'Save your judgement of fit: score 0-100, a summary, the likely level (e.g. graduate, junior, mid), and per requirement meets/partly/gap with Me evidence ids. Gaps become questions for the person.', inputSchema: kit.obj({ id: kit.str('Job id'), score: kit.num('0 to 100'), summary: kit.str('Why, in two or three sentences'), level: kit.str('The level this person would come in at'), lines: kit.arr('Per requirement', kit.obj({ requirement: kit.str('Requirement'), verdict: kit.str('meets | partly | gap'), evidence: kit.arr('Me item ids'), note: kit.str('Why') })), cv: kit.str('Best CV id or version for it') }, ['id', 'score']),
            run: (c, a, by) => jobLine(setMatch(a.id, a, by)) },
        { name: 'uk_estimate', description: 'A rough UK take-home for a gross salary (tax, NI, student loan, pension). UK jobs only: for other countries work it out from that country\'s tax and social-security rules (search official sources).', inputSchema: kit.obj({ gross: kit.num('Yearly gross') }, ['gross']), run: (c, a) => ukEstimate(a.gross, settings().money) },
        { name: 'save_money', description: 'Save the money line for a job (yearly, in the job\'s local currency): gross, take-home, living costs where the job is, what is left, and your assumptions (tax rules and year, sources).', inputSchema: kit.obj({ id: kit.str('Job id'), currency: kit.str('ISO code: GBP, EUR, CHF…'), gross: kit.num('Gross'), takeHome: kit.num('After tax, NI, loan, pension'), living: kit.num('Rent, bills, council tax, food, travel'), left: kit.num('Left over'), assumptions: kit.str('How you worked it out and the sources') }, ['id']),
            run: (c, a, by) => { const j = setMoney(a.id, a, by); return `${jobLine(j)} · left ${j.money.left ?? '?'}`; } },
        { name: 'add_gap', description: 'Note something jobs ask for that Me has no evidence of, for the person to answer.', inputSchema: kit.obj({ text: kit.str('The gap, as a question to the person'), job: kit.str('Job id') }, ['text']), run: (c, a, by) => addGap(a, by) },
        { name: 'cv_sections', description: 'The person\'s CV template sections and the variants of each (ids and labels).', inputSchema: kit.obj({}), run: () => { const t = cvTemplate(); if (!t.template) return 'No CV template yet.'; return t.sections.map(s => `${s.name}: ${s.variants.map(v => `${v.id} "${v.label}"${v.job ? ` (for ${v.job})` : ''}`).join(', ')}`).join('\n'); } },
        { name: 'cv_section_text', description: 'The LaTeX of one CV section variant.', inputSchema: kit.obj({ section: kit.str('Section name'), variant: kit.str('Variant id (default: base)') }, ['section']), run: (c, a) => { const t = cvTemplate(); const s = t.sections?.find(x => x.name.toLowerCase() === a.section.toLowerCase()); if (!s) throw httpError(404, 'No such section.'); return (s.variants.find(v => v.id === (a.variant || 'base')) || s.variants[0]).text; } },
        { name: 'suggest_cv_section', description: 'Suggest a rewrite of one CV section (LaTeX, same style as the template) for a job. Only true things from Me. The person picks it in the CV builder.', inputSchema: kit.obj({ section: kit.str('Section name'), label: kit.str('Short label'), text: kit.str('The LaTeX'), job: kit.str('Job id it is for') }, ['section', 'text']),
            run: (c, a, by) => addVariant(a.section, a, by) },
        { name: 'save_draft', description: 'Save a draft for a job as Markdown (cover-letter, application-answers, interview-prep, thank-you, offer-checklist, or another short name). Also copied into the job\'s application folder if there is one.', inputSchema: kit.obj({ job: kit.str('Job id'), name: kit.str('Short name, e.g. cover-letter'), text: kit.str('The draft, in Markdown') }, ['job', 'name', 'text']),
            run: (c, a, by) => saveDraft(a.job, a.name, a.text, by) },
        { name: 'read_draft', description: 'Read a saved draft for a job.', inputSchema: kit.obj({ job: kit.str('Job id'), name: kit.str('Draft name') }, ['job', 'name']), run: (c, a) => readDraft(a.job, a.name) },
        { name: 'job_advice', description: 'The research answers already gathered for a job (company, role, visa, pay).', inputSchema: kit.obj({ job: kit.str('Job id') }, ['job']), run: (c, a) => adviceFor(a.job).filter(p => p.status === 'done').map(p => `## ${p.subject}\n${p.answer}`).join('\n\n') || 'No research yet.' },
        { name: 'finish_wish', description: 'Close a wish with a short summary for the person.', inputSchema: kit.obj({ id: kit.str('Wish id'), summary: kit.str('What you found, the best three and why, gaps to close') }, ['id', 'summary']), run: (c, a) => finishWish(a.id, { summary: a.summary }) },
        { name: 'log', description: 'Recent Job Hunt activity.', inputSchema: kit.obj({}), run: () => readLog(40).map(e => `${new Date(e.t).toISOString().slice(0, 16)} ${e.by}: ${e.what}`).join('\n') },
    ],
});

// ---------- the CV template as an editor workspace ----------
ws.register({ id: 'jobs-cv', title: 'CV template', caps: ['build', 'spell'], dir: () => (fs.existsSync(CVD('paper', 'main.tex')) ? CVD() : null), afterWrite: rel => { if (rel === 'main.tex') syncTemplate(); } });

// ---------- each job as a project: stages, checklists, drafts ----------
// The stages follow the playbook (deploy/jobs/playbook.md, editable under AI prompts). Each stage has a checklist the
// person ticks and work an agent can do: research fans out probes; tailor, interview and follow-up run a one-shot agent
// in the Job Hunt folder that writes drafts (cover letter, answers, interview prep) and CV section suggestions.
export const PLAN = [
    { id: 'research', title: 'Research', ai: 'Research the employer', items: [['what', 'What they do, for whom'], ['values', 'Mission and values, with my examples'], ['news', 'Recent news'], ['people', 'Who leads the team'], ['market', 'Competitors and trends'], ['reviews', 'What working there is like'], ['visa', 'Right to work or sponsorship'], ['ask', 'Questions to ask them']] },
    { id: 'tailor', title: 'Tailor', ai: 'Tailor my CV and draft the letter', items: [['reqs', 'Requirements mapped to Me'], ['cv', 'CV version chosen'], ['letter', 'Cover letter written'], ['answers', 'Application questions answered']] },
    { id: 'apply', title: 'Apply', ai: null, items: [['deadline', 'Deadline checked'], ['sent', 'Application sent'], ['record', 'What I sent is in the folder'], ['tests', 'Online tests practised']] },
    { id: 'interview', title: 'Interview', ai: 'Prepare me for the interview', items: [['stories', '6–8 STAR stories ready'], ['likely', 'Likely questions practised'], ['tech', 'Technical topics revised'], ['myq', 'My questions for them'], ['logistics', 'Format, people, time, what to bring']] },
    { id: 'followup', title: 'Follow up', ai: 'Draft the follow-up', items: [['thanks', 'Thank-you sent'], ['feedback', 'Feedback asked for (if rejected)'], ['offer', 'Offer compared (if offered)']] },
];
export function setPlan(id, { stage, item, done } = {}, by = 'phone') {
    const b = board(); const j = b.jobs.find(x => x.id === id); if (!j) throw httpError(404, 'No such job.');
    j.plan ||= { stage: 'research', done: {} };
    if (stage !== undefined) { if (!PLAN.some(s => s.id === stage)) throw httpError(400, 'No such stage.'); j.plan.stage = stage; log({ kind: 'plan', by, what: `${j.title}: ${PLAN.find(s => s.id === stage).title}` }); }
    if (item !== undefined) { const ok = PLAN.some(s => s.items.some(([k]) => `${s.id}.${k}` === item)); if (!ok) throw httpError(400, 'No such checklist item.'); if (done) j.plan.done[item] = Date.now(); else delete j.plan.done[item]; }
    j.updated = Date.now(); saveBoard(b); return j.plan;
}
const DRAFT_NAME = /^[a-z0-9][a-z0-9-]{1,40}$/;
const draftDir = id => P('drafts', id);
export function drafts(id) { try { return fs.readdirSync(draftDir(id)).filter(f => f.endsWith('.md')).map(f => { const st = fs.statSync(path.join(draftDir(id), f)); return { name: f.slice(0, -3), size: st.size, at: st.mtimeMs }; }).sort((a, b) => b.at - a.at); } catch { return []; } }
export function readDraft(id, name) { if (!DRAFT_NAME.test(name)) throw httpError(400, 'Bad draft name.'); getJob(id); try { return fs.readFileSync(path.join(draftDir(id), `${name}.md`), 'utf8'); } catch { throw httpError(404, 'No such draft.'); } }
export function saveDraft(id, name, text, by = 'phone') {
    const j = getJob(id); const n = String(name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40); if (!DRAFT_NAME.test(n)) throw httpError(400, 'Name the draft (letters, digits, dashes), e.g. cover-letter.');
    const t = String(text || ''); if (t.trim().length < 10 || t.length > 200_000) throw httpError(400, 'The draft is empty or too long.');
    writeLetter(id, n, t, {}, 'agent'); const app = applications().find(a => a.job === id && !['rejected', 'withdrawn'].includes(a.stage));
    log({ kind: 'draft', by, what: `Draft "${n}" for ${j.title}${j.company ? ` at ${j.company}` : ''}` }); return { name: n, copiedTo: app ? path.relative(ROOT, app.folder) : null };
}
// The brief agents read: the Job Hunt brief, then the playbook (both editable under AI prompts).
export function writeBrief() {
    try { fs.mkdirSync(P('.platopypus'), { recursive: true }); fs.writeFileSync(P('.platopypus', 'jobs.md'), `${(prompts.text('jobs-brief') || '# Job Hunt').trim()}\n\n${(prompts.text('jobs-playbook') || '').trim()}\n`); share(P('.platopypus', 'jobs.md')); } catch { /* not set up */ }
}
export function stagePrompt(j, stage, extra = '') {
    const head = `Job ${j.id}: "${j.title}"${j.company ? ` at ${j.company}` : ''}${j.location ? ` (${j.location})` : ''}. Follow the playbook in $PORTHOLE_SECURITY_FILE for this stage. Use the jobs tools (MCP server "jobs", or the \`jobhunt\` command). Read me_summary and show_job first.\n\n`;
    const tail = `${extra ? `\nThe person adds: ${clip(extra, 1500)}\n` : ''}\nOnly true things from Me; record gaps with add_gap. Never contact the employer or send anything. Finish with a two-line summary of what you saved.`;
    if (stage === 'tailor') return `${head}Stage: Tailor.\n1. If the job has no requirements stored, read the advert and call set_requirements (essential first).\n2. compatibility, then save_match if not scored yet.\n3. cv_sections and cv_section_text, then suggest_cv_section (job ${j.id}) for the two or three sections that matter most for this job, in the template's LaTeX style.\n4. save_draft name "cover-letter": a UK one-page cover letter as the playbook describes, using any research in the job's advice (show_job shows it).\n5. If the advert has application questions, save_draft "application-answers".\n6. If show_job has a framework assessment, write to it: for Civil Service Success Profiles, save_draft "behaviour-statements" with one STAR example per behaviour assessed (about 250 words each, or the advert's limit) and "personal-statement" against the essential criteria; for SFIA, DDaT or similar, make the CV suggestions use the level language (autonomy, influence, complexity) honestly.${tail}`;
    if (stage === 'interview') return `${head}Stage: Interview.\nsave_draft name "interview-prep" with: the likely format; 6–8 STAR stories from Me mapped to the job's competencies (Situation, Task, Action (most of it), Result, first person); 10–15 likely questions (motivation, competency, technical, scenario) each with notes on which story or points to use; technical topics to revise; 5 questions to ask them drawn from the research; and a short logistics checklist. Where Me lacks a story for a competency, add_gap.${tail}`;
    if (stage === 'followup') return `${head}Stage: Follow up.\nsave_draft "thank-you": a short, specific thank-you message to send after the interview (leave [placeholders] for names and details the person must fill in). Also save_draft "offer-checklist": what to compare if an offer comes (pay, take-home vs living costs using save_money figures, pension, holiday, hybrid, training, progression, start date) and how to negotiate politely on facts.${tail}`;
    throw httpError(400, 'That stage has no agent work.');
}

// ---------- my documents: reports, papers, theses, slides, anything that shows what you have done ----------
// Kept in /Jobs/docs (docs.json lists them). "Read into Me" sends one to an agent that breaks it into the project, the
// skills it shows and the results, as proposals citing the document and the page or section.
const DOC_EXT = ['.pdf', '.docx', '.odt', '.pptx', '.md', '.txt', '.tex'];
const docsFile = () => P('docs', 'docs.json');
export function docs() { return (readJson(docsFile(), { docs: [] }) || { docs: [] }).docs; }
export function addDoc({ name, file, data, kind = '', notes = '' }, by = 'phone') {
    const list = docs(); const ext = path.extname(String(file || '')).toLowerCase(); if (!DOC_EXT.includes(ext)) throw httpError(400, 'Documents: PDF, Word, ODT, PowerPoint, LaTeX, Markdown or text.');
    const buf = Buffer.from(String(data || ''), 'base64'); if (!buf.length || buf.length > 40 * 1024 * 1024) throw httpError(400, 'The file is empty or over 40 MB.');
    fs.mkdirSync(P('docs'), { recursive: true }); share(P('docs'));
    const id = id6('d'); const f = `${id}${ext}`; fs.writeFileSync(P('docs', f), buf); share(P('docs', f));
    const d = { id, name: clip(name || path.basename(file, ext), 160), file: f, original: clip(file, 200), kind: clip(kind, 60), notes: clip(notes, 1000), added: Date.now(), by, read: null };
    list.push(d); writeJson(docsFile(), { docs: list }); log({ kind: 'doc', by, what: `Document added: ${d.name}` }); return d;
}
export function removeDoc(id) { const list = docs(); const d = list.find(x => x.id === id); if (!d) throw httpError(404, 'No such document.'); fs.rmSync(P('docs', d.file), { force: true }); writeJson(docsFile(), { docs: list.filter(x => x.id !== id) }); return { removed: id }; }
export function docPath(id) { const d = docs().find(x => x.id === id); if (!d) throw httpError(404, 'No such document.'); return { file: P('docs', d.file), name: d.original || d.file, doc: d }; }
export const docText = async id => fileText(docPath(id).file);
export function markDocRead(id) { const list = docs(); const d = list.find(x => x.id === id); if (d) { d.read = Date.now(); writeJson(docsFile(), { docs: list }); } }
export function docPrompt(d, extra = '') {
    return `Break down one of my documents into my Me map: "${d.name}" (document id ${d.id}${d.kind ? `, a ${d.kind}` : ''}).${d.notes ? ` My note on it: ${d.notes}` : ''}${extra ? `\nAlso: ${clip(extra, 1000)}` : ''}\n\n` +
        `1. me_summary, then read_doc (id ${d.id}). Page breaks and slide numbers are marked in the text.\n` +
        `2. propose_me ONE item for the work itself (kind project, or role/education if that is what it is): title, org, dates, a summary of the problem, what I did myself, methods and results, tags, and evidence with figures.\n` +
        `3. propose_me each skill the document actually demonstrates (kind skill): the level it supports (aware, working, strong, expert) and why, with evidence quoting what I did, and links to the project item's id. If a skill is already in Me, propose it again with the same title so the new evidence and source are added.\n` +
        `4. propose_me achievements or results worth a CV line (grades, awards, publications, measurable outcomes), linked to the project.\n` +
        `Every proposal: sources [{"title": "${d.name.replace(/"/g, "'")}", "note": "page or section it comes from"}], confidence high (it says so plainly), medium (clearly implied) or low (inferred). Only what the document supports; group work: say what was mine if it says, otherwise note it is unclear.\n` +
        `5. Link items with link_me once their ids exist (skills and results to the project).\n6. Finish with mark_doc_read (id ${d.id}) and a short summary of what you proposed.`;
}

// ---------- framework assessments (SFIA, Success Profiles, DDaT, …) with a blind second assessor ----------
// Agent A assesses a job against the framework it uses: each element's required level, the level the confirmed Me
// evidence supports, the Me ids it relied on and why. Then a blind assessor (a zero-trust agent that sees the rubric,
// the required levels and the evidence text, but not the job, the employer or A's levels) rates the same elements.
// Elements where the two differ by 2 or more are flagged. Profiles keep the person's levels per framework across jobs.
import * as fw from './frameworks.js';
export const frameworks = () => fw.list();
export function detectFrameworks(id) { const j = getJob(id); return fw.detect(`${j.title} ${j.description || ''} ${(j.requirements || []).join(' ')} ${j.notes || ''}`); }
const lvl = (f, v) => { const n = Number(v); return Number.isFinite(n) && Object.prototype.hasOwnProperty.call(f.scale, String(Math.round(n))) ? Math.round(n) : null; };
function cleanElements(f, list, ids) {
    return (Array.isArray(list) ? list : []).slice(0, 40).map(e => ({ id: clip(e.id || e.name, 60).toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: clip(e.name || e.id, 120), kind: clip(e.kind, 30), required: e.required === undefined || e.required === null || e.required === '' ? null : clip(e.required, 40), level: lvl(f, e.level), evidence: (Array.isArray(e.evidence) ? e.evidence : String(e.evidence || '').split(',')).map(x => String(x).trim()).filter(x => ids.has(x)).slice(0, 8), rationale: clip(e.rationale, 800) })).filter(e => e.name);
}
export function saveAssessment(id, body, by = 'phone') {
    const f = fw.get(String(body.framework || '')); const b = board(); const j = b.jobs.find(x => x.id === id); if (!j) throw httpError(404, 'No such job.');
    const ids = new Set(me().items.filter(i => i.status !== 'proposed').map(i => i.id));
    const a = { framework: f.id, meVersion: meVersion(), title: f.title, target: clip(body.target, 120), summary: clip(body.summary, 1500), elements: cleanElements(f, body.elements, ids), by, at: Date.now(), blind: null };
    if (!a.elements.length) throw httpError(400, 'An assessment needs elements (each with a name, the required level and the level the evidence supports).');
    j.assess = [...(j.assess || []).filter(x => x.framework !== f.id), a]; j.updated = Date.now(); saveBoard(b);
    log({ kind: 'assess', by, what: `${j.title}: assessed against ${f.title} (${a.elements.length} elements)` });
    if (body.blind !== false) blindReview(id, f.id, by).catch(e => log({ kind: 'assess', by: 'box', what: `Blind review not started: ${e.message}` }));
    return a;
}
function evidenceText(items) { return items.map(i => `[${i.id}] ${i.kind}: ${i.title}${i.from ? ` (${i.from}${i.to ? `–${i.to}` : ''})` : ''}\n${i.summary || ''}${(i.evidence || []).length ? `\nEvidence: ${i.evidence.join('; ')}` : ''}`).join('\n\n'); }
// Read an assessor's ratings: a JSON array (preferred), or failing that a Markdown table "| element | level | why |".
function parseRatings(answer, elements) {
    const txt = String(answer || ''); const m = txt.match(/```(?:json)?\s*([\s\S]*?)```/) || txt.match(/(\[\s*\{[\s\S]*\}\s*\])/);
    try { const arr = JSON.parse(m ? m[1] : txt); if (Array.isArray(arr)) return arr; } catch { /* try a table */ }
    const norm = x => String(x).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); const out = [];
    for (const line of txt.split('\n')) {
        const cells = line.split('|').map(x => x.replace(/\*\*/g, '').trim()).filter((x, i, all) => !(x === '' && (i === 0 || i === all.length - 1)));
        if (cells.length < 2) continue; const el = elements.find(e => norm(cells[0]) === norm(e.name) || norm(cells[0]) === norm(e.id) || norm(cells[0]).startsWith(norm(e.name)));
        const lv = (cells[1].match(/-?\d+(?:\.\d+)?/) || [])[0]; if (!el || lv === undefined) continue;
        out.push({ id: el.id, name: el.name, level: Number(lv), evidence: (line.match(/\bm[0-9a-f]{6}\b/g) || []), rationale: cells.slice(2).join(' ') });
    }
    return out.length ? out : null;
}
export async function blindReview(id, framework, by = 'phone') {
    const j = getJob(id); const a = (j.assess || []).find(x => x.framework === framework); if (!a) throw httpError(404, 'Assess the job against that framework first.');
    const f = fw.get(framework); const s = settings(); const items = me().items.filter(i => i.status !== 'proposed');
    const q = `You are an impartial assessor using the ${f.title}. Rate a candidate on each element below using only the evidence given. You are not told the job, the employer or anyone else's rating.\n\n` +
        `Scale: ${Object.entries(f.scale).map(([k, v]) => `${k} = ${v}`).join('; ')}.\nLevels in this framework: ${Object.entries(f.levels).map(([k, v]) => `${k} = ${v}`).join('; ')}.\nAssessor notes: ${f.notes}\n${f.url ? `Official descriptions: ${f.url}\n` : ''}\n` +
        `Elements to rate (with the level the role requires):\n${a.elements.map(e => `- ${e.id}: ${e.name}${e.kind ? ` (${e.kind})` : ''}; required: ${e.required ?? 'not stated'}`).join('\n')}\n\n` +
        `The candidate's evidence (everything on record; ids in brackets):\n${evidenceText(items).slice(0, 24000)}\n\n` +
        `Rules: rate what the evidence shows the candidate personally did, not potential; claims without specifics score low; do not reward length or prestige. ` +
        `Output ONLY one JSON array in a \`\`\`json block, no table and no other text: [{"id": "<element id exactly as listed>", "level": <number on the scale>, "evidence": ["<ids used>"], "rationale": "<one or two sentences>"}].`;
    return probesKit.start(P('assess', id), { subject: `${f.title}: blind assessment`, question: q, agent: s.agent || 'claude', model: s.model || '', web: false, by, tag: framework,
        onDone: p => {
            const b = board(); const jj = b.jobs.find(x => x.id === id); const aa = jj?.assess?.find(x => x.framework === framework); if (!aa) return;
            if (p.status !== 'done') { aa.blind = { status: 'failed', note: clip(p.answer, 300), at: Date.now() }; saveBoard(b); return; }
            let arr = parseRatings(p.answer, aa.elements);
            if (!arr) { aa.blind = { status: 'unreadable', note: clip(p.answer, 600), at: Date.now() }; saveBoard(b); log({ kind: 'assess', by: p.agent, what: `${jj.title}: blind review answer could not be read` }); return; }
            const ids = new Set(items.map(i => i.id)); const els = cleanElements(f, arr, ids);
            aa.blind = { status: 'done', by: p.agent, at: Date.now(), elements: els };
            for (const e of aa.elements) { const o = els.find(x => x.id === e.id); e.blind = o ? o.level : null; e.flag = o && e.level !== null && o.level !== null && Math.abs(e.level - o.level) >= 2; }
            saveBoard(b); log({ kind: 'assess', by: p.agent, what: `${jj.title}: blind ${f.title} review done; ${aa.elements.filter(e => e.flag).length} element(s) disagree by 2+` });
        } });
}
export function assessPrompt(j, framework = '') {
    const hint = framework ? `Use the framework "${framework}".` : `Find which framework the employer uses (detect_framework; the advert, the employer's careers pages and the grade or band named). If none, use "competency".`;
    return `Job ${j.id}: "${j.title}"${j.company ? ` at ${j.company}` : ''}. Assess my fit the way this employer will assess me. ${hint}\n` +
        `1. me_summary and show_job. framework_info for the framework, and read its official descriptions for the role and level (the URL it gives) so you apply the real level indicators.\n` +
        `2. Work out the target (grade, band, role level) and the elements assessed (for Success Profiles: the behaviours, experience, technical and strength elements in the advert; for SFIA, DDaT, e-CF: the skills named or implied by the role).\n` +
        `Levels are judged for this job's framework, grade and advert only; read Me notes, and previous_assessments for consistency (same evidence read the same way).\n3. save_assessment: per element the required level, the level my CONFIRMED evidence supports (on the framework's scale), the Me ids you relied on, and a short rationale. Be strict and fair, as a trained assessor would: score what I personally did, with specifics; where evidence is missing say so, and add_gap.\n` +
        `A blind second assessor then rates the same elements without seeing yours. Finish with a summary: likely sift outcome, the weakest elements, and which examples to strengthen.`;
}

// ---------- Me notes, the Me version, and keeping assessments current ----------
// Framework levels are not universal: each employer, grade and advert reads them differently, so they are assessed per
// job and never stored as facts about the person. What is kept is Me itself (plus free notes, e.g. which example best
// shows a behaviour), and each assessment records the Me version it used: a changed Me marks it stale.
export function meVersion() {
    const m = me(); const conf = m.items.filter(i => i.status !== 'proposed').map(i => [i.id, i.kind, i.title, i.summary, i.level, i.org, i.from, i.to, i.tags, i.evidence, i.links]);
    return crypto.createHash('sha1').update(JSON.stringify([conf, (m.notes || []).map(n => [n.id, n.text])])).digest('hex').slice(0, 12);
}
export function addNote({ text, topic = '' }, by = 'phone') { const m = me(); m.notes ||= []; const t = clip(text, 4000); if (t.length < 3) throw httpError(400, 'Write the note.'); const n = { id: id6('n'), text: t, topic: clip(topic, 80), by, at: Date.now() }; m.notes.push(n); saveMe(m); log({ kind: 'me', by, what: `Note added${n.topic ? ` (${n.topic})` : ''}` }); return n; }
export function removeNote(id) { const m = me(); m.notes = (m.notes || []).filter(n => n.id !== id); saveMe(m); return { removed: id }; }
// Elements a job asks for, when the framework has a fixed list (Success Profiles behaviours, KSF dimensions).
function namedElements(f, j) { const t = `${j.description || ''} ${(j.requirements || []).join(' ')}`.toLowerCase(); return (f.elements || []).filter(e => t.includes(e.name.toLowerCase())); }
const gradeOf = j => (`${j.title} ${j.description || ''}`.match(/\b(AA|AO|EO|HEO|SEO|G7|G6|Grade 7|Grade 6|SCS ?[1-4]?|Band [2-9][abcd]?|SFIA (?:level )?[1-7])\b/i) || [])[1]?.toUpperCase().replace('GRADE ', 'G') || '';
// Copy an assessment from another job when Me has not changed since, it used the same framework and grade, and it
// covered every element this job names. Returns true when it could.
function tryReuse(id, fid) {
    const b = board(); const j = b.jobs.find(x => x.id === id); if (!j) return false; const f = fw.get(fid); const need = namedElements(f, j); const g = gradeOf(j); const v = meVersion();
    if (!need.length || !g) return false;
    for (const o of b.jobs) {
        if (o.id === id) continue; const a = (o.assess || []).find(x => x.framework === fid && x.meVersion === v && x.blind?.status === 'done'); if (!a || gradeOf(o) !== g) continue;
        if (!need.every(e => a.elements.some(x => x.id === e.id))) continue;
        const els = a.elements.filter(x => need.some(e => e.id === x.id)).map(x => ({ ...x }));
        j.assess = [...(j.assess || []).filter(x => x.framework !== fid), { framework: fid, meVersion: v, title: a.title, target: a.target, summary: `Reused from "${o.title}"${o.company ? ` at ${o.company}` : ''}: same framework and grade, and Me has not changed since. ${a.summary || ''}`.slice(0, 1500), elements: els, by: 'box (reused)', reusedFrom: o.id, at: Date.now(), blind: { ...a.blind, elements: a.blind.elements.filter(x => need.some(e => e.id === x.id)) } }];
        saveBoard(b); log({ kind: 'assess', by: 'box', what: `${j.title}: ${f.title} assessment reused from ${o.title} (Me unchanged)` }); return true;
    }
    return false;
}
// New jobs that use a named framework are assessed on arrival: reused when possible, otherwise by an agent (one at a
// time, up to settings.autoAssessPerDay a day, default 6). The server sets the runner (it starts one-shot shells).
let runner = null; const queue = []; let busy = false;
export function setAgentRunner(fn) { runner = fn; }
export function queueAssess(id) {
    const s = settings(); if (s.autoAssess === false) return;
    let j; try { j = getJob(id); } catch { return; }
    const top = fw.detect(`${j.title} ${j.description || ''}`)[0]; if (!top || top.id === 'competency') return;
    if (tryReuse(id, top.id)) return;
    if (!queue.some(q => q.id === id)) queue.push({ id, framework: top.id }); drain();
}
async function drain() {
    if (busy || !runner || !queue.length) return; busy = true;
    try {
        while (queue.length) {
            const q = queue.shift(); const s = settings(); const day = new Date().toISOString().slice(0, 10);
            const used = readLog(2000).filter(e => e.kind === 'assess' && e.auto && new Date(e.t).toISOString().slice(0, 10) === day).length;
            if (used >= (Number(s.autoAssessPerDay) || 6)) { log({ kind: 'assess', by: 'box', what: `Daily limit of automatic assessments reached; ${queue.length + 1} job(s) left for you to assess` }); queue.length = 0; break; }
            if (tryReuse(q.id, q.framework)) continue;
            let j; try { j = getJob(q.id); } catch { continue; }
            if ((j.assess || []).some(a => a.framework === q.framework && a.meVersion === meVersion())) continue;
            try { const name = await runner(assessPrompt(j, q.framework), `assess-${q.id.slice(1)}`); log({ kind: 'assess', by: 'box', auto: true, what: `${j.title}: automatic ${q.framework} assessment started` }); await waitShell(name); }
            catch (e) { log({ kind: 'assess', by: 'box', what: `${j.title}: automatic assessment not started: ${e.message}` }); }
        }
    } finally { busy = false; }
}
function waitShell(name, ms = 20 * 60_000) { const f = path.join(config.state, 'oneshot', `${name}.json`); const t0 = Date.now(); return new Promise(ok => { const t = setInterval(() => { if (fs.existsSync(f) || Date.now() - t0 > ms) { clearInterval(t); ok(); } }, 5000); }); }

// ---------- cover letters: an editor per job, built from your similar past letters, with a fit review ----------
// Drafts are Markdown in /Jobs/drafts/<job>/<name>.md; every save keeps the previous text in .history/. "Generate"
// finds your most similar past letters (other jobs' drafts and letter files in application folders, ranked by how alike
// the jobs are) and has an agent adapt them, or write a new one. The fit review checks each requirement and framework
// element against the letter; the AI review is a zero-trust agent that quotes where each is met and suggests fixes.
const histDir = id => path.join(draftDir(id), '.history');
export function letter(id, name = 'cover-letter') {
    if (!DRAFT_NAME.test(name)) throw httpError(400, 'Bad draft name.'); getJob(id);
    const f = path.join(draftDir(id), `${name}.md`); const ok = fs.existsSync(f);
    let history = []; try { history = fs.readdirSync(histDir(id)).filter(x => x.startsWith(`${name}.`) && x.endsWith('.md')).map(x => ({ version: x.slice(name.length + 1, -3), at: Number(x.slice(name.length + 1, -3)) })).sort((a, b) => b.at - a.at).slice(0, 50); } catch { /* none */ }
    return { name, text: ok ? fs.readFileSync(f, 'utf8') : '', mtime: ok ? fs.statSync(f).mtimeMs : 0, history, review: readJson(path.join(draftDir(id), `${name}.review.json`), null) };
}
export function writeLetter(id, name, text, { baseMtime = 0 } = {}, by = 'phone') {
    if (!DRAFT_NAME.test(name)) throw httpError(400, 'Bad draft name.'); getJob(id);
    const t = String(text ?? ''); if (t.length > 200_000) throw httpError(413, 'Too long.');
    fs.mkdirSync(histDir(id), { recursive: true }); share(P('drafts')); share(draftDir(id)); share(histDir(id));
    const f = path.join(draftDir(id), `${name}.md`);
    if (fs.existsSync(f)) {
        if (baseMtime && fs.statSync(f).mtimeMs > Number(baseMtime) + 1) throw httpError(409, 'An agent changed this letter since you opened it. Reload to see its version (yours is still in the editor).');
        const old = fs.readFileSync(f, 'utf8'); if (old !== t) { const hf = path.join(histDir(id), `${name}.${Date.now()}.md`); fs.writeFileSync(hf, old); share(hf); }
    }
    fs.writeFileSync(f, t); share(f);
    const app = applications().find(a => a.job === id && !['rejected', 'withdrawn'].includes(a.stage));
    if (app) { try { const sub = /letter|cv/.test(name) ? 'CV & Cover Letter' : 'Notes'; fs.writeFileSync(path.join(app.folder, sub, `${name}.md`), t); share(path.join(app.folder, sub, `${name}.md`)); } catch { /* folder gone */ } }
    if (by !== 'phone') log({ kind: 'draft', by, what: `Letter "${name}" written for ${getJob(id).title}` });
    return { ok: true, mtime: fs.statSync(f).mtimeMs };
}
export function restoreLetter(id, name, version) {
    if (!DRAFT_NAME.test(name) || !/^\d{10,16}$/.test(String(version))) throw httpError(400, 'Bad version.');
    const hf = path.join(histDir(id), `${name}.${version}.md`); if (!fs.existsSync(hf)) throw httpError(404, 'No such version.');
    return writeLetter(id, name, fs.readFileSync(hf, 'utf8'), {}, 'phone');
}
// Your past letters, most similar job first.
export async function similarLetters(id, max = 3) {
    const j = getJob(id); const mine = new Set(words(`${j.title} ${(j.requirements || []).join(' ')} ${j.category || ''}`));
    const sim = o => { const w = new Set(words(`${o.title} ${(o.requirements || []).join(' ')} ${o.category || ''}`)); let n = 0; for (const x of w) if (mine.has(x)) n++; return n / Math.max(1, Math.min(mine.size, w.size)); };
    const out = []; const jobsById = new Map(board().jobs.map(o => [o.id, o]));
    for (const o of board().jobs) { if (o.id === id) continue; for (const d of drafts(o.id)) if (/letter/.test(d.name)) out.push({ job: o.id, title: o.title, company: o.company || '', file: path.join(draftDir(o.id), `${d.name}.md`), label: `${d.name}.md`, score: sim(o) }); }
    for (const a of applications()) {
        if (a.job === id) continue; const o = jobsById.get(a.job) || { title: a.title, requirements: [] }; const dir = path.join(a.folder, 'CV & Cover Letter');
        let files = []; try { files = fs.readdirSync(dir); } catch { continue; }
        for (const fn of files) if (/cover|letter/i.test(fn) && /\.(md|txt|docx|odt|pdf|tex)$/i.test(fn) && !out.some(x => x.job === a.job && x.label === fn)) out.push({ job: a.job, title: a.title, company: a.company, file: path.join(dir, fn), label: fn, score: sim(o) + (['interview', 'final', 'offer', 'accepted'].includes(a.stage) ? 0.15 : 0), stage: a.stage });
    }
    out.sort((x, y) => y.score - x.score);
    const top = out.slice(0, max);
    for (const t of top) { try { t.text = (await fileText(t.file)).slice(0, 7000); } catch { t.text = ''; } }
    return top.filter(t => t.text && t.text.length > 200 && !/^Could not extract/.test(t.text));
}
export async function letterPrompt(id, { name = 'cover-letter', extra = '', fresh = false } = {}) {
    const j = getJob(id); const sim = fresh ? [] : await similarLetters(id);
    const base = sim.length ? `My most similar past letters (adapt the best parts: structure, voice and strong examples, but make every specific fit THIS job and employer; never copy another employer's name or details):\n\n${sim.map((s2, i) => `--- Letter ${i + 1}: for "${s2.title}"${s2.company ? ` at ${s2.company}` : ''}${s2.stage ? ` (that application reached: ${s2.stage})` : ''} ---\n${s2.text}`).join('\n\n')}\n\n` : 'I have no similar past letters: write a new one.\n\n';
    return `Write my cover letter for job ${j.id}: "${j.title}"${j.company ? ` at ${j.company}` : ''}. Follow the playbook (Tailor). Use the jobs tools: me_summary, show_job, job_advice (company research: use one specific, true reason for this employer), and any framework assessment on the job (write in its terms).\n\n${base}` +
        `Save it with save_draft, name "${name}", in Markdown: a UK one-page letter (about 300–400 words), addressed to a named person if the research found one, otherwise "Dear Hiring Manager". Back two or three of the job's key requirements with short STAR-style evidence from my confirmed Me items; leave [placeholders] for anything you would have to guess. No clichés.${extra ? `\n\nI also want: ${clip(extra, 1500)}` : ''}\nFinish with two lines: what you based it on, and what I should check.`;
}
// Which requirements and framework elements the letter covers (by the words they share), with Me evidence for each.
export function coverage(id, name = 'cover-letter') {
    const j = getJob(id); const text = letter(id, name).text.toLowerCase(); const lw = new Set(words(text));
    const reqs = (j.requirements || []).map(r => ({ kind: 'requirement', text: r }));
    for (const a of j.assess || []) for (const e of a.elements) reqs.push({ kind: a.title, text: e.name, level: e.level, required: e.required });
    const cands = candidates(reqs.map(r => r.text));
    return reqs.map((r, i) => { const rw = words(r.text); const hit = rw.filter(w => lw.has(w)); const share = rw.length ? hit.length / rw.length : 0; return { ...r, status: share >= 0.5 ? 'covered' : share > 0 ? 'partly' : 'missing', words: hit, evidence: cands[i].candidates }; });
}
// The AI review: a zero-trust agent sees the advert's requirements and the letter (not Me), quotes and suggests.
export async function reviewLetter(id, name = 'cover-letter', by = 'phone') {
    const j = getJob(id); const l = letter(id, name); if (l.text.trim().length < 100) throw httpError(400, 'Write (or generate) the letter first.'); const s = settings();
    const reqs = coverage(id, name).map(r => `- ${r.kind === 'requirement' ? '' : `[${r.kind}] `}${r.text}`).join('\n') || '(no requirements stored: judge against the advert)';
    const q = `Review this cover letter for the job "${j.title}"${j.company ? ` at ${j.company}` : ''} like an experienced recruiter.\n\nThe job's requirements and assessed elements:\n${reqs}\n\nThe advert (excerpt):\n${(j.description || '').slice(0, 3000)}\n\nThe letter:\n${l.text.slice(0, 12000)}\n\n` +
        `Answer with one JSON object in a \`\`\`json block: {"requirements": [{"requirement": "...", "verdict": "covered|weak|missing", "quote": "<the letter's words that address it, or empty>", "suggestion": "<how to cover it better, one sentence>"}], "overall": {"length": "<words and whether it fits one page>", "tone": "...", "specificity": "<is the employer-specific reason real and specific?>", "cliches": ["..."], "top_fixes": ["...", "...", "..."]}}`;
    const dir = path.join(draftDir(id)); fs.mkdirSync(dir, { recursive: true });
    return probesKit.start(P('reviews', id), { subject: `${j.title}: cover letter review`, question: q, agent: s.agent || 'claude', model: s.model || '', web: false, by, tag: name,
        onDone: p => { let r = null; const m = String(p.answer).match(/```(?:json)?\s*([\s\S]*?)```/); try { r = JSON.parse(m ? m[1] : p.answer); } catch { r = null; } const out = { at: Date.now(), by: p.agent, status: p.status === 'done' && r ? 'done' : 'failed', mtime: l.mtime, ...(r || { note: clip(p.answer, 800) }) }; try { fs.writeFileSync(path.join(dir, `${name}.review.json`), JSON.stringify(out, null, 2)); share(path.join(dir, `${name}.review.json`)); } catch { /* gone */ } log({ kind: 'draft', by: p.agent, what: `Letter review for ${j.title}: ${out.status}` }); } });
}

// ---------- CPD log: what you did and learned, day by day ----------
// Entries in /Jobs/cpd.json. "Update Me from my log" (and, once 5 or more entries are new, at most once a day by itself)
// has an agent turn new entries into proposals: new skills, fresh evidence and progress on ongoing projects, notes.
export const CPD_TYPES = { work: 'Work', learning: 'Learning', course: 'Course or training', reading: 'Reading', event: 'Event or talk', project: 'Project', finding: 'Finding', cert: 'Certification', other: 'Other' };
const cpdFile = () => P('cpd.json');
export function cpd() { return (readJson(cpdFile(), { entries: [] }) || { entries: [] }).entries; }
export function saveCpd(b, by = 'phone') {
    const list = cpd(); let e = b.id ? list.find(x => x.id === b.id) : null; if (b.id && !e) throw httpError(404, 'No such entry.');
    const text = b.text !== undefined ? clip(b.text, 6000) : e?.text; if (!text || text.length < 3) throw httpError(400, 'Write what you did or learned.');
    if (!e) { e = { id: id6('p'), created: Date.now(), by, processed: null }; list.push(e); }
    e.text = text; e.date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : e.date || new Date().toISOString().slice(0, 10);
    if (b.type !== undefined) e.type = CPD_TYPES[b.type] ? b.type : 'work'; e.type ||= 'work';
    if (b.project !== undefined) e.project = clip(b.project, 160);
    if (b.meId !== undefined) e.meId = me().items.some(i => i.id === b.meId) ? b.meId : null;
    if (b.hours !== undefined) { const h = Number(b.hours); e.hours = Number.isFinite(h) && h > 0 ? Math.round(h * 4) / 4 : null; }
    if (b.tags !== undefined) e.tags = [...new Set((Array.isArray(b.tags) ? b.tags : String(b.tags).split(',')).map(t => clip(t, 40).toLowerCase()).filter(Boolean))].slice(0, 15);
    if (b.text !== undefined && e.processed) e.processed = null;   // edited: read it again
    e.updated = Date.now(); writeJson(cpdFile(), { entries: list }); if (!b.id) log({ kind: 'cpd', by, what: `CPD: ${text.slice(0, 80)}` });
    maybeAutoCpd(); return e;
}
export function removeCpd(id) { writeJson(cpdFile(), { entries: cpd().filter(x => x.id !== id) }); return { removed: id }; }
export function markCpd(ids) { const list = cpd(); const set = new Set(ids); for (const e of list) if (set.has(e.id)) e.processed = Date.now(); writeJson(cpdFile(), { entries: list }); return { marked: ids.length }; }
export function cpdCsv() {
    const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    return ['Date,Type,Project,Hours,Tags,Activity and what I learned', ...cpd().sort((a, b) => a.date.localeCompare(b.date)).map(e => [e.date, CPD_TYPES[e.type] || e.type, e.project || '', e.hours ?? '', (e.tags || []).join('; '), e.text].map(q).join(','))].join('\r\n') + '\r\n';
}
export function cpdPrompt() {
    return `Update my Me map from my CPD log. cpd_entries (new entries only) and me_summary first.\n` +
        `For each new entry: if it shows a skill I have not got in Me, or a higher or broader use of one I have, propose_me it (kind skill, evidence quoting what I did, a level only if the entries clearly support it, links to the project). If it is progress on an ongoing project or role, propose_me that item again with the same kind and title so the new evidence and dates are added (it will not overwrite what I confirmed). Courses, certifications and talks become cert, education or achievement items when they are complete. Many small entries on one theme can become one skill with combined evidence. Useful context that is not an item (what was mine in a team, what I am working towards) goes in add_me_note.\n` +
        `Every proposal: sources [{"title": "CPD log", "note": "<dates of the entries>"}]. Do not invent; routine entries with nothing new can be skipped. Then mark_cpd_processed with the ids you read, and finish with a short summary of what changed.`;
}
let cpdBusy = false;
function maybeAutoCpd() {
    const s = settings(); if (s.autoCpd === false || cpdBusy || !runner) return;
    const fresh = cpd().filter(e => !e.processed); if (fresh.length < 5) return;
    const today = new Date().toISOString().slice(0, 10); if (readLog(500).some(e => e.kind === 'cpd' && e.auto && new Date(e.t).toISOString().slice(0, 10) === today)) return;
    cpdBusy = true; log({ kind: 'cpd', by: 'box', auto: true, what: `Updating Me from ${fresh.length} new CPD entries` });
    runner(cpdPrompt(), 'cpd').then(name => waitShell(name)).catch(e => log({ kind: 'cpd', by: 'box', what: `CPD update not started: ${e.message}` })).finally(() => { cpdBusy = false; });
}
