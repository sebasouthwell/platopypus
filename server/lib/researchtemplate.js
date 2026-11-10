// A template or an example of what the paper should look like, per topic. Optional.
//
//   a LaTeX zip (for instance Overleaf's "Download source")  -> template/latex/, and optionally the paper's starting point
//   a PDF of a paper whose structure you want to follow        -> template/example.pdf + its text
// Either way the box writes template/structure.md (class, packages, section headings), which is what the agent reads:
// a page of structure instead of a whole document. A template is guidance, never a source to cite.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { record } from './audit.js';
import * as agentUser from './agentuser.js';
import * as T from './researchtools.js';
import { topicPath } from './research.js';
import { commit, ensureRepos } from './researchrepo.js';

const run = promisify(execFile);
const httpError = T.httpError;
const MAX = 60 * 1024 * 1024, MAX_FILES = 800, MAX_UNPACKED = 200 * 1024 * 1024;
const infoFile = dir => path.join(dir, '.platopypus', 'template.json');

export function get(slug) {
    const dir = topicPath(slug); const info = T.readJson(infoFile(dir), null);
    let structure = ''; try { structure = fs.readFileSync(path.join(dir, 'template', 'structure.md'), 'utf8').slice(0, 20000); } catch { /* none */ }
    return { template: info, structure };
}
export function remove(slug) {
    const dir = topicPath(slug); fs.rmSync(path.join(dir, 'template'), { recursive: true, force: true }); fs.rmSync(infoFile(dir), { force: true });
    return { ok: true };
}

async function receive(req, file) {
    let size = 0; const ws = fs.createWriteStream(file, { mode: 0o600 });
    await new Promise((ok, bad) => {
        req.on('data', c => { size += c.length; if (size > MAX) { req.destroy(); bad(httpError(413, 'That file is over 60 MB.')); } else ws.write(c); });
        req.on('end', () => ws.end(ok)); req.on('error', bad);
    });
    const head = Buffer.alloc(5); const fd = fs.openSync(file, 'r'); fs.readSync(fd, head, 0, 5, 0); fs.closeSync(fd);
    return head.toString('latin1');
}
function shareWithAgent(dir) {
    const a = agentUser.info(); if (!a || process.getuid?.() !== 0) return;
    const walk = d => { try { fs.chownSync(d, 0, a.gid); fs.chmodSync(d, fs.statSync(d).isDirectory() ? 0o2775 : 0o664); if (fs.statSync(d).isDirectory()) for (const f of fs.readdirSync(d)) walk(path.join(d, f)); } catch { /* best effort */ } };
    walk(dir);
}
const texFiles = (root, out = []) => { for (const e of fs.readdirSync(root, { withFileTypes: true })) { const p = path.join(root, e.name); if (e.isDirectory()) texFiles(p, out); else if (/\.(tex|cls|sty|bib|bst)$/i.test(e.name)) out.push(p); } return out; };

function latexStructure(root) {
    const files = texFiles(root); const tex = files.filter(f => f.endsWith('.tex'));
    const main = tex.find(f => /\\documentclass/.test(fs.readFileSync(f, 'utf8'))) || tex[0] || null;
    const lines = ['# Template structure', '', 'Follow this structure and keep its class and packages. It is guidance for layout, not a source to cite.', ''];
    if (main) {
        const m = fs.readFileSync(main, 'utf8');
        lines.push(`Main file: ${path.relative(root, main)}`, `Document class: ${m.match(/\\documentclass(?:\[[^\]]*\])?\{[^}]+\}/)?.[0] || '(not found)'}`);
        const pk = [...m.matchAll(/\\usepackage(?:\[[^\]]*\])?\{([^}]+)\}/g)].map(x => x[1]); if (pk.length) lines.push(`Packages: ${pk.join(', ')}`);
        const bib = m.match(/\\bibliographystyle\{([^}]+)\}/)?.[1] || (/\\addbibresource|biblatex/.test(m) ? 'biblatex' : ''); if (bib) lines.push(`Bibliography: ${bib}`);
    }
    lines.push('', '## Sections, in order');
    for (const f of tex) { const heads = [...fs.readFileSync(f, 'utf8').matchAll(/\\(chapter|section|subsection)\*?\{([^}]{1,120})\}/g)]; if (heads.length) { lines.push(`- ${path.relative(root, f)}`); for (const h of heads.slice(0, 60)) lines.push(`${h[1] === 'subsection' ? '    ' : '  '}- ${h[2]}`); } }
    lines.push('', '## Files', ...files.slice(0, 80).map(f => `- ${path.relative(root, f)}`));
    return { text: lines.join('\n') + '\n', main };
}
function pdfStructure(text, pages) {
    const KNOWN = /^(abstract|introduction|background|related work|literature review|method(s|ology)?|materials and methods|approach|experiments?|results?|evaluation|analysis|discussion|limitations|conclusions?|future work|acknowledge?ments?|references|bibliography|appendix.*)$/i;
    const heads = []; const seen = new Set();
    for (const raw of text.split('\n')) {
        const l = raw.trim(); if (l.length < 3 || l.length > 90) continue;
        const num = l.match(/^(\d{1,2}(?:\.\d{1,2}){0,2})\.?\s+([A-Z][^.]{2,80})$/);
        const h = num ? `${num[1]} ${num[2]}` : KNOWN.test(l) ? l : null;
        if (h && !seen.has(h.toLowerCase())) { seen.add(h.toLowerCase()); heads.push({ h, depth: num ? num[1].split('.').length : 1 }); }
    }
    const words = text.split(/\s+/).filter(Boolean).length;
    return ['# Example structure', '', 'The user gave this paper as an example of the structure and length to aim for. Follow its shape; do not cite it', 'and do not copy its wording.', '', `Length: ${pages} page${pages === 1 ? '' : 's'}, about ${words < 200 ? words : Math.round(words / 100) * 100} words.`, '', '## Headings found, in order', ...(heads.length ? heads.slice(0, 80).map(x => `${'  '.repeat(x.depth - 1)}- ${x.h}`) : ['(none recognised: read template/example.txt for the layout)']), ''].join('\n');
}

// adopt: for a LaTeX zip, also make it the paper's starting point (the current paper is saved as a version first).
export async function upload(slug, req, name, { adopt = false } = {}) {
    const dir = await ensureRepos(slug); const tdir = path.join(dir, 'template');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plato-tpl-')); const tmp = path.join(tmpDir, 'upload');
    try {
        const head = await receive(req, tmp); const clean = String(name || '').replace(/[^\w .()-]+/g, '_').slice(0, 100);
        let info;
        if (head === '%PDF-') {
            if (!(await T.which('pdftotext'))) throw httpError(501, 'pdftotext is not installed (run: research setup).');
            fs.rmSync(tdir, { recursive: true, force: true }); fs.mkdirSync(tdir, { recursive: true });
            fs.copyFileSync(tmp, path.join(tdir, 'example.pdf'));
            const { stdout } = await run('pdftotext', ['-layout', path.join(tdir, 'example.pdf'), '-'], { maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
            const pages = stdout.split('\f').filter(p => p.trim()).length;
            fs.writeFileSync(path.join(tdir, 'example.txt'), stdout); fs.writeFileSync(path.join(tdir, 'structure.md'), pdfStructure(stdout, pages));
            info = { kind: 'pdf', name: clean || 'example.pdf', at: Date.now(), pages, adopted: false };
        } else if (head.startsWith('PK')) {
            // Look before unpacking: no absolute paths, no "..", a sane number of files and total size.
            const { stdout: listing } = await run('unzip', ['-Z', '-1', tmp], { maxBuffer: 8 * 1024 * 1024 }).catch(() => { throw httpError(400, 'That zip could not be read.'); });
            const names = listing.split('\n').filter(Boolean);
            if (!names.length || names.length > MAX_FILES) throw httpError(400, `A template zip holds 1 to ${MAX_FILES} files.`);
            if (names.some(n => n.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(n) || n.includes('\\'))) throw httpError(400, 'That zip has unsafe paths in it.');
            const { stdout: tot } = await run('unzip', ['-Z', '-t', tmp]); const bytes = Number(tot.match(/(\d+) bytes uncompressed/)?.[1] || 0);
            if (bytes > MAX_UNPACKED) throw httpError(413, 'That zip unpacks to more than 200 MB.');
            if (!names.some(n => /\.tex$/i.test(n))) throw httpError(400, 'There is no .tex file in that zip.');
            fs.rmSync(tdir, { recursive: true, force: true }); const ldir = path.join(tdir, 'latex'); fs.mkdirSync(ldir, { recursive: true });
            await run('unzip', ['-q', '-o', tmp, '-d', ldir], { timeout: 120_000 });
            // A link inside the archive could point outside the topic: remove any.
            const strip = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isSymbolicLink()) fs.rmSync(p, { force: true }); else if (e.isDirectory()) strip(p); } }; strip(ldir);
            // Overleaf zips often hold one top folder: use its contents.
            let root = ldir; const top = fs.readdirSync(ldir); if (top.length === 1 && fs.statSync(path.join(ldir, top[0])).isDirectory()) root = path.join(ldir, top[0]);
            const st = latexStructure(root); fs.writeFileSync(path.join(tdir, 'structure.md'), st.text);
            info = { kind: 'latex', name: clean || 'template.zip', at: Date.now(), files: names.length, main: st.main ? path.relative(root, st.main) : null, adopted: false };
            if (adopt) {
                if (!st.main) throw httpError(400, 'No file with \\documentclass was found, so it cannot be the paper. It is kept as a reference.');
                await commit(slug, 'Before using the uploaded template');     // the paper as it was stays in the history
                const paper = path.join(dir, 'paper'); const keepBib = T.exists(path.join(paper, 'refs.bib')) ? fs.readFileSync(path.join(paper, 'refs.bib'), 'utf8') : '';
                fs.cpSync(root, paper, { recursive: true, force: true });
                if (path.relative(root, st.main) !== 'main.tex') fs.copyFileSync(st.main, path.join(paper, 'main.tex'));
                if (keepBib.trim()) fs.writeFileSync(path.join(paper, 'refs.bib'), keepBib);      // your references are not replaced by the template's
                else if (!T.exists(path.join(paper, 'refs.bib'))) fs.writeFileSync(path.join(paper, 'refs.bib'), '');
                fs.mkdirSync(path.join(paper, 'sections'), { recursive: true });
                info.adopted = true; shareWithAgent(paper);
            }
        } else throw httpError(400, 'Upload a LaTeX zip (for example Overleaf: Menu, Download, Source) or a PDF.');
        T.writeJson(infoFile(dir), info); shareWithAgent(tdir);
        record('activity', 'research-template', { actor: 'phone', what: `${slug}: ${info.kind} ${info.name}${info.adopted ? ' (used as the paper)' : ''}`, cwd: dir });
        await commit(slug, `Template: ${info.name}${info.adopted ? ' (used as the paper)' : ''}`).catch(() => {});
        return get(slug);
    } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
}
