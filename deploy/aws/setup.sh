#!/usr/bin/env bash
# Sets up Hisaab Bridge on Ubuntu 24.04 or newer (EC2). Safe to run again.
# Usage: sudo bash setup.sh <git-ref> [domain]
#   git-ref  branch, tag or commit of https://github.com/ajnasa2285/hisaab-bridge
#   domain   optional; default is <public-ip-with-dashes>.sslip.io
set -euo pipefail

REPO_URL="https://github.com/ajnasa2285/hisaab-bridge"
APP_DIR="/opt/hisaab-bridge"
DATA_DIR="/var/lib/hisaab"
ENV_DIR="/etc/hisaab"
ENV_FILE="$ENV_DIR/hisaab.env"

if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo: sudo bash $0 <git-ref> [domain]" >&2; exit 1; fi
REF="${1:-}"
if [ -z "$REF" ]; then echo "Usage: sudo bash $0 <git-ref> [domain]" >&2; exit 1; fi
DOMAIN="${2:-}"
export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get install -y ca-certificates curl gnupg git ffmpeg debian-keyring debian-archive-keyring apt-transport-https

# Node 24 (NodeSource)
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi

# Caddy (official apt repository)
if ! command -v caddy >/dev/null; then
  install -d -m 0755 /usr/share/keyrings
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

# Service user and folders
id hisaab >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin hisaab
install -d -m 0700 -o hisaab -g hisaab "$DATA_DIR"
chown hisaab:hisaab "$DATA_DIR"
chmod 700 "$DATA_DIR"
install -d -m 0755 "$ENV_DIR"

# Code at the requested ref
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --tags --prune origin
else
  rm -rf "$APP_DIR"
  git clone "$REPO_URL" "$APP_DIR"
fi
if git -C "$APP_DIR" rev-parse -q --verify "refs/remotes/origin/$REF" >/dev/null; then
  git -C "$APP_DIR" checkout --force -B "$REF" "origin/$REF"
else
  git -C "$APP_DIR" checkout --force "$REF"
fi
(cd "$APP_DIR" && npm ci --omit=dev)
chown -R root:root "$APP_DIR"
chmod -R go-w "$APP_DIR"

# Public address
if [ -z "$DOMAIN" ]; then
  TOKEN="$(curl -fsS -m 3 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' || true)"
  IP="$(curl -fsS -m 3 -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4 || true)"
  if [ -n "$IP" ]; then DOMAIN="${IP//./-}.sslip.io"; fi
fi
if [ -z "$DOMAIN" ]; then echo "Could not find the public IP; run again with a domain as the second argument." >&2; exit 1; fi

# Settings file: created from the template only if missing, never overwritten.
if [ -e "$ENV_FILE" ]; then
  echo "Keeping existing $ENV_FILE"
else
  install -m 0600 -o root -g root "$APP_DIR/deploy/aws/hisaab.env.example" "$ENV_FILE"
  sed -i "s#^HB_BASE_URL=.*#HB_BASE_URL=https://$DOMAIN#" "$ENV_FILE"
  echo "Created $ENV_FILE"
fi
chmod 600 "$ENV_FILE"

# Caddy settings (not secret) and config
printf 'HB_DOMAIN=%s\nHB_PORT=8080\n' "$DOMAIN" > /etc/caddy/hisaab.env
chmod 644 /etc/caddy/hisaab.env
install -d /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironmentFile=/etc/caddy/hisaab.env\n' > /etc/systemd/system/caddy.service.d/hisaab.conf
install -m 0644 "$APP_DIR/deploy/aws/Caddyfile" /etc/caddy/Caddyfile
install -m 0644 "$APP_DIR/deploy/aws/hisaab.service" /etc/systemd/system/hisaab.service

systemctl daemon-reload
systemctl enable hisaab caddy
systemctl restart caddy
if [ -f "$DATA_DIR/people.json" ]; then systemctl restart hisaab || true; fi

cat <<MSG

Done. Public address: https://$DOMAIN
Next:
  1. Fill the empty values:   sudo nano $ENV_FILE
  2. Write the people list:   sudo -u hisaab nano $DATA_DIR/people.json
     (shape: $APP_DIR/deploy/aws/people.json.example)
  3. Start the service:       sudo systemctl restart hisaab
  4. Check:                   curl https://$DOMAIN/health
Webhook URLs for Meta: https://$DOMAIN/wa/jcb/webhook and https://$DOMAIN/wa/site/webhook
Port 443 must be open in the EC2 security group (80 is optional).
MSG
