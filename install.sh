#!/usr/bin/env bash
#
# Livecast — one-command install.
#
# On the server (Ubuntu, as root), from the extracted folder:
#
#     bash install.sh live.tuodominio.it
#
# or, if the code is already in /srv/livecast/app:
#
#     bash install.sh
#
# It does everything: dependencies, media server, encoder, services, TLS,
# firewall and the admin account. Then open https://<domain>/admin and sign in
# with admin / admin — the panel forces a new password immediately.
set -euo pipefail

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Esegui come root sul server (sudo -i e poi di nuovo il comando)."

APP_DOMAIN="${APP_DOMAIN:-${1:-}}"
if [ -z "${APP_DOMAIN}" ]; then
  printf 'Dominio della diretta (es. live.tuodominio.it): '
  read -r APP_DOMAIN
fi
[ -n "${APP_DOMAIN}" ] || die "Serve un dominio che punti già a questo server."
APP_NAME="${APP_NAME:-livecast}"
APP_DIR="/srv/${APP_NAME}/app"

say "Preparo ${APP_DIR}"
mkdir -p "${APP_DIR}"
if [ "$(pwd -P)" != "$(cd "${APP_DIR}" && pwd -P)" ]; then
  if command -v rsync >/dev/null; then
    rsync -a --delete --exclude .git --exclude node_modules --exclude dist ./ "${APP_DIR}/"
  else
    cp -a ./. "${APP_DIR}/"
  fi
fi
cd "${APP_DIR}"

say "Installo (dominio: ${APP_DOMAIN})"
APP_NAME="${APP_NAME}" APP_DOMAIN="${APP_DOMAIN}" bash infra/scripts/deploy.sh --local --provision

cat <<MSG

\033[1;32mLivecast è installato.\033[0m

  1. Apri  https://${APP_DOMAIN}/admin
  2. Accedi con  utente: admin   password: admin
  3. Il pannello ti obbliga a scegliere una nuova password: fallo subito.
  4. Crea la diretta (titolo, immagine, video o solo audio) e premi "Vai in onda".
     Puoi pubblicare dalla camera del browser oppure con OBS (il pannello mostra l'URL).

MSG
