// Pre-accept each agent's "do you trust this folder?" prompt for the folder a PlatOpypus shell starts in, so an agent
// opened on the phone goes straight to work. Only ever for the exact folder the user picked in PlatOpypus; everything is
// best-effort (a format change in an agent's config must never stop the shell from starting).
//
//   Claude Code   <config>/.claude.json  projects[dir].hasTrustDialogAccepted = true  (config = CLAUDE_CONFIG_DIR's
//                 .claude.json, or ~/.claude.json for the default profile)
//   Codex CLI     ~/.codex/config.toml   [projects."<dir>"] trust_level = "trusted"
//   Antigravity   ~/.gemini/trustedFolders.json  { "<dir>": "TRUST_FOLDER" }  (Gemini CLI lineage)

import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.js';

function writeAtomic(file, text, owner) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.porthole-tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    if (owner) { try { fs.chownSync(tmp, owner.uid, owner.gid); fs.chownSync(path.dirname(file), owner.uid, owner.gid); } catch { /* best effort */ } }
    fs.renameSync(tmp, file);
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; } }

// home: the home of the user the agent runs as; configDir: CLAUDE_CONFIG_DIR if a profile is used; owner: {uid,gid}
// when that user is not root (files must stay readable by it).
export function trustFolder(agent, dir, { home, configDir = null, owner = null } = {}) {
    try {
        if (agent === 'claude') {
            const file = configDir ? path.join(configDir, '.claude.json') : path.join(home, '.claude.json');
            const cfg = readJson(file);
            cfg.projects = cfg.projects && typeof cfg.projects === 'object' ? cfg.projects : {};
            const p = cfg.projects[dir] || {};
            if (p.hasTrustDialogAccepted === true) return false;
            cfg.projects[dir] = { allowedTools: [], ...p, hasTrustDialogAccepted: true };
            writeAtomic(file, JSON.stringify(cfg, null, 2), owner);
        } else if (agent === 'codex') {
            const file = path.join(home, '.codex', 'config.toml');
            let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch { /* new */ }
            const header = `[projects.${JSON.stringify(dir)}]`;
            if (text.includes(header)) return false;
            writeAtomic(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}\n${header}\ntrust_level = "trusted"\n`, owner);
        } else if (agent === 'antigravity') {
            const file = path.join(home, '.gemini', 'trustedFolders.json');
            const cfg = readJson(file);
            if (cfg[dir] === 'TRUST_FOLDER') return false;
            cfg[dir] = 'TRUST_FOLDER';
            writeAtomic(file, JSON.stringify(cfg, null, 2), owner);
        } else return false;
        log('trust', `${agent} now trusts ${dir}`);
        return true;
    } catch (e) {
        log('trust', `could not pre-trust ${dir} for ${agent}: ${e.message}`);
        return false;
    }
}
