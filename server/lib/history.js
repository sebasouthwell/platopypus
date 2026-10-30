// History: recent shell commands (bash/zsh) and recent Claude Code prompts, so the phone can
// re-run or re-send them without retyping.

import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

async function readTail(file, maxBytes = 256 * 1024) {
    try {
        const h = await fs.open(file, 'r');
        try {
            const { size } = await h.stat();
            const start = Math.max(0, size - maxBytes);
            const buf = Buffer.alloc(size - start);
            await h.read(buf, 0, buf.length, start);
            const text = buf.toString('utf8');
            return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
        } finally {
            await h.close();
        }
    } catch {
        return '';
    }
}

export async function commands(limit = 150) {
    const bash = await readTail(path.join(config.home, '.bash_history'));
    const zsh = await readTail(path.join(config.home, '.zsh_history'));
    const lines = [];
    for (const raw of bash.split('\n')) {
        if (!raw || raw.startsWith('#')) continue; // timestamps when HISTTIMEFORMAT is set
        lines.push(raw);
    }
    for (const raw of zsh.split('\n')) {
        if (!raw) continue;
        const m = raw.match(/^: \d+:\d+;(.*)$/); // extended history format
        lines.push(m ? m[1] : raw);
    }
    // Most recent first, de-duplicated.
    const seen = new Set();
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        const cmd = lines[i].trim();
        if (!cmd || seen.has(cmd)) continue;
        seen.add(cmd);
        out.push(cmd);
    }
    return out;
}

export async function prompts(limit = 100) {
    const text = await readTail(path.join(config.home, '.claude', 'history.jsonl'), 1024 * 1024);
    const out = [];
    const lines = text.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        try {
            const j = JSON.parse(lines[i]);
            const display = (j.display || j.prompt || '').toString().trim();
            if (!display) continue;
            out.push({ text: display, when: j.timestamp || null, project: j.project || null });
        } catch { /* partial line */ }
    }
    return out;
}
