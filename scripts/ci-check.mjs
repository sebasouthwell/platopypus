#!/usr/bin/env node
// Static release gate, run by CI on every push (and locally: node scripts/ci-check.mjs).
//   - server/package.json version is MAJOR.MINOR.PATCH and UPDATE.md has a changelog entry for it
//   - with --since <git ref>: if code changed since that ref, the version was bumped
//   - every JavaScript file parses (node --check), every shell script parses (bash -n)
// Exit code 1 with one line per problem.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const problems = [];
const say = m => problems.push(m);

const version = JSON.parse(fs.readFileSync(path.join(root, 'server/package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) say(`server/package.json version "${version}" is not MAJOR.MINOR.PATCH`);
const update = fs.readFileSync(path.join(root, 'UPDATE.md'), 'utf8');
if (!update.includes(`- **${version}**`)) say(`UPDATE.md has no changelog entry "- **${version}** — …" for the current version`);

// Version bump check against a previous commit (CI passes the commit before the push).
const since = process.argv.includes('--since') ? process.argv[process.argv.indexOf('--since') + 1] : null;
if (since && !/^0+$/.test(since)) {
    try {
        const changed = execFileSync('git', ['-C', root, 'diff', '--name-only', since, 'HEAD'], { encoding: 'utf8' }).split('\n').filter(Boolean);
        const code = changed.filter(f => /^(server|web|bin|deploy)\/|^install\.sh$/.test(f) && !/\.md$/.test(f));
        const before = JSON.parse(execFileSync('git', ['-C', root, 'show', `${since}:server/package.json`], { encoding: 'utf8' })).version;
        if (code.length && before === version) say(`code changed since ${since.slice(0, 7)} (${code.slice(0, 3).join(', ')}${code.length > 3 ? ', …' : ''}) but the version is still ${version}; bump server/package.json and add an UPDATE.md entry`);
        const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
        if (cmp(version, before) < 0) say(`version went backwards: ${before} → ${version}`);
    } catch (e) { console.log(`(skipping bump check: ${String(e.message).split('\n')[0]})`); }
}

// Syntax of everything that ships.
function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out); else out.push(p);
    }
    return out;
}
const files = ['server', 'web', 'bin', 'deploy', 'scripts', 'test'].flatMap(d => fs.existsSync(path.join(root, d)) ? walk(path.join(root, d)) : []).concat([path.join(root, 'install.sh')]);
let js = 0, shells = 0;
for (const f of files) {
    const rel = path.relative(root, f).replace(/\\/g, '/');
    let kind = /\.(m?js)$/.test(f) ? 'js' : /\.sh$/.test(f) ? 'sh' : null;
    if (!kind && (rel.startsWith('bin/') || rel.startsWith('deploy/githooks/'))) {
        const first = fs.readFileSync(f, 'utf8').split('\n')[0];
        kind = /node/.test(first) ? 'js' : /\b(ba)?sh\b/.test(first) ? 'sh' : kind;
    }
    if (rel.startsWith('web/vendor/') || rel.endsWith('.min.js')) continue;
    try {
        if (kind === 'js') { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); js++; }
        else if (kind === 'sh' && process.platform !== 'win32') { execFileSync('bash', ['-n', f], { stdio: 'pipe' }); shells++; } // Windows: bash may be WSL's launcher; CI checks these on Linux
    } catch (e) { say(`${rel}: ${String(e.stderr || e.message).trim().split('\n').slice(0, 4).join(' | ')}`); }
}

if (problems.length) { for (const p of problems) console.log(`::error::${p}`); process.exit(1); }
console.log(`ci-check ok: version ${version}, ${js} JavaScript files, ${shells} shell scripts`);
