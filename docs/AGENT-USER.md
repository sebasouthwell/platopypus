# Agents without root — migration plan

Today every shell, agent and PlatOpypus itself run as root. The goal: AI agents run as an unprivileged `agent` user,
ask for root per command through the phone, and can only reach the Vault, cloud credentials and PlatOpypus's API
through narrow, audited doors. PlatOpypus itself keeps running as root (it manages nginx, Docker, tmux, certificates).

The change touches files agents depend on (their logins and configs, project folder ownership), so it is rolled out
in three stages. Each stage is safe to update into and to roll back from.

## Stage 1 — additive (1.9.0): the agent user exists, nothing moves

- `install.sh` creates the `agent` user (home `/home/agent`, no sudo, no password) and the `porthole-dev` group
  (root + agent), installs Claude Code and Antigravity for that user, and writes the agent instructions into its
  `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` and `~/.gemini/GEMINI.md`. Codex is already global.
- New shells get **Run as: agent user / root**. Root stays the default; every existing shell, profile and login is
  untouched.
- An agent-user shell may only start in a project under `/Projects`, a scratch folder or `/home/agent`. PlatOpypus makes
  that folder group-writable for `porthole-dev` (group ownership + setgid on folders) the first time; files stay owned
  by whoever made them, and root shells keep full access, so mixing both kinds in one project works.
- Each agent-user shell gets its own **shell token** (in its environment as `PLATO_TOKEN`). The box CLIs (`vault`,
  `credshare`, `svc`, `tunnel`, `live`, `project`, `elevate`) sign in with it and get a **restricted session**: only
  the routes those CLIs need. Files, shells, Docker, the Vault editor, security settings, updates and the terminal
  WebSocket are refused. The box token and `vault.key` are unreadable to the agent user.
- **`vault get`** from an agent-user shell goes through the API: PlatOpypus checks the calling process belongs to that
  shell, runs as the agent user, and that its real working directory (read from `/proc`, not claimed) is the
  project's main folder, then returns general or that project's values only.
- **`elevate -- <command>`** asks for root for one command. The phone shows a banner; the request names the shell,
  folder and command. **Allow once**, **Allow this shell for 30 minutes** (pure elevation, no further prompts), or
  **Deny**. Approved commands run as root in that folder with a 10-minute limit; output and exit code go back to the
  agent and into the PlatOpypus log.
- Servers started with `svc run` from an agent-user shell run as the agent user; it can stop only servers it owns.
  Live services are started from the phone only (an agent can still `live check` and `live status`).

Rollback: none needed; root shells work exactly as before.

## Stage 2 — move logins and folders, one tap each (1.12.0: logins done)

- **AI agents → Move logins to the agent user** copies `/root/.claude`, `/root/.claude.json`, `/root/.agent-profiles`,
  `/root/.codex`, `/root/.gemini` / `/root/.antigravity` and the gh config into `/home/agent`, fixes ownership and
  rewrites profile paths. The root copies stay in place, renamed `*.porthole-moved-<date>`, until the user confirms.
- **Files → folder → Make agent-ready** for projects created before stage 1 (the same group change, for the whole tree).
- New agent shells default to the agent user once logins are moved. Root stays one tap away.
- Backups of what is moved go to `~/.platopypus/migrate/stage2-<date>.tar.gz`.

Rollback: AI agents → Undo move restores the renamed root copies; the agent-user copies are left for inspection.

## Stage 2b — services off root (1.14.0, done)

- Live services and their actions run as one account per project (`ps-<project>`, ACL on that project only, no
  porthole-dev, firewall: no metadata service, no PlatOpypus API, Vault limited to `needs:`); `run_as: root` needs a
  phone approval pinned to the commands and the project's code (1.15.0). PlatOpypus stays the root controller.
- **Files → Make agent-ready** for projects created before stage 1.

## Stage 3 — root by grant only (2.0.0, MAJOR)

- Agent shells always run as the agent user; running an agent as root needs the explicit **Run as root** grant,
  shown in red on the shell.
- `server/lib/migrate.js` with `~/.platopypus/schema.json` (per UPDATE.md): confirms stage 2 ran, removes the renamed
  root copies after a final backup, and refuses to start on a failed step with the rollback written to the log.

## Compatibility notes

- `shells.json` gains `runAs` (missing = root) and `tokenHash`; old entries keep working.
- Box CLIs are unchanged for root shells: they still read `~/.platopypus/token`. The only new behaviour is when
  `PLATO_TOKEN` holds a shell token.
- Agent instructions explain `elevate` and are installed for both users.
