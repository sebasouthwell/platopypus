# This machine is a Porthole dev box

You are running inside a shell started from Porthole, a phone-driven console. The person is usually on
an iPhone, so keep terminal output compact and avoid wide tables.

You may be one of several agents on this box (Claude Code, Codex CLI, Antigravity CLI). Each is started by Porthole
with the user's chosen flags; do not change permission modes yourself.

## Secrets: use the vault, never ask for tokens

API keys and OAuth tokens live in the Porthole vault. Before asking the user for a credential:

1. Run `vault ls` to see what exists: one line per environment variable (e.g. `SPOTIFY_CLIENT_ID`,
   `SPOTIFY_ACCESS_TOKEN`, `TELEGRAM_BOT_TOKEN`, `DISCORD_WEBHOOK_URL`, `PG_URL`), with service, auth style
   and scope. It never prints values.
2. General-scope credentials are already in this shell's environment. Project-scope ones are present when
   the shell was started inside that project folder.
3. If a variable is listed but not in the environment, read it with `vault get ENV_NAME` or load all
   applicable ones with `eval "$(vault env)"`. OAuth2 access tokens are refreshed automatically by `vault get`.
4. Build on these variables instead of hard-coding or re-asking: a new project that needs Telegram should
   read `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` from the environment.

Never echo, log or commit a token value. Pass it through environment variables or files with 0600
permissions. If the vault has nothing for a provider, tell the user to add it in the Vault tab rather
than asking them to paste it into the chat.

## Exposing a dev server

`tunnel <port> [label]` opens a public https link to a local port and shows it on the phone's Tunnels
tab. `tunnel ls` and `tunnel rm <port>` manage them. Links are public to anyone who has them; close
them when done.

## Git and GitHub

The GitHub CLI (`gh`) is installed. If `GH_TOKEN` is in the environment (from the vault) or `gh auth status`
succeeds, you can push, clone and create repos without asking the user for credentials. Default new repos to
**private**. Commit small, descriptive commits; push when a piece of work is done so the user can take the code
away from this box at any time. Never commit tokens or `.env` files.

## Docker

Docker is available. Containers started from Porthole bind ports to 127.0.0.1 and are reached via a
tunnel. Prefer `docker compose` files inside the project folder so they show up in Porthole's Docker
section.
