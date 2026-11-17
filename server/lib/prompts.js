// The master prompts PlatOpypus gives agents, viewable and editable from More → AI prompts.
//
// Each prompt has a default (a file in deploy/, or text built in here) that comes with the app. Your own version, if
// you save one, is kept in state/prompts/<id>.json together with the default it was based on. When an update changes
// the default, your version is marked "based on an old default": it keeps being used until you choose to switch to the
// new default (yours is kept as deprecated), migrate (edit starting from the new one), or keep yours as it is.
//
// Prompts that agents read from a path (security briefs, which a session points at) are also written, when you have
// your own version, to a folder agents can read and updates do not touch (PUBLIC_DIR).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { record } from './audit.js';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const deploy = (...p) => path.resolve(here, '..', '..', 'deploy', ...p);
const STATE = path.join(config.state, 'prompts');
export const PUBLIC_DIR = process.env.PLATO_PROMPTS_DIR || '/usr/local/share/platopypus/prompts';
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 16);

export const PROBE_DEFAULT = 'You are a careful research assistant. Answer the question from public, citable sources: official registers and filings, court records, reputable reporting, company reports, exchange data, block explorers. For every fact give the source as a URL. Say plainly when something is unverified, disputed or not found, and do not speculate. Do not look for or report private individuals’ personal details, home addresses (unless they appear in a public company register or official filing, and then only as part of that record), phone numbers, personal emails, family members who hold no public role, health or anything similar. End with a short list headed "Sources".';
export const ASK_DEFAULT = 'You answer questions about an investigation using ONLY the case file you are given: its cards, strings (connections), sources, theories, open questions and notes. Cite the ids you rely on in square brackets, like [S3] or [l1a2b3c]. Keep fact and allegation apart: strings marked alleged are unverified. If the case file does not answer the question, say so plainly and suggest one to three narrow probes (a subject and a question each) that could. Do not speculate beyond the file and do not add outside knowledge as fact. Never suggest probes that seek private individuals’ personal details: no electoral rolls, people-search sites, home addresses, co-residence or family relationships, unless a public register of interests, a company filing or a court record states them; suggest those official records instead. Be concise.';

const SEC = [['control', 'Control sessions'], ['throwaway', 'Projects: throwaway'], ['personal-private', 'Projects: personal, private'], ['personal-shared', 'Projects: personal, shared'], ['professional-internal', 'Projects: professional, internal'], ['professional-public', 'Projects: professional, public'], ['professional-regulated', 'Projects: professional, regulated']];
export const REGISTRY = [
    { id: 'agent-global', app: 'Box', title: 'Instructions for every agent', file: deploy('AGENT.global.md'), used: 'Written into every agent’s own instructions file (CLAUDE.md, AGENTS.md, GEMINI.md, ~/.agents/AGENTS.md) for root and the agent user. New sessions read it.' },
    ...SEC.map(([k, t]) => ({ id: `security-${k}`, app: 'Box', title: `Security brief: ${t}`, file: deploy('security', `${k}.md`), path: true, used: k === 'control' ? 'Every control session reads it (its $PORTHOLE_SECURITY_FILE).' : 'Copied into a project when its security level is set, and read by sessions there.' })),
    { id: 'research-brief', app: 'Research', title: 'Research session brief', file: deploy('research', 'brief.md'), used: 'Copied into each new research topic (.platopypus/research.md).' },
    { id: 'lab-brief', app: 'Security Lab', title: 'Engagement brief', file: deploy('lab', 'brief.md'), used: 'Copied into each new engagement (.platopypus/lab.md).' },
    { id: 'case-brief', app: 'Conspiracy', title: 'Case brief (the lead agent)', file: deploy('cases', 'brief.md'), used: 'Copied into each new case (.platopypus/case.md), with the case facts added.' },
    { id: 'case-probe', app: 'Conspiracy', title: 'Probe instructions (each sub-agent)', builtin: PROBE_DEFAULT, used: 'The system prompt of every zero-trust probe. Applies to the next probe.' },
    { id: 'case-ask', app: 'Conspiracy', title: 'Ask instructions', builtin: ASK_DEFAULT, used: 'The system prompt for questions asked on a case’s Ask page. Applies to the next question.' },
];
const byId = id => { const p = REGISTRY.find(r => r.id === id); if (!p) throw httpError(404, 'No such prompt.'); return p; };
const defaultText = p => p.builtin ?? (() => { try { return fs.readFileSync(p.file, 'utf8'); } catch { return ''; } })();
const stateFile = id => path.join(STATE, `${id}.json`);
const loadOv = id => { try { return JSON.parse(fs.readFileSync(stateFile(id), 'utf8')); } catch { return null; } };
const saveOv = (id, o) => { fs.mkdirSync(STATE, { recursive: true, mode: 0o700 }); fs.writeFileSync(stateFile(id), JSON.stringify(o, null, 2), { mode: 0o600 }); };

function view(p, withText = false) {
    const def = defaultText(p); const dh = sha(def); const ov = loadOv(p.id);
    const custom = !!ov?.text; const outdated = custom && ov.baseHash !== dh;
    return { id: p.id, app: p.app, title: p.title, used: p.used, state: !custom ? 'default' : outdated ? 'outdated' : 'custom', editedAt: ov?.editedAt || null, deprecated: (ov?.deprecated || []).length,
        ...(withText ? { defaultText: def, customText: ov?.text || null, baseText: ov?.baseText ?? null, deprecatedVersions: ov?.deprecated || [] } : {}) };
}
export function list() { return { prompts: REGISTRY.map(p => view(p)), review: REGISTRY.filter(p => view(p).state === 'outdated').length }; }
export function get(id) { return view(byId(id), true); }
// What agents get: your version if you saved one, else the default.
export function text(id) { const p = byId(id); const ov = loadOv(id); return ov?.text || defaultText(p); }
// For prompts read from a path: your version's readable copy, else the default file.
export function filePath(id) { const p = byId(id); const ov = loadOv(id); const f = path.join(PUBLIC_DIR, `${id}.md`); return ov?.text && fs.existsSync(f) ? f : p.file; }

function publish(p) {
    if (!p.path && p.id !== 'agent-global') return;
    const ov = loadOv(p.id); const f = path.join(PUBLIC_DIR, `${p.id}.md`);
    try { if (ov?.text) { fs.mkdirSync(PUBLIC_DIR, { recursive: true, mode: 0o755 }); fs.writeFileSync(f, ov.text, { mode: 0o644 }); } else fs.rmSync(f, { force: true }); } catch { /* not on a box (tests) */ }
    if (p.id === 'agent-global') applyGlobal();
}
export function save(id, body = {}) {
    const p = byId(id); const t = String(body.text ?? ''); if (t.trim().length < 20) throw httpError(400, 'A prompt needs some text (20 characters or more).'); if (t.length > 120_000) throw httpError(400, 'Keep it under 120 000 characters.');
    const def = defaultText(p); const ov = loadOv(id) || {};
    if (t === def) return reset(id);   // saving the default is the same as using it
    saveOv(id, { ...ov, text: t, baseHash: sha(def), baseText: def, editedAt: Date.now() });
    publish(p); record('activity', 'prompt-saved', { actor: 'phone', what: `${p.title}: your version saved` });
    return get(id);
}
// Back to the default; your version is kept (the last five) as deprecated.
export function reset(id) {
    const p = byId(id); const ov = loadOv(id); if (!ov?.text) return get(id);
    const dep = [{ text: ov.text, basedOn: ov.baseHash, savedAt: ov.editedAt, retiredAt: Date.now() }, ...(ov.deprecated || [])].slice(0, 5);
    saveOv(id, { deprecated: dep }); publish(p);
    record('activity', 'prompt-reset', { actor: 'phone', what: `${p.title}: back to the default (your version kept as deprecated)` });
    return get(id);
}
// Keep your version as it is, against the new default (until the next update changes it again).
export function acknowledge(id) {
    const p = byId(id); const ov = loadOv(id); if (!ov?.text) return get(id); const def = defaultText(p);
    saveOv(id, { ...ov, baseHash: sha(def), baseText: def }); record('activity', 'prompt-kept', { actor: 'phone', what: `${p.title}: your version kept with the new default` });
    return get(id);
}
// Copy a deprecated version back as your version.
export function restore(id, i) { const ov = loadOv(id); const d = ov?.deprecated?.[Number(i)]; if (!d) throw httpError(404, 'No such deprecated version.'); return save(id, { text: d.text }); }

// ---------- the instructions in every agent's own file ----------
// The installer writes AGENT.global.md between platopypus markers; with your own version, the block is replaced with
// it (and put back when you reset). Runs on save and at start, so an update that rewrote the default keeps yours.
export function applyGlobal() {
    const t = text('agent-global'); const block = `<!-- platopypus:begin -->\n${t.trim()}\n<!-- platopypus:end -->`;
    const homes = [config.home, '/home/agent'].filter(h => { try { return fs.statSync(h).isDirectory(); } catch { return false; } });
    let n = 0;
    for (const h of homes) {
        const files = [path.join(h, '.claude', 'CLAUDE.md'), path.join(h, '.codex', 'AGENTS.md'), path.join(h, '.gemini', 'GEMINI.md'), path.join(h, '.agents', 'AGENTS.md')];
        try { for (const d of fs.readdirSync(path.join(h, '.agent-profiles', 'claude'))) files.push(path.join(h, '.agent-profiles', 'claude', d, 'CLAUDE.md')); } catch { /* no profiles */ }
        for (const f of files) {
            let cur; try { cur = fs.readFileSync(f, 'utf8'); } catch { continue; }
            const re = /<!-- platopypus:begin -->[\s\S]*?<!-- platopypus:end -->/; if (!re.test(cur)) continue;
            const next = cur.replace(re, block); if (next === cur) continue;
            try { const st = fs.statSync(f); fs.writeFileSync(f, next); fs.chownSync(f, st.uid, st.gid); fs.chmodSync(f, st.mode & 0o777); n++; } catch { /* best effort */ }
        }
    }
    return n;
}
// At start: put readable copies back (an update may have wiped nothing, but be sure) and re-apply the global block.
export function startup() { for (const p of REGISTRY) { try { publish(p); } catch { /* fine */ } } }
