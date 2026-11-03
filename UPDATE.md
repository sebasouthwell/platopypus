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
| `services.json` | services.js | `{ items: { "<slug>": { slug, name, port, cwd, cmd[]\|null, pid, session\|null, project, created, stoppedAt, log, external, cmdline? } } }` — registered servers (1.3.0); logs in `services/<slug>.log` |
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

## When a migration is unavoidable (MAJOR)

- Add `server/lib/migrate.js` with numbered steps keyed by a `schema` field written to `~/.porthole/schema.json`.
- Each step backs up the file it changes to `<file>.bak-<schema>` before writing, is re-runnable, and logs.
- Run migrations at server start *before* any route is served; if a step fails, refuse to start and log how to
  roll back (`/opt/porthole.prev` + the `.bak` file).
- Document the step here and in the release commit message, including the manual rollback.

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

## Release checklist

1. Bump `server/package.json` version; note state changes in this file.
2. `npm run lint` in `server/` (use-before-define over the browser module and the server), then `docker compose up -d --build`
   and run `test/smoke.mjs` in a throwaway container — all checks pass. **Then load the app in a browser**: the smoke
   suite is API-only and cannot see a front-end that fails to start.
3. Release with `scripts/release.ps1 -Message "<version>: …" -Push` (public tree only: no infra, no personal data).
4. On a box: More → Updates → Check → Update, confirm `update-result.json` says `ok: true`.
