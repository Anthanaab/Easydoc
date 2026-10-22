#!/usr/bin/env bash
# Easydoc — création complète du conteneur LXC sur Proxmox VE, avec menus.
# À lancer sur l'HÔTE Proxmox (shell du nœud, en root) :
#   bash deploy/easydoc-lxc.sh            # création guidée (simple / avancé)
#   bash deploy/easydoc-lxc.sh update     # met à jour un conteneur existant
#   bash deploy/easydoc-lxc.sh status     # état + URL du service
#   bash deploy/easydoc-lxc.sh destroy    # arrête et supprime le conteneur
#
# Le script choisit le système (Debian/Ubuntu), crée le conteneur (CPU, RAM, disque, réseau…),
# le démarre, puis déploie Easydoc depuis GitHub (public) et configure le service auto-démarrage.
# EASYDOC_DRYRUN=1 : affiche les commandes sans rien créer.
set -Eeuo pipefail

REPO="${EASYDOC_REPO:-Anthanaab/Easydoc}"
BRANCH="${EASYDOC_BRANCH:-main}"
TITLE="Easydoc — conteneur LXC"
DRY="${EASYDOC_DRYRUN:-}"
PORT="${EASYDOC_PORT:-3000}"

# -- affichage ------------------------------------------------------------------------------------------
if [ -t 1 ]; then G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; B=$'\e[1m'; N=$'\e[0m'; else G= Y= R= B= N=; fi
info() { echo "${B}==>${N} $*"; }
ok() { echo " ${G}✓${N} $*"; }
warn() { echo " ${Y}!${N} $*"; }
die() { echo " ${R}✗ $*${N}" >&2; exit 1; }
trap 'echo; die "Erreur ligne $LINENO : $BASH_COMMAND"' ERR

run() {  # commande Proxmox (simulée en mode test)
  if [ -n "$DRY" ]; then echo "    [simulation] $(printf '%q ' "$@")" >&2; else "$@"; fi
}

wt() { whiptail --backtitle "Easydoc — plateau collaboratif Markdown temps réel" --title "$TITLE" "$@" 3>&1 1>&2 2>&3; }
cancel() { clear; echo "Opération annulée."; exit 0; }
ask() { local __var="$1" __r; shift; __r="$(wt "$@")" || cancel; printf -v "$__var" '%s' "$__r"; }
msg() { wt --msgbox "$@"; }
yesno() { wt --yesno "$@"; }

# -- vérifications --------------------------------------------------------------------------------------
[ "$(id -u)" -eq 0 ] || die "Lancez ce script en root sur l'hôte Proxmox."
for c in pct pveam pvesm pvesh whiptail; do command -v "$c" >/dev/null || die "Commande « $c » introuvable : ce script doit tourner sur un hôte Proxmox VE."; done

# -- valeurs proposées ----------------------------------------------------------------------------------
CTID="$(pvesh get /cluster/nextid 2>/dev/null || echo 120)"
HN=easydoc
OSV=debian-12
CORES=2
RAM=2048
SWAP=512
DISK=8
NET=dhcp
GW=""
DNS=""
VLAN=""
PASSWORD=""
UNPRIV=1
NESTING=0
ONBOOT=1
TOKEN="${EASYDOC_TOKEN:-}"

mapfile -t ROOT_STORAGES < <(pvesm status -content rootdir 2>/dev/null | awk 'NR>1 {print $1" "$2" "$3}')
mapfile -t TPL_STORAGES < <(pvesm status -content vztmpl 2>/dev/null | awk 'NR>1 {print $1" "$2" "$3}')
[ "${#ROOT_STORAGES[@]}" -gt 0 ] || die "Aucun stockage ne peut accueillir de conteneur (contenu « rootdir »)."
[ "${#TPL_STORAGES[@]}" -gt 0 ] || die "Aucun stockage pour les modèles de conteneur (contenu « vztmpl »)."
STORAGE="$(echo "${ROOT_STORAGES[0]}" | cut -d' ' -f1)"
for s in "${ROOT_STORAGES[@]}"; do [ "${s%% *}" = "local-lvm" ] && STORAGE="local-lvm"; done
TSTORAGE="$(echo "${TPL_STORAGES[0]}" | cut -d' ' -f1)"
for s in "${TPL_STORAGES[@]}"; do [ "${s%% *}" = "local" ] && TSTORAGE="local"; done
mapfile -t BRIDGES < <(ip -o link show type bridge 2>/dev/null | awk -F': ' '{print $2}' | cut -d@ -f1)
[ "${#BRIDGES[@]}" -gt 0 ] || BRIDGES=(vmbr0)

pick_storage() {
  local __var="$1" title="$2"; shift 2
  local cur="${!__var}" items=() s n t
  for s in "$@"; do read -r n t _ <<<"$s"; items+=("$n" "$t" "$([ "$n" = "$cur" ] && echo ON || echo OFF)"); done
  ask "$__var" --radiolist "$title" 16 70 6 "${items[@]}"
}

# -- actions rapides (update / status / destroy) ---------------------------------------------------------
USAGE=create
[ "${1:-}" = update ] && USAGE=update
[ "${1:-}" = status ] && USAGE=status
[ "${1:-}" = destroy ] && USAGE=destroy

if [ "$USAGE" != create ]; then
  [ "${1:-}" = update ] && CTID="${2:-$CTID}"
  list="$(pct list 2>/dev/null | awk -v n="$HN" 'NR>1 && $2==n {print $1}')"
  if [ -z "$list" ]; then
    # dernier conteneur contenant "easydoc" dans sa description
    list="$(pct list 2>/dev/null | awk 'NR>1 {print $1}' | while read -r id; do
      pct config "$id" 2>/dev/null | grep -q "description: .*[Ee]asydoc" && echo "$id"
    done | head -1)"
  fi
  CTID="${CTID:-${list:-}}"
  [ -n "$CTID" ] || die "Conteneur Easydoc introuvable (passer le CTID : $0 $USAGE <ctid>)."
  pct status "$CTID" >/dev/null 2>&1 || die "Conteneur $CTID inexistant."
  case "$USAGE" in
    status)
      echo "État du conteneur $CTID ($HN) : $(pct status "$CTID")"
      if pct status "$CTID" | grep -q running; then
        IP="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')"
        if pct exec "$CTID" -- curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
          ok "Easydoc répond : http://${IP}:$PORT"
        else
          warn "Conteneur actif mais service injoignable (journalctl -u easydoc)."
        fi
      fi
      exit 0;;
    destroy)
      yesno "Supprimer définitivement le conteneur $CTID ($HN) et ses données ?" 10 60 || cancel
      run pct stop "$CTID" 2>/dev/null || true
      run pct destroy "$CTID"
      ok "Conteneur $CTID supprimé."; exit 0;;
    update)
      yesno "Mettre à jour Easydoc dans le conteneur $CTID (git pull + redémarrage) ?" 10 60 || cancel
      INFO="Mise à jour d'Easydoc dans le conteneur $CTID"
      ;;
  esac
fi

# -- menus ----------------------------------------------------------------------------------------------
if [ "$USAGE" = create ]; then
  msg "Ce script va créer un conteneur LXC sur ce serveur Proxmox et y déployer Easydoc.\\n\\nVous pourrez choisir le système, le processeur, la mémoire, le disque et le réseau.\\n\\nAucune modification n'est faite avant la confirmation finale." 13 70
  ask MODE --menu "Type d'installation" 12 70 2 \
    "simple" "Réglages recommandés (Debian 12, 2 cœurs, 2 Go, 8 Go, DHCP)" \
    "avance" "Je choisis tout moi-même"

  if [ "$MODE" = "avance" ]; then
    ask OSV --radiolist "Système d'exploitation du conteneur" 13 70 3 \
      "debian-12" "Debian 12 Bookworm (recommandé)" ON \
      "debian-13" "Debian 13 Trixie" OFF \
      "ubuntu-24.04" "Ubuntu 24.04 LTS" OFF
    while :; do
      ask CTID --inputbox "Numéro du conteneur (CT ID)" 10 60 "$CTID"
      [[ "$CTID" =~ ^[0-9]+$ ]] || { msg "Nombre attendu." 8 50; continue; }
      if pct status "$CTID" >/dev/null 2>&1 || qm status "$CTID" >/dev/null 2>&1; then
        msg "Le numéro $CTID est déjà utilisé." 8 50; continue
      fi
      break
    done
    ask HN --inputbox "Nom du conteneur (nom d'hôte)" 10 60 "$HN"
    ask CORES --inputbox "Nombre de cœurs processeur" 10 60 "$CORES"
    ask RAM --inputbox "Mémoire vive en Mo" 10 60 "$RAM"
    ask SWAP --inputbox "Mémoire d'échange (swap) en Mo" 10 60 "$SWAP"
    ask DISK --inputbox "Taille du disque en Go" 10 60 "$DISK"
    pick_storage STORAGE "Stockage du disque du conteneur" "${ROOT_STORAGES[@]}"
    pick_storage TSTORAGE "Stockage des modèles (template)" "${TPL_STORAGES[@]}"
    items=(); for b in "${BRIDGES[@]}"; do items+=("$b" "pont réseau" "$([ "$b" = "${BRIDGE:-vmbr0}" ] && echo ON || echo OFF)"); done
    BRIDGE="$(echo "${BRIDGES[0]}")"
    ask BRIDGE --radiolist "Pont réseau" 13 70 5 "${items[@]}"
    if yesno "Adresse IP automatique (DHCP) ?\\n\\n« Non » = adresse fixe (conseillé pour un serveur)." 11 70; then
      NET=dhcp
    else
      NET=""
      while :; do
        ask NET --inputbox "Adresse IP fixe avec masque (ex : 192.168.1.50/24)" 10 70 "$NET"
        [[ "$NET" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$ ]] && break
        msg "Format attendu : 192.168.1.50/24" 8 60
      done
      GW="${NET%.*}.1"
      ask GW --inputbox "Passerelle (adresse de votre box / routeur)" 10 70 "$GW"
      ask DNS --inputbox "Serveur DNS (vide = celui de l'hôte Proxmox)" 10 60 ""
    fi
    ask VLAN --inputbox "VLAN (vide = aucun)" 10 60 ""
    [[ -z "$VLAN" || "$VLAN" =~ ^[0-9]+$ ]] || VLAN=""
    yesno "Conteneur non privilégié ? (recommandé, plus sûr)" 8 70 && UNPRIV=1 || UNPRIV=0
    yesno "Démarrer le conteneur automatiquement avec Proxmox ?" 8 70 && ONBOOT=1 || ONBOOT=0
    while :; do
      ask PASSWORD --passwordbox "Mot de passe root du conteneur\\n(vide = accès via « pct enter $CTID » depuis l'hôte)" 11 70 ""
      [ -z "$PASSWORD" ] && break
      ask P2 --passwordbox "Confirmez le mot de passe" 9 70 ""
      [ "$PASSWORD" = "$P2" ] && break
      msg "Les mots de passe ne correspondent pas." 8 50
    done
  fi

  while :; do
    ask TOKEN --passwordbox "Jeton GitHub (scope repo)\\n\\nNécessaire pour que l'app publie les documents (commits) et relise Claude.\\nCommence par ghp_ ou github_pat_ — voir github.com/settings/tokens." 12 74 "$TOKEN"
    [ -z "$TOKEN" ] && { warn "Sans jeton, la publication GitHub échouera — vous pourrez le rajouter dans /opt/easydoc/.env."; break; }
    [[ "$TOKEN" =~ ^(ghp_|github_pat_) ]] && break
    msg "Ce n'est pas un jeton GitHub (il commence par ghp_ ou github_pat_)." 8 70
  done

  case "$OSV" in
    debian-12) TPL_PATTERN='^debian-12-standard'; OSTYPE=debian ;;
    debian-13) TPL_PATTERN='^debian-13-standard'; OSTYPE=debian ;;
    ubuntu-24.04) TPL_PATTERN='^ubuntu-24\.04-standard'; OSTYPE=ubuntu ;;
  esac
  IPLABEL="$([ "$NET" = dhcp ] && echo "automatique (DHCP)" || echo "$NET via $GW")"

  SUMMARY="Conteneur  : $CTID ($HN)
Système    : $OSV
Processeur : $CORES cœur(s)
Mémoire    : $RAM Mo (+ $SWAP Mo de swap)
Disque     : $DISK Go sur $STORAGE
Réseau     : ${BRIDGE:-vmbr0}, IP $IPLABEL${VLAN:+, VLAN $VLAN}
Options    : $([ "$UNPRIV" = 1 ] && echo "non privilégié" || echo "privilégié")$([ "$ONBOOT" = 1 ] && echo ", démarrage auto")
Jeton      : $([ -n "$TOKEN" ] && echo "fourni" || echo "ABSENT (à mettre dans /opt/easydoc/.env)")"
  yesno "Récapitulatif :\\n\\n$SUMMARY\\n\\nCréer le conteneur et déployer Easydoc ?" 20 74 || { clear; echo "Installation annulée."; exit 0; }
  clear
fi

CTID="${CTID:-$(pvesh get /cluster/nextid 2>/dev/null || echo 120)}"

# -- modèle du système (création seule) -------------------------------------------------------------------
if [ "$USAGE" = create ]; then
  info "Modèle du système ($OSV)"
  run pveam update >/dev/null || warn "Mise à jour de la liste des modèles impossible, on continue avec la liste locale"
  TEMPLATE="$(pveam available --section system 2>/dev/null | awk '{print $2}' | grep -E "$TPL_PATTERN" | sort -V | tail -1 || true)"
  [ -n "$TEMPLATE" ] || die "Aucun modèle $OSV trouvé (pveam available --section system)."
  if pveam list "$TSTORAGE" 2>/dev/null | grep -q "$TEMPLATE"; then
    ok "$TEMPLATE déjà présent sur $TSTORAGE"
  else
    info "Téléchargement de $TEMPLATE sur $TSTORAGE"
    run pveam download "$TSTORAGE" "$TEMPLATE"
  fi

  info "Création du conteneur $CTID"
  BRIDGE="${BRIDGE:-$(echo "${BRIDGES[0]}")}"
  NET0="name=eth0,bridge=$BRIDGE,ip=$NET"
  [ "$NET" != dhcp ] && NET0+=",gw=$GW"
  [ -n "$VLAN" ] && NET0+=",tag=$VLAN"
  FEATURES=()
  [ "$NESTING" = 1 ] && FEATURES+=("nesting=1")
  [ "$UNPRIV" = 1 ] && FEATURES+=("keyctl=1")
  FEATURES="$(IFS=,; echo "${FEATURES[*]}")"
  ARGS=(--hostname "$HN" --ostype "$OSTYPE" --cores "$CORES" --memory "$RAM" --swap "$SWAP"
        --rootfs "$STORAGE:$DISK" --net0 "$NET0" --unprivileged "$UNPRIV"
        --onboot "$ONBOOT" --description "Easydoc - plateau collaboratif Markdown temps reel")
  [ -n "$FEATURES" ] && ARGS+=(--features "$FEATURES")
  [ -n "$DNS" ] && ARGS+=(--nameserver "$DNS")
  [ -n "$PASSWORD" ] && ARGS+=(--password "$PASSWORD")
  run pct create "$CTID" "$TSTORAGE:vztmpl/$TEMPLATE" "${ARGS[@]}" >/dev/null
  ok "Conteneur créé"
  run pct start "$CTID"
  ok "Conteneur démarré"

  info "Attente du réseau"
  if [ -z "$DRY" ]; then
    for i in $(seq 1 60); do
      pct exec "$CTID" -- getent hosts github.com >/dev/null 2>&1 && break
      sleep 2
      [ "$i" = 60 ] && die "Le conteneur n'a pas accès à Internet (vérifiez pont, passerelle, DNS)."
    done
  fi
  ok "Internet accessible"
fi

# -- déploiement d'Easydoc -------------------------------------------------------------------------------
info "Déploiement d'Easydoc (quelques minutes)"
run pct exec "$CTID" -- env DEBIAN_FRONTEND=noninteractive \
  EASYDOC_TOKEN="$TOKEN" EASYDOC_REPO="$REPO" EASYDOC_BRANCH="$BRANCH" EASYDOC_PORT="$PORT" bash -c "
    set -e
    curl -fsSL 'https://raw.githubusercontent.com/$REPO/$BRANCH/deploy/provision.sh' -o /tmp/easydoc-provision.sh \
      || { echo 'Provisionnement introuvable sur GitHub' >&2; exit 1; }
    bash /tmp/easydoc-provision.sh"

IP="$( [ -n "$DRY" ] && echo "IP" || pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')"
echo
ok "${B}Easydoc est prêt : http://${IP}:${PORT}${N}"
echo "   Conteneur $CTID ($HN) — console : pct enter $CTID"
echo "   Mise à jour : bash deploy/easydoc-lxc.sh update $CTID"
echo "   Journal : journalctl -u easydoc -f (dans le conteneur)"
[ -z "$DRY" ] && msg "Easydoc a été déployé !\\n\\nOuvrez : http://${IP}:${PORT}\\n\\nConteneur $CTID ($HN)." 12 60 || true