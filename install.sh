#!/usr/bin/env bash
# PlatOpypus box installer for Ubuntu 24.04. Idempotent: safe to re-run for upgrades.
#
# Usage (as root):
#   PORTHOLE_SRC=/path/to/porthole ./install.sh                      # full box: tools, Tailscale, nginx, systemd
#   PORTHOLE_DOMAIN=box.example.com LE_EMAIL=me@example.com ./install.sh
#   MODE=docker ./install.sh                                          # container image: tools + app only
#
# Env:
#   PORTHOLE_USER    user the service and shells run as (default: root; set ubuntu for a confined install)
#   PORTHOLE_SRC     directory containing server/ web/ bin/ (default: directory of this script)
#   PORTHOLE_DOMAIN  public hostname for nginx + Let's Encrypt (empty = no nginx)
#   LE_EMAIL         Let's Encrypt contact e-mail (required with PORTHOLE_DOMAIN)
#   MODE             "box" (default) or "docker"

set -euo pipefail
# Never run from inside a folder this script may move (2.0 moves /opt/porthole): a vanished cwd breaks rsync.
cd /
# Callers (containers, a service with a short PATH) may lack sbin, where useradd/groupadd/iptables live.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin${PATH:+:$PATH}"

# On the EC2 box the first boot writes the env file; later re-runs (scripts/box.ps1 deploy, the updater) reuse it.
# 2.0: the file is /etc/platopypus.env (PLATO_*); /etc/porthole.env (PORTHOLE_*) is still read and copied over once.
for envf in /etc/porthole.env /etc/platopypus.env; do [ -f "$envf" ] && { set -a; . "$envf"; set +a; chmod 600 "$envf"; }; done   # root only: app accounts must not read box settings
if [ -f /etc/porthole.env ] && [ ! -f /etc/platopypus.env ]; then sed -e 's/^PORTHOLE_/PLATO_/' /etc/porthole.env > /etc/platopypus.env; chmod 600 /etc/platopypus.env; fi
# Either spelling of a setting wins the same way everywhere: PLATO_* first, then PORTHOLE_*.
export PLATO_ALIAS_DOMAINS PLATO_REDIRECT_DOMAINS 2>/dev/null || true
PORTHOLE_USER="${PLATO_USER:-${PORTHOLE_USER:-}}"; PORTHOLE_SRC="${PLATO_SRC:-${PORTHOLE_SRC:-}}"; PORTHOLE_DOMAIN="${PLATO_DOMAIN:-${PORTHOLE_DOMAIN:-}}"; PORTHOLE_AGENT_USER="${PLATO_AGENT_USER:-${PORTHOLE_AGENT_USER:-}}"

# Default: a box when systemd runs this machine, otherwise a container (the self-updater re-runs this script without MODE).
if [ -z "${MODE:-}" ]; then if [ -d /run/systemd/system ]; then MODE=box; else MODE=docker; fi; fi
PORTHOLE_USER="${PORTHOLE_USER:-root}"      # root: shells, Docker and the Files tab cover the whole box
PORTHOLE_SRC="${PORTHOLE_SRC:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
PORTHOLE_DOMAIN="${PORTHOLE_DOMAIN:-}"
LE_EMAIL="${LE_EMAIL:-}"
APP_DIR=/opt/platopypus
export DEBIAN_FRONTEND=noninteractive

say() { printf '\n\033[1;33m[platopypus]\033[0m %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "run as root"; exit 1; }

# ---------- user ----------
if ! id "$PORTHOLE_USER" >/dev/null 2>&1; then
    useradd -m -s /bin/bash "$PORTHOLE_USER"
fi
HOME_DIR=$(getent passwd "$PORTHOLE_USER" | cut -d: -f6)
ARCH=$(dpkg --print-architecture)   # amd64 | arm64

# ---------- base packages ----------
say "base packages"
apt-get -o DPkg::Lock::Timeout=600 update -q
apt-get -o DPkg::Lock::Timeout=600 install -y -q --no-install-recommends \
    ca-certificates curl gnupg git tmux jq unzip zip ripgrep iproute2 procps less nano \
    build-essential python3 python3-pip python3-venv sudo locales openssl ncurses-term rsync acl iptables zstd
locale-gen en_GB.UTF-8 en_US.UTF-8 >/dev/null 2>&1 || true

# ---------- node 22 ----------
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -c2-3)" -lt 20 ]; then
    say "node 22"
    install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg --yes
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
    apt-get -o DPkg::Lock::Timeout=600 update -q && apt-get -o DPkg::Lock::Timeout=600 install -y -q nodejs
fi

# ---------- cloudflared ----------
if ! command -v cloudflared >/dev/null 2>&1; then
    say "cloudflared"
    install -d -m 0755 /usr/share/keyrings
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" > /etc/apt/sources.list.d/cloudflared.list
    apt-get -o DPkg::Lock::Timeout=600 update -q && apt-get -o DPkg::Lock::Timeout=600 install -y -q cloudflared
fi

# ---------- other agents: Codex CLI (OpenAI), Antigravity CLI (Google) ----------
if ! command -v codex >/dev/null 2>&1; then
    say "codex cli"
    npm install -g @openai/codex --no-audit --no-fund --loglevel=error || echo "codex install failed (retry on next run)"
fi
if ! command -v cline >/dev/null 2>&1; then   # the fourth agent; it runs on an Ollama server chosen in the app
    say "cline cli"
    npm install -g cline --no-audit --no-fund --loglevel=error || echo "cline install failed (retry on next run)"
fi
if ! sudo -u "$PORTHOLE_USER" -H bash -lc 'command -v agy' >/dev/null 2>&1; then
    say "antigravity cli"
    sudo -u "$PORTHOLE_USER" -H bash -lc 'curl -fsSL https://antigravity.google/cli/install.sh | bash' || echo "antigravity install failed (retry on next run)"
fi

# ---------- code-server (VS Code in the browser; installed, never started unless asked) ----------
if ! command -v code-server >/dev/null 2>&1; then
    say "code-server"
    curl -fsSL https://code-server.dev/install.sh | sh -s -- --method standalone --prefix /usr/local >/dev/null 2>&1 \
        || curl -fsSL https://code-server.dev/install.sh | sh >/dev/null 2>&1 \
        || echo "code-server install failed (retry on next run)"
fi

# ---------- github cli ----------
if ! command -v gh >/dev/null 2>&1; then
    say "github cli"
    install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
    echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
    apt-get -o DPkg::Lock::Timeout=600 update -q && apt-get -o DPkg::Lock::Timeout=600 install -y -q gh
fi
# git defaults for the service user: main branch, gh as credential helper (uses GH_TOKEN from the vault or gh login)
sudo -u "$PORTHOLE_USER" -H bash -lc '
git config --global init.defaultBranch main
git config --global pull.ff only
git config --global --add safe.directory "*"
git config --global credential.helper "!gh auth git-credential"
' || true

# One projects folder. With the files root at / that is /Projects; keep ~/Projects as a link to it (1.9.1 merged the two).
if [ "$PORTHOLE_USER" = root ]; then   # files root is / for a root install (see the systemd unit)
    install -d -m 0755 /Projects
    if [ ! -e "$HOME_DIR/Projects" ]; then ln -s /Projects "$HOME_DIR/Projects"
    elif [ -d "$HOME_DIR/Projects" ] && [ ! -L "$HOME_DIR/Projects" ] && [ -z "$(ls -A "$HOME_DIR/Projects")" ]; then rmdir "$HOME_DIR/Projects" && ln -s /Projects "$HOME_DIR/Projects"
    elif [ -d "$HOME_DIR/Projects" ] && [ ! -L "$HOME_DIR/Projects" ]; then echo "note: $HOME_DIR/Projects and /Projects both hold projects; merge them (PlatOpypus lists /Projects)"; fi
fi

# ---------- agent user (docs/AGENT-USER.md stage 1): AI agents can run without root ----------
AGENT_USER="${PORTHOLE_AGENT_USER:-agent}"
getent group porthole-dev >/dev/null || groupadd --system porthole-dev
id "$AGENT_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash --user-group "$AGENT_USER"
usermod -aG porthole-dev "$AGENT_USER"; usermod -aG porthole-dev "$PORTHOLE_USER" 2>/dev/null || true
passwd -l "$AGENT_USER" >/dev/null 2>&1 || true
# Live services run as one account per project (ps-<project>, primary group porthole-svcs), created by PlatOpypus on
# first start with an ACL on that project only (server/lib/svcuser.js). The 1.14.0 shared account loses its access.
getent group porthole-svcs >/dev/null || groupadd --system porthole-svcs
install -d -m 0755 /var/lib/porthole-svc
id porthole-svc >/dev/null 2>&1 && gpasswd -d porthole-svc porthole-dev >/dev/null 2>&1 || true
AGENT_HOME="$(getent passwd "$AGENT_USER" | cut -d: -f6)"
if ! sudo -u "$AGENT_USER" -H bash -lc 'test -x ~/.local/bin/claude' >/dev/null 2>&1; then
    say "claude code for the agent user"
    sudo -u "$AGENT_USER" -H bash -lc 'curl -fsSL https://claude.ai/install.sh | bash' || echo "claude install for $AGENT_USER failed (retry on next run)"
fi
if ! sudo -u "$AGENT_USER" -H bash -lc 'command -v agy' >/dev/null 2>&1; then
    sudo -u "$AGENT_USER" -H bash -lc 'curl -fsSL https://antigravity.google/cli/install.sh | bash' || echo "antigravity install for $AGENT_USER failed (retry on next run)"
fi
sudo -u "$AGENT_USER" -H bash -lc 'git config --global init.defaultBranch main; git config --global pull.ff only; git config --global --add safe.directory "*"' || true

# ---------- claude code (native installer, per user) ----------
if ! sudo -u "$PORTHOLE_USER" -H bash -lc 'command -v claude || test -x ~/.local/bin/claude' >/dev/null 2>&1; then
    say "claude code"
    sudo -u "$PORTHOLE_USER" -H bash -lc 'curl -fsSL https://claude.ai/install.sh | bash' || echo "claude install failed (will retry on next run)"
fi

# ---------- docker CLI only (container test image talks to the host daemon through a mounted socket) ----------
if [ "$MODE" = "docker" ] && ! command -v docker >/dev/null 2>&1; then
    say "docker cli (static)"
    case "$ARCH" in arm64) DA=aarch64;; *) DA=x86_64;; esac
    DV=$(curl -fsSL https://download.docker.com/linux/static/stable/${DA}/ | grep -o 'docker-2[0-9]\.[0-9]*\.[0-9]*\.tgz' | sort -V | tail -1)
    curl -fsSL "https://download.docker.com/linux/static/stable/${DA}/${DV}" | tar -xz -C /tmp
    install -m 0755 /tmp/docker/docker /usr/local/bin/docker && rm -rf /tmp/docker
fi

# ---------- shell history that is actually useful from a phone ----------
BASHRC="$HOME_DIR/.bashrc"
if ! grep -q 'porthole history' "$BASHRC" 2>/dev/null; then
    say "bash history settings"
    cat >> "$BASHRC" <<'EOF'

# porthole history: append after every command so other shells and the phone see it
shopt -s histappend
export HISTSIZE=50000 HISTFILESIZE=100000 HISTCONTROL=ignoredups:erasedups
export PROMPT_COMMAND="history -a; ${PROMPT_COMMAND:-}"
export PATH="$HOME/.local/bin:$PATH"
EOF
    chown "$PORTHOLE_USER:$PORTHOLE_USER" "$BASHRC"
fi

if [ "$MODE" = "box" ]; then
    # ---------- docker ----------
    if ! command -v docker >/dev/null 2>&1; then
        say "docker"
        apt-get -o DPkg::Lock::Timeout=600 install -y -q docker.io docker-compose-v2
        systemctl enable --now docker
    fi
    [ "$PORTHOLE_USER" = root ] || usermod -aG docker "$PORTHOLE_USER"

    # ---------- aws cli v2 ----------
    if ! command -v aws >/dev/null 2>&1; then
        say "aws cli"
        case "$ARCH" in arm64) A=aarch64;; *) A=x86_64;; esac
        curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${A}.zip" -o /tmp/awscli.zip
        (cd /tmp && unzip -q -o awscli.zip && ./aws/install --update >/dev/null && rm -rf aws awscli.zip)
    fi

    # ---------- tailscale ----------
    if ! command -v tailscale >/dev/null 2>&1; then
        say "tailscale"
        curl -fsSL https://tailscale.com/install.sh | sh
    fi

    # ---------- unattended security updates ----------
    apt-get -o DPkg::Lock::Timeout=600 install -y -q unattended-upgrades
    dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true
fi

# ---------- 2.0 rename: the old folders move, links stay at the old paths (running processes, old scripts, rollbacks) ----------
move_with_link() {   # old new
    if [ -d "$1" ] && [ ! -L "$1" ] && [ ! -e "$2" ]; then mv -T "$1" "$2" && ln -s "$2" "$1" && say "moved $1 -> $2 (link left behind)"; fi
    [ -e "$1" ] || { [ -e "$2" ] && ln -s "$2" "$1"; } || true
}
move_with_link /opt/porthole /opt/platopypus
move_with_link /opt/porthole-src /opt/platopypus-src
move_with_link "$HOME_DIR/.porthole" "$HOME_DIR/.platopypus"
STATE_DIR="$HOME_DIR/.platopypus"
install -d -o "$PORTHOLE_USER" -g "$PORTHOLE_USER" -m 0700 "$STATE_DIR"
[ -e "$HOME_DIR/.porthole" ] || ln -s "$STATE_DIR" "$HOME_DIR/.porthole"

# ---------- platopypus app ----------
say "platopypus app -> $APP_DIR"
install -d -o "$PORTHOLE_USER" -g "$PORTHOLE_USER" "$APP_DIR"
rsync -a --delete --exclude node_modules --exclude .git --exclude infra --exclude test \
    "$PORTHOLE_SRC"/ "$APP_DIR"/ 2>/dev/null || {
    apt-get -o DPkg::Lock::Timeout=600 install -y -q rsync
    rsync -a --delete --exclude node_modules --exclude .git --exclude infra --exclude test "$PORTHOLE_SRC"/ "$APP_DIR"/
}
chown -R "$PORTHOLE_USER:$PORTHOLE_USER" "$APP_DIR"
chmod +x "$APP_DIR/bin/"* "$APP_DIR/install.sh" 2>/dev/null || true
# Record what is installed (commit + time) so the self-updater can compare against the public repo.
{ git -C "$PORTHOLE_SRC" rev-parse --short HEAD 2>/dev/null || echo bundle; echo " $(date +%s)"; } | tr -d '\n' > "$APP_DIR/VERSION"; echo >> "$APP_DIR/VERSION"
chown "$PORTHOLE_USER:$PORTHOLE_USER" "$APP_DIR/VERSION"
ln -sf "$APP_DIR/bin/tunnel" /usr/local/bin/tunnel
ln -sf "$APP_DIR/bin/vault" /usr/local/bin/vault
ln -sf "$APP_DIR/bin/porthole" /usr/local/bin/porthole
ln -sf "$APP_DIR/bin/porthole" /usr/local/bin/plato
ln -sf "$APP_DIR/bin/plato-update" /usr/local/bin/plato-update
ln -sf "$APP_DIR/bin/credshare" /usr/local/bin/credshare
ln -sf "$APP_DIR/bin/credshare" /usr/local/bin/credentialshare
ln -sf "$APP_DIR/bin/svc" /usr/local/bin/svc
ln -sf "$APP_DIR/bin/project" /usr/local/bin/project
ln -sf "$APP_DIR/bin/live" /usr/local/bin/live
ln -sf "$APP_DIR/bin/research" /usr/local/bin/research
ln -sf "$APP_DIR/bin/lab" /usr/local/bin/lab
ln -sf "$APP_DIR/bin/consult" /usr/local/bin/consult
ln -sf "$APP_DIR/bin/elevate" /usr/local/bin/elevate
# Publishing gate: a global pre-push hook asks PlatOpypus whether the folder is flagged as a repo; .pasted/ never enters git.
install -d -o "$PORTHOLE_USER" -g "$PORTHOLE_USER" -m 0755 "$STATE_DIR/githooks"
install -o "$PORTHOLE_USER" -g "$PORTHOLE_USER" -m 0755 "$APP_DIR/deploy/githooks/pre-push" "$STATE_DIR/githooks/pre-push"
install -o "$PORTHOLE_USER" -g "$PORTHOLE_USER" -m 0644 "$APP_DIR/deploy/gitignore_global" "$STATE_DIR/gitignore_global"
sudo -u "$PORTHOLE_USER" -H bash -lc "git config --global core.hooksPath '$STATE_DIR/githooks'; git config --global core.excludesFile '$STATE_DIR/gitignore_global'" || true

# Global agent instructions (vault, credshare, tunnels, git, phone-sized output). The same text goes into every
# agent's own global file. The block between the platopypus markers is replaced on every run; anything the user wrote
# outside it is kept. 1.x used porthole markers (replaced the same way); installs before 1.2.3 appended the block
# without markers, and it ran to the end of the file.
install_agent_md() {
    local dir="$1" file="$2" src="$APP_DIR/deploy/AGENT.global.md" tmp
    install -d -o "$PORTHOLE_USER" -g "$PORTHOLE_USER" -m 0700 "$dir"
    tmp="$(mktemp)"
    {
        if [ -f "$file" ]; then
            if grep -q '<!-- platopypus:begin -->' "$file"; then
                awk '/<!-- platopypus:begin -->/{skip=1} !skip{print} /<!-- platopypus:end -->/{skip=0}' "$file"
            elif grep -q '<!-- porthole:begin -->' "$file"; then
                awk '/<!-- porthole:begin -->/{skip=1} !skip{print} /<!-- porthole:end -->/{skip=0}' "$file"
            elif grep -q '^# This machine is a PlatOpypus dev box' "$file"; then
                awk '/^# This machine is a PlatOpypus dev box/{exit} {print}' "$file"
            else
                cat "$file"; printf '\n'
            fi
        fi
        printf '<!-- platopypus:begin -->\n'; cat "$src"; printf '\n<!-- platopypus:end -->\n'
    } > "$tmp"
    install -o "$PORTHOLE_USER" -g "$PORTHOLE_USER" -m 0600 "$tmp" "$file"; rm -f "$tmp"
}
install_agent_md "$HOME_DIR/.claude" "$HOME_DIR/.claude/CLAUDE.md"   # Claude Code
install_agent_md "$HOME_DIR/.codex"  "$HOME_DIR/.codex/AGENTS.md"    # Codex CLI
install_agent_md "$HOME_DIR/.gemini" "$HOME_DIR/.gemini/GEMINI.md"   # Antigravity CLI (Gemini CLI lineage)
install_agent_md "$HOME_DIR/.agents" "$HOME_DIR/.agents/AGENTS.md"   # Cline (global instructions)
for d in "$HOME_DIR"/.agent-profiles/claude/*/; do [ -d "$d" ] && install_agent_md "$d" "${d}CLAUDE.md"; done   # Claude profiles
if [ -n "${AGENT_HOME:-}" ]; then   # the same instructions for agents running as the agent user
    PORTHOLE_USER_SAVED="$PORTHOLE_USER"; PORTHOLE_USER="$AGENT_USER"
    install_agent_md "$AGENT_HOME/.claude" "$AGENT_HOME/.claude/CLAUDE.md"
    install_agent_md "$AGENT_HOME/.codex"  "$AGENT_HOME/.codex/AGENTS.md"
    install_agent_md "$AGENT_HOME/.gemini" "$AGENT_HOME/.gemini/GEMINI.md"
    install_agent_md "$AGENT_HOME/.agents" "$AGENT_HOME/.agents/AGENTS.md"
    PORTHOLE_USER="$PORTHOLE_USER_SAVED"
    # the global pre-push hook and .pasted ignore apply to the agent user too
    # (the root copies under ~/.platopypus are unreadable to this user, and git silently skips an unreadable hooks path)
    chmod 0755 "$APP_DIR/deploy/githooks/pre-push"; chmod 0644 "$APP_DIR/deploy/gitignore_global"
    sudo -u "$AGENT_USER" -H bash -lc "git config --global core.hooksPath '$APP_DIR/deploy/githooks'; git config --global core.excludesFile '$APP_DIR/deploy/gitignore_global'" 2>/dev/null || true
fi
sudo -u "$PORTHOLE_USER" -H bash -lc "cd $APP_DIR/server && npm install --omit=dev --no-audit --no-fund --loglevel=error"

if [ "$MODE" = "box" ]; then
    # ---------- systemd ----------
    say "systemd service"
    cat > /etc/systemd/system/platopypus.service <<EOF
[Unit]
Description=PlatOpypus phone console
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$PORTHOLE_USER
WorkingDirectory=$APP_DIR/server
EnvironmentFile=-/etc/porthole.env
EnvironmentFile=-/etc/platopypus.env
Environment=HOME=$HOME_DIR
Environment=PATH=$HOME_DIR/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=PLATO_BIND=127.0.0.1
Environment=PLATO_PORT=7331
Environment=PLATO_ROOT=$([ "$PORTHOLE_USER" = root ] && echo / || echo "$HOME_DIR")
Environment=LANG=C.UTF-8
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=2
# Stop/restart ends only PlatOpypus's own process: the tmux server (every shell, server, live service and tunnel) lives
# in this cgroup too and must survive updates. PlatOpypus re-attaches to it on start.
KillMode=process
# Shells need a full environment, so no sandboxing beyond running unprivileged.
NoNewPrivileges=no
# The phone must stay responsive whatever the agents do: PlatOpypus goes first for CPU and disk, keeps 256 MB of its
# memory out of reclaim, and is the last thing the OOM killer picks. Shells, servers and tunnels run in their own
# scope (see server/lib/tmux.js) at normal priority, so this covers PlatOpypus's own process only.
Nice=-10
CPUWeight=1000
IOWeight=1000
MemoryLow=256M
OOMScoreAdjust=-900

[Install]
WantedBy=multi-user.target
EOF
    # Memory protection only counts when the parent slice carries it too; nginx (the only way in) gets a share.
    mkdir -p /etc/systemd/system/system.slice.d /etc/systemd/system/nginx.service.d
    printf '[Slice]\nMemoryLow=384M\n' > /etc/systemd/system/system.slice.d/platopypus.conf
    printf '[Service]\nNice=-5\nCPUWeight=500\nIOWeight=500\nMemoryLow=64M\nOOMScoreAdjust=-500\n' > /etc/systemd/system/nginx.service.d/platopypus.conf
    rm -f /etc/systemd/system/system.slice.d/porthole.conf /etc/systemd/system/nginx.service.d/porthole.conf
    systemctl daemon-reload
    # 2.0: the unit is platopypus.service. The 1.x unit file stays on disk (disabled) so a rollback to 1.x can start it.
    if systemctl is-enabled --quiet porthole 2>/dev/null; then systemctl disable porthole >/dev/null 2>&1 || true; fi
    systemctl enable platopypus >/dev/null 2>&1 || true
    if systemctl is-active --quiet porthole 2>/dev/null; then systemctl stop porthole; fi   # KillMode=process: shells and services stay up
    systemctl restart platopypus
    systemctl try-restart nginx 2>/dev/null || true

    # ---------- nginx + let's encrypt ----------
    # nginx config is rendered by PlatOpypus on every run (safe for updates); certbot only obtains/renews the
    # certificate (certonly), never edits config. With a certificate: redirect + 443 server; without: plain 80.
    if [ -n "$PORTHOLE_DOMAIN" ]; then
        [ -n "$LE_EMAIL" ] || { echo "LE_EMAIL is required with PORTHOLE_DOMAIN"; exit 1; }
        say "nginx for $PORTHOLE_DOMAIN"
        apt-get -o DPkg::Lock::Timeout=600 install -y -q nginx certbot python3-certbot-nginx
        rm -f /etc/nginx/sites-enabled/default
        install -d -m 0755 /var/www/html
        cp "$APP_DIR/deploy/nginx-snippets.conf" /etc/nginx/conf.d/platopypus-snippets.conf
        cp "$APP_DIR/deploy/platopypus-proxy.inc" /etc/nginx/conf.d/platopypus-proxy.inc
        # 1.x file names go (the zones and the include they defined are now in the platopypus-* files).
        rm -f /etc/nginx/conf.d/porthole-snippets.conf /etc/nginx/conf.d/porthole-proxy.inc /etc/nginx/sites-enabled/porthole /etc/nginx/sites-available/porthole
        for f in /etc/nginx/sites-available/porthole-zoned-*; do   # hostnames on your domain made by 1.x
            [ -e "$f" ] || continue; slug="${f##*/porthole-zoned-}"
            mv -f "$f" "/etc/nginx/sites-available/platopypus-zoned-$slug"; rm -f "/etc/nginx/sites-enabled/porthole-zoned-$slug"
            ln -sf "/etc/nginx/sites-available/platopypus-zoned-$slug" "/etc/nginx/sites-enabled/platopypus-zoned-$slug"
        done
        render_site() {
            local tpl="$1"
            sed -e "s/__DOMAIN__/$PORTHOLE_DOMAIN/g" "$APP_DIR/deploy/$tpl" > /etc/nginx/sites-available/platopypus
            ln -sf /etc/nginx/sites-available/platopypus /etc/nginx/sites-enabled/platopypus
            nginx -t && systemctl enable --now nginx && systemctl reload nginx
        }
        CERT="/etc/letsencrypt/live/$PORTHOLE_DOMAIN/fullchain.pem"
        if [ -s "$CERT" ] && [ -s /etc/letsencrypt/options-ssl-nginx.conf ]; then
            render_site nginx-platopypus-ssl.conf
        else
            render_site nginx-platopypus.conf
            say "let's encrypt certificate (retries until DNS resolves here)"
            for i in $(seq 1 30); do
                if certbot certonly --webroot -w /var/www/html --non-interactive --agree-tos --no-eff-email -m "$LE_EMAIL"                     -d "$PORTHOLE_DOMAIN" --deploy-hook "systemctl reload nginx"; then
                    break
                fi
                echo "certbot attempt $i failed; waiting 30s"; sleep 30
            done
            # certbot ships these two files with the nginx plugin; make sure they exist for the ssl template.
            [ -s /etc/letsencrypt/options-ssl-nginx.conf ] || cp /usr/lib/python3/dist-packages/certbot_nginx/_internal/tls_configs/options-ssl-nginx.conf /etc/letsencrypt/options-ssl-nginx.conf 2>/dev/null || true
            [ -s /etc/letsencrypt/ssl-dhparams.pem ] || cp /usr/lib/python3/dist-packages/certbot/ssl-dhparams.pem /etc/letsencrypt/ssl-dhparams.pem 2>/dev/null || true
            [ -s "$CERT" ] && render_site nginx-platopypus-ssl.conf
        fi
        # Other names for the same app (2.0.1). PLATO_ALIAS_DOMAINS: served there too, with their own certificates.
        # PLATO_REDIRECT_DOMAINS: sent to the primary name with a 301 (the name you moved away from). Comma separated.
        # Moving to a new address: add it as an alias, check it, then make it PLATO_DOMAIN and the old one a redirect.
        ALIASES="$(printf '%s' "${PLATO_ALIAS_DOMAINS:-}" | tr ',' ' ')"; REDIRECTS="$(printf '%s' "${PLATO_REDIRECT_DOMAINS:-}" | tr ',' ' ')"
        cert_for() {   # domain: try to get a certificate (HTTP-01 through the shared webroot); 0 when one exists afterwards
            local d="$1" c="/etc/letsencrypt/live/$1/fullchain.pem" i
            [ -s "$c" ] && return 0
            # Two tries only: every failed attempt counts against Let's Encrypt's limit of 5 failures per name per hour.
            for i in 1 2; do
                certbot certonly --webroot -w /var/www/html --non-interactive --agree-tos --no-eff-email -m "$LE_EMAIL" -d "$d" --deploy-hook "systemctl reload nginx" >/dev/null 2>&1 && break
                sleep 20
            done
            [ -s "$c" ]
        }
        for f in /etc/nginx/sites-available/platopypus-alias-* /etc/nginx/sites-available/platopypus-redirect-*; do   # names no longer listed go
            [ -e "$f" ] || continue; n="${f##*/platopypus-}"; d="${n#alias-}"; d="${d#redirect-}"
            case " $ALIASES $REDIRECTS " in *" $d "*) ;; *) rm -f "$f" "/etc/nginx/sites-enabled/${f##*/}" ;; esac
        done
        for d in $ALIASES; do
            [ "$d" = "$PORTHOLE_DOMAIN" ] && continue
            say "alias $d"
            AF="/etc/nginx/sites-available/platopypus-alias-$d"
            if [ ! -s "/etc/letsencrypt/live/$d/fullchain.pem" ]; then
                # No certificate yet: answer only the certificate check on port 80 (the app is never served over plain http).
                printf 'server {
    listen 80;
    listen [::]:80;
    server_name %s;
    location ^~ /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 404; }
}
' "$d" > "$AF"
                ln -sf "$AF" "/etc/nginx/sites-enabled/platopypus-alias-$d"
                nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
            fi
            if cert_for "$d"; then
                sed -e "s/__DOMAIN__/$d/g" "$APP_DIR/deploy/nginx-platopypus-ssl.conf" > "$AF"
                ln -sf "$AF" "/etc/nginx/sites-enabled/platopypus-alias-$d"
            else
                echo "no certificate for $d yet (is its DNS record in place and pointing at this box?); it will be tried again at the next update"
            fi
        done
        for d in $REDIRECTS; do
            [ "$d" = "$PORTHOLE_DOMAIN" ] && continue
            say "redirect $d -> $PORTHOLE_DOMAIN"
            {
                printf 'server {\n    listen 80;\n    listen [::]:80;\n    server_name %s;\n    location ^~ /.well-known/acme-challenge/ { root /var/www/html; }\n    location / { return 301 https://%s$request_uri; }\n}\n' "$d" "$PORTHOLE_DOMAIN"
                if [ -s "/etc/letsencrypt/live/$d/fullchain.pem" ]; then
                    printf 'server {\n    listen 443 ssl http2;\n    listen [::]:443 ssl http2;\n    server_name %s;\n    ssl_certificate /etc/letsencrypt/live/%s/fullchain.pem;\n    ssl_certificate_key /etc/letsencrypt/live/%s/privkey.pem;\n    include /etc/letsencrypt/options-ssl-nginx.conf;\n    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;\n    return 301 https://%s$request_uri;\n}\n' "$d" "$d" "$d" "$PORTHOLE_DOMAIN"
                fi
            } > "/etc/nginx/sites-available/platopypus-redirect-$d"
            ln -sf "/etc/nginx/sites-available/platopypus-redirect-$d" "/etc/nginx/sites-enabled/platopypus-redirect-$d"
        done
        # A bad alias/redirect file must never take the main site down: drop them and keep going.
        if nginx -t >/dev/null 2>&1; then systemctl reload nginx; else echo "nginx rejected the alias/redirect files; removing them"; rm -f /etc/nginx/sites-*/platopypus-alias-* /etc/nginx/sites-*/platopypus-redirect-*; nginx -t && systemctl reload nginx; fi
        systemctl enable --now certbot.timer >/dev/null 2>&1 || true
    fi

    TOKEN_FILE="$STATE_DIR/token"
    for i in 1 2 3 4 5; do [ -s "$TOKEN_FILE" ] && break; sleep 1; done
    say "done."
    echo "  login token:  $(cat "$TOKEN_FILE" 2>/dev/null || echo '(not yet written; see journalctl -u platopypus)')"
    echo "  local URL:    http://127.0.0.1:7331"
    [ -n "$PORTHOLE_DOMAIN" ] && echo "  public URL:   https://$PORTHOLE_DOMAIN"
    echo "  tailscale:    sudo tailscale up --ssh --hostname=platopypus   (then https://platopypus.<tailnet>.ts.net via 'tailscale serve')"
fi
