// Source control for a research topic, and PDF upload.
//
// Two repositories per topic, on purpose:
//   /Research/<Topic>         everything except the paper: sources (uploaded PDFs included), extracted text, notes.
//                             Local history only. It is never pushed anywhere (projects.allowPush refuses it).
//   /Research/<Topic>/paper   the LaTeX and refs.bib. This is the only part that may be published, and only to a
//                             private repo. Keeping it a separate repository means a push cannot carry a source file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { record } from './audit.js';
import * as T from './researchtools.js';
import { topicPath } from './research.js';

const run = promisify(execFile);
const httpError = T.httpError;
const ID = ['-c', 'safe.directory=*', '-c', 'user.name=PlatOpypus', '-c', 'user.email=plato@localhost', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false'];
const git = async (cwd, args) => (await run('git', [...ID, ...args], { cwd, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })).stdout;

const ROOT_IGNORE = '# The paper has its own repository (paper/.git): it is the only part that may be published.\n/paper/\n# Made again from the originals when needed.\nsources/*/frames/\nsources/*/pages/\nsources/*/audio.*\nsources/*/video.*\n.platopypus/asks/\n.platopypus/cost.json\n';
const PAPER_IGNORE = '/build/\n';

async function ensure(dir, ignore) {
    if (!T.exists(path.join(dir, '.gitignore'))) fs.writeFileSync(path.join(dir, '.gitignore'), ignore);
    if (!T.exists(path.join(dir, '.git'))) await git(dir, ['init', '-q']);
}
export async function ensureRepos(slug) {
    const dir = topicPath(slug);
    await ensure(dir, ROOT_IGNORE); await ensure(path.join(dir, 'paper'), PAPER_IGNORE);
    return dir;
}
async function commitIn(dir, message) {
    await git(dir, ['add', '-A']);
    if (!(await git(dir, ['status', '--porcelain'])).trim()) return null;
    await git(dir, ['commit', '-q', '-m', message]);
    return (await git(dir, ['rev-parse', '--short', 'HEAD'])).trim();
}
// One "version": a commit in whichever of the two repositories has changes.
export async function commit(slug, message) {
    const dir = await ensureRepos(slug); const msg = String(message || '').trim().slice(0, 200) || 'Saved version';
    const out = { paper: await commitIn(path.join(dir, 'paper'), msg), research: await commitIn(dir, msg) };
    if (out.paper || out.research) record('activity', 'research-version', { actor: 'phone', what: `${slug}: ${msg}`, cwd: dir });
    return out;
}
export async function history(slug, n = 30) {
    const dir = await ensureRepos(slug); const out = [];
    for (const [where, d] of [['paper', path.join(dir, 'paper')], ['research', dir]]) {
        let log = ''; try { log = await git(d, ['log', `-${n}`, '--format=%h%x09%ct%x09%s']); } catch { /* no commits yet */ }
        for (const l of log.split('\n').filter(Boolean)) { const [id, t, ...s] = l.split('\t'); out.push({ where, id, at: Number(t) * 1000, message: s.join('\t') }); }
    }
    return out.sort((a, b) => b.at - a.at).slice(0, n);
}

// A PDF sent from the browser becomes a source: sources/<id>/original.pdf + extracted text, then a version.
export async function upload(slug, req, name) {
    const dir = await ensureRepos(slug);
    const base = String(name || 'document.pdf').replace(/[^\w .()-]+/g, '_').replace(/\.pdf$/i, '').slice(0, 90) || 'document';
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plato-up-')); const tmp = path.join(tmpDir, base + '.pdf');
    try {
        const MAX = 80 * 1024 * 1024; let size = 0; const ws = fs.createWriteStream(tmp, { mode: 0o600 });
        await new Promise((ok, bad) => {
            req.on('data', c => { size += c.length; if (size > MAX) { req.destroy(); bad(httpError(413, 'That PDF is over 80 MB.')); } else ws.write(c); });
            req.on('end', () => ws.end(ok)); req.on('error', bad);
        });
        const head = Buffer.alloc(5); const fd = fs.openSync(tmp, 'r'); fs.readSync(fd, head, 0, 5, 0); fs.closeSync(fd);
        if (head.toString('latin1') !== '%PDF-') throw httpError(400, 'That file is not a PDF.');
        const sha = crypto.createHash('sha256').update(fs.readFileSync(tmp)).digest('hex');
        const dupe = T.listSources(dir).find(m => m.sha256 === sha); if (dupe) throw httpError(409, `That PDF is already here as ${dupe.id} (${dupe.title}).`);
        const r = await T.addSource(dir, tmp, { note: 'uploaded' });
        const id = r.meta.id; const mf = path.join(dir, 'sources', id, 'meta.json');
        let meta = T.readJson(mf, {}); meta.sha256 = sha; meta.uploaded = true; meta.file = base + '.pdf'; meta.needsMeta = true; T.writeJson(mf, meta);
        // A DOI gives the publisher's own entry. Without one the agent reads the first and last page (research meta <id>).
        const doi = await T.resolveDoi(dir, id).catch(e => ({ ok: false, reason: e.message }));
        meta = T.readJson(mf, {});
        const c = T.cite(dir, id, {});         // a refs.bib entry tied to the file, ready to cite
        await commit(slug, `Add source ${id}: ${meta.title || base}`);
        return { id, title: meta.title || base, key: c.key, pages: meta.pages || null, doi: doi.ok ? doi.doi : null, needsMeta: !doi.ok };
    } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
}
