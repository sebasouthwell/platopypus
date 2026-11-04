# Updating Porthole

This file is the contract between a running box and a newer version of this repo. Read it before changing
anything under `server/lib` that reads or writes state, and before changing `install.sh`.

## How an update runs

1. The box checks `https://raw.githubusercontent.com/<repo>/master/server/package.json` and the commit list once
   a day (and on demand). A higher `version`, or a different commit when the install was made from git, shows
   **Update available** under More.
2. **Update** starts `bin/porthole-update` detached from the service (a transient systemd unit, or `setsid`):
   - fetch the repo into `$PORTHOLE_SRC` (default `/opt/porthole-src`; a bundle install is converted to a clone)
   - snapshot `/opt/porthole` → `/opt/porthole.prev`
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

- `server/package.json` → `version` is the product version (`MAJOR.MINOR.PATCH`). Bump it in every release.
  *PATCH* = no state format change. *MINOR* = additive state change (new fields/files, old ones still read).
  *MAJOR* = a migration is required (see below).
- `/opt/porthole/VERSION` holds `<short-sha> <unix-time>` of the installed source (`bundle` if installed from
  the deploy bundle rather than git).

## State on disk (owned by the server)

All under `PORTHOLE_STATE` (default `~/.porthole`, mode 0700). Every file is written atomically (tmp + rename)
with mode 0600. Formats as of version 1.0:

| File | Writer | Shape |
|---|---|---|
| `token` | config.js | one line: 32-char base64url setup/CLI token |
| `tmux.conf` | config.js | regenerated at every start; not user-editable |
| `auth-sessions.json` | auth.js | `{ "<sid>": { created, lastSeen, ua, how } }` |
| `security.json` | credentials.js, totp.js | `{ passkeys: [{ id, publicKey(base64url), counter, transports, deviceType, backedUp, name, created, lastUsed }], password: { salt, hash, set }, totp: { enabled, secret(base32), enabledAt, lastCounter }, pending: {...} }` — any key may be absent |
| `shells.json` | shells.js | `{ "<name>": { kind: shell\|agent\|remote-control, cwd, created, agent?, yolo?, resume?, profile?, scratch? } }` — legacy `kind: "claude"` is read as `agent` + `agent: "claude"`; `scratch: true` (1.1.0) marks a shell whose `cwd` under `~/scratch/` is deleted when the shell is ended |
| `shared-creds.json` | sharedcreds.js | `{ items: [ { id, title, fields: [{ label, value(enc), secret }], url, note, shell, project?, port, at } ] }` — credentials handed over by `credshare`; values encrypted with `vault.key`; dropped after 7 days (1.0.4, documented 1.1.0) |
| `tunnels/tunnels.json`, `tunnels/<port>.log` | tunnels.js | `{ "<port>": { name, created, expires, origin, owner, misses, publicUrl? } }`; logs are cloudflared output; `publicUrl` (1.3.0) overrides the trycloudflare address for tunnels on the user's own domain |
| `vault.key` | vault.js | 32-byte key, base64 |
| `vault.json` | vault.js | `{ items: [ v2 ] }` where v2 = `{ id, provider, title, style, name, prefix, scope, notes, fields: { <field>: <enc> }, secretFields: [..], labels: {..}, envMap: {..}, oauth: { authUrl, tokenUrl, scopes, clientAuth, pkce, authParams, scopeSeparator, expiresAt, tokenType, obtainedAt, grantedScopes }\|null, created, updated, lastUsed }`. **v1 items** (`{ envName, value, kind }`) are still read via `normalise()` and must keep working. `<enc>` = `iv.tag.ciphertext` base64, AES-256-GCM. |
| `zoned.json`, `zoned/<slug>.log` | zoned.js | `{ items: { "<slug>": { slug, hostname, port, name, mode: direct\|tunnel, zoneId, zoneName, accountId, tunnelId, dnsRecordId, via, origin, created, token(enc) } } }` — hostnames on the user's domain (1.5.0); `token` is the cloudflared run token encrypted with `vault.key` |
| `projects.json` | projects.js | `{ repos: { "<abs folder>": { flag: private\|public, set } } }` — publishing flags (1.4.0); a folder absent from the map is local only |
| `services.json` | services.js | `{ items: { "<slug>": { slug, name, port, cwd, cmd[]\|null, pid, session\|null, project, created, stoppedAt, log, external, cmdline?, owner?, live?: { project, key, title }, runAs?: agent\|service\|root } } }` — registered servers (1.3.0); logs in `services/<slug>.log`, or `/home/agent/.porthole/services/<slug>.log` for agent-started servers (1.14.0); missing `runAs` = root |
| `live-approvals.json` | live.js | `{ "<live slug>": "<sha256 of start, cwd, patch and action commands>" }` — services allowed to run as root (1.14.0); a changed manifest no longer matches, so it asks again |
| `schema.json` | migrate.js | `{ version, applied: [{ id, version, at, ms, result? }], updatedAt, lastBackup, lastRun: { from, to, at, ids } }` — upgrade migrations (1.15.0); absent = none applied yet |
| `migrate/pre-<version>-<stamp>.tar.gz` | migrate.js | state archive taken before migrations (5 kept); also login-move backups (1.12.0) |
| `project-links.json` | upgrade.js | `{ links: [{ from, to, at, level, commit }] }` — "Upgrade repo" relationships between project folders (1.16.0) |
| `logos/` | logos.js | cached Docker Hub image logos (`<hash>.png`, `<hash>.none` = none, retried after a week) (1.16.0) |
| `update-plan.json` | bin/porthole-update | `{ from, to, pending: [manifest entries] }` written before each install (1.15.0) |
| `code-server.json` | codeserver.js | `{ password, folder, startedAt, projects: { "code-<slug>": { password, folder } } }` |
| `update.json`, `update-result.json`, `update.log`, `update.lock` | update.js, bin/porthole-update | check status, last result, log, lock (pid) |
| `trash/` | files.js | deleted files/folders, `<ISO-stamp>__<name>` |

nginx: zoned shares add `/etc/nginx/sites-{available,enabled}/porthole-zoned-<slug>` (owned and removed by Porthole);
`install.sh` renders `/etc/nginx/sites-available/porthole` from `deploy/nginx-porthole.conf` (no certificate yet)
or `deploy/nginx-porthole-ssl.conf` (certificate present) on **every** run; certbot runs in `certonly` mode and
never edits nginx config. Do not hand-edit the site file on a box; change the template and release.

Other locations the app relies on but does not own: `~/.claude`, `~/.agent-profiles/claude/<name>` (Claude
profiles = `CLAUDE_CONFIG_DIR`), `~/.codex`, `~/.antigravity`/`~/.gemini`, the agent instruction files
`~/.porthole/githooks/pre-push` and `~/.porthole/gitignore_global` (installed by `install.sh`, referenced from the service
user's global git config), `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md` and each profile's `CLAUDE.md` (only the block
between `<!-- porthole:begin -->` and `<!-- porthole:end -->` is Porthole's; it is rewritten by `install.sh` on every update), `~/.config/gh`, `~/.ssh/id_ed25519`,
`~/apps/<app>/` (volumes for catalogue apps), `~/scratch/<date>-<shell>/` (scratch shells; deleted by the server when
that shell is ended, never by an update), `<project>/.pasted/` (attachments), `/etc/porthole.env`.

### Session rules (1.1.0)

Sessions expire after 7 idle days (`PORTHOLE_SESSION_DAYS`) **and** 30 days after sign-in regardless of use
(`PORTHOLE_SESSION_ABSOLUTE_DAYS`). Every credential change (password set/cleared, passkey added/removed, two-step
enabled/disabled) revokes all other sessions. `X-Real-IP` is honoured only when the TCP peer is loopback (nginx).
Older `auth-sessions.json` records already carry `created`, so no migration.

## Rules for compatible changes

0. **An update never ends a session.** Shells, servers, live services and tunnels are tmux sessions that must survive
   `systemctl restart porthole` (`KillMode=process`); check it on the box: `tmux -L porthole ls` before and after.
1. **Additive by default.** New fields get defaults when read; missing files mean "first run" for that feature.
   Never require a field that older versions did not write.
2. **Read old, write new.** When a shape changes, keep a `normalise()` step that upgrades records on read (see
   `vault.js`), and write the new shape only when the record is next saved. Do not rewrite whole files at
   startup just to migrate; a crash mid-way must leave the old file readable.
3. **Never rename an environment variable** that the vault already exports (`<PREFIX>_<FIELD>`), nor a
   catalogue `env` prefix or auth-style field `env` suffix — projects on the box depend on them. Add a new
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

- **1.1.0** — `shells.json` gains optional `scratch`; `shared-creds.json` documented; new routes `POST /api/creds/share`
  (box CLIs register a credential), `DELETE /api/shells/<name>?keep=1` (end a scratch shell but keep its folder);
  `POST /api/docker/inspect` adds `existing`, `POST /api/docker/run` may answer **409** when a container from the same
  image is already running (one quick-run container per image) or `{ reused: true }` when it restarted a stopped one;
  shell WebSocket gains text frame `{ type: "cred", id, title, port }`; tmux option `allow-passthrough on` is in
  the generated `tmux.conf` and also set live on the running tmux server (existing sessions are untouched).

- **1.1.1** — every API response carries `X-Porthole-Version` and `/api/me` returns `version` (client offers a reload
  when the page predates the running server); updater step lines are appended to `update.log` with the token masked;
  tmux mouse option targets fixed (`name:` instead of `=name`). No state changes.

- **1.2.0** — **fixes a blank page in 1.1.0/1.1.1** (`app.js` referenced the composer before it was declared, so the
  module failed to load; boxes on those versions show nothing until updated). `shared-creds.json` items gain optional `project` (cwd of the sharing process); `GET /api/creds` and
  `/api/creds/:id/values` add `project`, `openUrl` (tunnel URL, with the path of a local URL, or the explicit public URL)
  and `localOnly`; `service.local` added. credshare accepts `--for` (alias of `--note`) and sends `cwd`.

- **1.2.1** — shared credentials move out of the Vault page into their own More → Shared credentials page (grouped by
  project). No API or state change.

- **1.2.2** — index.html is served with version-stamped asset URLs (`/app.js?v=…`, `/styles.css?v=…`, `/sprite.svg?v=…#`)
  and a `porthole-version` meta tag. Reason: Cloudflare (and most proxies) cache `.js`/`.css` for hours regardless of the
  origin's `Cache-Control`, so after an update phones were getting a new page with the previous script. No state change.

- **1.2.3** — the agent instructions (`deploy/AGENT.global.md`, formerly `CLAUDE.global.md`) are installed for all three
  agents: `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, plus every Claude profile. The block is
  wrapped in `porthole:begin/end` markers and refreshed on each update (a legacy unmarked block is replaced from its
  heading to the end of the file). No state change.

- **1.3.0** — update channel defaults to `stable` (promote with `release.ps1 -Promote`); post-update health check also
  verifies the page, the stamped assets and that `app.js` parses, rolling back otherwise. Registered servers: `services.json` (new), routes `GET/POST /api/servers`, `POST /api/servers/run`,
  `POST /api/servers/<slug>/stop|start`, `GET /api/servers/<slug>/logs`, `DELETE /api/servers/<slug>`; `svc` CLI; tmux
  session prefixes `svc-` and `zoned-` are reserved like `tunnel-`. `/api/services` adds `servers` and `system` (ports
  owned by Porthole, agents and box daemons, never shareable) and excludes both from `devservers`; links carry
  `kind: quick|zoned`. No migration.

- **1.4.0** — publishing flag per project: `projects.json` (new), routes `GET/PUT /api/projects/repo`, `GET /api/projects/repo/all`;
  `git/status` adds `publish`; `git/publish` ignores the request's `private` and uses the flag (409 when local only);
  `git/push` is gated the same way. install.sh sets the service user's `core.hooksPath` to `~/.porthole/githooks`
  (pre-push asks `project allow-push`) and `core.excludesFile` to `~/.porthole/gitignore_global` (`.pasted/`). New CLI
  `project`. No migration; existing folders become local only until flagged.

- **1.5.0** — share on your own domain: `zoned.json` (new), routes `GET /api/zoned`, `GET /api/zoned/prereq`, `POST /api/zoned`,
  `DELETE /api/zoned/<slug>`; `tunnels.list()` (and therefore `/api/tunnels`, `/api/services.links`, shared-credential
  `openUrl`) includes zoned entries with `kind: zoned`, `hostname`, `slug`, `connected`; `DELETE /api/tunnels/<port>` on a
  zoned port removes the hostname. Porthole writes `/etc/nginx/sites-{available,enabled}/porthole-zoned-<slug>` on boxes
  with nginx and removes them again; nothing else under /etc/nginx is touched. tmux prefix `zoned-`. No migration.

- **1.6.0** — Vault: required fields may be left empty on save (item reported with `incomplete: [labels]`, and `fields[]`
  includes the missing definitions with `missing: true`); `POST /api/vault/derive` (Telegram getMe / chat lookup; values
  are used for the one call, never stored). No state change: an item simply lacks some `fields` keys.

- **1.7.0** — "Share on your domain" gains **direct** mode (default on a box with a public address, nginx and a Let's Encrypt
  certificate for the Porthole hostname): A record → box (proxied like the Porthole record), nginx :80/:443 blocks,
  `certbot certonly --webroot` for the hostname (renewed by certbot's timer), no tunnel process. Items without `mode`
  (1.5.0) are treated as tunnel mode. `/api/zoned/prereq` adds `mode`; entries add `mode`. Remove deletes the
  certificate too (`certbot delete`). Only `/etc/nginx/sites-{available,enabled}/porthole-zoned-*` and
  `/etc/letsencrypt/live|archive|renewal/<hostname>` for shared hostnames are touched.

- **1.7.1** — install.sh waits up to 10 minutes for the dpkg lock (`-o DPkg::Lock::Timeout=600`) instead of failing when
  unattended-upgrades is running; an update on the box had rolled back for exactly that reason.

- **1.8.0** — live services from `PORTHOLE.md` (see docs/LIVE.md): routes `GET /api/live`, `GET /api/live/check`,
  `POST /api/live/<project>/<service>/start|stop|hostname`, `POST …/actions/<n>`, `POST …/credentials/<n>`, `GET …/logs`;
  `/api/services` adds `live` and its `servers` no longer include `live-*` registrations. Live services run through the
  servers registry as `live-<project>-<key>`. Hostnames on your domain now show a coming-up page
  (`/var/www/porthole/coming-up.html`) when the service is not answering; stopping a server no longer removes a
  domain hostname. **Behaviour change:** project-scoped Vault entries are no longer exported into shells; `vault get`
  returns them only from the project's main folder (general entries are unchanged). New CLI `live`; dependency `yaml`.

- **1.9.0** — agents without root, stage 1 of docs/AGENT-USER.md (additive; root stays the default). install.sh creates
  the `agent` user and `porthole-dev` group and installs Claude Code / Antigravity and the agent instructions for it.
  `shells.json` entries gain `runAs` (missing = root) and `tokenHash`. `POST /api/shells` accepts `runAs: agent`. Shell
  tokens sign in through `/api/login/token` to a restricted session (AGENT_ROUTES in server.js; WebSocket refused).
  New: `POST /api/agent/vault`, `POST /api/agent/elevate`, `GET /api/agent/elevate/<id>`, `GET /api/elevate/pending`,
  `POST /api/elevate/<id>/allow|deny`, `POST /api/shells/<name>/elevation`, `GET /api/agent-user`; CLI `elevate`.
  `services.json` items may carry `owner` (agent-user shell). Agent-user folders get group `porthole-dev` + setgid.

- **1.9.1** — one projects folder: clone and New shell default to `<files root>/Projects` (was `~/Projects`, which on a
  root-at-/ box made a second folder); install.sh links `~/Projects` → `/Projects` when it is missing or empty. Red Stop button beside Send in the terminal sends Ctrl+C; live service page shows the running dot in green. UI only.

- **1.10.0** — session type and security level for agent sessions. New per-project files `<project>/.porthole/project.json`
  (`{ level: throwaway|personal|professional, audience?, tier?, set, lastCveCheck? }`) and `.porthole/security.md` (copied from
  `deploy/security/<key>.md`); both travel with the repo. `POST /api/shells` accepts `session: control|project` (428 with
  `needProfile` when a project has no level yet); shells get `PORTHOLE_SESSION`, `PORTHOLE_SECURITY_LEVEL`,
  `PORTHOLE_SECURITY_FILE`; `shells.json` entries may carry `session` and `security`. Routes `GET/PUT /api/projects/profile`,
  `POST /api/projects/profile/cve-checked`. `project security`, `project cve-checked`. Shells created without `session` behave
  as before.

- **1.11.0** — agents start trusted in the folder picked in Porthole (Claude `.claude.json` projects[dir].hasTrustDialogAccepted,
  Codex `config.toml` [projects."dir"] trust_level, Antigravity/Gemini `trustedFolders.json`), written for the user the agent
  runs as; `POST /api/shells` accepts `firstPrompt` (Claude/Codex as an argument via `PORTHOLE_FIRST_PROMPT`, Antigravity typed
  in). Home gains "I wish for:". No state change.

- **1.11.1** — New shell always defaults to Run as root (the agent-user choice is no longer remembered, it had switched
  Claude to an unsigned-in user); the dialog warns when the agent has no login for the agent user; agent-user scratch folders
  live in the agent's home; `GET /api/agent-user` adds `signedIn`.

- **1.12.0** — stage 2 of docs/AGENT-USER.md: AI agents → Move logins moves (not copies) root's `.claude`, `.claude.json`,
  `.agent-profiles`, `.codex`, `.gemini`, `.antigravity` to the agent user after a tar backup in `~/.porthole/migrate/`; marker
  `~/.porthole/logins-moved.json`; Undo moves them back. Once moved, agent and Remote Control shells default to the agent user
  (plain shells stay root), profiles resolve under the agent's home, and `/api/agents` reports sign-in from there. New
  routes `POST /api/agent-user/move-logins|undo-move`; `/api/agent-user` adds `loginsMoved`, `rootLogins`. New shell defaults to
  the agent user for AI agents. Home "I wish for:" gains Temp (scratch folder, agent user, throwaway brief, first message, no
  questions).

- **1.13.0** — one-shot runs: `POST /api/shells` accepts `oneshot: true` (Claude `-p` / `codex exec`, auto-approved, scratch
  folder); when the session ends Porthole stores `{ name, agent, prompt, started, finished, output }` in `~/.porthole/oneshot/<name>.json`
  (30 kept) and deletes the folder. `GET /api/oneshot`. Home Temp gains a ▾ menu: Temp session / One-shot / results.

- **1.14.0** — live services run as **porthole-svc** (no shell, no logins, group porthole-dev; created by `install.sh` or on
  first use), and so do their actions; Porthole keeps the log and the stop. `run_as: root` in PORTHOLE.md needs approval on
  the phone, pinned to a hash of the commands (`POST|DELETE /api/live/<p>/<k>/root`). Starting a live service takes over its
  port from a plain server in the same project folder and refuses other holders; servers that die straight after starting
  report their log. `svc restart` and `POST /api/servers/<slug>/restart` (live slugs restart through live.js; names resolve
  to live services by title or key). `POST /api/live/<p>/<k>/restart`. Actions gain `restart`, `stop_first` and typed
  `inputs` (string, integer, number, boolean, choice; min, max, pattern, default, required) delivered as `INPUT_<NAME>`
  environment variables, never pasted into the command; the action body is `{ inputs: {...} }` (absent = none). Files gains
  **Make agent-ready** (`GET|POST /api/agent-ready`). Agent-started servers log under the agent's home (they could not
  write to `/root/.porthole`).

- **1.14.1** — `porthole.service` gains `KillMode=process`: restarting Porthole (every update) no longer ends the tmux
  server, so shells, servers, live services and tunnels survive updates as `tmux.js` always intended. Before this, each
  update ended every session on the box. No state change.

- **1.15.0** — live services run as one account **per project**, `ps-<project>` (primary group `porthole-svcs`,
  home `/var/lib/porthole-svc/<project>`), with a POSIX ACL on that project only (plus default ACLs, and `o::---`;
  marker `<project>/.porthole/acl.json`); top-level project folders lose all "other" permissions; agent shells use
  `umask 007`. The 1.14.0 shared `porthole-svc` account is removed from `porthole-dev`. iptables/ip6tables `OUTPUT`
  rules (re-applied at every start) reject `porthole-svcs` traffic to the EC2 metadata service and Porthole's port; the
  live list reports `firewall: { ok, detail }`, `account`, `vaultNames`. **Behaviour change:** a service now receives
  only the Vault names in its `needs:` (before: every general and project value). Root approvals also pin the
  project's code, so 1.14.0 approvals ask once more. `install.sh` adds `acl` and `iptables`. CI (`.github/workflows`):
  contract + syntax + lint, smoke suite and headless browser probe on every push; **Promote to stable** gates on CI,
  then tags `v<version>` and publishes a GitHub release from this changelog. Upgrade migrations (`server/migrations/`, `server/lib/migrate.js`, `~/.porthole/schema.json`,
  `~/.porthole/migrate/pre-*.tar.gz`, `~/.porthole/update-plan.json`); the updater hands over to the new release's
  updater and restores the state archive on rollback; `/api/update` status gains `plan`. First migration:
  `1.15.0-isolate-services`. CI gains the upgrade-from-stable job.

- **1.15.1** — `install.sh` makes `/etc/porthole.env` readable by root only (it was world-readable; found by the isolation
  check on the live box: no secrets in it, but service accounts should not see box settings). No state change.
- **1.15.2** — Open buttons for a site (shared link, registered server, live service hostname) use a shared
  credential's link when it is the same site with a path or query, e.g. a `?k=` login key; Copy still copies the bare
  address. Promote workflow: when a promotion changes `.github/workflows` (which the workflow token may not push), it
  stops after CI with a notice and `scripts/promote.ps1 -Wait` pushes the tested commit; a `PROMOTE_TOKEN` secret lets
  the workflow do it. No state change.

- **1.16.0** — *Upgrade repo* (Files → a project's ⋯ → Upgrade): a new project at a chosen level that rebuilds a
  prototype instead of hardening it in place; the original is not touched, the new project gets a root-owned read-only
  copy (`.porthole/prototype/`, no dependencies, history or .env files), `.porthole/UPGRADE.md` with the
  reverse-engineer → threat model → architecture → rebuild → verify workflow, and a first agent prompt that asks for
  `PROPOSAL.md` (with a prototype-vs-new comparison table) before any code. The link shows on both folders.
  **Groups** for live services (`groups:` in PORTHOLE.md): dropdowns of items from a list command, each item with its
  own commands, plus "All". **Icons:** project folders and live services show the project's favicon; containers show
  their Docker Hub image logo with a Docker badge. **One card per thing:** with All shown, a container's or server's
  shared link sits on its card instead of a second card under Shared links. Selected options in list-style choices
  (session type, security level) are now highlighted. New state: `project-links.json`, `logos/` (additive, no
  migration).

- **1.17.0** — **Desktop layout.** At 720 px and wider the bottom tabs become a left rail; a hamburger opens it as a
  drawer with labels on tablets. From 1024 px it is a full sidebar (collapsible to the rail, remembered) with the
  More pages and the open shells for one-click switching; terminal and editor sit beside it, Home has two columns,
  shells are a grid with longer previews, dialogs open as a side panel (confirmations stay centred), Escape closes
  them, rows show hover states, and the terminal's on-screen keys sit behind a Keys toggle for real keyboards.
  The phone layout is unchanged except that the "I wish for" buttons now wrap under the text on narrow screens.
  **`.portholerun`:** a small YAML file in a project folder (`run`, `port`, `before`, `cwd`, `env`, `needs`,
  `share`, `hostname`, `open`, `run_as`). Files shows a Run card for that folder; tapping shows every command, the
  account (the project's own by default), what gets shared and which Vault names, and runs it only with the hash of
  what was shown. It runs as a registered server (`run-<name>`), opens its link, and Porthole adds it to the
  project's .gitignore. No state change.

- **1.17.1** — **Drag and drop in Files** (mouse): drop files or whole folders from the computer onto the list
  (this folder), a folder row or a breadcrumb to upload there, keeping the folder structure (offers to skip
  node_modules/.git, asks above 200 files); drag a row onto a folder, the ".." row or a breadcrumb to move it
  (`POST /api/files/move`, refuses a folder into itself and name clashes); drag a file out to the desktop to
  download it (Chrome/Edge). No state change.

- **1.17.2** — New update screen: the version change, the four stages (download, install, restart, health check)
  read from the update log, a ring that turns green when done or red with the reason, Show log and Reload. The Run
  card for a `.portholerun` folder now sits right under the git card, and folders with one show a Run button in the
  Projects listing. No state change.

- **1.17.3** — Projects show what runs in them: Home's project list and the Files listing say "● <name> running ·
  :port" (running projects first on Home); a project with a running `.portholerun` shows Running (restart/stop) and
  Open instead of Run, and its Run card says it is running with Open and Manage. `/api/files` adds `running` for the
  folder and each folder listed; `/api/home` adds `running` per project. No state change.

## Release checklist

1. Bump `server/package.json` version; add the changelog entry here; add a migration if anything on disk changes.
2. Locally: `node scripts/ci-check.mjs`, `npm run lint` in `server/`, the smoke suite in a throwaway container, and
   `test/browser.mjs` against it (`CHANNEL=chrome` uses the installed Chrome).
3. `scripts/release.ps1 -Message "<version>: …" -Push` (runs ci-check first; public tree only). GitHub CI then runs
   static checks, the smoke suite, the browser probe and the upgrade-from-stable test on the pushed commit.
4. Soak on the live box (`PORTHOLE_UPDATE_BRANCH=master porthole update`).
5. `scripts/promote.ps1` (or Actions → Promote to stable): CI again on that exact commit, then stable moves, the
   commit is tagged `v<version>` and a GitHub release is published with these changelog entries. A version that is
   already tagged on another commit is refused.
