// AI agents that can run in a PlatOpypus shell, their per-agent flags, and Claude Code profiles.
//
// A Claude "profile" is an isolated config directory (credentials, settings, history) selected with
// CLAUDE_CONFIG_DIR — the same mechanism the account-switcher tools use. Profiles live in
// ~/.agent-profiles/claude/<name>; the default profile is ~/.claude.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { log } from './log.js';
import * as agentUser from './agentuser.js';
import * as cline from './cline.js';

const run = promisify(execFile);

function httpError(status, message) {
    const e = new Error(message);
    e.status = status;
    return e;
}

export const catalog = {
    claude: {
        key: 'claude', title: 'Claude Code', vendor: 'Anthropic', bin: 'claude',
        yoloFlag: '--dangerously-skip-permissions', yoloEnv: { IS_SANDBOX: '1' }, // Claude refuses the flag as root unless it believes it is sandboxed
        resumeArgs: ['--continue'], loginArgs: [], profiles: true,
        quick: ['yes', 'no', 'continue', 'show the diff', 'run the tests', 'run it and share a link', 'commit this', '/compact', '/clear'],
        blurb: 'Deep terminal harness; Remote Control to the Claude app.',
    },
    codex: {
        key: 'codex', title: 'Codex CLI', vendor: 'OpenAI', bin: 'codex',
        yoloFlag: '--dangerously-bypass-approvals-and-sandbox', yoloEnv: {},
        resumeArgs: ['resume', '--last'], loginArgs: ['login'], profiles: false,
        quick: ['yes', 'no', 'continue', 'show the diff', 'run the tests', 'commit this', '/compact', '/new'],
        blurb: 'OpenAI\'s coding agent; sandboxed by default.',
    },
    antigravity: {
        key: 'antigravity', title: 'Antigravity CLI', vendor: 'Google', bin: 'agy',
        yoloFlag: '--dangerously-skip-permissions', yoloEnv: {},   // agy 1.4: --dangerously-skip-permissions, --continue
        resumeArgs: ['--continue'], loginArgs: [], profiles: false,
        quick: ['yes', 'no', 'continue', 'show the diff', 'run the tests', 'commit this', '/compress', '/clear'],
        blurb: 'Google\'s terminal agent (successor to Gemini CLI, June 2026).',
    },
    cline: {
        key: 'cline', title: 'Cline', vendor: 'Ollama (your server)', bin: 'cline',
        // Cline approves every tool by default: a normal session turns that off, an auto-approve one leaves it on.
        baseArgs: ['-i'], safeArgs: ['--auto-approve', 'false'], yoloFlag: null, yoloEnv: {},
        resumeArgs: [], loginArgs: [], profiles: false, noResume: true,
        quick: ['yes', 'no', 'continue', 'show the diff', 'run the tests', 'commit this'],
        blurb: 'Open-source coding agent, running on an Ollama server you choose.',
    },
};

// Logins live with the agent user once moved (stage 2), otherwise with root.
const home = () => agentUser.loginHome();
const profilesRootDir = () => path.join(home(), '.agent-profiles', 'claude');
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/;

async function which(bin) {
    try { const { stdout } = await run('bash', ['-lc', `command -v ${bin}`], { timeout: 5000 }); return stdout.trim() || null; } catch { return null; }
}
async function version(bin) {
    try { const { stdout } = await run('bash', ['-lc', `${bin} --version 2>/dev/null | head -1`], { timeout: 8000 }); return stdout.trim() || null; } catch { return null; }
}

function claudeSignedIn(dir) {
    return fs.existsSync(path.join(dir, '.credentials.json'));
}

export function profileDir(name) {
    if (!name || name === 'default') return path.join(home(), '.claude');
    if (!NAME_RE.test(name)) throw httpError(400, 'Profile name: letters, numbers, dash, underscore.');
    const dir = path.join(profilesRootDir(), name);
    if (!fs.existsSync(dir)) throw httpError(404, 'No such profile.');
    return dir;
}

export function listProfiles() {
    const out = [{ name: 'default', dir: path.join(home(), '.claude'), signedIn: claudeSignedIn(path.join(home(), '.claude')) }];
    try {
        for (const e of fs.readdirSync(profilesRootDir(), { withFileTypes: true })) {
            if (!e.isDirectory()) continue;
            const dir = path.join(profilesRootDir(), e.name);
            out.push({ name: e.name, dir, signedIn: claudeSignedIn(dir) });
        }
    } catch { /* none yet */ }
    return out;
}

export function createProfile(name) {
    if (!NAME_RE.test(name) || name === 'default') throw httpError(400, 'Profile name: letters, numbers, dash, underscore.');
    const dir = path.join(profilesRootDir(), name);
    if (fs.existsSync(dir)) throw httpError(409, 'Profile already exists.');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const owner = home() !== config.home ? agentUser.info() : null;
    if (owner) { for (const d of [path.dirname(path.dirname(dir)), path.dirname(dir), dir]) { try { fs.chownSync(d, owner.uid, owner.gid); } catch { /* best effort */ } } }
    // Share the global instructions (vault/tunnel/git guidance) with every profile.
    const globalMd = path.join(home(), '.claude', 'CLAUDE.md');
    if (fs.existsSync(globalMd)) { fs.copyFileSync(globalMd, path.join(dir, 'CLAUDE.md')); if (owner) { try { fs.chownSync(path.join(dir, 'CLAUDE.md'), owner.uid, owner.gid); } catch { /* best effort */ } } }
    log('agents', `created claude profile "${name}"`);
    return { name, dir, signedIn: false };
}

export function removeProfile(name) {
    if (name === 'default') throw httpError(400, 'The default profile cannot be removed.');
    const dir = profileDir(name);
    fs.rmSync(dir, { recursive: true, force: true });
    log('agents', `removed claude profile "${name}"`);
}

let statusCache = { at: 0, value: null };
export async function status() {
    if (statusCache.value && Date.now() - statusCache.at < 30_000) return refreshSignIn(statusCache.value);
    const out = [];
    const probes = await Promise.all(Object.values(catalog).map(async a => { const bin = await which(a.bin); return { a, bin, ver: bin ? await version(a.bin) : null }; }));
    for (const { a, bin, ver } of probes) {
        let signedIn = null;
        if (a.key === 'claude') signedIn = claudeSignedIn(path.join(home(), '.claude'));
        if (a.key === 'codex') signedIn = fs.existsSync(path.join(home(), '.codex', 'auth.json'));
        if (a.key === 'antigravity') signedIn = ['.antigravity', '.gemini'].some(d => fs.existsSync(path.join(home(), d, 'oauth_creds.json'))) || !!process.env.GEMINI_API_KEY;
        if (a.key === 'cline') signedIn = cline.settings().ready;
        out.push({ key: a.key, title: a.title, vendor: a.vendor, blurb: a.blurb, installed: !!bin, version: ver, signedIn, profiles: a.profiles ? listProfiles() : null, yoloFlag: a.yoloFlag, quick: a.quick });
    }
    statusCache = { at: Date.now(), value: out };
    return out;
}

// Sign-in state and profiles are cheap file checks: refresh them even when the version probe is cached.
function refreshSignIn(list) {
    return list.map(a => {
        let signedIn = a.signedIn;
        if (a.key === 'claude') signedIn = claudeSignedIn(path.join(home(), '.claude'));
        if (a.key === 'codex') signedIn = fs.existsSync(path.join(home(), '.codex', 'auth.json'));
        if (a.key === 'antigravity') signedIn = ['.antigravity', '.gemini'].some(d => fs.existsSync(path.join(home(), d, 'oauth_creds.json'))) || !!process.env.GEMINI_API_KEY;
        if (a.key === 'cline') signedIn = cline.settings().ready;
        return { ...a, signedIn, profiles: a.profiles ? listProfiles() : null };
    });
}

// Build the command + env for a shell that runs an agent.
// A model name is passed to the agent's own --model flag; it is checked to be a plain name, never free shell text.
export const MODEL_OK = /^[A-Za-z0-9][A-Za-z0-9._:\/\[\]@-]{0,99}$/;
// Codex can drive a model on your Ollama server instead of OpenAI's: write the model as "oss:<name>".
export const ossModel = (agent, model) => (agent === 'codex' && /^oss:/.test(String(model || '').trim()) ? String(model).trim().slice(4) : null);
// The Conspiracy MCP server (bin/sleuth-mcp) on an agent's command line, for case sessions. Codex filters the
// environment of MCP servers, so the shell token is passed through by name. Cline reads it from its MCP settings file
// (written per shell, see cline.isolate). Others: none.
export const SLEUTH_TOOLS = ['case_status', 'send_probe', 'list_probes', 'show_probe', 'adopt_probe_sources', 'add_source', 'pin_card', 'connect_cards', 'add_note', 'add_question', 'answer_question', 'add_theory', 'weigh_evidence', 'find_paths'];
export const RESEARCH_TOOLS = ['research_status', 'add_source', 'find', 'read', 'transcript', 'frames', 'see_frames', 'source_meta', 'cite', 'build_paper', 'ask_user', 'wait_answer', 'user_answers', 'reply_question'];
// The MCP server for a session type: sleuth for a Conspiracy case, research for a Research topic.
export const LAB_TOOLS = ['lab_status', 'lab_tools', 'run_tool', 'show_run'];
export const JOB_TOOLS = ['me_summary', 'me_item', 'add_me', 'propose_me', 'link_me', 'me_duplicates', 'tidy_suggestions', 'suggest_merge', 'suggest_fix', 'suggest_remove', 'code_summary', 'mark_code_read', 'list_applications', 'add_event', 'list_frameworks', 'framework_info', 'detect_framework', 'save_assessment', 'add_me_note', 'previous_assessments', 'cpd_entries', 'mark_cpd_processed', 'doc_files', 'read_doc', 'mark_doc_read', 'cv_files', 'read_cv', 'list_cv_templates', 'create_cv_template', 'update_cv_template', 'build_cv_template', 'set_search', 'hunt', 'list_jobs', 'show_job', 'add_job', 'set_requirements', 'compatibility', 'save_match', 'uk_estimate', 'save_money', 'add_gap', 'cv_sections', 'cv_section_text', 'suggest_cv_section', 'save_draft', 'read_draft', 'job_advice', 'set_wish_plan', 'set_route', 'show_plan', 'save_plan', 'finish_wish', 'log'];
export const SELFCHECK_TOOLS = ['selfcheck_findings', 'selfcheck_log', 'selfcheck_waiting', 'selfcheck_report'];
export const MCP_FOR = { selfcheck: { name: 'selfcheck', command: 'plato-mcp', args: ['selfcheck'], tools: SELFCHECK_TOOLS }, jobs: { name: 'jobs', command: 'plato-mcp', args: ['jobs'], tools: JOB_TOOLS }, case: { name: 'sleuth', command: 'sleuth-mcp', tools: SLEUTH_TOOLS }, research: { name: 'research', command: 'research-mcp', tools: RESEARCH_TOOLS }, lab: { name: 'lab', command: 'lab-mcp', tools: LAB_TOOLS } };
const PASS_ENV = '["PORTHOLE_TOKEN","PLATO_TOKEN","PORTHOLE_PORT","PLATO_PORT","PORTHOLE_PROJECT_ROOT","PORTHOLE_SESSION","HOME","PATH"]';
export function mcpArgs(agent, session) {
    const m = MCP_FOR[session]; if (!m) return '';
    // Long tools (a transcript, waiting on the user) may run for minutes: 15 minutes before the agent gives up on one.
    const args = JSON.stringify(m.args || []);
    if (agent === 'codex') return `-c 'mcp_servers.${m.name}.command="${m.command}"' -c 'mcp_servers.${m.name}.args=${args}' -c 'mcp_servers.${m.name}.env_vars=${PASS_ENV}' -c 'mcp_servers.${m.name}.tool_timeout_sec=900'`;
    if (agent === 'claude') return `--mcp-config '{"mcpServers":{"${m.name}":{"command":"${m.command}","args":${args}}}}' --allowedTools ${m.tools.map(t => `mcp__${m.name}__${t}`).join(',')}`;
    return '';
}
export const sleuthMcpArgs = agent => mcpArgs(agent, 'case');
export function modelArgs(agent, model) {
    const m = String(model || '').trim(); if (!m) return [];
    if (!MODEL_OK.test(m)) throw httpError(400, 'Model: a plain model name (letters, numbers, dots, dashes).');
    if (agent === 'cline') return ['-m', m];
    const oss = ossModel(agent, m); if (oss) return ['--oss', '--local-provider', 'ollama', '-c', 'model_provider=ollama', '-m', oss];   // Codex on your Ollama server (CODEX_OSS_BASE_URL is set by the shell)
    return ['claude', 'codex', 'antigravity'].includes(agent) ? ['--model', m] : [];
}
export function command({ agent = 'claude', yolo = false, resume = false, profile = 'default', login = false, model = '' }) {
    const a = catalog[agent];
    if (!a) throw httpError(400, 'Unknown agent.');
    const args = [];
    if (!login) args.push(...modelArgs(agent, model));
    if (login && a.loginArgs.length) args.push(...a.loginArgs);
    else {
        args.unshift(...(a.baseArgs || []));
        if (resume) args.push(...a.resumeArgs);
        if (yolo && a.yoloFlag) args.push(a.yoloFlag);
        if (!yolo && a.safeArgs) args.push(...a.safeArgs);
    }
    const env = {};
    if (yolo) Object.assign(env, a.yoloEnv);
    if (a.key === 'claude' && profile && profile !== 'default') env.CLAUDE_CONFIG_DIR = profileDir(profile);
    // Shell-safe: every token is a fixed string or a validated profile path.
    const cmd = [a.bin, ...args].join(' ');
    return { cmd, env, label: a.title };
}
