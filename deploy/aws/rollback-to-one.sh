#!/usr/bin/env bash
# From the separate services back to the one-process service (deploy/aws/SPLIT.md), keeping everything
# written since the split. The services' folders are copied, never changed; the old folder is set aside.
#
#   Try on a copy:
#     bash rollback-to-one.sh --copy <prefix of the copies, e.g. /tmp/x/hisaab-> <empty folder for the result>
#
#   The real thing:
#     sudo bash rollback-to-one.sh --apply
set -euo pipefail

APP_DIR="/opt/hisaab-bridge"
OLD_DATA="/var/lib/hisaab"
PREFIX="/var/lib/hisaab-"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [ "${1:-}" = "--copy" ]; then
  [ $# -eq 3 ] || { echo "Usage: bash $0 --copy <prefix> <empty folder>" >&2; exit 2; }
  cd "$HERE"
  exec node --disable-warning=ExperimentalWarning src/service/migrate.js back --from-prefix "$2" --to "$3"
fi

[ "${1:-}" = "--apply" ] || { echo "Usage: bash $0 --copy <prefix> <empty folder>   or   sudo bash $0 --apply" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo" >&2; exit 1; }

STAMP="$(date +%Y%m%d-%H%M%S)"
NEW="$OLD_DATA.rollback-$STAMP"

echo "1. Stopping the four services (WhatsApp messages wait at Meta from here)"
systemctl disable --now hisaab-router hisaab-agent@jcb hisaab-agent@site hisaab-agent@supplier

echo "2. Bringing the data back into one folder and checking it"
cd "$APP_DIR"
if ! node --disable-warning=ExperimentalWarning src/service/migrate.js back --from-prefix "$PREFIX" --to "$NEW"; then
  echo "The check did not pass. Nothing was switched; the services' folders and the old folder are as they were." >&2
  echo "Look at the message above before starting anything." >&2
  exit 1
fi

echo "3. Switching folders; the old one is kept as $OLD_DATA.before-rollback-$STAMP"
mv "$OLD_DATA" "$OLD_DATA.before-rollback-$STAMP"
mv "$NEW" "$OLD_DATA"
chown -R hisaab:hisaab "$OLD_DATA"
chmod -R go-rwx "$OLD_DATA"

echo "4. The old front door and the one-process service"
install -m 0644 "$APP_DIR/deploy/aws/Caddyfile" /etc/caddy/Caddyfile
set -a; . /etc/caddy/hisaab.env; set +a
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable --now hisaab
systemctl restart caddy

echo "5. Checking"
sleep 5
systemctl is-active --quiet hisaab && echo "   hisaab running" || { echo "   hisaab NOT RUNNING: sudo journalctl -u hisaab -n 50" >&2; exit 1; }
[ "$(curl -s -m 5 http://127.0.0.1:8080/health)" = "ok" ] && echo "   health ok" || { echo "   health NOT OK" >&2; exit 1; }
echo "Done. The services' folders in $PREFIX* are left in place; delete them only when you are sure."
