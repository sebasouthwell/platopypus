# Updating PlatOpypus

This file is the contract between a running box and a newer version of this repo. Read it before changing
anything under `server/lib` that reads or writes state, and before changing `install.sh`.

## How an update runs

1. The box checks `https://raw.githubusercontent.com/<repo>/master/server/package.json` and the commit list once
   a day (and on demand). A higher `version`, or a different commit when the install was made from git, shows
   **Update available** under More.
2. **Update** starts `bin/porthole-update` detached from the service (a transient systemd unit, or `setsid`):
   - fetch the repo into `$PORTHOLE_SRC` (default `/opt/porthole-src`; a bundle install is converted to a clone)
   - snapshot `/opt/porthole` â†’ `/opt/porthole.prev`
   - run `install.sh` from the new source (idempotent: rsync the app, `npm install --omit=dev`, write `VERSION`,
     restart the `porthole` systemd service)
   - health check for up to 45 s: the API answers, the home page is served with version-stamped assets, `app.js` and
     `styles.css` come back with a plausible size and `app.js` parses (`node --check`); otherwise restore the snapshot
     and restart (the reason is written to `update.log`)
   - write `~/.porthole/update-result.json` and append to `~/.porthole/update.log`
3. The web app shows a full-screen "shutting down for approximately 5 minutes" notice, polls until the API
   answers, and reloads.

**An update must never touch:** `~/.porthole` (except by the running server's own normal reads/writes), user
files, tmux sessions (shells, tunnels, code-server), Docker containers/volumes, nginx config and certificates,
`/etc/porthole.env`. If a change needs any of those to move, it is a *migration* and follows the rules below.

## Channels

Boxes follow the **`stable`** branch by default (`PORTHOLE_UPDATE_BRANCH`, set in `/etc/porthole.env`). Every release
lands on `master`; `stable` is moved to it with `scripts/release.ps1 -Promote` only after the release has run on a
real box for a while without surprises. Tapping Update therefore never installs something newer than the last
promoted version. Set `PORTHOLE_UPDATE_BRANCH=master` to follow every release immediately.

## Versioning

- `server/package.json` â†’ `version` is the product version (`MAJOR.MINOR.PATCH`). Bump it in every release.
  *PATCH* = no state format change. *MINOR* = additive state change (new fields/files, old ones still read).
  *MAJOR* = a migration is required (see below).
- `/opt/porthole/VERSION` holds `<short-sha> <unix-time>` of the installed source (`bundle` if installed from
  the deploy bundle rather than git).

## 2.0: the rename on disk

2.0.0 renames what 1.x called `porthole` on the box, keeping every old name usable (the table in
`docs/MIGRATION-2.0.md` is the full list). The rules that make an update to 2.0 safe and a rollback possible:

- **Old paths stay valid.** `~/.porthole` → `~/.platopypus` and `/opt/porthole` → `/opt/platopypus` are renames with a
  symlink left at the old path, done before anything reads them (`config.js` for the state folder at server start,
  `install.sh` for the app folder). Running processes keep their open files; a rolled-back 1.x release finds its
  state and code through the links.
- **Old names are read.** `PORTHOLE_*` settings are mirrored to `PLATO_*` (and back) at startup; every shell and
  service gets both spellings for all of 2.x. `X-Porthole` and the `porthole_session` cookie are accepted until 3.0;
  responses carry both version headers. `.portholerun` and `PORTHOLE.md` are read for good.
- **The 1.x unit file is left in place (disabled).** `platopypus.service` is the unit; a rollback to 1.x re-enables
  `porthole.service` (the updater checks the major version of the code it is putting back).
- **The tmux socket moves only by hand.** New code keeps talking to the `porthole` socket while it has sessions; the
  "Finish the rename" step on More stops live services, ends the old server, switches to `plato` and starts them again.
- **Accounts and groups are not renamed in 2.0** (`porthole-dev`, `porthole-svcs`, `porthole-svc`, `ps-<project>`):
  that is 2.1, with a reverse step for rollback.

## State on disk (owned by the server)

2.0: the folder is `~/.platopypus` (`~/.porthole` is a link to it).

All under `PORTHOLE_STATE` (default `~/.porthole`, mode 0700). Every file is written atomically (tmp + rename)
with mode 0600. Formats as of version 1.0:

| File | Writer | Shape |
|---|---|---|
| `token` | config.js | one line: 32-char base64url setup/CLI token |
| `tmux.conf` | config.js | regenerated at every start; not user-editable |
| `auth-sessions.json` | auth.js | `{ "<sid>": { created, lastSeen, ua, how } }` |
| `security.json` | credentials.js, totp.js | `{ passkeys: [{ id, publicKey(base64url), counter, transports, deviceType, backedUp, name, created, lastUsed }], password: { salt, hash, set }, totp: { enabled, secret(base32), enabledAt, lastCounter }, pending: {...} }` â€” any key may be absent |
| `shells.json` | shells.js | `{ "<name>": { kind: shell\|agent\|remote-control, cwd, created, agent?, yolo?, resume?, profile?, scratch? } }` â€” legacy `kind: "claude"` is read as `agent` + `agent: "claude"`; `scratch: true` (1.1.0) marks a shell whose `cwd` under `~/scratch/` is deleted when the shell is ended |
| `shared-creds.json` | sharedcreds.js | `{ items: [ { id, title, fields: [{ label, value(enc), secret }], url, note, shell, project?, port, at } ] }` â€” credentials handed over by `credshare`; values encrypted with `vault.key`; dropped after 7 days (1.0.4, documented 1.1.0) |
| `tunnels/tunnels.json`, `tunnels/<port>.log` | tunnels.js | `{ "<port>": { name, created, expires, origin, owner, misses, publicUrl? } }`; logs are cloudflared output; `publicUrl` (1.3.0) overrides the trycloudflare address for tunnels on the user's own domain |
| `vault.key` | vault.js | 32-byte key, base64 |
| `vault.json` | vault.js | `{ items: [ v2 ] }` where v2 = `{ id, provider, title, style, name, prefix, scope, notes, fields: { <field>: <enc> }, secretFields: [..], labels: {..}, envMap: {..}, oauth: { authUrl, tokenUrl, scopes, clientAuth, pkce, authParams, scopeSeparator, expiresAt, tokenType, obtainedAt, grantedScopes }\|null, created, updated, lastUsed }`. **v1 items** (`{ envName, value, kind }`) are still read via `normalise()` and must keep working. `<enc>` = `iv.tag.ciphertext` base64, AES-256-GCM. |
| `zoned.json`, `zoned/<slug>.log` | zoned.js | `{ items: { "<slug>": { slug, hostname, port, name, mode: direct\|tunnel, zoneId, zoneName, accountId, tunnelId, dnsRecordId, via, origin, created, token(enc) } } }` â€” hostnames on the user's domain (1.5.0); `token` is the cloudflared run token encrypted with `vault.key` |
| `projects.json` | projects.js | `{ repos: { "<abs folder>": { flag: private\|public, set } } }` â€” publishing flags (1.4.0); a folder absent from the map is local only |
| `services.json` | services.js | `{ items: { "<slug>": { slug, name, port, cwd, cmd[]\|null, pid, session\|null, project, created, stoppedAt, log, external, cmdline?, owner?, live?: { project, key, title }, runAs?: agent\|service\|root } } }` â€” registered servers (1.3.0); logs in `services/<slug>.log`, or `/home/agent/.porthole/services/<slug>.log` for agent-started servers (1.14.0); missing `runAs` = root |
| `live-approvals.json` | live.js | `{ "<live slug>": "<sha256 of start, cwd, patch and action commands>" }` â€” services allowed to run as root (1.14.0); a changed manifest no longer matches, so it asks again |
| `schema.json` | migrate.js | `{ version, applied: [{ id, version, at, ms, result? }], updatedAt, lastBackup, lastRun: { from, to, at, ids } }` â€” upgrade migrations (1.15.0); absent = none applied yet |
| `migrate/pre-<version>-<stamp>.tar.gz` | migrate.js | state archive taken before migrations (5 kept); also login-move backups (1.12.0) |
| `project-links.json` | upgrade.js | `{ links: [{ from, to, at, level, commit }] }` â€” "Upgrade repo" relationships between project folders (1.16.0) |
| `portholerun.json` | portholerun.js | `{ "<run-slug>": { file, hash, at } }` â€” what each .portholerun server was started from, for restarts (1.18.4) |
| `quick.json` | quick.js | `{ pins: [{ id, kind, project, key, action, group, item, itemLabel, at }], recents: [â€¦ , code] }` â€” Home shortcuts to live-service commands; matched by label (1.19.0) |
| `audit/YYYY-MM-DD.jsonl` | audit.js | one JSON line per escalation, credential use or activity (names and commands, never values or output); one file per UTC day, kept 90 days, 200 MB cap; `count`/`lastAt` on merged repeats (1.21.0; `audit.jsonl`/`audit.1.jsonl` from 1.20.0 read until they age out) |
| `alerts.json` | alerts.js | `{ itemId, chatId, on: { root, signin, link, crash, egress, credential, commit }, pausedUntil, origin, lastSent, lastError }` â€” Telegram alerts; the bot is a general Vault entry referenced by id, its token is never copied here (1.22.0) |
| `limit.json` | limit.js | `{ on, load, last: { at, reason, load, stopped, links } }` — the overload guard (1.25.0) |
| `backups.json`, `backup-tmp/` | backup.js | backup settings and per-project last run; archives in flight (1.26.0) |
| `egress/YYYY-MM-DD.json`, `egress/seen.json` | egress.js | new outbound connections by the agent user and service accounts, one row per (who, project, host, port) with count/first/last/procs, kept 90 days; `seen.json` = first time each project reached each host:port (1.22.0) |
| `logos/` | logos.js | cached Docker Hub image logos (`<hash>.png`, `<hash>.none` = none, retried after a week) (1.16.0) |
| `update-plan.json` | bin/porthole-update | `{ from, to, pending: [manifest entries] }` written before each install (1.15.0) |
| `code-server.json` | codeserver.js | `{ password, folder, startedAt, projects: { "code-<slug>": { password, folder } } }` |
| `update.json`, `update-result.json`, `update.log`, `update.lock` | update.js, bin/porthole-update | check status, last result, log, lock (pid) |
| `trash/` | files.js | deleted files/folders, `<ISO-stamp>__<name>` |

nginx: zoned shares add `/etc/nginx/sites-{available,enabled}/porthole-zoned-<slug>` (owned and removed by PlatOpypus);
`install.sh` renders `/etc/nginx/sites-available/porthole` from `deploy/nginx-platopypus.conf` (no certificate yet)
or `deploy/nginx-platopypus-ssl.conf` (certificate present) on **every** run; certbot runs in `certonly` mode and
never edits nginx config. Do not hand-edit the site file on a box; change the template and release.

Other locations the app relies on but does not own: `~/.claude`, `~/.agent-profiles/claude/<name>` (Claude
profiles = `CLAUDE_CONFIG_DIR`), `~/.codex`, `~/.antigravity`/`~/.gemini`, the agent instruction files
`~/.porthole/githooks/pre-push` and `~/.porthole/gitignore_global` (installed by `install.sh`, referenced from the service
user's global git config), `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md` and each profile's `CLAUDE.md` (only the block
between `<!-- porthole:begin -->` and `<!-- porthole:end -->` is PlatOpypus's; it is rewritten by `install.sh` on every update), `~/.config/gh`, `~/.ssh/id_ed25519`,
`~/apps/<app>/` (volumes for catalogue apps), `~/scratch/<date>-<shell>/` (scratch shells; deleted by the server when
that shell is ended, never by an update), `<project>/.pasted/` (attachments), `/etc/porthole.env`.

### Session rules (1.1.0)

Sessions expire after 7 idle days (`PORTHOLE_SESSION_DAYS`) **and** 30 days after sign-in regardless of use
(`PORTHOLE_SESSION_ABSOLUTE_DAYS`). Every credential change (password set/cleared, passkey added/removed, two-step
enabled/disabled) revokes all other sessions. `X-Real-IP` is honoured only when the TCP peer is loopback (nginx).
Older `auth-sessions.json` records already carry `created`, so no migration.

## Rules for compatible changes

0. **An update never ends a session.** Shells, servers, live services and tunnels are tmux sessions that must survive
   `systemctl restart platopypus` (`KillMode=process`); check it on the box: `tmux -L plato ls` (or `-L porthole` before the rename is finished) before and after.
1. **Additive by default.** New fields get defaults when read; missing files mean "first run" for that feature.
   Never require a field that older versions did not write.
2. **Read old, write new.** When a shape changes, keep a `normalise()` step that upgrades records on read (see
   `vault.js`), and write the new shape only when the record is next saved. Do not rewrite whole files at
   startup just to migrate; a crash mid-way must leave the old file readable.
3. **Never rename an environment variable** that the vault already exports (`<PREFIX>_<FIELD>`), nor a
   catalogue `env` prefix or auth-style field `env` suffix â€” projects on the box depend on them. Add a new
   field instead; mark the old one deprecated in `catalog.js` comments.
4. **tmux is the source of truth for shells and tunnels.** Metadata files may lag; code must tolerate a session
   that exists without metadata and vice versa (as `shells.list()` and `tunnels.list()` do today).
5. **Crypto parameters are frozen per record.** `vault.key` length, AES-GCM layout, scrypt parameters for the
   password, and passkey storage must keep decrypting/verifying old records. To change them, add a version
   marker to new records and keep the old path for old ones.
6. **install.sh must stay idempotent and offline-tolerant.** It is re-run on every update; each step checks
   before it acts; network installers are wrapped so a failure logs and continues.
7. **API routes are append-only within a MAJOR.** Clients may be a cached older `app.js` for a few seconds
   after an update; do not change the meaning of an existing route/response field, add new ones.
8. **Docker and code-server containers are user data.** Never remove or recreate them in an update; name
   schemes (`app-<key>`, `code-<slug>`) are stable.

## Upgrade plan: migrations (every release, 1.15.0+)

Every release must upgrade any box on the previous stable release with its data intact, by itself, from the
phone's Update button. Mechanism:

- **Migrations** live in `server/migrations/`: one entry per step in `manifest.json` (`id` = `<version>-<what>`,
  `version`, `title`, `detail` shown on the phone, `touches`) and `<id>.js` exporting `async up({ state, from, to, log })`.
  Write one whenever a release changes anything on disk outside the app folder: a state file's shape, accounts,
  permissions, system config, project folders. Purely additive changes (new optional fields, new files) need none.
- **Rules for a step:** idempotent (it may run on any older box, including one that never recorded a schema); keeps
  the user's data (transform, never drop; if something must go, move it under `~/.porthole/migrate/`); never needs
  the network; fast (seconds), or it is not a migration but a job.
- **Running:** `server/lib/migrate.js` runs every pending step at server start, before any route. It archives the
  whole state folder to `~/.porthole/migrate/pre-<version>-<stamp>.tar.gz` first (5 kept), records applied steps in
  `~/.porthole/schema.json`, and on any failure restores the archive and exits, so the old code comes back on the old
  data. `node server/lib/migrate.js plan|apply|status|restore` does the same by hand.
- **Updater:** after fetching, the installed updater hands over to the new release's `bin/porthole-update` (once),
  which writes the plan to `~/.porthole/update-plan.json` and the log, installs, and health-checks (including that the
  migrations were recorded). On failure it restores the state archive from this update along with the previous code.
  The phone's update check reads the new release's `manifest.json` and lists the steps before you confirm.
- **Proof:** CI's `upgrade` job installs the current `stable`, fills it with data (password, Vault entries, project
  files, a shell with scrollback, a running server), updates it to the candidate with that box's own updater, checks
  every item survived and every migration ran, then runs the full smoke suite on the upgraded box. Promotion to
  stable requires it.
- **MAJOR** releases are the ones where old code cannot read the migrated state; CI refuses a `x.0.0` without a
  migration for `x`. Their rollback is the state archive.

## Change log of state and API additions

- **1.1.0** â€” `shells.json` gains optional `scratch`; `shared-creds.json` documented; new routes `POST /api/creds/share`
  (box CLIs register a credential), `DELETE /api/shells/<name>?keep=1` (end a scratch shell but keep its folder);
  `POST /api/docker/inspect` adds `existing`, `POST /api/docker/run` may answer **409** when a container from the same
  image is already running (one quick-run container per image) or `{ reused: true }` when it restarted a stopped one;
  shell WebSocket gains text frame `{ type: "cred", id, title, port }`; tmux option `allow-passthrough on` is in
  the generated `tmux.conf` and also set live on the running tmux server (existing sessions are untouched).

- **1.1.1** â€” every API response carries `X-Porthole-Version` and `/api/me` returns `version` (client offers a reload
  when the page predates the running server); updater step lines are appended to `update.log` with the token masked;
  tmux mouse option targets fixed (`name:` instead of `=name`). No state changes.

- **1.2.0** â€” **fixes a blank page in 1.1.0/1.1.1** (`app.js` referenced the composer before it was declared, so the
  module failed to load; boxes on those versions show nothing until updated). `shared-creds.json` items gain optional `project` (cwd of the sharing process); `GET /api/creds` and
  `/api/creds/:id/values` add `project`, `openUrl` (tunnel URL, with the path of a local URL, or the explicit public URL)
  and `localOnly`; `service.local` added. credshare accepts `--for` (alias of `--note`) and sends `cwd`.

- **1.2.1** â€” shared credentials move out of the Vault page into their own More â†’ Shared credentials page (grouped by
  project). No API or state change.

- **1.2.2** â€” index.html is served with version-stamped asset URLs (`/app.js?v=â€¦`, `/styles.css?v=â€¦`, `/sprite.svg?v=â€¦#`)
  and a `porthole-version` meta tag. Reason: Cloudflare (and most proxies) cache `.js`/`.css` for hours regardless of the
  origin's `Cache-Control`, so after an update phones were getting a new page with the previous script. No state change.

- **1.2.3** â€” the agent instructions (`deploy/AGENT.global.md`, formerly `CLAUDE.global.md`) are installed for all three
  agents: `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, plus every Claude profile. The block is
  wrapped in `porthole:begin/end` markers and refreshed on each update (a legacy unmarked block is replaced from its
  heading to the end of the file). No state change.

- **1.3.0** â€” update channel defaults to `stable` (promote with `release.ps1 -Promote`); post-update health check also
  verifies the page, the stamped assets and that `app.js` parses, rolling back otherwise. Registered servers: `services.json` (new), routes `GET/POST /api/servers`, `POST /api/servers/run`,
  `POST /api/servers/<slug>/stop|start`, `GET /api/servers/<slug>/logs`, `DELETE /api/servers/<slug>`; `svc` CLI; tmux
  session prefixes `svc-` and `zoned-` are reserved like `tunnel-`. `/api/services` adds `servers` and `system` (ports
  owned by PlatOpypus, agents and box daemons, never shareable) and excludes both from `devservers`; links carry
  `kind: quick|zoned`. No migration.

- **1.4.0** â€” publishing flag per project: `projects.json` (new), routes `GET/PUT /api/projects/repo`, `GET /api/projects/repo/all`;
  `git/status` adds `publish`; `git/publish` ignores the request's `private` and uses the flag (409 when local only);
  `git/push` is gated the same way. install.sh sets the service user's `core.hooksPath` to `~/.porthole/githooks`
  (pre-push asks `project allow-push`) and `core.excludesFile` to `~/.porthole/gitignore_global` (`.pasted/`). New CLI
  `project`. No migration; existing folders become local only until flagged.

- **1.5.0** â€” share on your own domain: `zoned.json` (new), routes `GET /api/zoned`, `GET /api/zoned/prereq`, `POST /api/zoned`,
  `DELETE /api/zoned/<slug>`; `tunnels.list()` (and therefore `/api/tunnels`, `/api/services.links`, shared-credential
  `openUrl`) includes zoned entries with `kind: zoned`, `hostname`, `slug`, `connected`; `DELETE /api/tunnels/<port>` on a
  zoned port removes the hostname. PlatOpypus writes `/etc/nginx/sites-{available,enabled}/porthole-zoned-<slug>` on boxes
  with nginx and removes them again; nothing else under /etc/nginx is touched. tmux prefix `zoned-`. No migration.

- **1.6.0** â€” Vault: required fields may be left empty on save (item reported with `incomplete: [labels]`, and `fields[]`
  includes the missing definitions with `missing: true`); `POST /api/vault/derive` (Telegram getMe / chat lookup; values
  are used for the one call, never stored). No state change: an item simply lacks some `fields` keys.

- **1.7.0** â€” "Share on your domain" gains **direct** mode (default on a box with a public address, nginx and a Let's Encrypt
  certificate for the PlatOpypus hostname): A record â†’ box (proxied like the PlatOpypus record), nginx :80/:443 blocks,
  `certbot certonly --webroot` for the hostname (renewed by certbot's timer), no tunnel process. Items without `mode`
  (1.5.0) are treated as tunnel mode. `/api/zoned/prereq` adds `mode`; entries add `mode`. Remove deletes the
  certificate too (`certbot delete`). Only `/etc/nginx/sites-{available,enabled}/porthole-zoned-*` and
  `/etc/letsencrypt/live|archive|renewal/<hostname>` for shared hostnames are touched.

- **1.7.1** â€” install.sh waits up to 10 minutes for the dpkg lock (`-o DPkg::Lock::Timeout=600`) instead of failing when
  unattended-upgrades is running; an update on the box had rolled back for exactly that reason.

- **1.8.0** â€” live services from `PORTHOLE.md` (see docs/LIVE.md): routes `GET /api/live`, `GET /api/live/check`,
  `POST /api/live/<project>/<service>/start|stop|hostname`, `POST â€¦/actions/<n>`, `POST â€¦/credentials/<n>`, `GET â€¦/logs`;
  `/api/services` adds `live` and its `servers` no longer include `live-*` registrations. Live services run through the
  servers registry as `live-<project>-<key>`. Hostnames on your domain now show a coming-up page
  (`/var/www/porthole/coming-up.html`) when the service is not answering; stopping a server no longer removes a
  domain hostname. **Behaviour change:** project-scoped Vault entries are no longer exported into shells; `vault get`
  returns them only from the project's main folder (general entries are unchanged). New CLI `live`; dependency `yaml`.

- **1.9.0** â€” agents without root, stage 1 of docs/AGENT-USER.md (additive; root stays the default). install.sh creates
  the `agent` user and `porthole-dev` group and installs Claude Code / Antigravity and the agent instructions for it.
  `shells.json` entries gain `runAs` (missing = root) and `tokenHash`. `POST /api/shells` accepts `runAs: agent`. Shell
  tokens sign in through `/api/login/token` to a restricted session (AGENT_ROUTES in server.js; WebSocket refused).
  New: `POST /api/agent/vault`, `POST /api/agent/elevate`, `GET /api/agent/elevate/<id>`, `GET /api/elevate/pending`,
  `POST /api/elevate/<id>/allow|deny`, `POST /api/shells/<name>/elevation`, `GET /api/agent-user`; CLI `elevate`.
  `services.json` items may carry `owner` (agent-user shell). Agent-user folders get group `porthole-dev` + setgid.

- **1.9.1** â€” one projects folder: clone and New shell default to `<files root>/Projects` (was `~/Projects`, which on a
  root-at-/ box made a second folder); install.sh links `~/Projects` â†’ `/Projects` when it is missing or empty. Red Stop button beside Send in the terminal sends Ctrl+C; live service page shows the running dot in green. UI only.

- **1.10.0** â€” session type and security level for agent sessions. New per-project files `<project>/.porthole/project.json`
  (`{ level: throwaway|personal|professional, audience?, tier?, set, lastCveCheck? }`) and `.porthole/security.md` (copied from
  `deploy/security/<key>.md`); both travel with the repo. `POST /api/shells` accepts `session: control|project` (428 with
  `needProfile` when a project has no level yet); shells get `PORTHOLE_SESSION`, `PORTHOLE_SECURITY_LEVEL`,
  `PORTHOLE_SECURITY_FILE`; `shells.json` entries may carry `session` and `security`. Routes `GET/PUT /api/projects/profile`,
  `POST /api/projects/profile/cve-checked`. `project security`, `project cve-checked`. Shells created without `session` behave
  as before.

- **1.11.0** â€” agents start trusted in the folder picked in PlatOpypus (Claude `.claude.json` projects[dir].hasTrustDialogAccepted,
  Codex `config.toml` [projects."dir"] trust_level, Antigravity/Gemini `trustedFolders.json`), written for the user the agent
  runs as; `POST /api/shells` accepts `firstPrompt` (Claude/Codex as an argument via `PORTHOLE_FIRST_PROMPT`, Antigravity typed
  in). Home gains "I wish for:". No state change.

- **1.11.1** â€” New shell always defaults to Run as root (the agent-user choice is no longer remembered, it had switched
  Claude to an unsigned-in user); the dialog warns when the agent has no login for the agent user; agent-user scratch folders
  live in the agent's home; `GET /api/agent-user` adds `signedIn`.

- **1.12.0** â€” stage 2 of docs/AGENT-USER.md: AI agents â†’ Move logins moves (not copies) root's `.claude`, `.claude.json`,
  `.agent-profiles`, `.codex`, `.gemini`, `.antigravity` to the agent user after a tar backup in `~/.porthole/migrate/`; marker
  `~/.porthole/logins-moved.json`; Undo moves them back. Once moved, agent and Remote Control shells default to the agent user
  (plain shells stay root), profiles resolve under the agent's home, and `/api/agents` reports sign-in from there. New
  routes `POST /api/agent-user/move-logins|undo-move`; `/api/agent-user` adds `loginsMoved`, `rootLogins`. New shell defaults to
  the agent user for AI agents. Home "I wish for:" gains Temp (scratch folder, agent user, throwaway brief, first message, no
  questions).

- **1.13.0** â€” one-shot runs: `POST /api/shells` accepts `oneshot: true` (Claude `-p` / `codex exec`, auto-approved, scratch
  folder); when the session ends PlatOpypus stores `{ name, agent, prompt, started, finished, output }` in `~/.porthole/oneshot/<name>.json`
  (30 kept) and deletes the folder. `GET /api/oneshot`. Home Temp gains a â–¾ menu: Temp session / One-shot / results.

- **1.14.0** â€” live services run as **porthole-svc** (no shell, no logins, group porthole-dev; created by `install.sh` or on
  first use), and so do their actions; PlatOpypus keeps the log and the stop. `run_as: root` in PORTHOLE.md needs approval on
  the phone, pinned to a hash of the commands (`POST|DELETE /api/live/<p>/<k>/root`). Starting a live service takes over its
  port from a plain server in the same project folder and refuses other holders; servers that die straight after starting
  report their log. `svc restart` and `POST /api/servers/<slug>/restart` (live slugs restart through live.js; names resolve
  to live services by title or key). `POST /api/live/<p>/<k>/restart`. Actions gain `restart`, `stop_first` and typed
  `inputs` (string, integer, number, boolean, choice; min, max, pattern, default, required) delivered as `INPUT_<NAME>`
  environment variables, never pasted into the command; the action body is `{ inputs: {...} }` (absent = none). Files gains
  **Make agent-ready** (`GET|POST /api/agent-ready`). Agent-started servers log under the agent's home (they could not
  write to `/root/.porthole`).

- **1.14.1** â€” `porthole.service` gains `KillMode=process`: restarting PlatOpypus (every update) no longer ends the tmux
  server, so shells, servers, live services and tunnels survive updates as `tmux.js` always intended. Before this, each
  update ended every session on the box. No state change.

- **1.15.0** â€” live services run as one account **per project**, `ps-<project>` (primary group `porthole-svcs`,
  home `/var/lib/porthole-svc/<project>`), with a POSIX ACL on that project only (plus default ACLs, and `o::---`;
  marker `<project>/.porthole/acl.json`); top-level project folders lose all "other" permissions; agent shells use
  `umask 007`. The 1.14.0 shared `porthole-svc` account is removed from `porthole-dev`. iptables/ip6tables `OUTPUT`
  rules (re-applied at every start) reject `porthole-svcs` traffic to the EC2 metadata service and PlatOpypus's port; the
  live list reports `firewall: { ok, detail }`, `account`, `vaultNames`. **Behaviour change:** a service now receives
  only the Vault names in its `needs:` (before: every general and project value). Root approvals also pin the
  project's code, so 1.14.0 approvals ask once more. `install.sh` adds `acl` and `iptables`. CI (`.github/workflows`):
  contract + syntax + lint, smoke suite and headless browser probe on every push; **Promote to stable** gates on CI,
  then tags `v<version>` and publishes a GitHub release from this changelog. Upgrade migrations (`server/migrations/`, `server/lib/migrate.js`, `~/.porthole/schema.json`,
  `~/.porthole/migrate/pre-*.tar.gz`, `~/.porthole/update-plan.json`); the updater hands over to the new release's
  updater and restores the state archive on rollback; `/api/update` status gains `plan`. First migration:
  `1.15.0-isolate-services`. CI gains the upgrade-from-stable job.

- **1.15.1** â€” `install.sh` makes `/etc/porthole.env` readable by root only (it was world-readable; found by the isolation
  check on the live box: no secrets in it, but service accounts should not see box settings). No state change.
- **1.15.2** â€” Open buttons for a site (shared link, registered server, live service hostname) use a shared
  credential's link when it is the same site with a path or query, e.g. a `?k=` login key; Copy still copies the bare
  address. Promote workflow: when a promotion changes `.github/workflows` (which the workflow token may not push), it
  stops after CI with a notice and `scripts/promote.ps1 -Wait` pushes the tested commit; a `PROMOTE_TOKEN` secret lets
  the workflow do it. No state change.

- **1.16.0** â€” *Upgrade repo* (Files â†’ a project's â‹¯ â†’ Upgrade): a new project at a chosen level that rebuilds a
  prototype instead of hardening it in place; the original is not touched, the new project gets a root-owned read-only
  copy (`.porthole/prototype/`, no dependencies, history or .env files), `.porthole/UPGRADE.md` with the
  reverse-engineer â†’ threat model â†’ architecture â†’ rebuild â†’ verify workflow, and a first agent prompt that asks for
  `PROPOSAL.md` (with a prototype-vs-new comparison table) before any code. The link shows on both folders.
  **Groups** for live services (`groups:` in PORTHOLE.md): dropdowns of items from a list command, each item with its
  own commands, plus "All". **Icons:** project folders and live services show the project's favicon; containers show
  their Docker Hub image logo with a Docker badge. **One card per thing:** with All shown, a container's or server's
  shared link sits on its card instead of a second card under Shared links. Selected options in list-style choices
  (session type, security level) are now highlighted. New state: `project-links.json`, `logos/` (additive, no
  migration).

- **1.17.0** â€” **Desktop layout.** At 720 px and wider the bottom tabs become a left rail; a hamburger opens it as a
  drawer with labels on tablets. From 1024 px it is a full sidebar (collapsible to the rail, remembered) with the
  More pages and the open shells for one-click switching; terminal and editor sit beside it, Home has two columns,
  shells are a grid with longer previews, dialogs open as a side panel (confirmations stay centred), Escape closes
  them, rows show hover states, and the terminal's on-screen keys sit behind a Keys toggle for real keyboards.
  The phone layout is unchanged except that the "I wish for" buttons now wrap under the text on narrow screens.
  **`.portholerun`:** a small YAML file in a project folder (`run`, `port`, `before`, `cwd`, `env`, `needs`,
  `share`, `hostname`, `open`, `run_as`). Files shows a Run card for that folder; tapping shows every command, the
  account (the project's own by default), what gets shared and which Vault names, and runs it only with the hash of
  what was shown. It runs as a registered server (`run-<name>`), opens its link, and PlatOpypus adds it to the
  project's .gitignore. No state change.

- **1.17.1** â€” **Drag and drop in Files** (mouse): drop files or whole folders from the computer onto the list
  (this folder), a folder row or a breadcrumb to upload there, keeping the folder structure (offers to skip
  node_modules/.git, asks above 200 files); drag a row onto a folder, the ".." row or a breadcrumb to move it
  (`POST /api/files/move`, refuses a folder into itself and name clashes); drag a file out to the desktop to
  download it (Chrome/Edge). No state change.

- **1.17.2** â€” New update screen: the version change, the four stages (download, install, restart, health check)
  read from the update log, a ring that turns green when done or red with the reason, Show log and Reload. The Run
  card for a `.portholerun` folder now sits right under the git card, and folders with one show a Run button in the
  Projects listing. No state change.

- **1.17.3** â€” Projects show what runs in them: Home's project list and the Files listing say "â— <name> running Â·
  :port" (running projects first on Home); a project with a running `.portholerun` shows Running (restart/stop) and
  Open instead of Run, and its Run card says it is running with Open and Manage. `/api/files` adds `running` for the
  folder and each folder listed; `/api/home` adds `running` per project. No state change.

- **1.17.4** â€” Projects keep `.porthole/` and `.claude/` out of git: added to `.gitignore` when a project is created
  in /Projects, gets its security level, is made a git repository, is upgraded, runs a `.portholerun`, or starts an
  agent session (so existing projects pick it up too). Override per project with a negation (`!.claude/`) or a
  `# porthole: track .claude` line. Files already committed stay tracked. No state change.

- **1.18.0** â€” **Services by project.** The default view is one card per project folder with everything that runs
  for it: live services, `.portholerun` runs and registered servers (by their folder), containers (by the folder Docker
  Compose started them in), project editors (by the folder they mount) and stray ports (by the shell that opened
  them); a link sits on what it shares. A card shows the project's favicon and opens its folder; containers show
  their image logo, and a compose project's containers fold into one row. One-part projects are a single row.
  Things outside /Projects (Box editor, stray links, system ports, leftovers whose folder is gone) are under Box;
  idle projects are in a collapsed "Not running" list. Views: Projects, Links, Docker, Everything (the old list).
  The app catalog moved to + â†’ Start an app. **Home** has "Running now" (its Projects list shows the rest).
  `/api/services` adds `projects` and `box`; containers carry `workdir`. No state change.

- **1.18.1** â€” The SSH port (22, also when systemd holds the socket) counts as a system port, so it no longer shows up
  as a stray port inside a project. No state change.

- **1.18.2** â€” VS Code on project cards keeps every control: Share (password-protected, timed), Open and Unshare
  with the time left, Start/Stop for the Box editor, and the editor menu; a project without an editor offers "Open
  in VS Code" from its menu. An editor's share link is never the project's Open button. No state change.

- **1.18.3** â€” The Open buttons added in 1.18.0 (Services cards and parts, Home's Running now, the Files Running pill
  and Run card, the .portholerun result) use a shared credential's keyed link for the same site, as the older Open
  buttons do; a site that answers 404 without its key (BusTracker's `?k=`) no longer looks offline. Copy still
  copies the bare address. No state change.

- **1.18.4** â€” Starting or restarting a `.portholerun` server from Services or `svc restart` repeats the run with its
  settings, Vault values and account (it used to rerun the bare command, so BusTracker came back without its API
  keys or `PORT`); if the file changed since it last ran, it asks you to review it in Files first. Live services take
  their own start path the same way. New state: `portholerun.json` (slug â†’ file and the hash that was run; additive).

- **1.19.0** â€” Quick access to live-service commands. Pin an action, a group (Rooms) or one item (a room) to Home
  and the desktop sidebar; Home also lists the last commands run (Recent), which reopen their sheet without running.
  Running cards show their service's groups and first actions as chips. The open action, group or item sheet comes
  back after a reload for 10 minutes, and each has a Copy link (`/#do=â€¦`, opens the sheet, never runs). Group lists
  put this device's recently used items first and get a filter past 8 items. Pins point by label and are checked when
  opened; confirmations, inputs and list checks are unchanged. New state: `quick.json` (pins and recents; additive).
  New API: `GET /api/quick`, `POST /api/quick/pins`, `DELETE /api/quick/pins/:id`, `DELETE /api/quick/recents`.

- **1.20.0** â€” Audit log (More â†’ Audit log, and the desktop sidebar). Every root request (with how it ended and who
  decided), standing root grants, services allowed or started as root; every credential use (an agent's `vault get`,
  Vault values put into a new shell, given to a live service or a `.portholerun`, revealed on the phone, shared with
  `credshare`); and activity (quick links, hostnames, servers, live services and their actions, `.portholerun`, git
  from the phone), each with who asked (agent shell, box CLI, phone) and the project. Commits come from each project's
  git history, marked as an agent's by author or `Co-Authored-By`. Filters by kind and project, with a per-project
  summary. Never stores secret values or command output; agents cannot read it. New state: `audit.jsonl` (+ one
  rotated `audit.1.jsonl`, 4 MB each; additive). New API: `GET /api/audit?type=&project=&days=`.

- **1.21.0** â€” Secrets are fetched per use. New shells no longer get general Vault values in their environment unless
  that value's **Put into new shells** switch is on (off for every existing value: this is a behaviour change).
  Agents use `vault run NAME[,NAME] -- command` (just those values, for one command) or `vault get NAME`; each use is
  logged with the command it was for, including root shells' `vault get`/`run`/`env` (as a record: root can read
  the key). Audit retention is by time: one file per UTC day under `audit/`, kept 90 days (`PORTHOLE_AUDIT_DAYS`),
  a 200 MB cap (`PORTHOLE_AUDIT_MB`) that drops activity before root and credential lines; repeated identical events
  within 2 minutes become one line with a count. The 1.20.0 files are still read until they age out. Vault items
  gain `inShells` (additive; absent = off).
- **1.22.0** â€” **Alerts** (More â†’ Alerts): Telegram messages through a bot you pick from the Vault (general "Telegram
  bot + chat" entries; add one from the page), to its saved chat or one picked from the chats the bot has seen. On by
  default once set up: root requests waiting, sign-ins and lockouts, agents opening public links, servers stopping by
  themselves. Off by default: new connections, agent Vault use, agent commits. Pause 1 h / 8 h. Messages link back to
  PlatOpypus; nothing can be approved from Telegram. At most 20 per 10 minutes, the rest summarised. **Network egress
  log** (Audit log â†’ Network): an iptables chain `PORTHOLE-EGRESS` (jumped to from OUTPUT, IPv4 and IPv6) logs new
  connections from the agent user, `porthole-svc` and the `porthole-svcs` group to the kernel log; PlatOpypus follows
  `journalctl -k` and `resolvectl monitor` to name them. Root processes are not logged. The first connection from a
  project to a host is an audit line of the new type `network`. `PORTHOLE_EGRESS=0` turns it off; without journald
  it reports itself off. New state: `alerts.json`, `egress/` (additive). PlatOpypus now exits cleanly on SIGTERM.
- **1.23.0** â€” **Container services.** A `PORTHOLE.md` service may give `image:` instead of `start:` (with
  `container_port`, `volumes: [<folder in the project>:<path in the container>[:ro]]`, `command`, `memory`, `user:
  service|image`). It runs through the service registry as `docker run --rm` attached in the pane (registry `runAs:
  container`, `account` set); the app inside runs as the project's account (`--user`, `--cap-drop ALL`,
  `no-new-privileges`, `--init`, loopback port). Vault values pass by name (`-e NAME`) from the pane environment.
  Stop sends `docker stop -t 15` first. New route `POST /api/live/:project/:key/pull` (audit `image-pull`) and an
  **Update image** button. Live services that were running at shutdown (`stoppedAt` null, session gone) are started
  again 15 s after boot. Egress: `DOCKER-USER` gets a LOG rule for new connections off `docker0` (rows say
  `container "<name>"`) and a REJECT for 169.254.169.254. Root volume default 50 GB in Terraform. No new state.
- **1.23.1** — Container services: settings under `env:` reach the container by value (`-e K=V`), Vault values and PlatOpypus's own names by name only; `PATH` is never passed. Needed so an image can be given `HOME` or its own settings.
- **1.24.0** — **Stat bubbles.** Every shell, live service, server and container shows its memory (resident plus
  swapped, over the whole process tree; containers from `docker stats`) and CPU (% of one core): amber past 400 MB or
  60 %, red past 900 MB. The Shells tab opens with a box line (memory, swap, load) that turns amber when the box is
  short. New route `GET /api/usage` (lib/usage.js, sampled from /proc at most every 3 s). No new state.
- **1.25.0** — **Limit reached** (More → Alerts): when the 1-minute load stays over the limit (10, `PORTHOLE_LIMIT_LOAD`
  or the page) for two 30 s checks, PlatOpypus closes every public quick link, then stops what is not a live service,
  worst first (CPU + memory incl. swap, newest first on a tie): registered servers, `.portholerun` runs, containers.
  It stops one, waits 30 s, and goes on only while the load is still over 70 % of the limit; 10-minute cooldown.
  Live services, hostnames on your domain and shells are never touched; nothing is deleted. Alert kind `limit` (on
  by default), audit `limit-reached` / `limit-changed`, routes `GET/PUT /api/limit`, `POST /api/limit/run` (`dry`
  for a preview). New state `limit.json` (`{ on, load, last }`). **Device priority:** the systemd unit gets
  `Nice=-10 CPUWeight=1000 IOWeight=1000 MemoryLow=256M OOMScoreAdjust=-900` (plus `system.slice` `MemoryLow=384M` and an
  nginx drop-in), PlatOpypus raises its own nice at start in Docker mode, and the tmux server is started through
  `systemd-run --scope` (CPUWeight 100, OOMScoreAdjust 500) at nice 0, so shells, servers and tunnels live outside
  PlatOpypus's cgroup at normal priority and survive its restarts as before. Existing tmux servers are untouched until
  they next exit (end every shell once, or reboot, for the new scope).
- **1.25.1** — Shell scope: `systemd-run --scope` was given `OOMScoreAdjust`, which scopes refuse, so on a systemd box no
  new shell or service could start under 1.25.0. Scopes now carry `CPUWeight`/`IOWeight` only, and any scope failure
  falls back to plain tmux (logged) instead of failing the start.
- **1.26.0** — **Backups to S3** (More → Backups; Back up now / Backups… on a service page). Storage is the new Vault
  service *Backup storage (S3)* (style `s3Bucket`: key, secret, bucket, region, optional prefix and endpoint). One
  `tar.zst` per run of `backup.paths` plus container volumes (rw), owners/ACLs kept, service frozen (SIGSTOP / docker
  pause) while read; keys `<prefix>/<project>/<ISO time>.tar.zst`; retention keeps the last N (14); optional daily
  hour with per-project switches. Restore stops the service, moves the current folders to
  `.porthole/restore-undo-<ts>`, extracts, starts again. Own SigV4 client (lib/s3.js, no SDK; single PUT ≤ 5 GB).
  Routes `GET/PUT /api/backups`, `POST /api/backups/check`, `GET/POST /api/backups/:project`,
  `POST /api/backups/:project/restore`. Audit `backup` / `backup-failed` / `restore`; alert kind `backup` (failures).
  New state `backups.json` (`{ keep, daily, projects: { name: { daily, last, lastError } } }`) and a scratch folder
  `backup-tmp/`. install.sh now installs `zstd` (backups need it; a box updated from an older release gets it on
  update). A spawn failure in a backup fails that backup, never the server.
- **1.27.0** — **Renamed: Agent PlatOpypus** (PlatOpypus in the app and the docs). Brand only: the UI, README, docs,
  agent instructions and repository (`github.com/sebasouthwell/platopypus`; the old URL redirects, and the updater's
  default repo follows). A project may call its manifest `PLATOPYPUS.md`; `PORTHOLE.md` keeps working. The box gets a
  `plato` command beside `porthole`. Nothing on disk moves: `~/.porthole`, the `porthole` service and accounts, the
  `PORTHOLE_*` variables, the `X-Porthole` header, `.portholerun` and your hostnames are unchanged (that is a 2.0).
- **1.28.0** — **The mascot.** A grey platypus in dark glasses with an earpiece (own drawing, brass bill, no hat), as
  `web/mascot.svg`: the sign-in screen, the Home and sidebar brand marks, the SVG favicon, and the PWA icons
  (rendered from it by `scripts/render-mascot.mjs`; `make-icons.mjs` is retired). Brand text on Home and in the
  sidebar now reads PlatOpypus.
- **1.28.1** — The mascot redrawn by its owner (same brief: grey platypus, dark glasses, earpiece, brass bill, no hat);
  icons re-rendered from it.
- **2.0.0** — **The rename on disk** (MAJOR; see "2.0: the rename on disk" above and `docs/MIGRATION-2.0.md`). State
  `~/.platopypus`, app `/opt/platopypus`, source `/opt/platopypus-src` (links at the old paths); `/etc/platopypus.env`
  written from `/etc/porthole.env`; unit `platopypus.service` (1.x unit kept, disabled); drop-ins and nginx files
  renamed (`platopypus`, `platopypus-snippets.conf`, `platopypus-proxy.inc`, `platopypus-zoned-<slug>`, zones
  `plato_login`/`plato_api`); settings `PLATO_*` with `PORTHOLE_*` mirrored; `X-Plato` / `plato_session` with the old
  ones accepted; tmux socket `plato` after "Finish the rename" (`GET /api/rename`, `POST /api/rename/finish`, audit
  `rename-finished`); firewall chain `PLATO-EGRESS`; `bin/plato-update` (`porthole-update` is a shim for 1.x hand-off);
  `.platorun` (`.portholerun` read); agent-file markers `platopypus:begin/end`. Migration `2.0.0-rename` (idempotent:
  links, env file, old chain). No route changed or removed. Also fixes 1.28.x: `install.sh` no longer regenerates the
  old icons over the mascot.
- **2.0.1** — **Other names for the app.** `PLATO_ALIAS_DOMAINS` (comma separated, in `/etc/platopypus.env`) makes
  `install.sh` serve the app on more names, each with its own Let's Encrypt certificate and an nginx file
  `platopypus-alias-<name>`; `PLATO_REDIRECT_DOMAINS` makes the listed names answer with a 301 to `PLATO_DOMAIN`
  (`platopypus-redirect-<name>`). Files for names removed from the lists are removed. This is how to move to a new
  address: add it as an alias, check it, make it `PLATO_DOMAIN`, list the old one as a redirect. A passkey belongs to
  one address (its WebAuthn relying party is the host name), so the new address needs its own; see
  `docs/MIGRATION-2.0.md`, phase 3.
- **2.0.2** — Alias names with no certificate yet answer only the certificate check on port 80 (404 for anything else),
  instead of the app over plain http, which also made the check fail (the app answered 404 for the challenge file);
  two certificate attempts per update instead of six, to stay inside Let's Encrypt's 5-failures-per-hour limit.
- **2.1.0** — **Keep-alive and the 2-day auto-stop.** More shows *Keep the box on*: until a date you choose the
  schedule leaves the box alone (for a live service that has to stay up). `GET/PUT/DELETE /api/keepalive`, state
  `keepalive.json` (`{ until, reason, set }`, max 60 days, ignored once past). `GET /api/activity` says which agent
  shells are WORKING (terminal changing in the last 90 s, session transcript written in the last 2 min, or CPU under
  them), never counting waiting-for-input prompts, live services, plain shells or servers. `POST /api/autostop/check`
  (`{ dry }`) returns what the schedule would do (`stop`, `why`: idle | working | keep-alive) and, unless dry, writes
  the audit entry (`autostop` / `autostop-skipped`) and sends the Telegram alert (new kind `autostop`, awaited so it
  goes out before a stop). `plato autostop-check [--dry]` and `plato activity` on the box. Terraform: a control-Lambda
  schedule every 2 days (`autostop.tf`) asks the box through one fixed SSM document and stops the instance only when
  the box says so; an agent working, a keep-alive, a box that does not answer, or one started under 12 h ago all skip
  the round (next try in 2 days, nothing is ever forced).
- **2.1.1** — `plato reset-auth` ended early (a `tr | head` pipe under `pipefail`) after writing the new setup token but
  before restarting the server, so the running server still held the old token and rejected the new one. The token is now
  made with node, in the server's own format, and the restart runs.
- **2.2.0** — **Research**: a tab of its own. A topic is a folder `/Research/<Topic>` (`paper/`, `sources/<id>/`, `notes/`,
  `.platopypus/`); nothing existing moves, so there is no migration. New on disk, all inside a topic: `research.json`
  (title, brief, `lang`), `asks/`, `questions/`, `seen.json`, `words.txt`, `cost.json`, `notes/decisions.md`, and two git
  repositories (the topic, and `paper/` on its own). `install.sh` links `bin/research` to `/usr/local/bin/research` and
  creates `/Research`. The heavy tools (LaTeX, ffmpeg, tesseract, poppler, yt-dlp, faster-whisper, aspell) are **not**
  installed by an update: `research setup` installs them when wanted, and every feature says what is missing.
  New session type `research` (`PLATO_SESSION=research`, brief at `<topic>/.platopypus/research.md`); a one-shot run with
  that session works in the topic instead of a throwaway folder and is refused as root. Phone routes under
  `/api/research` (topics, build, pages, sources, exports, asks, questions, notes, files, upload, commit, history,
  links, language, spell); agent routes `POST /api/agent/research/ask`, `GET /api/agent/research/ask/:id`.
  `/editor.html?topic=<slug>` edits the paper (same sign-in, same CSP).
  **Publishing rule**: anything under `/Research` can never be flagged private or public, except `<topic>/paper`, which
  may be flagged private only (`projects.setRepoFlag`, checked again in `projects.allowPush`).
  **Power status**: `GET /api/power` (read-only: `canPowerOff`, `why`, `message`) and `plato power` (exit 0 = may be
  powered off, 3 = no) for any scheduler; `POST /api/power/check` is the recorded form. `/api/autostop/check` and
  `plato autostop-check` keep working, so the control Lambda needs no change. Alert kinds `research` added; `autostop`
  retitled "Automatic power-off". The web manifest is renamed (re-add the Home Screen icon to see the new name).
  A topic may hold `template/` (an uploaded LaTeX zip or example PDF, with `structure.md` for the agent) and
  `.platopypus/template.json`. Files gains Home / Projects / Research shortcuts. On screens 720px and wider every
  direct child of a tab or page is held in the content column (`.tab > *` margins are now `!important`).
  `plato reset-auth`: the 2.1.1 fix had a line break inside the token command and crashed after clearing the logins;
  fixed here (2.1.1 was never released).
- **2.2.1** — the paper editor gets an Agent pane: ask for a change to the paper (the open file and any selected text
  go with it), with a saved version recommended first. New routes `GET /api/research/:slug/versions` (uncommitted
  files, last version), `POST …/revert` (paper back to the last version), `POST …/edits` (one agent run; one at a time).
  Edit requests are stored with the topic's questions (`kind: "edit"`). No state change outside a topic.
- **2.2.2** — paper editor: a Changes pane (`GET /api/research/:slug/diff[?version=<id>]`: the paper against its last
  version, or what one saved version changed; shown after an agent run, with the changed words marked); PDF sources
  open as one scroll of all pages, at the cited page, and a citation without a page says what the source was cited
  for (`claims` in the source view, from `notes/claims.md`, with the page its quote was found on); text size and
  preview/source zoom; the files and references panel can be hidden. No state change.
- **2.2.3** — paper editor: LaTeX and BibTeX colouring (coloured text under a transparent text box; no new
  dependency); selectable text over PDF source pages (`GET /api/research/:slug/source/:id/lines/:n`, cached beside the
  page images). CI builds its images on the host network. No state change.
- **2.2.4** — editor: citation check (`GET/POST /api/research/:slug/citecheck`: a mechanical scan of every cited
  paragraph, then one agent run that reads each cited passage and writes `.platopypus/citereport.json`; the app lists
  what needs a look first and folds the supported ones away); a notice when any agent task in the topic finishes;
  selectable PDF text placed word by word, on a page box of the page's real shape (`…/lines/:n` now returns words;
  cache `p<n>.words.json`). Research agent and model: `GET/PUT /api/research-settings` (`state/research-settings.json`:
  `agent`, `models`), used by Ask, editor changes, citation checks and new research sessions; `shells.create` and
  `agents.command` take an optional `model` passed to `--model` (Claude Code, Codex; checked as a plain name).
  `research setup`: pip no longer fails on Debian's `typing_extensions`. No migration.
- **2.2.5** — editor: the citation check's findings are marked on the text (partly / not supported / could not
  check, and statements that need a citation), found by searching the text so they follow edits; the strip under the
  editor explains the mark at the cursor and switches the marks off (`editor.marks` in the browser). Each problem in
  the report has "Edit this sentence", which opens the file with those words selected. No server or state change.
- **2.2.6** — editor look: one meaning per colour (brass for the main action and where you are; green, amber,
  red and grey only for verdicts; a separate muted set for LaTeX, with citation keys in rose throughout), quieter
  citation marks, the citation report as a status bar plus a list with Source / Edit on each row, tabs on one row
  ("Source + preview" is now "Split"). No server or state change.
- **2.2.7** — editor is calmer: the header keeps the title, save state, a "more" menu (text size, language, build
  on save, save now, save a version) and Build; Spelling and Citations share one Checks tab; Split is an icon; references
  are one line with actions on hover; under the text a single status line with the build result as a chip. No server
  or state change.
- **2.3.0** — research references have one master: each source's `meta.json` record (title, authors, year, journal,
  volume, issue, pages as `pageRange`, publisher, DOI, link, entry type, with `from` saying where each came from:
  DOI, PDF, web page, YouTube, refs.bib, the agent, you). `refs.bib` is written from the records of cited sources
  (`citeKey` is fixed once cited, so keys never change); editing a linked entry in refs.bib writes back into its record.
  First sync of an older topic copies details found only in refs.bib into the records (`bibAbsorbed`); entries without
  a source are untouched. New: `POST …/source/:id/record`, `GET …/export/csv`, uploads of Word, images (OCR), text,
  Markdown, CSV, HTML, LaTeX and `.bib` (one record per entry), uploads no longer cite automatically; a blank topic
  (`blank` on create); template style notes (`template/style.md`, `POST …/template/notes`) and pictures from a template
  or example PDF offered for the paper (`POST …/template/use-image` → `paper/figures/`); resizable editor columns;
  thin scrollbars; the Research agent card sits first on the Research tab.

## Release checklist

1. Bump `server/package.json` version; add the changelog entry here; add a migration if anything on disk changes.
2. Locally: `node scripts/ci-check.mjs`, `npm run lint` in `server/`, the smoke suite in a throwaway container, and
   `test/browser.mjs` against it (`CHANNEL=chrome` uses the installed Chrome).
3. `scripts/release.ps1 -Message "<version>: â€¦" -Push` (runs ci-check first; public tree only). GitHub CI then runs
   static checks, the smoke suite, the browser probe and the upgrade-from-stable test on the pushed commit.
4. Soak on the live box (`PORTHOLE_UPDATE_BRANCH=master porthole update`).
5. `scripts/promote.ps1` (or Actions â†’ Promote to stable): CI again on that exact commit, then stable moves, the
   commit is tagged `v<version>` and a GitHub release is published with these changelog entries. A version that is
   already tagged on another commit is refused.
