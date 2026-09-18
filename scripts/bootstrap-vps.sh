#!/usr/bin/env bash
# Engångs-bootstrap på VPS:en. Körs som root:  bash bootstrap-vps.sh "<publik ssh-nyckel för deploy>"
# Idempotent – går bra att köra igen.
set -euo pipefail

PUBKEY="${1:-}"
APP_DIR="${APP_DIR:-/var/www/necom-data-mcp}"
HOSTNAME_MCP="${HOSTNAME_MCP:-mcp.necom.se}"
CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"

[ -n "$PUBKEY" ] || { echo "Ange deploy-användarens publika SSH-nyckel som första argument."; exit 1; }

echo "== Node"
if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "== PM2 + rsync"
command -v pm2 >/dev/null || npm install -g pm2
command -v rsync >/dev/null || apt-get install -y rsync

echo "== deploy-användare"
id deploy >/dev/null 2>&1 || adduser --disabled-password --gecos "" deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
grep -qF "$PUBKEY" /home/deploy/.ssh/authorized_keys 2>/dev/null || echo "$PUBKEY" >> /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys && chmod 600 /home/deploy/.ssh/authorized_keys

echo "== appkatalog"
install -d -o deploy -g deploy "$APP_DIR"

echo "== sudo för Caddy-reload"
cat > /etc/sudoers.d/deploy <<EOF
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl reload caddy
EOF
chmod 440 /etc/sudoers.d/deploy

echo "== Caddy-block"
if ! grep -q "^$HOSTNAME_MCP" "$CADDYFILE"; then
  cat >> "$CADDYFILE" <<EOF

$HOSTNAME_MCP {
	encode gzip
	reverse_proxy 127.0.0.1:3010 {
		flush_interval -1
		transport http {
			read_timeout 600s
		}
	}
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		Referrer-Policy no-referrer
	}
}
EOF
  caddy validate --config "$CADDYFILE" && systemctl reload caddy
  echo "Caddy-block tillagt och laddat."
else
  echo "Caddy-block finns redan."
fi

echo "== PM2 som deploy-användare vid boot"
su - deploy -c "pm2 startup systemd -u deploy --hp /home/deploy" >/dev/null 2>&1 || true
env PATH=$PATH:/usr/bin pm2 startup systemd -u deploy --hp /home/deploy >/dev/null 2>&1 || true

echo
echo "Klart. Nästa steg: lägg secrets i GitHub (VPS_HOST, VPS_USER=deploy, VPS_SSH_KEY, ENV_FILE, GA4_SERVICE_ACCOUNT_JSON) och pusha till main."
echo "DNS: A-post $HOSTNAME_MCP -> $(curl -fsS https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
