// Every project keeps PlatOpypus's and Claude's per-box folders out of git: .porthole/ (security level, upgrade brief,
// prototype copy, ACL marker) and .claude/ (agent settings and local memory). Added when a project is created, gets
// its security level, becomes a git repo, or an agent session starts in it.
//
// Manual override: a project that wants one of them tracked says so in its .gitignore with a negation
// (`!.claude/` or `!.porthole/`), or by writing the line `# porthole: track .claude` — PlatOpypus then leaves it alone.
import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.js';

export const DEFAULT_IGNORES = ['.porthole/', '.claude/'];

const norm = l => l.trim().replace(/^\/+/, '').replace(/\/+$/, '').replace(/^\*\*\//, '');

// Adds what is missing; returns the entries added (empty when nothing changed).
export function ensureIgnored(root, entries = DEFAULT_IGNORES) {
    if (!root) return [];
    const file = path.join(root, '.gitignore');
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { /* none yet */ }
    const lines = text.split('\n');
    const have = new Set(lines.map(norm));
    const overridden = new Set(lines.filter(l => /^\s*!/.test(l)).map(l => norm(l.replace(/^\s*!/, ''))));
    for (const m of text.matchAll(/^#\s*porthole:\s*track\s+(\S+)/gim)) overridden.add(norm(m[1]));
    const add = entries.filter(e => !have.has(norm(e)) && !overridden.has(norm(e)));
    if (!add.length) return [];
    const block = `${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}# PlatOpypus: per-box folders, not part of the project (to track one, add e.g. "!.claude/")\n${add.join('\n')}\n`;
    try {
        fs.writeFileSync(file, text + block);
        // Keep the file usable by agent shells (group porthole-dev) when the folder is shared with them.
        try { const st = fs.statSync(root); fs.chownSync(file, fs.statSync(file).uid, st.gid); fs.chmodSync(file, 0o664); } catch { /* best effort */ }
        log('gitignore', `${path.basename(root)}: added ${add.join(' ')}`);
        return add;
    } catch { return []; }
}
