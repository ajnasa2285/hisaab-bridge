#!/usr/bin/env bash
# From the one-process service to the separate services (deploy/aws/SPLIT.md). The old folder is copied,
# never changed, and stays where it is.
#
#   Try on a copy, nothing on the system is touched (no sudo needed if you can read the copy):
#     bash split-services.sh --copy <copy of /var/lib/hisaab> <copy of hisaab.env> <empty folder for the result>
#
#   The real thing, with the code already at /opt/hisaab-bridge:
#     sudo bash split-services.sh --apply
set -euo pipefail

APP_DIR="/opt/hisaab-bridge"
OLD_DATA="/var/lib/hisaab"
OLD_ENV="/etc/hisaab/hisaab.env"
PREFIX="/var/lib/hisaab-"
ENV_DIR="/etc/hisaab"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [ "${1:-}" = "--copy" ]; then
  [ $# -eq 4 ] || { echo "Usage: bash $0 --copy <data copy> <env copy> <empty folder>" >&2; exit 2; }
  mkdir -p "$4"
  cd "$HERE"
  exec node --disable-warning=ExperimentalWarning src/service/migrate.js split --from "$2" --env-in "$3" --to-prefix "$4/hisaab-" --env-out "$4/env"
fi

[ "${1:-}" = "--apply" ] || { echo "Usage: bash $0 --copy <data copy> <env copy> <empty folder>   or   sudo bash $0 --apply" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo" >&2; exit 1; }
[ -f "$APP_DIR/src/service/migrate.js" ] || { echo "$APP_DIR does not have this version of the code" >&2; exit 1; }

echo "1. Users"
for u in router jcb site supplier; do
  id "hisaab-$u" >/dev/null 2>&1 || useradd --system --home-dir "$PREFIX$u" --no-create-home --shell /usr/sbin/nologin "hisaab-$u"
done

echo "2. Stopping the one-process service (WhatsApp messages wait at Meta from here)"
systemctl stop hisaab

echo "3. Copying and checking the data"
cd "$APP_DIR"
if ! node --disable-warning=ExperimentalWarning src/service/migrate.js split --from "$OLD_DATA" --env-in "$OLD_ENV" --to-prefix "$PREFIX" --env-out "$ENV_DIR"; then
  echo "The check did not pass. Starting the one-process service again; the new folders are left for looking at." >&2
  systemctl start hisaab
  exit 1
fi

# From here to the start of the new services, a failed step puts the old service back as it was.
undo() {
  echo "A step failed before the switch. Starting the one-process service again; the new folders are left for looking at." >&2
  [ -f /etc/caddy/Caddyfile.one-process ] && install -m 0644 /etc/caddy/Caddyfile.one-process /etc/caddy/Caddyfile
  systemctl enable hisaab || true
  systemctl start hisaab || true
}
trap undo ERR

echo "4. Each folder to its own user, private"
for u in router jcb site supplier; do
  chown -R "hisaab-$u:hisaab-$u" "$PREFIX$u"
  chmod -R go-rwx "$PREFIX$u"
  chown root:root "$ENV_DIR/$u.env"
  chmod 600 "$ENV_DIR/$u.env"
done
# Nobody but root and the old service's user can read the old folder and its three keys.
chmod 700 "$OLD_DATA"

echo "5. Units and front door"
install -m 0644 "$APP_DIR/deploy/aws/hisaab-agent@.service" /etc/systemd/system/
install -m 0644 "$APP_DIR/deploy/aws/hisaab-router.service" /etc/systemd/system/
systemctl daemon-reload
systemctl disable hisaab
cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.one-process
install -m 0644 "$APP_DIR/deploy/aws/Caddyfile.services" /etc/caddy/Caddyfile
set -a; . /etc/caddy/hisaab.env; set +a
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

trap - ERR
echo "6. Starting the four services"
systemctl enable --now hisaab-router hisaab-agent@jcb hisaab-agent@site hisaab-agent@supplier
systemctl restart caddy

echo "7. Checking"
sleep 5
fail=0
for s in hisaab-router hisaab-agent@jcb hisaab-agent@site hisaab-agent@supplier; do
  systemctl is-active --quiet "$s" && echo "   $s running" || { echo "   $s NOT RUNNING" >&2; fail=1; }
done
for p in 8080 8081 8082 8083; do
  [ "$(curl -s -m 5 "http://127.0.0.1:$p/health")" = "ok" ] && echo "   port $p ok" || { echo "   port $p NOT OK" >&2; fail=1; }
done
for pair in "jcb:site/keys/contractor.pem" "jcb:supplier/keys/supplier.pem" "site:jcb/keys/jcb.pem" "site:supplier/keys/supplier.pem" "supplier:jcb/keys/jcb.pem" "supplier:site/keys/contractor.pem" "router:jcb/keys/jcb.pem"; do
  who="${pair%%:*}"; what="${pair#*:}"
  if sudo -u "hisaab-$who" test -r "$PREFIX$what" || sudo -u "hisaab-$who" test -r "$OLD_DATA/keys/jcb.pem"; then echo "   hisaab-$who CAN READ another key" >&2; fail=1; fi
done
[ "$fail" -eq 0 ] && echo "Done. Each agent reads only its own key." || { echo "Something is wrong: see above; deploy/aws/rollback-to-one.sh goes back." >&2; exit 1; }
