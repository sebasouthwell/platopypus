// Ask: the user's own questions about a topic, answered by an agent from the topic's sources.
//
// The user is a co-researcher. They ask in the app; an agent is started just for that question (one run, no terminal
// to watch), answers from the sources with citations, and the answer appears in the app. An answer is a side note by
// default: it only becomes part of the paper when the user taps "Add to paper", which starts a second run that works it
// into the right section. Questions, answers and what happened to them are kept in .platopypus/questions/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { log } from './log.js';
import { record } from './audit.js';
import * as agentUser from './agentuser.js';
import * as shells from './shells.js';
import * as T from './researchtools.js';
import { topicPath } from './research.js';

const httpError = T.httpError;
const qDir = dir => path.join(dir, '.platopypus', 'questions');
const qFile = (dir, id) => path.join(qDir(dir), `${/^[a-f0-9]{10}$/.test(String(id)) ? id : 'x'}.json`);
const AGENTS = ['claude', 'codex'];

export function list(slug) {
    const dir = topicPath(slug);
    try { return fs.readdirSync(qDir(dir)).filter(f => f.endsWith('.json')).map(f => T.readJson(path.join(qDir(dir), f))).filter(Boolean).sort((a, b) => a.created - b.created).slice(-80); } catch { return []; }
}
function save(dir, q) {
    fs.mkdirSync(qDir(dir), { recursive: true }); T.writeJson(qFile(dir, q.id), q);
    // The agent runs as another user and writes its reply into the same file.
    const a = agentUser.info(); try { if (a && process.getuid?.() === 0) { fs.chownSync(qDir(dir), 0, a.gid); fs.chmodSync(qDir(dir), 0o2775); fs.chownSync(qFile(dir, q.id), 0, a.gid); } fs.chmodSync(qFile(dir, q.id), 0o664); } catch { /* best effort */ }
}

const answerPrompt = q => `The user asked this while reading their research topic. Answer it; do not change the paper.

Question (${q.id}): ${q.text}

How:
1. Read notes/decisions.md and notes/outline.md for what this research is about.
2. Look in the topic's sources first: research find "…", then research read <id> for the passages that matter. If the sources do not cover it, say so plainly; add a source (research add <url>) only if it is clearly needed.
3. Write a short answer in plain text (under 250 words, no LaTeX). After each claim put where it comes from in square brackets, like [s03 14:32] or [s02 p. 4]. Say what is uncertain or missing.
4. Save the answer to a file and hand it over: research reply ${q.id} --file <that file>
Do not edit anything under paper/. Do not ask the user anything in this run.`;

const addPrompt = q => `The user wants this answer worked into the paper.

Question (${q.id}): ${q.text}

Answer already given:
${q.answer}

How:
1. Read paper/main.tex and the files in paper/sections/ and decide where this belongs (an existing section, or a new one if nothing fits).
2. Write it into the paper in the paper's own voice, not as a question and answer. Every claim keeps its citation: get each \\cite with research cite <id> [--at mm:ss | --page n] --claim "…".
3. research build, and fix what it reports.
4. Tell the app where it went: research reply ${q.id} --added "<section title>"
Change only what this needs. Do not ask the user anything in this run.`;

// Start a single agent run in the topic for one question. If none can be started the question still waits, and an
// agent the user has open in the topic will see it through `research answers`.
async function dispatch(slug, dir, q, prompt, agent) {
    const name = `ask-${q.id.slice(0, 6)}${q.toPaper === 'requested' ? 'p' : ''}`;
    try {
        await shells.create({ name, kind: 'agent', agent: AGENTS.includes(agent) ? agent : 'claude', cwd: path.join('Research', slug), session: 'research', firstPrompt: prompt, oneshot: true });
        q.run = name; delete q.problem;
    } catch (e) { q.problem = `No agent could be started for this: ${e.message} It will be picked up by an agent you start in this topic.`; log('research', `${slug}: ask ${q.id} not dispatched: ${e.message}`); }
    save(dir, q);
}

export async function ask(slug, text, { agent = 'claude' } = {}) {
    const dir = topicPath(slug); const t = String(text || '').trim(); if (t.length < 3) throw httpError(400, 'Write the question first.');
    if (list(slug).filter(q => q.status === 'waiting').length >= 5) throw httpError(429, 'Five questions are still being answered. Wait for one to finish.');
    const q = { id: crypto.randomBytes(5).toString('hex'), topic: slug, text: t.slice(0, 2000), status: 'waiting', created: Date.now(), toPaper: null };
    save(dir, q); record('activity', 'research-question', { actor: 'phone', what: `${slug}: ${q.text.slice(0, 100)}`, cwd: dir });
    await dispatch(slug, dir, q, answerPrompt(q), agent);
    return q;
}
export async function addToPaper(slug, id, { agent = 'claude' } = {}) {
    const dir = topicPath(slug); const q = T.readJson(qFile(dir, id)); if (!q) throw httpError(404, 'No such question.');
    if (q.status !== 'answered') throw httpError(409, 'It has not been answered yet.');
    if (q.toPaper === 'done') throw httpError(409, 'That is already in the paper.');
    q.toPaper = 'requested'; q.toPaperAt = Date.now(); save(dir, q);
    record('activity', 'research-add-answer', { actor: 'phone', what: `${slug}: ${q.text.slice(0, 100)}`, cwd: dir });
    await dispatch(slug, dir, q, addPrompt(q), agent);
    return q;
}
export function remove(slug, id) { const dir = topicPath(slug); const f = qFile(dir, id); if (!T.exists(f)) throw httpError(404, 'No such question.'); fs.rmSync(f); return { ok: true }; }

// ---------- the editor's agent panel: ask for a change to the paper ----------
const editPrompt = q => `The user is editing their paper and asked you for this change.

Request (${q.id}): ${q.text}
${q.file ? `\nThey have paper/${q.file} open.` : ''}${q.selection ? `\nThey selected this text:\n<<<\n${q.selection}\n>>>` : ''}

How:
1. Read notes/decisions.md, and template/structure.md if it exists.
2. Make the change in paper/ and nothing wider than what was asked. Keep their wording wherever they did not ask for it to change.
3. A new claim needs a source: research find / research read, then research cite <id> [--at mm:ss | --page n] --claim "…" for the \\cite. Never invent a reference.
4. research build, and fix what it reports.
5. Tell them what you did in two or three plain sentences (which file, what changed, anything you could not do): research reply ${q.id} --text "…"
Do not ask the user anything in this run. Do not commit: versions are theirs to save.`;

export async function edit(slug, text, { agent = 'claude', file = '', selection = '' } = {}) {
    const dir = topicPath(slug); const t = String(text || '').trim(); if (t.length < 3) throw httpError(400, 'Say what you want changed.');
    if (list(slug).some(q => q.kind === 'edit' && q.status === 'waiting' && !q.problem)) throw httpError(409, 'An agent is already changing the paper. Wait for it to finish.');
    const q = { id: crypto.randomBytes(5).toString('hex'), topic: slug, kind: 'edit', text: t.slice(0, 2000), file: /^[\w./-]{1,80}$/.test(String(file)) ? String(file) : '', selection: String(selection || '').slice(0, 6000), status: 'waiting', created: Date.now(), toPaper: null };
    save(dir, q); record('activity', 'research-edit-request', { actor: 'phone', what: `${slug}: ${q.text.slice(0, 100)}`, cwd: dir });
    await dispatch(slug, dir, q, editPrompt(q), agent);
    return q;
}
