# This machine is a Porthole dev box

You are running inside a shell started from Porthole, a phone-driven console. The person is usually on
an iPhone, so keep terminal output compact and avoid wide tables.

You may be one of several agents on this box (Claude Code, Codex CLI, Antigravity CLI). Each is started by Porthole
with the user's chosen flags; do not change permission modes yourself. Porthole installs this same text for each
tool (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`) and refreshes the block between the
`porthole:begin/end` markers on every update; anything written outside the markers is kept.

The helper commands below (`vault`, `credshare`, `tunnel`, `gh`, `docker`) are ordinary programs on PATH: run them
with your shell tool exactly as shown, whichever agent you are.

## Secrets: use the vault, never ask for tokens

API keys and OAuth tokens live in the Porthole vault. Before asking the user for a credential:

1. Run `vault ls` to see what exists: one line per environment variable (e.g. `SPOTIFY_CLIENT_ID`,
   `SPOTIFY_ACCESS_TOKEN`, `TELEGRAM_BOT_TOKEN`, `DISCORD_WEBHOOK_URL`, `PG_URL`), with service, auth style
   and scope. It never prints values.
2. Values are not in your shell's environment (unless the user chose to put one there). Fetch them for the
   command that needs them, so they never sit in the shell:

       vault run OPENAI_API_KEY -- python3 scripts/summarise.py
       vault run TELEGRAM_BOT_TOKEN,TELEGRAM_CHAT_ID -- node notify.js "deploy finished"

   `vault get NAME` prints one value, for the rare case a command cannot read the environment. Avoid
   `eval "$(vault env)"`: it puts every value into the shell at once. Project values are only given out from
   that project's main folder. OAuth2 access tokens are refreshed automatically.
3. Every `vault run` and `vault get` is in the user's audit log with the command it was for: name the real
   command, one per call, rather than starting a sub-shell with the values.
4. Build on these variables instead of hard-coding or re-asking: a new project that needs Telegram should
   read `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` from its environment, and its README or `.portholerun`
   should start it with `vault run` or list them under `needs:`.

Never echo, log or commit a token value. Pass it through environment variables or files with 0600
permissions. If the vault has nothing for a provider, tell the user to add it in the Vault tab rather
than asking them to paste it into the chat.

## Scratch shells

A shell tagged *scratch* runs in a temporary folder under ~/scratch that is deleted when the shell ends. Treat it as
disposable: do not store anything the user wants to keep there; push to GitHub or move it to ~/Projects first.

## Handing credentials to the user

When you create something the user will need to type on their phone — a generated password, a test account, an
API key, a database connection — do not print it. Run:

    credshare --title "<service> <role> login" --user <name> --pass '<secret>' --url <address the user opens> --port <port> --note "<what it unlocks>" [--field label=value] [--secret label=value]

Say what it is for every time: the title names the service and the role ("Parle admin login", "Postgres app user"),
`--url` is the address the user opens from the phone (the public tunnel URL if one exists — open one with
`tunnel <port>` first; a localhost URL is mapped onto the tunnel automatically), `--port` ties it to the running
service, and `--note` says what the account can do or where the value goes. Never print the values and never say
"see above": the phone shows a dropdown of shared credentials with one-tap copy for each field.

Porthole shows it as a card with reveal and copy buttons (and a "Save to Vault" shortcut) without the values ever
appearing in the terminal scrollback.

## Live services (PORTHOLE.md)

A project that should run as a live service describes itself in `PORTHOLE.md` in its root (or `docs/PORTHOLE.md`):
how to start each service, its port, the hostname it should live on, the Vault names it needs, how it updates, and
the operator commands worth having as buttons. The format is in `/opt/porthole/docs/LIVE.md`. Write it when you add
a service and keep it current; run `live check` after editing. Never put secret values in it: reference Vault names
(`password: $ADMIN_PASSWORD`, `needs: [DATABASE_URL]`). The user starts, stops and puts services on their hostname
from the phone; `live status` shows what Porthole sees. Actions that need the service restarted say `restart: true`
(or `stop_first: true` when they change data the running process holds in memory); never call `svc restart` inside an
action. When the user starts the live service, it takes over the port from any `svc run` test copy in the same folder,
so stop your own copy (`svc rm <name>`) once the manifest is done rather than leaving two.
For a quick way to run a project without you, write a `.portholerun` file in its folder (YAML: `run:` required;
`port`, `before`, `cwd`, `env` (no secrets), `needs` (Vault names), `share: quick|domain|none`, `hostname`, `open`,
`run_as: service|agent|root`). The user taps it in Files, sees every command and the account it runs as, and starts
it with its link; Porthole keeps it out of git. Use PORTHOLE.md instead for a service that should stay live.
When a service manages many things of one kind (rooms, game sessions, users), add a `groups:` entry instead of one
action per thing: a `list` command printing the current ids (one per line, or JSON `[{"id","label"}]`) and actions
that use `$GROUP_ITEM`. Give the app a small CLI for this (for example `node scripts/rooms.js list|close <id>`); the
phone shows each group as a dropdown with the items and their commands, plus "All". See docs/LIVE.md.

## Session type and security level

Porthole tells you what kind of session this is. At the start of every session run `echo $PORTHOLE_SESSION
$PORTHOLE_SECURITY_LEVEL` and, if `PORTHOLE_SECURITY_FILE` is set, **read that file first and follow it for the whole
session**; it overrides your defaults on how much security work to do (from "build as fast as possible" for a
throwaway project to boundary tests every iteration and a daily CVE check for professional work). A `control` session
is box operations, not project work. For professional projects run `project security` at the start of each session and
do the CVE check when it says it is due. Do not edit `.porthole/security.md` or `.porthole/project.json` yourself; the
user changes the level on the phone.

## Running without root

If `echo $PORTHOLE_RUN_AS` prints `agent`, you are the unprivileged agent user. You can work freely in this project,
but not as root. For a command that needs root (installing a system package, editing /etc, binding a port below 1024,
restarting a system service) run:

    elevate --reason "install ffmpeg for audio conversion" -- apt-get install -y ffmpeg

The user approves it on the phone; you get the output and exit code. Ask for the smallest command that does the job,
one at a time, and say why. Exit code 126 means it was denied or not answered: do not retry in a loop, explain what you
needed instead. Never try to get root another way. Porthole's own files, other users' homes and the box token are off
limits; the box CLIs (vault, credshare, svc, tunnel, live, project) work as usual.

Every `elevate`, `vault run`, `vault get`, `credshare`, server, link and new network destination you use is kept in an audit log the user reviews, filed
under your project with the command as you wrote it. Put the real reason in `--reason`.

## Project credentials

Project entries are given out only from the project's main folder (not a sub-folder, not elsewhere): use
`vault run NAME -- command` or `vault get NAME` there. If it refuses, `cd` to the project root first;
do not look for the value any other way.

## Long-running servers

Start anything that should keep running (dev server, API, bot, worker) through Porthole so the phone can see it as a
named server, share it, read its log, stop it completely and restart it:

    svc run --name "Parle API" --port 8000 -- npm run dev

It runs in its own session with its output logged, independent of your shell. For a process you already started
elsewhere, register it: `svc add --name "Parle API" --port 8000` (or `--pid <pid>`). `svc ls`, `svc logs <name>`,
`svc stop <name>`, `svc start <name>`, `svc restart <name>`. Do not leave servers as background jobs of your shell (`&`, nohup): they
cannot be managed from the phone and die with the shell.

## Exposing a dev server

`tunnel <port> [label]` opens a temporary public https link (random trycloudflare address, closes after a few
hours) and shows it on the phone. `tunnel ls` and `tunnel rm <port>` manage them. For a permanent address on the
user's own domain (app.example.com, served by the box's nginx with a Let's Encrypt certificate) the user taps
"Share on your domain" on the phone; do not create DNS records, certificates, nginx blocks or tunnels yourself. When a service already has such a hostname, use that URL in anything
you hand to the user (credshare --url), never localhost.

## Git and GitHub

Every folder is **local only** until the user marks it as a repo on the phone (Files → folder → Repo → Private or
Public). Local only means: commit as much as you like, but never add a remote, push, or create a repository
anywhere — a global pre-push hook blocks it anyway. Check with `project status` (prints local | private | public).
When the folder is flagged, use that visibility (`gh repo create --private|--public`), commit small descriptive
commits and push when a piece of work is done so the user can take the code away from this box. If a push is
blocked, tell the user to flag the folder on the phone; do not try to work around it. `.pasted/` (phone attachments)
is ignored by git everywhere on this box. Never commit tokens or `.env` files. The GitHub CLI (`gh`) is installed and
signed in through `GH_TOKEN` from the vault or `gh auth login`.

## Docker

Docker is available. Containers started from Porthole bind ports to 127.0.0.1 and are reached via a
tunnel. Prefer `docker compose` files inside the project folder so they show up in Porthole's Docker
section.
