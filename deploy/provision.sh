#!/usr/bin/env bash
# Easydoc — provisioning d'un conteneur LXC Debian 12+/Ubuntu 24.04 (ou n'importe quel hôte-propre).
# À exécuter en root DANS le conteneur. Utilisé automatiquement par deploy/easydoc-lxc.sh,
# mais peut aussi être lancé à la main.
#
#   export EASYDOC_TOKEN=ghp_...        # obligatoire (l'app écrit sur GitHub)
#   export EASYDOC_REPO=Anthanaab/Easydoc
#   export EASYDOC_BRANCH=main
#   export EASYDOC_PORT=3000
#   curl -fsSL "https://raw.githubusercontent.com/\$EASYDOC_REPO/\$EASYDOC_BRANCH/deploy/provision.sh" | bash
#
# Ré-exécutable : met à jour le code (git pull) et relance le service.
set -Eeuo pipefail

REPO="${EASYDOC_REPO:-Anthanaab/Easydoc}"
BRANCH="${EASYDOC_BRANCH:-main}"
PORT="${EASYDOC_PORT:-3000}"
TOKEN="${EASYDOC_TOKEN:-}"
APP_DIR=/opt/easydoc
SERVICE=easydoc.service
PROVISION_VERSION=3   # marqueur vérifié par easydoc-lxc.sh (le CDN peut servir une version périmée)

# Mise à jour : préserve la configuration existante si aucune variable n'est fournie.
if [ -f "$APP_DIR/.env" ]; then
  [ -n "$TOKEN" ] || TOKEN="$(sed -n 's/^GITHUB_TOKEN=//p' "$APP_DIR/.env" | head -1)"
  [ -n "${EASYDOC_REPO:-}" ] || REPO="$(sed -n 's/^GITHUB_REPO=//p' "$APP_DIR/.env" | head -1)"
  [ -n "${EASYDOC_BRANCH:-}" ] || BRANCH="$(sed -n 's/^GITHUB_BRANCH=//p' "$APP_DIR/.env" | head -1)"
  [ -n "${EASYDOC_PORT:-}" ] || PORT="$(sed -n 's/^PORT=//p' "$APP_DIR/.env" | head -1)"
fi

G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; B=$'\e[1m'; N=$'\e[0m'
info() { echo "${B}==>${N} $*"; }
ok()   { echo " ${G}✓${N} $*"; }
warn() { echo " ${Y}!${N} $*"; }
die()  { echo " ${R}✗ $*${N}" >&2; exit 1; }
trap 'echo; die "Erreur ligne $LINENO : $BASH_COMMAND"' ERR

[ "$(id -u)" -eq 0 ] || die "Lancez ce script en root dans le conteneur."
export DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8

# -- 1. Node.js (>= 18) ---------------------------------------------------------------------------------
info "Paquets de base + Node.js"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git >/dev/null

if command -v node >/dev/null && [ "$(node -v | cut -d. -f1 | tr -d v)" -ge 18 ]; then
  ok "Node.js déjà présent ($(node -v))"
else
  if curl -fsSL https://deb.nodesource.com/setup_20.x -o /tmp/node-setup.sh 2>/dev/null && bash /tmp/node-setup.sh >/dev/null 2>&1; then
    apt-get install -y -qq nodejs >/dev/null
  else
    warn "NodeSource indisponible pour cette distribution, paquet système utilisé"
    apt-get install -y -qq nodejs npm >/dev/null
  fi
  command -v node >/dev/null && [ "$(node -v | cut -d. -f1 | tr -d v)" -ge 18 ] \
    || die "Node.js introuvable (>= 18 requis)"
  ok "Node.js $(node -v)"
fi

# -- 2. Code source --------------------------------------------------------------------------------------
# Le dépôt appartient à l'utilisateur applicatif (chown ci-dessous) : autoriser git
# à le relire quand on relance le provisionnement en root (dubious ownership).
git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
info "Code source : $REPO ($BRANCH) → $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --quiet origin
  git -C "$APP_DIR" checkout --quiet "$BRANCH" 2>/dev/null || true
  git -C "$APP_DIR" pull --quiet --ff-only origin "$BRANCH" || warn "pull : modifications locales non suivies, on continue"
else
  rm -rf "$APP_DIR"
  git clone --quiet --branch "$BRANCH" "https://github.com/$REPO.git" "$APP_DIR" \
    || die "Clonage impossible (repo inaccessible ?)"
fi

# -- 3. Configuration locale ------------------------------------------------------------------------------
[ -n "$TOKEN" ] || warn "Aucun jeton fourni : Easydoc démarre en mode local — connecte ton dépôt GitHub depuis l'interface (⚙️ Réglages, aucune redémarrage nécessaire)."
install -d -o root -g root -m 755 /opt
cat > "$APP_DIR/.env" <<EOF
# Fichier local au conteneur (jamais versionné).
PORT=$PORT
GITHUB_TOKEN=$TOKEN
GITHUB_REPO=$REPO
GITHUB_BRANCH=$BRANCH
EOF
chown root:root "$APP_DIR/.env" && chmod 600 "$APP_DIR/.env"

# -- 4. Dépendances --------------------------------------------------------------------------------------
info "Dépendances (npm install)"
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm install --omit=dev || die "npm install a échoué"

# -- 5. Utilisateur système + droits ---------------------------------------------------------------------
if ! id -u easydoc >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin easydoc
fi
chown -R easydoc:easydoc "$APP_DIR"

# -- 6. Service systemd ----------------------------------------------------------------------------------
install -d -o root -g root -m 755 /etc/systemd/system
cat > /etc/systemd/system/$SERVICE <<UNIT
[Unit]
Description=Easydoc — plateau collaboratif Markdown temps réel (Yjs + GitHub)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=easydoc
Group=easydoc
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload
  systemctl enable --now $SERVICE >/dev/null 2>&1 || systemctl restart $SERVICE
  info "Attente du démarrage (health check)"
  okc=0
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then okc=1; break; fi
    sleep 1
  done
  [ "$okc" = 1 ] || { systemctl status $SERVICE --no-pager 2>&1 | tail -8 || true; die "Le service ne répond pas sur le port $PORT."; }
  ok "Service $SERVICE actif, santé OK sur le port $PORT"
else
  warn "systemd indisponible ici — démarrage manuel : node $APP_DIR/server.js"
fi

echo
ok "${B}Easydoc est prêt : http://$(hostname -I 2>/dev/null | awk '{print $1}')${N}:$PORT (ou :3000 si le champ IP est vide)"
echo "   Journal : journalctl -u $SERVICE -f —  Mise à jour : relancer ce script."