# Porthole

A phone-first web console for your own Linux dev box. Open it on a phone and you get real terminals running
AI coding agents, a file browser with upload and editing, one-tap public links to anything that listens on a
port, Docker and VS Code on demand, Git and GitHub, and an encrypted credential vault that feeds every shell.
It is a single Node process with a handful of dependencies, designed for one owner and a box that can be
rebuilt at any time.

Design reference: `web/design/mockup.html` (served at `/design/mockup.html` on a running instance).

## What you get

- **Shells** — several tmux-backed terminals, each an **AI agent** (Claude Code, Codex CLI or Antigravity CLI)
  or a plain shell. Per-agent *Resume last session here* and *Auto-approve everything* switches, Claude
  **profiles** (separate config folders for different accounts or usage limits), a chat-style composer with
  quick replies, a key strip for what the phone keyboard lacks, copy/paste that works on iOS, link chips for any
  URL the agent prints, history, and attachments (paste or drop an image and its path lands in your message).
  Full TUI support over a real pty. Agents hand you secrets with `credshare --user … --pass …`, which shows a card with
  a dropdown of shared credentials: every field is a tap-to-copy row, the card says what it is for (project, shell,
  note), and Open goes to the public tunnel rather than a localhost address (one tap opens a tunnel if there is none).
  The CLI registers the card with the server, so it arrives even if no phone was watching. A **scroll** key swaps the live terminal for a
  natively scrollable copy of the full tmux history; typing or sending brings the live view back. Shared credentials persist
  (encrypted) for seven days, attach to the service on their port (key chip on the Services row, live/gone status),
  and are listed under Vault → "Shared by agents" where stale ones can be deleted.
- **Files** — browse the box like the iOS Files app with a permanent `..`, upload from the phone, download,
  preview, rename, trash, **new file** with an extension picker, and a built-in **text editor** with manual Save
  and a conflict check. Any folder that is a Git repo shows a card with branch, changes, ahead/behind, Commit,
  Push, Pull, and **Publish to GitHub** (private by default).
- **Services** — everything with a port in one place: **shared links** (Cloudflare quick tunnels, auto-expiring,
  tied to their process so they close when it dies), **dev servers** from your shells with one-tap Share,
  **Docker** containers and compose projects with start/stop/logs/remove, a **Run any image** form that pulls the
  image and pre-fills its ports, environment and volumes, a one-tap **app catalogue** (Stirling PDF, n8n, File
  Browser, Excalidraw, IT Tools, Uptime Kuma, Jupyter, Postgres, Redis), and **VS Code in the browser** in two
  flavours: a native box editor or a Docker project editor that sees one folder.
- **Vault** — an n8n-style credential store: a catalogue of ~80 services, each with typed fields for its auth
  style (API key, token, user+password, client pair, AWS keys, webhook URL, bot+chat, SMTP, connection URL,
  JSON file, SSH key, **OAuth2** with PKCE and automatic refresh through Porthole's own redirect endpoint).
  Every field is exported to shells as `<PREFIX>_<FIELD>` (`TELEGRAM_BOT_TOKEN`, `DISCORD_WEBHOOK_URL`,
  `SPOTIFY_ACCESS_TOKEN`…), general or per project, and the agents are told to use `vault ls` / `vault get`
  instead of asking you.
- **Run any image** — look an image up first (ports, default environment, volumes), then start it. One quick-run
  container per image: a second tap restarts the existing one or points you at it in Services.
- **Servers** — `svc run --name "API" --port 8000 -- npm run dev` starts a process in its own logged session and lists
  it on Services as a named server with Stop (whole process group, plus its public link), Start, Logs and Share.
  `svc add --port 8000` registers something already running. Box plumbing (Porthole, agents' local ports,
  code-server, daemons) sits under a collapsed System group with no Share button.
- **Shared credentials** — More → Shared credentials lists everything agents handed over, grouped by project, with
  live/gone status and one-tap stale cleanup. Separate from the Vault on purpose: the Vault is what agents use, this is
  what they gave you.
- **Scratch shells** — "Quick task" on Home (or the Scratch toggle in New shell) starts an agent in a temporary folder
  under `~/scratch` that is deleted when the shell ends: for one-off jobs you don't want to tidy up after.
- **More** — box health, AI agents (install state, sign-in, Claude profiles, Remote Control), GitHub (connect,
  clone, SSH key), Security (passkeys, password, two-step codes, signed-in devices), sign out.

## Security model

Porthole is root-level control of a box, so every layer assumes the one before it can fail.

| Layer | What |
|---|---|
| First run | Setup screen, not a login: needs the one-time setup token printed by the installer **and** creates a passkey (WebAuthn via SimpleWebAuthn). Password optional (scrypt). Once a credential exists the token no longer opens the site. |
| Login | Passkey **or** password, then a TOTP code when two-step is on (short-lived ticket bound to the client address). 5 failures → 15-minute lock per address; nginx throttles the sign-in and setup paths. Unauthenticated status returns booleans only. |
| Reset | Only from the box itself: `porthole reset-auth` (forgets passkeys, password, two-step codes and sessions, prints a fresh setup token) or `porthole reset-totp` (lost authenticator only). Run it in a shell on the box or through your cloud's session manager. No remote recovery by design. |
| Session | HttpOnly + Secure + SameSite=Strict cookie, 256-bit id, 7-day rolling **with a 30-day absolute cap**, persisted; "Sign out others". Any credential change (password, passkey added/removed, two-step on/off) signs out every other device. The client address comes from the socket; `X-Real-IP` is honoured only when the connection comes from the local reverse proxy. |
| Requests | Same-host Origin and `X-Porthole: 1` header on every mutation; WebSocket upgrades need cookie + Origin. CSP, nosniff, no-referrer, frame-ancestors self. |
| Files | Paths resolved with realpath against the configured root; names sanitised; upload cap; atomic editor writes; delete = move to trash. Inline previews serve html/svg/xml/js as plain text under a `sandbox` CSP. |
| Tunnels | Public URLs → warning in UI, auto-expiry (4 h; 20 min for editors), Porthole's own port refused, and a watcher that closes a tunnel when the process behind it disappears. |
| Vault | AES-256-GCM, key file 0600, values never listed, reveal is explicit and logged, reserved env names blocked, project scope only reaches shells in that folder. |
| Docker | Arguments validated and exec'd without a shell; containers bind to loopback. |
| Process | Runs as root by default (`PORTHOLE_USER=ubuntu` for a confined install). Loopback-only token sign-in remains for the box's own `vault`/`tunnel` CLIs; requests through the reverse proxy can never use it. |
| Audit | Every auth event and every shell, tunnel, vault, docker, git and editor action goes to stdout → journald. |

Every route is listed with its gate in `server/server.js`; the endpoint audit is summarised at the bottom of
this file.

## Install on a box

Ubuntu 24.04, any cloud. Put the repo on the box and run the installer as root. It installs Node 22, tmux,
cloudflared, Docker, GitHub CLI, Claude Code, Codex CLI, Antigravity CLI, code-server, Tailscale, the
Porthole service, and (when a domain is given) nginx with a Let's Encrypt certificate.

```bash
git clone https://github.com/<you>/porthole /opt/porthole-src
cd /opt/porthole-src
sudo PORTHOLE_DOMAIN=porthole.example.com LE_EMAIL=you@example.com ./install.sh
```

The installer prints the **setup token**. Open `https://porthole.example.com`, enter the token, create a
passkey, then turn on two-step codes under More → Security. Re-run `install.sh` to upgrade.

Your firewall should admit 80/443 only (ideally only from your CDN's edge if you proxy the domain). No SSH is
needed; use your cloud's session manager or Tailscale SSH for break-glass.

Environment variables (see `server/lib/config.js`): `PORTHOLE_PORT` (7331), `PORTHOLE_BIND` (127.0.0.1),
`PORTHOLE_ROOT` (files root), `PORTHOLE_STATE` (~/.porthole), `PORTHOLE_TUNNEL_TTL`, `PORTHOLE_MAX_UPLOAD_MB`,
`PORTHOLE_SESSION_DAYS`, `PORTHOLE_ALLOWED_ORIGINS`, `PORTHOLE_DOCKER_HOST`, `PORTHOLE_ALLOW_PASSWORD_ONLY`.

## Local test (Docker)

```bash
docker compose up -d --build
docker cp test/smoke.mjs porthole:/tmp/smoke.mjs
docker compose exec porthole node /tmp/smoke.mjs     # ~5 min end-to-end suite, includes real Cloudflare tunnels
```

Open `http://127.0.0.1:7331/`, setup token `porthole-test`. The compose file mounts the host Docker socket so
the Docker features can be exercised, sets `PORTHOLE_DOCKER_HOST=host.docker.internal` (container ports live on
the host when Porthole itself runs in a container), and allows password-only setup because passkeys need
https or localhost. On a real box Porthole runs natively and none of that applies.

## Layout

```
server/            Node server: server.js + lib/{auth,credentials,totp,shells,tmux,agents,files,tunnels,vault,catalog,
                   docker,apps,codeserver,git,home,history,system}.js
web/               Static UI (index.html, app.js, styles.css, sprite.svg, fonts/, manifest, preview.html, design/)
bin/               tunnel, vault — CLIs used inside shells (symlinked to /usr/local/bin)
deploy/            nginx config, AGENT.global.md (instructions installed for Claude Code, Codex and Antigravity)
install.sh         Idempotent Ubuntu 24.04 installer (box or docker mode)
Dockerfile, docker-compose.yml   Local test image = same installer
test/smoke.mjs     End-to-end suite run inside the container
scripts/           make-icons.mjs (PWA icons), make-sprite.mjs (Lucide sprite)
```

## Updates

The box checks the public repo once a day (and on demand under More) and shows "Update available" with the
latest commit messages. **Update** shows a "shutting down for approximately 5 minutes" screen and runs a
detached updater: fetch the repo into `/opt/porthole-src`, snapshot `/opt/porthole`, re-run `install.sh`,
restart only the Porthole service, and roll back automatically if the API is not healthy within 30 seconds.
State (`~/.porthole`), your files, tmux sessions, Docker and nginx are never touched; the page reloads itself
when the service is back. Point it at a fork with `PORTHOLE_UPDATE_REPO=owner/repo`. **`UPDATE.md`** is the contract for new versions:
how the updater runs, every state file and its shape, and the rules for changing them compatibly.

## Box CLI

`porthole status` · `porthole token` · `porthole reset-auth` · `porthole reset-totp` · `porthole sessions` ·
`porthole update`. Plus `vault ls|get|env` and `tunnel <port>|ls|rm` for use inside shells.

## Moving off

The box is disposable: Files → each project → Push (or Publish). More → Vault → reveal anything you still
need (or `vault env` in a shell). Then destroy the machine.

## Endpoint audit

- **Static, unauthenticated:** `/`, `/app.js`, `/styles.css`, `/sprite.svg`, `/fonts/*`, `/icons/*`, `/vendor/*`,
  `/preview.html`, `/design/*`. Fixed directory, normalised-path check, no listing, no user content.
- **Sign-in, unauthenticated, Origin-checked, throttled:** `GET /api/login` (booleans), `POST /api/setup/*`
  (token-gated, refused once set up), `POST /api/login/{passkey/options,passkey/verify,password,totp,token}`,
  `POST /api/logout`, `GET /oauth/callback` (requires a session; state-checked). Every failure counts toward the
  lockout; `/api/login/token` is loopback-only.
- **Everything else:** session cookie required; mutations also require same-host Origin and `X-Porthole: 1`;
  WebSocket upgrades require cookie + Origin. Inputs: shell names `^[A-Za-z0-9][\w-]{0,39}$`; ports 1–65535
  (Porthole's own refused); image/container/compose names by regex and passed as argv; vault env names
  `UPPER_SNAKE` with reserved names blocked; git paths via the root resolver, repo specs by regex, messages as
  argv. Secrets are never listed. Error messages carry only the last lines of tool stderr.

## Licence

MIT. Icons are Lucide (ISC); fonts are Geist and Geist Mono (OFL). See `LICENSE`.
