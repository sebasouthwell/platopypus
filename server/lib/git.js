// Git and GitHub for project folders. Uses the git and gh CLIs via execFile (no shell). A GH_TOKEN in the
// vault (general scope) is passed to gh/git so pushes, clones and repo creation work without any interactive
// login; otherwise `gh auth login --web` from a Porthole shell stores credentials in ~/.config/gh.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { resolveInRoot, relative, safeName } from './files.js';
import { envForSync as envFor } from './vault.js';
import { log } from './log.js';

const run = promisify(execFile);

function httpError(status, message) {
    const e = new Error(message);
    e.status = status;
    return e;
}

function env() {
    const e = { ...process.env, ...envFor(config.home), GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
    if (e.GITHUB_TOKEN && !e.GH_TOKEN) e.GH_TOKEN = e.GITHUB_TOKEN;
    return e;
}

async function git(cwd, args, timeout = 60_000) {
    try {
        const { stdout } = await run('git', args, { cwd, env: env(), timeout, maxBuffer: 8 * 1024 * 1024 });
        return stdout;
    } catch (err) {
        const msg = (err.stderr || err.message || '').trim();
        if (/not a git repository/i.test(msg)) throw httpError(400, 'Not a git repository.');
        if (/could not read Username|Authentication failed|Permission denied|403/i.test(msg)) throw httpError(401, 'GitHub refused the push. Add a GH_TOKEN to the vault or sign in from a shell with gh auth login.');
        throw httpError(500, msg.split('\n').slice(-3).join(' ').slice(0, 400) || 'git failed');
    }
}

async function gh(args, timeout = 60_000) {
    try {
        const { stdout } = await run('gh', args, { cwd: config.home, env: env(), timeout, maxBuffer: 8 * 1024 * 1024 });
        return stdout;
    } catch (err) {
        const msg = (err.stderr || err.message || '').trim();
        if (/ENOENT/.test(msg)) throw httpError(503, 'GitHub CLI (gh) is not installed on the box.');
        if (/not logged|authentication|auth login|GH_TOKEN/i.test(msg)) throw httpError(401, 'Not connected to GitHub yet.');
        throw httpError(500, msg.split('\n').slice(-3).join(' ').slice(0, 400) || 'gh failed');
    }
}

const NAME_RE = /^[a-zA-Z0-9._-]{1,100}$/;

export async function isRepo(dir) {
    try { await run('git', ['-C', dir, 'rev-parse', '--git-dir'], { env: env(), timeout: 5000 }); return true; } catch { return false; }
}

export async function status(rel) {
    const dir = resolveInRoot(rel || '.');
    if (!(await isRepo(dir))) return { repo: false, path: relative(dir) };
    const [branch, porcelain, remote, lastLog] = await Promise.all([
        git(dir, ['symbolic-ref', '--short', 'HEAD']).catch(() => git(dir, ['rev-parse', '--short', 'HEAD']).then(h => `detached @ ${h.trim()}`).catch(() => 'main')),
        git(dir, ['status', '--porcelain=v1']),
        git(dir, ['remote', 'get-url', 'origin']).catch(() => ''),
        git(dir, ['log', '-1', '--format=%h%x09%ar%x09%s']).catch(() => ''),
    ]);
    let ahead = 0, behind = 0, upstream = null;
    try {
        const ab = await git(dir, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
        [behind, ahead] = ab.trim().split(/\s+/).map(Number);
        upstream = (await git(dir, ['rev-parse', '--abbrev-ref', '@{upstream}'])).trim();
    } catch { /* no upstream */ }
    const lines = porcelain.split('\n').filter(Boolean);
    const [hash, when, subject] = lastLog.trim().split('\t');
    return {
        repo: true, path: relative(dir), branch: branch.trim(), remote: remote.trim() || null, upstream, ahead, behind,
        changed: lines.length, files: lines.slice(0, 50).map(l => ({ state: l.slice(0, 2).trim() || '??', file: l.slice(3) })),
        last: hash ? { hash, when, subject } : null,
        github: parseGithub(remote.trim()),
    };
}

function parseGithub(url) {
    const m = String(url || '').match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
    return m ? { owner: m[1], repo: m[2], url: `https://github.com/${m[1]}/${m[2]}` } : null;
}

// Global git defaults, applied lazily so they survive a home folder that was created after install.
let configured = false;
async function ensureGitConfig() {
    if (configured) return;
    const want = { 'init.defaultBranch': 'main', 'pull.ff': 'only', 'credential.helper': '!gh auth git-credential' };
    for (const [k, v] of Object.entries(want)) {
        const cur = (await run('git', ['config', '--global', '--get', k], { env: env() }).then(r => r.stdout.trim()).catch(() => ''));
        if (!cur) await run('git', ['config', '--global', k, v], { env: env() }).catch(() => {});
    }
    await run('git', ['config', '--global', '--add', 'safe.directory', '*'], { env: env() }).catch(() => {});
    configured = true;
}

async function ensureIdentity(dir) {
    await ensureGitConfig();
    const name = (await git(dir, ['config', 'user.name']).catch(() => '')).trim();
    const email = (await git(dir, ['config', 'user.email']).catch(() => '')).trim();
    if (name && email) return;
    let login = 'porthole', mail = 'porthole@localhost';
    try {
        const me = JSON.parse(await gh(['api', 'user']));
        login = me.name || me.login || login;
        mail = me.email || `${me.id}+${me.login}@users.noreply.github.com`;
    } catch { /* not connected: fall back */ }
    if (!name) await git(dir, ['config', '--global', 'user.name', login]);
    if (!email) await git(dir, ['config', '--global', 'user.email', mail]);
}

export async function init(rel) {
    const dir = resolveInRoot(rel || '.');
    await ensureGitConfig();
    if (await isRepo(dir)) throw httpError(409, 'Already a git repository.');
    await git(dir, ['init', '-b', 'main']);
    if (!fs.existsSync(path.join(dir, '.gitignore'))) await fsp.writeFile(path.join(dir, '.gitignore'), 'node_modules/\n.env\n__pycache__/\n.venv/\n*.log\n.DS_Store\n');
    log('git', `init ${relative(dir)}`);
    return status(rel);
}

export async function commit(rel, message) {
    const dir = resolveInRoot(rel || '.');
    const msg = String(message || '').trim().slice(0, 500);
    if (!msg) throw httpError(400, 'Write a commit message.');
    await ensureIdentity(dir);
    await git(dir, ['add', '-A']);
    const staged = (await git(dir, ['diff', '--cached', '--name-only'])).trim();
    if (!staged) throw httpError(409, 'Nothing to commit.');
    await git(dir, ['commit', '-m', msg]);
    log('git', `commit in ${relative(dir)}: ${msg.split('\n')[0]}`);
    return status(rel);
}

export async function push(rel) {
    const dir = resolveInRoot(rel || '.');
    await ensureGitConfig();
    const st = await status(rel);
    if (!st.repo) throw httpError(400, 'Not a git repository.');
    if (!st.remote) throw httpError(400, 'No remote yet. Publish to GitHub first.');
    const args = st.upstream ? ['push'] : ['push', '-u', 'origin', st.branch];
    await git(dir, args, 180_000);
    log('git', `push ${relative(dir)} (${st.branch})`);
    return status(rel);
}

export async function pull(rel) {
    const dir = resolveInRoot(rel || '.');
    await ensureGitConfig();
    await git(dir, ['pull', '--ff-only'], 180_000);
    log('git', `pull ${relative(dir)}`);
    return status(rel);
}

// Create a GitHub repo for the folder and push it. Default private.
export async function publish(rel, { name, isPrivate = true, description = '' } = {}) {
    const dir = resolveInRoot(rel || '.');
    if (!(await isRepo(dir))) await init(rel);
    const st = await status(rel);
    if (st.remote) throw httpError(409, 'This folder already has a remote.');
    const repoName = String(name || path.basename(dir)).trim();
    if (!NAME_RE.test(repoName)) throw httpError(400, 'Repository name: letters, numbers, dots, dashes, underscores.');
    await ensureIdentity(dir);
    const hasCommit = await git(dir, ['rev-parse', 'HEAD']).then(() => true).catch(() => false);
    if (!hasCommit) {
        await git(dir, ['add', '-A']);
        await git(dir, ['commit', '--allow-empty', '-m', 'Initial commit from Porthole']);
    }
    const args = ['repo', 'create', repoName, isPrivate ? '--private' : '--public', '--source', dir, '--remote', 'origin', '--push'];
    if (description) args.push('--description', String(description).slice(0, 200));
    await gh(args, 300_000);
    log('git', `published ${relative(dir)} as ${repoName} (${isPrivate ? 'private' : 'public'})`);
    return status(rel);
}

export async function clone(repo, destRel) {
    const spec = String(repo || '').trim();
    await ensureGitConfig();
    if (!/^(https:\/\/github\.com\/[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*(\.git)?|git@github\.com:[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*(\.git)?|[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*)$/.test(spec)) throw httpError(400, 'Repository: owner/name or a GitHub URL.');
    const parent = resolveInRoot(destRel || path.relative(config.root, path.join(config.home, 'Projects')));
    await fsp.mkdir(parent, { recursive: true });
    const folder = safeName(spec.replace(/\.git$/, '').split(/[/:]/).pop());
    const target = path.join(parent, folder);
    if (fs.existsSync(target)) throw httpError(409, `"${folder}" already exists in that folder.`);
    await gh(['repo', 'clone', spec, target], 600_000);
    log('git', `cloned ${spec} -> ${relative(target)}`);
    return { path: relative(target), name: folder };
}

export async function account() {
    try {
        const me = JSON.parse(await gh(['api', 'user']));
        return { connected: true, login: me.login, name: me.name, avatar: me.avatar_url, via: env().GH_TOKEN ? 'vault token' : 'gh auth login' };
    } catch (e) {
        const installed = await run('gh', ['--version'], { timeout: 5000 }).then(() => true).catch(() => false);
        return { connected: false, installed, error: e.status === 401 ? null : e.message };
    }
}

export async function repos(limit = 60) {
    const out = await gh(['repo', 'list', '--limit', String(Math.min(200, limit)), '--json', 'name,nameWithOwner,isPrivate,updatedAt,description,url,isFork']);
    return JSON.parse(out).map(r => ({ name: r.name, full: r.nameWithOwner, private: r.isPrivate, updated: r.updatedAt, description: r.description || '', url: r.url, fork: r.isFork }));
}

// SSH key for the box (alternative to tokens). Generated on first request.
export async function sshKey() {
    const dir = path.join(config.home, '.ssh');
    const key = path.join(dir, 'id_ed25519');
    if (!fs.existsSync(key + '.pub')) {
        await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
        await run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'porthole-box', '-f', key], { timeout: 20_000 });
        log('git', 'generated ssh key for the box');
    }
    return { publicKey: (await fsp.readFile(key + '.pub', 'utf8')).trim() };
}
