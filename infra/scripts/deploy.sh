#!/usr/bin/env bash
#
# Livecast — deploy to the VPS.
#
#   bash infra/scripts/deploy.sh              # normal release
#   bash infra/scripts/deploy.sh --provision  # first install (runs provision.sh remotely)
#   bash infra/scripts/deploy.sh --allow-dirty
#
# Run from the repository root on the machine holding the SSH key.
#
# Build happens on the server, not locally: better-sqlite3 and @node-rs/argon2
# ship platform-specific binaries, and an arm64 Mac bundle cannot run on an
# x86_64 VPS.
#
# Failure behaviour: every remote step aborts the script, and the service is
# restarted only after a successful build, so a bad release leaves the previous
# one running.

set -euo pipefail

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m==> FAILED: %s\033[0m\n' "$*" >&2; exit 1; }

# Connection settings come from the environment or from a git-ignored
# .deploy.env next to this repository (.deploy.env.example shows the two
# variables). Nothing here is tied to one host.
if [ -f .deploy.env ]; then
  # shellcheck disable=SC1091
  source .deploy.env
fi
SSH_HOST="${SSH_HOST:?set SSH_HOST (e.g. root@203.0.113.10) in .deploy.env or the environment}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
APP_NAME="${APP_NAME:-livecast}"
APP_USER="${APP_USER:-${APP_NAME}}"
APP_DIR="/srv/${APP_NAME}/app"
UNIT="${APP_NAME}.service"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:4100/api/health}"
SSH="ssh -i ${SSH_KEY} -o BatchMode=yes -o ServerAliveInterval=30 -o ConnectTimeout=15 ${SSH_HOST}"

# macOS ships openrsync at /usr/bin/rsync, which rejects this script's options
# ("hostname contains invalid characters"). Prefer a real GNU rsync — Homebrew's
# or Linux's — and fall back to tar over ssh when only openrsync exists. The
# tar fallback cannot delete files removed from the repo; that is the documented
# trade for not depending on a package manager.
RSYNC_BIN="$(command -v rsync || true)"
if [ -x "/opt/homebrew/bin/rsync" ] && "/opt/homebrew/bin/rsync" --version | grep -q "version 3\."; then
  RSYNC_BIN="/opt/homebrew/bin/rsync"
fi
if [ -n "${RSYNC_BIN}" ] && "${RSYNC_BIN}" --version 2>/dev/null | grep -q "GNU rsync"; then
  SYNC_MODE="rsync"
else
  SYNC_MODE="tar"
fi

PROVISION=0
ALLOW_DIRTY=0
# --local: run everything on this machine, for the beginner path where the
# operator works directly in the VPS's browser terminal and has no laptop
# SSH setup. It needs the repo checked out on the server and root access.
LOCAL=0
for arg in "$@"; do
  case "$arg" in
    --provision) PROVISION=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --local) LOCAL=1 ;;
    *) fail "unknown option: $arg" ;;
  esac
done
if [ "${LOCAL}" -eq 1 ]; then
  SSH_HOST="local"
  run() { bash -c "$1"; }
  [ "$(id -u)" -eq 0 ] || fail "--local must run as root on the server"
else
  [ -n "${SSH_HOST:-}" ] || fail "set SSH_HOST in .deploy.env (or pass --local to run on this machine)"
  run() { ssh -i "${SSH_KEY}" -o BatchMode=yes -o ServerAliveInterval=30 -o ConnectTimeout=15 "${SSH_HOST}" "$1"; }
fi

# --- 1. Safety checks -------------------------------------------------------

if [ "${ALLOW_DIRTY}" -eq 0 ] && [ -d .git ] && [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  fail "working tree not clean — commit first, or pass --allow-dirty for an emergency hotfix"
fi

[ -f "pnpm-lock.yaml" ] || fail "run me from the repository root (pnpm-lock.yaml not found)"

# --- 2. Transfer source -----------------------------------------------------

log "Syncing source to ${APP_DIR}"
# provision.sh owns the directory tree, but a first deploy with no
# --provision (or a VPS where the app dir was removed) still has to land
# somewhere: create it root-owned, provision re-owns it afterwards.
run "mkdir -p ${APP_DIR}"
# .env, data and node_modules are server state, never local state:
# `--delete` would otherwise wipe the production credentials and the database.
EXCLUDES=(--exclude node_modules --exclude dist --exclude .git --exclude .env
  --exclude data --exclude coverage --exclude "*.log" --exclude .DS_Store)
if [ "${SYNC_MODE}" = "rsync" ]; then
  "${RSYNC_BIN}" -az --delete "${EXCLUDES[@]}" \
    -e "ssh -i ${SSH_KEY} -o BatchMode=yes" \
    ./ "${APP_DIR}/"
else
  log "GNU rsync not found — syncing with tar (removed files are not deleted remotely)"
  COPYFILE_DISABLE=1 tar -czf - --no-xattrs --exclude "._*" "${EXCLUDES[@]}" . \
    | run "mkdir -p ${APP_DIR} && tar -xzf - -C ${APP_DIR}"
fi
# Before the first provision the service user does not exist yet; after it,
# this is what keeps the tree owned by the user systemd runs as.
run "if id ${APP_USER} >/dev/null 2>&1; then chown -R ${APP_USER}:${APP_USER} ${APP_DIR}; fi; chmod -R g+w ${APP_DIR}"
log "source synced (${SYNC_MODE})"

# --- 3. First-install provisioning (optional) -------------------------------

if [ "${PROVISION}" -eq 1 ]; then
  log "Provisioning (MediaMTX, systemd, nginx, TLS, firewall)"
  # Forward the install parameters over ssh: environment variables set on the
  # laptop do not travel by themselves, and provisioning for the wrong domain
  # installs an nginx site nobody asked for.
  PROVISION_ENV="APP_NAME=${APP_NAME}"
  [ -n "${APP_DOMAIN:-}" ] && PROVISION_ENV="${PROVISION_ENV} APP_DOMAIN=${APP_DOMAIN}"
  [ -n "${LETSENCRYPT_EMAIL:-}" ] && PROVISION_ENV="${PROVISION_ENV} LETSENCRYPT_EMAIL=${LETSENCRYPT_EMAIL}"
  run "${PROVISION_ENV} bash ${APP_DIR}/infra/scripts/provision.sh"
fi

# --- 4. Build on the server -------------------------------------------------

log "Installing dependencies and building"
run "set -euo pipefail
  cd ${APP_DIR}
  # corepack's shim can be present yet fail to resolve its cached pnpm
  # (MODULE_NOT_FOUND under ~/.cache/node/corepack). A real pnpm@12 install is
  # one npm command and cannot half-work.
  if ! pnpm --version 2>/dev/null | grep -q '^12\.'; then
    npm install -g pnpm@12.14.0 >/dev/null 2>&1
  fi
  pnpm install --frozen-lockfile
  pnpm --filter @livecast/api build
  pnpm --filter @livecast/web build
  chown -R ${APP_USER}:${APP_USER} ${APP_DIR}
"
log "build ok"

# --- 5. Restart and verify ---------------------------------------------------

log "Restarting livecast"
run "systemctl restart ${UNIT} && sleep 1 && systemctl is-active --quiet ${UNIT}" \
  || { run "journalctl -u ${UNIT} -n 40 --no-pager" || true; fail "service did not start"; }

if run "curl -fsS ${HEALTH_URL}" >/dev/null; then
  log "health check passed (${HEALTH_URL})"
else
  run "journalctl -u ${UNIT} -n 40 --no-pager" || true
  fail "health check failed"
fi

# --- 6. First admin user ----------------------------------------------------

log "Admin user"
CREATE_OUT="$(run "cd ${APP_DIR} && node --env-file=.env apps/api/dist/cli.js create-admin --username admin" 2>&1)" || RC=$?
RC="${RC:-0}"
if [ "${RC}" -eq 2 ]; then
  log "admin user already exists — password unchanged"
elif [ "${RC}" -eq 0 ]; then
  PW="$(printf '%s\n' "${CREATE_OUT}" | sed -n 's/^ADMIN_PASSWORD=//p')"
  [ -n "${PW}" ] || fail "create-admin printed no password: ${CREATE_OUT}"
  run "printf 'ADMIN_PASSWORD=%s\n' '${PW}' >> /root/.livecast-credentials && chmod 600 /root/.livecast-credentials"
  printf '\n\033[1;32mAdmin creato.\033[0m  utente: admin\n'
  printf '  password: \033[1;33m%s\033[0m\n' "${PW}"
  printf '  (salvata anche in /root/.livecast-credentials sul VPS)\n'
  printf '  Cambiala subito dal pannello dopo il primo accesso.\n'
else
  fail "create-admin failed: ${CREATE_OUT}"
fi

printf '\n\033[1;32mDeploy completato.\033[0m\n'
