#!/usr/bin/env bash
#
# NDX Live — VPS provisioning.
#
# Run once on a fresh Ubuntu LTS VPS as root:
#     bash infra/scripts/provision.sh
#
# Re-runnable: every step checks before acting, so running it twice is safe.
# What it does NOT do: install the web app. That is deploy.sh, which runs
# afterwards and is repeated on every release.
#
# Assumptions: Ubuntu LTS, root access, Node.js >= 22 installed, and a DNS A
# record for the chosen hostname already pointing here (certbot needs it).
#
#   APP_DOMAIN=live.example.com bash infra/scripts/provision.sh
#
set -euo pipefail

APP_DOMAIN="${APP_DOMAIN:-live.ndx-llc.com}"
APP_USER="${APP_USER:-ndxlive}"
APP_DIR="${APP_DIR:-/srv/ndx-live}"
PORT="${PORT:-4100}"
INGEST_PORT="${INGEST_PORT:-1935}"
MEDIAMTX_VERSION="${MEDIAMTX_VERSION:-v1.21.3}"
LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:-info@ndx-llc.com}"
CREDENTIALS_FILE="/root/.ndx-live-credentials"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok() { printf '\033[1;32m  ok  %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[warn] %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m[FAIL] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "This script must run as root."

# --- 0. Preconditions ------------------------------------------------------

log "Preconditions"
command -v node >/dev/null || fail "node not found — install Node.js >= 22 first"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "${NODE_MAJOR}" -ge 22 ] || fail "Node.js >= 22 required, found $(node -v)"
NODE_BIN="$(command -v node)"
command -v nginx >/dev/null || fail "nginx not installed"
command -v certbot >/dev/null || fail "certbot not installed (apt install certbot)"
command -v ffmpeg >/dev/null || { apt-get update -qq && apt-get install -y -qq ffmpeg; }
ok "node $(node -v), nginx, certbot, ffmpeg"

# --- 1. Service user and directories --------------------------------------

log "Service user and directories"
if ! id "${APP_USER}" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "${APP_DIR}" --shell /usr/sbin/nologin "${APP_USER}"
  ok "created system user ${APP_USER}"
else
  ok "system user ${APP_USER} already exists"
fi
# The app directory is owned by the service user but written by root at deploy
# time (rsync), so it also needs group write: root:ndxlive with 775.
install -d -o "${APP_USER}" -g "${APP_USER}" -m 775 "${APP_DIR}" "${APP_DIR}/bin" "${APP_DIR}/data" "${APP_DIR}/data/hls" "${APP_DIR}/data/recordings"
ok "directories under ${APP_DIR}"

# --- 2. Credentials (generated once) --------------------------------------

log "Credentials"
if [ ! -f "${CREDENTIALS_FILE}" ]; then
  {
    echo "PUBLISH_USER=ndx"
    echo "PUBLISH_PASS=$(openssl rand -base64 36 | tr -dc 'A-Za-z0-9' | cut -c1-32)"
    echo "READER_USER=ndx-reader"
    echo "READER_PASS=$(openssl rand -base64 36 | tr -dc 'A-Za-z0-9' | cut -c1-32)"
  } > "${CREDENTIALS_FILE}"
  chmod 600 "${CREDENTIALS_FILE}"
  ok "generated ${CREDENTIALS_FILE}"
else
  ok "reusing ${CREDENTIALS_FILE}"
fi
# shellcheck disable=SC1090
source "${CREDENTIALS_FILE}"

# --- 3. MediaMTX binary ----------------------------------------------------

log "MediaMTX ${MEDIAMTX_VERSION}"
if [ -x "${APP_DIR}/bin/mediamtx" ]; then
  ok "mediamtx already installed ($("${APP_DIR}"/bin/mediamtx --version 2>/dev/null || echo installed))"
else
  TMP="$(mktemp -d)"
  BASE="https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VERSION}"
  ARCHIVE="mediamtx_${MEDIAMTX_VERSION}_linux_amd64.tar.gz"
  curl -fsSL "${BASE}/${ARCHIVE}" -o "${TMP}/${ARCHIVE}"
  # The checksum file is published next to the archive; verifying it costs one
  # line and turns "we downloaded a binary as root" into a supply-chain check.
  # The archive keeps its release filename so the checksum lookup matches.
  curl -fsSL "${BASE}/checksums.sha256" -o "${TMP}/checksums.sha256"
  ( cd "${TMP}" && sha256sum --check --ignore-missing checksums.sha256 >/dev/null && echo ok ) || fail "checksum mismatch for ${MEDIAMTX_VERSION}"
  tar -xzf "${TMP}/${ARCHIVE}" -C "${TMP}" mediamtx
  install -m 755 -o root -g root "${TMP}/mediamtx" "${APP_DIR}/bin/mediamtx"
  rm -rf "${TMP}"
  ok "installed ${APP_DIR}/bin/mediamtx"
fi

# --- 4. Configuration files -----------------------------------------------

log "Configuration"
render() {
  # __PLACEHOLDER__ replacement; values are alphanumeric so sed is safe.
  sed -e "s/__PUBLISH_USER__/${PUBLISH_USER}/g" \
      -e "s/__PUBLISH_PASS__/${PUBLISH_PASS}/g" \
      -e "s/__READER_USER__/${READER_USER}/g" \
      -e "s/__READER_PASS__/${READER_PASS}/g" \
      -e "s/__DOMAIN__/${APP_DOMAIN}/g" \
      -e "s/__NODE__/${NODE_BIN//\//\\/}/g" \
      "$1"
}

MEDIAMTX_SRC="$(dirname "$0")/../mediamtx.yml.tpl"
[ -f "${MEDIAMTX_SRC}" ] || MEDIAMTX_SRC="${APP_DIR}/app/infra/mediamtx.yml.tpl"
[ -f "${MEDIAMTX_SRC}" ] || fail "mediamtx.yml.tpl not found (run provision.sh from the repo, or deploy first)"

MEDIAMTX_YML="${APP_DIR}/mediamtx.yml"
render "${MEDIAMTX_SRC}" > "${MEDIAMTX_YML}.new"
if ! cmp -s "${MEDIAMTX_YML}.new" "${MEDIAMTX_YML}" 2>/dev/null; then
  mv "${MEDIAMTX_YML}.new" "${MEDIAMTX_YML}"
  chown "${APP_USER}:${APP_USER}" "${MEDIAMTX_YML}"
  chmod 640 "${MEDIAMTX_YML}"  # contains the publish password
  ok "rendered ${MEDIAMTX_YML} (changed)"
  # Only restart on an actual change: re-running provisioning during an event
  # must not drop the ingest connection for the sake of idempotence.
  if systemctl is-active --quiet ndx-live-mediamtx; then
    systemctl restart ndx-live-mediamtx
    ok "ndx-live-mediamtx restarted to pick up the new config"
  fi
else
  rm -f "${MEDIAMTX_YML}.new"
  ok "mediamtx config unchanged"
fi

if [ ! -f "${APP_DIR}/app/.env" ]; then
  install -d -o "${APP_USER}" -g "${APP_USER}" -m 775 "${APP_DIR}/app"
  cat > "${APP_DIR}/app/.env" <<EOF
# NDX Live — written once by provision.sh, edited by hand if needed.
NODE_ENV=production
PORT=${PORT}
HOST=127.0.0.1
DATA_DIR=${APP_DIR}/data
PUBLIC_URL=https://${APP_DOMAIN}
INGEST_HOST=${APP_DOMAIN}
INGEST_PORT=${INGEST_PORT}
MEDIAMTX_API_URL=http://127.0.0.1:9997
MEDIAMTX_RTMP_URL=rtmp://127.0.0.1:1935
MEDIAMTX_READ_USER=${READER_USER}
MEDIAMTX_READ_PASS=${READER_PASS}
PUBLISH_USER=${PUBLISH_USER}
PUBLISH_PASS=${PUBLISH_PASS}
COOKIE_SECURE=true
FFMPEG_BIN=$(command -v ffmpeg)
EOF
  chown "${APP_USER}:${APP_USER}" "${APP_DIR}/app/.env"
  chmod 600 "${APP_DIR}/app/.env"
  ok "wrote ${APP_DIR}/app/.env"
else
  ok "keeping existing ${APP_DIR}/app/.env"
fi

# --- 5. systemd units ------------------------------------------------------

log "systemd units"
SYSTEMD_SRC="$(dirname "$0")/../systemd"
[ -f "${SYSTEMD_SRC}/ndx-live.service" ] || SYSTEMD_SRC="${APP_DIR}/app/infra/systemd"
[ -f "${SYSTEMD_SRC}/ndx-live.service" ] || fail "systemd units not found"

render "${SYSTEMD_SRC}/ndx-live.service" > /etc/systemd/system/ndx-live.service
install -m 644 "${SYSTEMD_SRC}/ndx-live-mediamtx.service" /etc/systemd/system/ndx-live-mediamtx.service
systemctl daemon-reload
systemctl enable --now ndx-live-mediamtx.service >/dev/null
ok "ndx-live-mediamtx enabled and running"
systemctl enable ndx-live.service >/dev/null
if [ -f "${APP_DIR}/app/apps/api/dist/main.js" ]; then
  systemctl restart ndx-live.service
  ok "ndx-live restarted"
else
  warn "app not deployed yet — run deploy.sh, then 'systemctl start ndx-live'"
fi

# --- 6. Firewall -----------------------------------------------------------

log "Firewall"
if command -v ufw >/dev/null; then
  ufw allow "${INGEST_PORT}/tcp" comment 'NDX Live RTMP ingest' >/dev/null
  ok "ufw allows ${INGEST_PORT}/tcp"
else
  warn "ufw not installed — make sure ${INGEST_PORT}/tcp is reachable"
fi

# --- 7. nginx + TLS --------------------------------------------------------

log "nginx site for ${APP_DOMAIN}"
NGINX_SRC="$(dirname "$0")/../nginx"
[ -f "${NGINX_SRC}/live.conf" ] || NGINX_SRC="${APP_DIR}/app/infra/nginx"
SITE="/etc/nginx/sites-available/${APP_DOMAIN}.conf"

if [ ! -f "/etc/letsencrypt/live/${APP_DOMAIN}/fullchain.pem" ]; then
  install -d -m 755 /var/www/html
  warn "no certificate yet — installing the HTTP bootstrap site so certbot can validate"
  render "${NGINX_SRC}/live.http.conf" > "${SITE}"
  ln -sf "${SITE}" "/etc/nginx/sites-enabled/${APP_DOMAIN}.conf"
  nginx -t >/dev/null 2>&1 && systemctl reload nginx
  ok "HTTP bootstrap site active"

  if certbot certonly --webroot -w /var/www/html -d "${APP_DOMAIN}" \
    --email "${LETSENCRYPT_EMAIL}" --agree-tos --no-eff-email -n; then
    ok "certificate issued"
  else
    # Not fatal on purpose: everything else — MediaMTX, systemd units, the app —
    # is usable, and the only missing prerequisite is usually the DNS record,
    # which is a five-minute manual step outside this script.
    warn "certbot could not issue a certificate for ${APP_DOMAIN}."
    warn "Most likely cause: no DNS A record for ${APP_DOMAIN} pointing at this VPS."
    warn "The app keeps working over HTTP on this host until then."
    warn "After adding the record, re-run: bash infra/scripts/deploy.sh --provision"
  fi
fi

if [ -f "/etc/letsencrypt/live/${APP_DOMAIN}/fullchain.pem" ]; then
  render "${NGINX_SRC}/live.conf" > "${SITE}"
  ln -sf "${SITE}" "/etc/nginx/sites-enabled/${APP_DOMAIN}.conf"
  nginx -t >/dev/null
  systemctl reload nginx
  ok "https site for ${APP_DOMAIN} active"
else
  render "${NGINX_SRC}/live.http.conf" > "${SITE}"
  ln -sf "${SITE}" "/etc/nginx/sites-enabled/${APP_DOMAIN}.conf"
  nginx -t >/dev/null
  systemctl reload nginx
  warn "http-only site for ${APP_DOMAIN} active (no certificate yet)"
fi

# --- 8. Summary ------------------------------------------------------------

printf '\n\033[1;32mNDX Live provisioned.\033[0m\n\n'
printf '  App dir        %s\n' "${APP_DIR}"
printf '  Domain         https://%s\n' "${APP_DOMAIN}"
printf '  Ingest (OBS)   rtmp://%s:%s/live\n' "${APP_DOMAIN}" "${INGEST_PORT}"
printf '  Credentials    %s (publish user %s, reader user %s)\n\n' "${CREDENTIALS_FILE}" "${PUBLISH_USER}" "${READER_USER}"
printf 'Next:\n'
printf '  1. From the repo on your machine:  bash infra/scripts/deploy.sh --provision\n'
printf '  2. Open https://%s/admin and log in with the credentials printed by deploy.sh\n' "${APP_DOMAIN}"
printf '  3. In OBS: Server = the full RTMP URL shown in the panel, Stream Key = empty\n'

