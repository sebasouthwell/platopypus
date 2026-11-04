#!/usr/bin/env node
// Release notes from UPDATE.md: every changelog entry "- **X.Y.Z** — …" newer than <previous> up to <version>.
//   node scripts/release-notes.mjs 1.14.1 1.3.0
import fs from 'node:fs';
import path from 'node:path';

const [version, previous] = process.argv.slice(2);
if (!version) { console.error('usage: release-notes.mjs <version> [previous]'); process.exit(2); }
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const text = fs.readFileSync(path.join(root, 'UPDATE.md'), 'utf8');
const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

// Each entry starts with "- **X.Y.Z**" and runs until the next entry, a blank line or a heading.
const entries = [];
let cur = null;
for (const line of text.split('\n')) {
    const m = line.match(/^- \*\*(\d+\.\d+\.\d+)\*\*\s*[—-]?\s*(.*)$/);
    if (m) { cur = { v: m[1], lines: [m[2]] }; entries.push(cur); continue; }
    if (cur && /^\s{2,}\S/.test(line)) { cur.lines.push(line.trim()); continue; }
    cur = null;
}
const picked = entries.filter(e => cmp(e.v, version) <= 0 && (!previous || cmp(e.v, previous) > 0)).sort((a, b) => cmp(b.v, a.v));
const list = picked.length ? picked : entries.filter(e => e.v === version);
if (!list.length) { console.error(`UPDATE.md has no entry for ${version}`); process.exit(1); }

const out = [];
out.push(`Boxes on the stable channel get this from **More → Update**.${previous ? ` Changes since ${previous}:` : ''}`, '');
for (const e of list) out.push(`### ${e.v}`, '', e.lines.join(' '), '');
const repo = process.env.GITHUB_REPOSITORY;
out.push(`Compatibility contract and state formats: ${repo ? `[UPDATE.md](https://github.com/${repo}/blob/v${version}/UPDATE.md)` : 'UPDATE.md'}.`);
console.log(out.join('\n'));
