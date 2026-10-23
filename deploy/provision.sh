#!/usr/bin/env bash
# Easydoc — installation / mise à jour dans un conteneur LXC (Debian 12+, Ubuntu 24.04) ou une VM.
# À exécuter en root DANS le conteneur. Lancé automatiquement par deploy/easydoc-lxc.sh,
# peut aussi être lancé à la main :
#
#   curl -fsSL https://raw.githubusercontent.com/Anthanaab/Easydoc/main/deploy/provision.sh | bash
#
# Aucun jeton n'est nécessaire : le dépôt de documents se connecte ensuite depuis l'interface
# (Réglages). Variables facultatives :
#   EASYDOC_PORT=3000                       port HTTP (défaut 3000)
#   EASYDOC_DOCS_REPO=moi/docs EASYDOC_TOKEN=ghp_…   préconfigurer le dépôt de documents
#   EASYDOC_REPO / EASYDOC_BRANCH           dépôt et branche du CODE d'Easydoc (défaut Anthanaab/Easydoc, main)
#
# Ré-exécutable : met le code à jour, réinstalle les dépendances et redémarre le service.
# La configuration (.env, data/ : dépôt connecté, jeton, documents locaux) est conservée.
set -Eeuo pipefail

SRC_REPO="${EASYDOC_REPO:-Anthanaab/Easydoc}"
SRC_BRANCH="${EASYDOC_BRANCH:-main}"
APP_DIR=/opt/easydoc
APP_USER=easydoc
SERVICE=easydoc.service
PROVISION_VERSION=5   # marqueur vérifié par easydoc-lxc.sh (le CDN peut servir une version périmée)

if [ -t 1 ]; then G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; B=$'\e[1m'; N=$'\e[0m'; else G= Y= R= B= N=; fi
info() { echo "${B}==>${N} $*"; }
ok()   { echo " ${G}✓${N} $*"; }
warn() { echo " ${Y}!${N} $*"; }
die()  { echo " ${R}✗ $*${N}" >&2; exit 1; }
trap 'echo; die "Erreur ligne $LINENO : $BASH_COMMAND"' ERR

[ "$(id -u)" -eq 0 ] || die "Lancez ce script en root dans le conteneur."
export DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8

# -- 1. Paquets + Node.js (>= 18) ------------------------------------------------------------------
info "Paquets de base et Node.js"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git >/dev/null
NODE_MAJOR=22   # requis par la lecture des PDF (unpdf)
node_major() { command -v node >/dev/null && node -v | cut -d. -f1 | tr -d v || echo 0; }
if [ "$(node_major)" -ge "$NODE_MAJOR" ]; then
  ok "Node.js $(node -v) déjà présent"
else
  [ "$(node_major)" -gt 0 ] && info "Mise à niveau de Node.js $(node -v) vers la version $NODE_MAJOR"
  if curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/node-setup.sh 2>/dev/null && bash /tmp/node-setup.sh >/dev/null 2>&1; then
    apt-get install -y -qq nodejs >/dev/null
  else
    warn "Dépôt NodeSource indisponible pour ce système : paquet de la distribution utilisé"
    apt-get install -y -qq nodejs npm >/dev/null
  fi
  [ "$(node_major)" -ge "$NODE_MAJOR" ] || die "Node.js $NODE_MAJOR ou plus récent est requis (installé : $(node -v 2>/dev/null || echo aucun))."
  ok "Node.js $(node -v)"
fi

# -- 2. Code source ---------------------------------------------------------------------------------
# Le dossier appartient à l'utilisateur du service : autoriser git (root) à le manipuler.
git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
info "Code : $SRC_REPO ($SRC_BRANCH) → $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" remote set-url origin "https://github.com/$SRC_REPO.git"
  git -C "$APP_DIR" fetch --quiet origin "$SRC_BRANCH" || die "Impossible de récupérer le code (réseau ?)."
  # reset et non pull : un fichier suivi modifié localement (package-lock…) ne bloque plus la mise à jour.
  # .env, data/ et node_modules/ ne sont pas suivis par git : ils sont conservés.
  git -C "$APP_DIR" reset --hard --quiet "origin/$SRC_BRANCH"
else
  [ -e "$APP_DIR" ] && mv "$APP_DIR" "$APP_DIR.bak.$(date +%s)"
  git clone --quiet --branch "$SRC_BRANCH" "https://github.com/$SRC_REPO.git" "$APP_DIR" || die "Clonage impossible."
fi
ok "Version $(git -C "$APP_DIR" log -1 --format='%h — %s' | cut -c1-80)"

# -- 3. Configuration (créée une fois, puis conservée) ------------------------------------------------
ENV_FILE="$APP_DIR/.env"
set_env() {  # set_env CLÉ VALEUR : remplace ou ajoute la ligne
  if grep -q "^$1=" "$ENV_FILE" 2>/dev/null; then sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"; else echo "$1=$2" >> "$ENV_FILE"; fi
}
if [ ! -f "$ENV_FILE" ]; then
  printf '# Configuration locale d'"'"'Easydoc (jamais versionnée).\n# Le dépôt de documents se règle dans l'"'"'interface (Réglages) : data/config.json.\n' > "$ENV_FILE"
  set_env PORT "${EASYDOC_PORT:-3000}"
else
  [ -n "${EASYDOC_PORT:-}" ] && set_env PORT "$EASYDOC_PORT"
fi
if [ -n "${EASYDOC_DOCS_REPO:-}" ] && [ -n "${EASYDOC_TOKEN:-}" ]; then
  set_env GITHUB_REPO "$EASYDOC_DOCS_REPO"
  set_env GITHUB_TOKEN "$EASYDOC_TOKEN"
  ok "Dépôt de documents préconfiguré : $EASYDOC_DOCS_REPO"
fi
PORT="$(sed -n 's/^PORT=//p' "$ENV_FILE" | head -1)"; PORT="${PORT:-3000}"
mkdir -p "$APP_DIR/data"

# -- 4. Dépendances ---------------------------------------------------------------------------------
info "Dépendances"
cd "$APP_DIR"
if [ -f package-lock.json ]; then
  npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm ci --omit=dev --no-audit --no-fund || die "npm ci a échoué."
else
  npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || die "npm install a échoué."
fi
ok "Dépendances installées"

# -- 5. Utilisateur du service + droits ---------------------------------------------------------------
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 600 "$ENV_FILE"
chmod 700 "$APP_DIR/data"

# -- 6. Service systemd ------------------------------------------------------------------------------
cat > "/etc/systemd/system/$SERVICE" <<UNIT
[Unit]
Description=Easydoc — éditeur Markdown collaboratif
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
ExecStart=$(command -v node) server.js
Restart=on-failure
RestartSec=3
# arrêt propre : les documents ouverts sont enregistrés avant l'extinction
KillSignal=SIGTERM
TimeoutStopSec=20
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  systemctl daemon-reload
  systemctl enable "$SERVICE" >/dev/null 2>&1
  systemctl restart "$SERVICE"   # restart (et non enable --now) : charge bien le nouveau code
  info "Vérification du service"
  HEALTH=""
  for _ in $(seq 1 30); do
    HEALTH="$(curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)"
    [ -n "$HEALTH" ] && break
    sleep 1
  done
  if [ -z "$HEALTH" ]; then
    journalctl -u "$SERVICE" -n 15 --no-pager 2>/dev/null || true
    die "Le service ne répond pas sur le port $PORT."
  fi
  VER="$(echo "$HEALTH" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
  ok "Service actif — Easydoc ${VER:-?}"
else
  warn "systemd absent : démarrage manuel avec  cd $APP_DIR && sudo -u $APP_USER node server.js"
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
ok "${B}Easydoc est prêt : http://${IP:-<adresse-du-conteneur>}:$PORT${N}"
echo "   Connecte ton dépôt GitHub depuis l'interface : Réglages (en bas à gauche)."
echo "   Journal : journalctl -u easydoc -f   ·   Mise à jour : relancer ce script."
