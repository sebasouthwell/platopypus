#!/usr/bin/env bash
# Porthole box installer for Ubuntu 24.04. Idempotent: safe to re-run for upgrades.
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

# On the EC2 box the first boot writes /etc/porthole.env; later re-runs (scripts/box.ps1 deploy) reuse it.
if [ -f /etc/porthole.env ]; then set -a; . /etc/porthole.env; set +a; fi

MODE="${MODE:-box}"
PORTHOLE_USER="${PORTHOLE_USER:-root}"      # root: shells, Docker and the Files tab cover the whole box
PORTHOLE_SRC="${PORTHOLE_SRC:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
PORTHOLE_DOMAIN="${PORTHOLE_DOMAIN:-}"
LE_EMAIL="${LE_EMAIL:-}"
APP_DIR=/opt/porthole
export DEBIAN_FRONTEND=noninteractive

say() { printf '\n\033[1;33m[porthole]\033[0m %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "run as root"; exit 1; }

# ---------- user ----------
if ! id "$PORTHOLE_USER" >/dev/null 2>&1; then
    useradd -m -s /bin/bash "$PORTHOLE_USER"
fi
HOME_DIR=$(getent passwd "$PORTHOLE_USER" | cut -d: -f6)
ARCH=$(dpkg --print-architecture)   # amd64 | arm64

# ---------- base packages ----------
say "base packages"
apt-get update -q
apt-get install -y -q --no-install-recommends \
    ca-certificates curl gnupg git tmux jq unzip zip ripgrep iproute2 procps less nano \
    build-essential python3 python3-pip python3-venv sudo locales openssl ncurses-term rsync
locale-gen en_GB.UTF-8 en_US.UTF-8 >/dev/null 2>&1 || true

# ---------- node 22 ----------
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -c2-3)" -lt 20 ]; then
    say "node 22"
    install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg --yes
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
    apt-get update -q && apt-get install -y -q nodejs
fi

# ---------- cloudflared ----------
if ! command -v cloudflared >/dev/null 2>&1; then
    say "cloudflared"
    install -d -m 0755 /usr/share/keyrings
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" > /etc/apt/sources.list.d/cloudflared.list
    apt-get update -q && apt-get install -y -q cloudflared
fi

# ---------- other agents: Codex CLI (OpenAI), Antigravity CLI (Google) ----------
if ! command -v codex >/dev/null 2>&1; then
    say "codex cli"
    npm install -g @openai/codex --no-audit --no-fund --loglevel=error || echo "codex install failed (retry on next run)"
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
    apt-get update -q && apt-get install -y -q gh
fi
# git defaults for the service user: main branch, gh as credential helper (uses GH_TOKEN from the vault or gh login)
sudo -u "$PORTHOLE_USER" -H bash -lc '
git config --global init.defaultBranch main
git config --global pull.ff only
git config --global --add safe.directory "*"
git config --global credential.helper "!gh auth git-credential"
' || true

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
        apt-get install -y -q docker.io docker-compose-v2
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
    apt-get install -y -q unattended-upgrades
    dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true
fi

# ---------- porthole app ----------
say "porthole app -> $APP_DIR"
install -d -o "$PORTHOLE_USER" -g "$PORTHOLE_USER" "$APP_DIR"
rsync -a --delete --exclude node_modules --exclude .git --exclude infra --exclude test \
    "$PORTHOLE_SRC"/ "$APP_DIR"/ 2>/dev/null || {
    apt-get install -y -q rsync
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
ln -sf "$APP_DIR/bin/credshare" /usr/local/bin/credshare
ln -sf "$APP_DIR/bin/credshare" /usr/local/bin/credentialshare

# Global Claude Code instructions: use the vault, the tunnel helper, keep output phone-sized.
install -d -o "$PORTHOLE_USER" -g "$PORTHOLE_USER" -m 0700 "$HOME_DIR/.claude"
GLOBAL_MD="$HOME_DIR/.claude/CLAUDE.md"
if ! grep -q 'Porthole dev box' "$GLOBAL_MD" 2>/dev/null; then
    { [ -s "$GLOBAL_MD" ] && printf '\n\n'; cat "$APP_DIR/deploy/CLAUDE.global.md"; } >> "$GLOBAL_MD"
    chown "$PORTHOLE_USER:$PORTHOLE_USER" "$GLOBAL_MD"
fi
sudo -u "$PORTHOLE_USER" -H bash -lc "cd $APP_DIR/server && npm install --omit=dev --no-audit --no-fund --loglevel=error"
sudo -u "$PORTHOLE_USER" -H bash -lc "cd $APP_DIR && node scripts/make-icons.mjs >/dev/null"

if [ "$MODE" = "box" ]; then
    # ---------- systemd ----------
    say "systemd service"
    cat > /etc/systemd/system/porthole.service <<EOF
[Unit]
Description=Porthole phone console
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$PORTHOLE_USER
WorkingDirectory=$APP_DIR/server
EnvironmentFile=-/etc/porthole.env
Environment=HOME=$HOME_DIR
Environment=PATH=$HOME_DIR/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=PORTHOLE_BIND=127.0.0.1
Environment=PORTHOLE_PORT=7331
Environment=PORTHOLE_ROOT=$([ "$PORTHOLE_USER" = root ] && echo / || echo "$HOME_DIR")
Environment=LANG=C.UTF-8
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=2
# Shells need a full environment, so no sandboxing beyond running unprivileged.
NoNewPrivileges=no

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable --now porthole
    systemctl restart porthole

    # ---------- nginx + let's encrypt ----------
    # nginx config is rendered by Porthole on every run (safe for updates); certbot only obtains/renews the
    # certificate (certonly), never edits config. With a certificate: redirect + 443 server; without: plain 80.
    if [ -n "$PORTHOLE_DOMAIN" ]; then
        [ -n "$LE_EMAIL" ] || { echo "LE_EMAIL is required with PORTHOLE_DOMAIN"; exit 1; }
        say "nginx for $PORTHOLE_DOMAIN"
        apt-get install -y -q nginx certbot python3-certbot-nginx
        rm -f /etc/nginx/sites-enabled/default
        install -d -m 0755 /var/www/html
        cp "$APP_DIR/deploy/nginx-snippets.conf" /etc/nginx/conf.d/porthole-snippets.conf
        cp "$APP_DIR/deploy/porthole-proxy.inc" /etc/nginx/conf.d/porthole-proxy.inc
        render_site() {
            local tpl="$1"
            sed -e "s/__DOMAIN__/$PORTHOLE_DOMAIN/g" "$APP_DIR/deploy/$tpl" > /etc/nginx/sites-available/porthole
            ln -sf /etc/nginx/sites-available/porthole /etc/nginx/sites-enabled/porthole
            nginx -t && systemctl enable --now nginx && systemctl reload nginx
        }
        CERT="/etc/letsencrypt/live/$PORTHOLE_DOMAIN/fullchain.pem"
        if [ -s "$CERT" ] && [ -s /etc/letsencrypt/options-ssl-nginx.conf ]; then
            render_site nginx-porthole-ssl.conf
        else
            render_site nginx-porthole.conf
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
            [ -s "$CERT" ] && render_site nginx-porthole-ssl.conf
        fi
        systemctl enable --now certbot.timer >/dev/null 2>&1 || true
    fi

    TOKEN_FILE="$HOME_DIR/.porthole/token"
    for i in 1 2 3 4 5; do [ -s "$TOKEN_FILE" ] && break; sleep 1; done
    say "done."
    echo "  login token:  $(cat "$TOKEN_FILE" 2>/dev/null || echo '(not yet written; see journalctl -u porthole)')"
    echo "  local URL:    http://127.0.0.1:7331"
    [ -n "$PORTHOLE_DOMAIN" ] && echo "  public URL:   https://$PORTHOLE_DOMAIN"
    echo "  tailscale:    sudo tailscale up --ssh --hostname=porthole   (then https://porthole.<tailnet>.ts.net via 'tailscale serve')"
fi
