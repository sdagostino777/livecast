#!/usr/bin/env bash
#
# NDX Live — deploy to the VPS.
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

SSH_HOST="${SSH_HOST:-root@187.77.174.159}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/ndx_vps}"
APP_DIR="/srv/ndx-live/app"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:4100/api/health}"
SSH="ssh -i ${SSH_KEY} -o BatchMode=yes -o ServerAliveInterval=30 -o ConnectTimeout=15"
SCP_SYNC="rsync -az --delete"

PROVISION=0
ALLOW_DIRTY=0
for arg in "$@"; do
  case "$arg" in
    --provision) PROVISION=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    *) fail "unknown option: $arg" ;;
  esac
done

# --- 1. Safety checks -------------------------------------------------------

if [ "${ALLOW_DIRTY}" -eq 0 ] && [ -d .git ] && [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  fail "working tree not clean — commit first, or pass --allow-dirty for an emergency hotfix"
fi

[ -f "pnpm-lock.yaml" ] || fail "run me from the repository root (pnpm-lock.yaml not found)"

# --- 2. Transfer source -----------------------------------------------------

log "Syncing source to ${SSH_HOST}:${APP_DIR}"
# provision.sh owns the directory tree, but a first deploy with no
# --provision (or a VPS where the app dir was removed) still has to land
# somewhere: create it root-owned, provision re-owns it afterwards.
${SSH} "mkdir -p ${APP_DIR}"
# .env, data and node_modules are server state, never local state:
# `--delete` would otherwise wipe the production credentials and the database.
${SCP_SYNC} \
  --exclude node_modules --exclude dist --exclude .git \
  --exclude .env --exclude data --exclude coverage --exclude "*.log" \
  -e "ssh -i ${SSH_KEY} -o BatchMode=yes" \
  ./ "${SSH_HOST}:${APP_DIR}/"
${SSH} "chown -R ndxlive:ndxlive ${APP_DIR} && chmod -R g+w ${APP_DIR}"
log "source synced"

# --- 3. First-install provisioning (optional) -------------------------------

if [ "${PROVISION}" -eq 1 ]; then
  log "Provisioning (MediaMTX, systemd, nginx, TLS, firewall)"
  ${SSH} "bash ${APP_DIR}/infra/scripts/provision.sh"
fi

# --- 4. Build on the server -------------------------------------------------

log "Installing dependencies and building"
${SSH} "set -euo pipefail
  cd ${APP_DIR}
  corepack enable >/dev/null 2>&1 || true
  pnpm install --frozen-lockfile
  pnpm --filter @ndx-live/api build
  pnpm --filter @ndx-live/web build
  chown -R ndxlive:ndxlive ${APP_DIR}
"
log "build ok"

# --- 5. Restart and verify ---------------------------------------------------

log "Restarting ndx-live"
${SSH} "systemctl restart ndx-live && sleep 1 && systemctl is-active --quiet ndx-live" \
  || { ${SSH} "journalctl -u ndx-live -n 40 --no-pager" || true; fail "service did not start"; }

if ${SSH} "curl -fsS ${HEALTH_URL}" >/dev/null; then
  log "health check passed (${HEALTH_URL})"
else
  ${SSH} "journalctl -u ndx-live -n 40 --no-pager" || true
  fail "health check failed"
fi

# --- 6. First admin user ----------------------------------------------------

log "Admin user"
CREATE_OUT="$(${SSH} "cd ${APP_DIR} && node --env-file=.env apps/api/dist/cli.js create-admin --username admin" 2>&1)" || RC=$?
RC="${RC:-0}"
if [ "${RC}" -eq 2 ]; then
  log "admin user already exists — password unchanged"
elif [ "${RC}" -eq 0 ]; then
  PW="$(printf '%s\n' "${CREATE_OUT}" | sed -n 's/^ADMIN_PASSWORD=//p')"
  [ -n "${PW}" ] || fail "create-admin printed no password: ${CREATE_OUT}"
  ${SSH} "printf 'ADMIN_PASSWORD=%s\n' '${PW}' >> /root/.ndx-live-credentials && chmod 600 /root/.ndx-live-credentials"
  printf '\n\033[1;32mAdmin creato.\033[0m  utente: admin\n'
  printf '  password: \033[1;33m%s\033[0m\n' "${PW}"
  printf '  (salvata anche in /root/.ndx-live-credentials sul VPS)\n'
  printf '  Cambiala subito dal pannello dopo il primo accesso.\n'
else
  fail "create-admin failed: ${CREATE_OUT}"
fi

printf '\n\033[1;32mDeploy completato.\033[0m\n'
