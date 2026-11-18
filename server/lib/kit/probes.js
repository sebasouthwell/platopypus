// Probes for any app: one question about one subject to a zero-trust agent (consult.zeroTrust: an empty home, the
// question and nothing else, web search when granted), kept as <folder>/probes/pN.json. Several can run at once.
import fs from 'node:fs';
import path from 'node:path';
import * as consult from '../consult.js';
import * as agentUser from '../agentuser.js';

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const write = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); const a = agentUser.info(); try { if (a && process.getuid?.() === 0) fs.chownSync(f, 0, a.gid); fs.chmodSync(f, 0o660); } catch { /* best effort */ } };
const running = new Map();
export function list(dir) { try { return fs.readdirSync(path.join(dir, 'probes')).filter(f => /^p\d+\.json$/.test(f)).map(f => readJson(path.join(dir, 'probes', f))).filter(Boolean).sort((a, b) => b.at - a.at); } catch { return []; } }
export function get(dir, id) { if (!/^p\d{1,5}$/.test(id)) throw httpError(400, 'Bad probe id.'); const p = readJson(path.join(dir, 'probes', `${id}.json`)); if (!p) throw httpError(404, 'No such probe.'); return p; }
// Start a probe; resolves at once with it (status "running"). onDone(p) runs when it comes back.
export async function start(dir, { subject, question, agent = 'claude', model = '', web = true, system, by = 'phone', tag = null, maxRunning = 4, onDone = null }) {
    const subj = String(subject || '').trim().slice(0, 200), q = String(question || '').trim().slice(0, 6000);
    if (subj.length < 2 || q.length < 8) throw httpError(400, 'A probe needs a subject and a question.');
    if ((running.get(dir) || 0) >= maxRunning) throw httpError(429, `${maxRunning} probes are already running here.`);
    const st = await consult.available('case'); const av = st.agents.find(a => a.key === agent);
    const local = agent === 'codex' && /^oss:/.test(model);
    if (!av?.installed || (!av.signedIn && !local)) throw httpError(409, `${av?.title || agent} is not ready on this box.`);
    const n = list(dir).reduce((m, p) => Math.max(m, Number(String(p.id).slice(1)) || 0), 0) + 1;
    const p = { id: `p${n}`, subject: subj, question: q, agent, model, web: consult.WEB_AGENTS.includes(agent) && web !== false && !local, tag, status: 'running', answer: '', by, at: Date.now() };
    const f = path.join(dir, 'probes', `${p.id}.json`); write(f, p); running.set(dir, (running.get(dir) || 0) + 1);
    consult.zeroTrust({ target: agent, question: `Subject: ${subj}\n\nQuestion: ${q}`, web: p.web, title: av.title, system, model })
        .then(a => { p.status = 'done'; p.answer = a; }).catch(e => { p.status = 'failed'; p.answer = e.message; })
        .finally(() => { p.finished = Date.now(); try { write(f, p); } catch { /* folder gone */ } running.set(dir, Math.max(0, (running.get(dir) || 1) - 1)); if (onDone) { try { onDone(p); } catch { /* the caller's problem */ } } });
    return p;
}
// Wait for a probe to finish (polling its file), up to ms.
export async function wait(dir, id, ms = 300_000) { const t0 = Date.now(); for (;;) { const p = get(dir, id); if (p.status !== 'running' || Date.now() - t0 > ms) return p; await new Promise(r => setTimeout(r, 2000)); } }
