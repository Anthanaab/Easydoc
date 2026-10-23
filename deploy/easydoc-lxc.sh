#!/usr/bin/env bash
# Easydoc — création et gestion du conteneur LXC sur Proxmox VE (menus guidés).
# À lancer sur l'HÔTE Proxmox, en root :
#
#   bash easydoc-lxc.sh                 création guidée (simple / avancé)
#   bash easydoc-lxc.sh update [ctid]   met à jour Easydoc (code + dépendances + redémarrage)
#   bash easydoc-lxc.sh status [ctid]   état et adresse
#   bash easydoc-lxc.sh destroy [ctid]  supprime le conteneur (confirmation demandée)
#   bash easydoc-lxc.sh users [ctid]    liste des comptes Easydoc
#   bash easydoc-lxc.sh reset-password <identifiant> [ctid]
#                                       nouveau mot de passe pour un compte (mot de passe oublié)
#
# Sans numéro, le conteneur Easydoc est retrouvé automatiquement.
# EASYDOC_DRYRUN=1 : affiche les commandes Proxmox sans rien créer.
# Aucun jeton GitHub n'est demandé : le dépôt de documents se connecte depuis l'interface.
set -Eeuo pipefail

REPO="${EASYDOC_REPO:-Anthanaab/Easydoc}"      # dépôt du CODE d'Easydoc
BRANCH="${EASYDOC_BRANCH:-main}"
TITLE="Easydoc — conteneur LXC"
DRY="${EASYDOC_DRYRUN:-}"
DESC_TAG="easydoc-app"                         # repère dans la description du conteneur

if [ -t 1 ]; then G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; B=$'\e[1m'; N=$'\e[0m'; else G= Y= R= B= N=; fi
info() { echo "${B}==>${N} $*"; }
ok() { echo " ${G}✓${N} $*"; }
warn() { echo " ${Y}!${N} $*"; }
die() { echo " ${R}✗ $*${N}" >&2; exit 1; }
trap 'echo; die "Erreur ligne $LINENO : $BASH_COMMAND"' ERR

run() { if [ -n "$DRY" ]; then echo "    [simulation] $(printf '%q ' "$@")" >&2; else "$@"; fi; }
wt() { whiptail --backtitle "Easydoc — éditeur Markdown collaboratif" --title "$TITLE" "$@" 3>&1 1>&2 2>&3; }
cancel() { clear; echo "Opération annulée, rien n'a été modifié."; exit 0; }
ask() { local __var="$1" __r; shift; __r="$(wt "$@")" || cancel; printf -v "$__var" '%s' "$__r"; }
msg() { wt --msgbox "$@" || true; }
yesno() { wt --yesno "$@"; }
ask_int() {  # ask_int VAR "texte" min max
  local __var="$1" text="$2" min="$3" max="$4" __v
  while :; do
    ask __v --inputbox "$text" 10 70 "${!__var}"
    if [[ "$__v" =~ ^[0-9]+$ ]] && [ "$__v" -ge "$min" ] && [ "$__v" -le "$max" ]; then printf -v "$__var" '%s' "$__v"; return; fi
    msg "Valeur invalide : un nombre entre $min et $max." 8 60
  done
}

[ "$(id -u)" -eq 0 ] || die "Lancez ce script en root sur l'hôte Proxmox."
for c in pct pveam pvesm pvesh whiptail curl; do command -v "$c" >/dev/null || die "Commande « $c » introuvable : ce script doit tourner sur un hôte Proxmox VE."; done

# -- retrouver le conteneur Easydoc -------------------------------------------------------------------
find_ct() {
  local id
  for id in $(pct list 2>/dev/null | awk 'NR>1 {print $1}'); do
    if pct config "$id" 2>/dev/null | grep -qiE "description:.*($DESC_TAG|easydoc)|^hostname: *easydoc"; then echo "$id"; return; fi
  done
}
ct_port() { pct exec "$1" -- sh -c "sed -n 's/^PORT=//p' /opt/easydoc/.env 2>/dev/null | head -1" 2>/dev/null || true; }
ct_ip() { pct exec "$1" -- hostname -I 2>/dev/null | awk '{print $1}'; }

ACTION="${1:-create}"
case "$ACTION" in create|update|status|destroy|users|reset-password) ;;
  *) die "Action inconnue : $ACTION (create, update, status, destroy, users, reset-password)";; esac

if [ "$ACTION" = reset-password ]; then LOGIN="${2:-}"; CTARG="${3:-}"; else LOGIN=""; CTARG="${2:-}"; fi

if [ "$ACTION" != create ]; then
  CTID="${CTARG:-$(find_ct)}"
  [ -n "$CTID" ] || die "Conteneur Easydoc introuvable. Indiquez son numéro : bash $0 $ACTION <ctid>"
  pct status "$CTID" >/dev/null 2>&1 || die "Le conteneur $CTID n'existe pas."
  HN="$(pct config "$CTID" | sed -n 's/^hostname: *//p')"
  case "$ACTION" in
    status)
      echo "Conteneur $CTID ($HN) : $(pct status "$CTID" | awk '{print $2}')"
      if pct status "$CTID" | grep -q running; then
        PORT="$(ct_port "$CTID")"; PORT="${PORT:-3000}"
        H="$(pct exec "$CTID" -- curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)"
        if [ -n "$H" ]; then ok "Easydoc répond : http://$(ct_ip "$CTID"):$PORT  ($(echo "$H" | sed -n 's/.*"version":"\([^"]*\)".*/version \1/p'))"
        else warn "Le conteneur tourne mais Easydoc ne répond pas : pct exec $CTID -- journalctl -u easydoc -n 30"; fi
      fi
      exit 0;;
    destroy)
      yesno "Supprimer définitivement le conteneur $CTID ($HN) ?\n\nLes documents enregistrés dans GitHub ne sont pas touchés ; ceux du dépôt local du conteneur seront perdus." 12 70 || cancel
      clear
      run pct stop "$CTID" >/dev/null 2>&1 || true
      run pct destroy "$CTID" --purge
      ok "Conteneur $CTID supprimé."; exit 0;;
    users|reset-password)
      pct status "$CTID" | grep -q running || die "Le conteneur $CTID est arrêté : pct start $CTID"
      pct exec "$CTID" -- test -f /opt/easydoc/cli.js || die "Version d'Easydoc trop ancienne : lancez d'abord « bash $0 update $CTID »."
      if [ "$ACTION" = users ] || [ -z "$LOGIN" ]; then
        echo "Comptes Easydoc du conteneur $CTID :"
        pct exec "$CTID" -- sh -c 'cd /opt/easydoc && node cli.js users'
        [ "$ACTION" = users ] && exit 0
        echo; die "Indiquez l'identifiant : bash $0 reset-password <identifiant> [ctid]"
      fi
      [[ "$LOGIN" =~ ^[a-z0-9._-]+$ ]] || die "Identifiant invalide : $LOGIN"
      pct exec "$CTID" -- sh -c 'cd /opt/easydoc && node cli.js reset-password "$1"' sh "$LOGIN"
      exit 0;;
    update)
      pct status "$CTID" | grep -q running || { info "Démarrage du conteneur $CTID"; run pct start "$CTID"; sleep 3; }
      info "Mise à jour d'Easydoc dans le conteneur $CTID ($HN)";;
  esac
fi

# -- création : valeurs proposées -------------------------------------------------------------------
if [ "$ACTION" = create ]; then
  CTID="$(pvesh get /cluster/nextid 2>/dev/null || echo 120)"
  HN=easydoc; OSV=debian-12; CORES=2; RAM=1024; SWAP=512; DISK=8
  NET=dhcp; GW=""; DNS=""; VLAN=""; PASSWORD=""; UNPRIV=1; ONBOOT=1
  NESTING=1   # recommandé par Proxmox pour systemd récent (évite l'avertissement « enable nesting »)

  mapfile -t ROOT_STORAGES < <(pvesm status -content rootdir 2>/dev/null | awk 'NR>1 {print $1" "$2}')
  mapfile -t TPL_STORAGES < <(pvesm status -content vztmpl 2>/dev/null | awk 'NR>1 {print $1" "$2}')
  [ "${#ROOT_STORAGES[@]}" -gt 0 ] || die "Aucun stockage ne peut accueillir de conteneur (contenu « rootdir »)."
  [ "${#TPL_STORAGES[@]}" -gt 0 ] || die "Aucun stockage pour les modèles de conteneur (contenu « vztmpl »)."
  STORAGE="${ROOT_STORAGES[0]%% *}"; for s in "${ROOT_STORAGES[@]}"; do [ "${s%% *}" = local-lvm ] && STORAGE=local-lvm; done
  TSTORAGE="${TPL_STORAGES[0]%% *}"; for s in "${TPL_STORAGES[@]}"; do [ "${s%% *}" = local ] && TSTORAGE=local; done
  BRIDGES=()
  for d in /sys/class/net/*/bridge; do [ -d "$d" ] && BRIDGES+=("$(basename "$(dirname "$d")")"); done
  [ "${#BRIDGES[@]}" -gt 0 ] || BRIDGES=(vmbr0)
  BRIDGE="${BRIDGES[0]}"; for b in "${BRIDGES[@]}"; do [ "$b" = vmbr0 ] && BRIDGE=vmbr0; done

  pick() {  # pick VAR "titre" éléments…  (liste radio, valeur actuelle présélectionnée)
    local __var="$1" title="$2"; shift 2
    local cur="${!__var}" items=() s n t
    for s in "$@"; do read -r n t <<<"$s"; items+=("$n" "${t:-—}" "$([ "$n" = "$cur" ] && echo ON || echo OFF)"); done
    ask "$__var" --radiolist "$title" 16 70 6 "${items[@]}"
  }

  msg "Ce script crée un conteneur LXC et y installe Easydoc.\n\nAucun compte ni jeton n'est demandé : tu connecteras ton dépôt GitHub ensuite, depuis l'interface.\n\nRien n'est créé avant la confirmation finale." 13 70
  ask MODE --menu "Type d'installation" 12 72 2 \
    simple "Recommandé : Debian 12, 2 cœurs, 1 Go, 8 Go, DHCP" \
    avance "Je choisis tout moi-même"

  if [ "$MODE" = avance ]; then
    ask OSV --radiolist "Système du conteneur" 13 70 3 \
      debian-12 "Debian 12 Bookworm (recommandé)" ON \
      debian-13 "Debian 13 Trixie" OFF \
      ubuntu-24.04 "Ubuntu 24.04 LTS" OFF
    while :; do
      ask_int CTID "Numéro du conteneur (CT ID)" 100 999999999
      if pct status "$CTID" >/dev/null 2>&1 || qm status "$CTID" >/dev/null 2>&1; then msg "Le numéro $CTID est déjà utilisé." 8 50; else break; fi
    done
    while :; do
      ask HN --inputbox "Nom du conteneur (nom d'hôte)" 10 70 "$HN"
      [[ "$HN" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$ ]] && break
      msg "Nom invalide : lettres, chiffres et tirets uniquement." 8 60
    done
    ask_int CORES "Nombre de cœurs" 1 64
    ask_int RAM "Mémoire vive en Mo (1024 suffisent)" 256 262144
    ask_int SWAP "Swap en Mo" 0 65536
    ask_int DISK "Disque en Go" 2 4096
    pick STORAGE "Stockage du disque" "${ROOT_STORAGES[@]}"
    pick TSTORAGE "Stockage des modèles (templates)" "${TPL_STORAGES[@]}"
    BR=(); for b in "${BRIDGES[@]}"; do BR+=("$b pont"); done
    pick BRIDGE "Pont réseau" "${BR[@]}"
    if yesno "Adresse IP automatique (DHCP) ?\n\n« Non » pour une adresse fixe (conseillé : l'adresse d'Easydoc ne changera plus)." 11 70; then
      NET=dhcp
    else
      NET=""
      while :; do
        ask NET --inputbox "Adresse IP fixe avec masque (ex : 192.168.1.50/24)" 10 70 "$NET"
        [[ "$NET" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$ ]] && break
        msg "Format attendu : 192.168.1.50/24" 8 60
      done
      GW="${NET%.*}.1"
      while :; do
        ask GW --inputbox "Passerelle (box / routeur)" 10 70 "$GW"
        [[ "$GW" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] && break
        msg "Format attendu : 192.168.1.1" 8 60
      done
      ask DNS --inputbox "Serveur DNS (vide = celui de l'hôte)" 10 70 ""
    fi
    ask VLAN --inputbox "VLAN (vide = aucun)" 10 60 ""
    [[ -z "$VLAN" || "$VLAN" =~ ^[0-9]+$ ]] || VLAN=""
    if yesno "Conteneur non privilégié ? (recommandé)" 8 70; then UNPRIV=1; else UNPRIV=0; fi
    if yesno "Démarrer automatiquement avec Proxmox ?" 8 70; then ONBOOT=1; else ONBOOT=0; fi
    while :; do
      ask PASSWORD --passwordbox "Mot de passe root du conteneur\n(vide = accès uniquement via « pct enter $CTID »)" 11 70 ""
      [ -z "$PASSWORD" ] && break
      if [ "${#PASSWORD}" -lt 5 ]; then msg "5 caractères minimum." 8 50; continue; fi
      ask P2 --passwordbox "Confirme le mot de passe" 9 70 ""
      [ "$PASSWORD" = "$P2" ] && break
      msg "Les mots de passe ne correspondent pas." 8 50
    done
  fi

  case "$OSV" in
    debian-12) TPL_PATTERN='^debian-12-standard'; OSTYPE=debian ;;
    debian-13) TPL_PATTERN='^debian-13-standard'; OSTYPE=debian ;;
    ubuntu-24.04) TPL_PATTERN='^ubuntu-24\.04-standard'; OSTYPE=ubuntu ;;
  esac
  IPLABEL="$([ "$NET" = dhcp ] && echo "automatique (DHCP)" || echo "$NET via $GW")"
  yesno "Récapitulatif :

Conteneur  : $CTID ($HN)
Système    : $OSV
Processeur : $CORES cœur(s)
Mémoire    : $RAM Mo (+ $SWAP Mo de swap)
Disque     : $DISK Go sur $STORAGE
Réseau     : $BRIDGE, IP $IPLABEL${VLAN:+, VLAN $VLAN}
Options    : $([ "$UNPRIV" = 1 ] && echo "non privilégié" || echo "privilégié"), imbrication$([ "$ONBOOT" = 1 ] && echo ", démarrage auto")

Créer le conteneur et installer Easydoc ?" 21 74 || cancel
  clear

  info "Modèle du système ($OSV)"
  run pveam update >/dev/null || warn "Liste des modèles non mise à jour, on continue avec la liste locale"
  TEMPLATE="$(pveam available --section system 2>/dev/null | awk '{print $2}' | grep -E "$TPL_PATTERN" | sort -V | tail -1 || true)"
  [ -n "$TEMPLATE" ] || die "Aucun modèle $OSV disponible (pveam available --section system)."
  if pveam list "$TSTORAGE" 2>/dev/null | grep -q "$TEMPLATE"; then ok "$TEMPLATE déjà présent sur $TSTORAGE"
  else info "Téléchargement de $TEMPLATE"; run pveam download "$TSTORAGE" "$TEMPLATE"; fi

  info "Création du conteneur $CTID"
  NET0="name=eth0,bridge=$BRIDGE,ip=$NET"
  [ "$NET" != dhcp ] && NET0+=",gw=$GW"
  [ -n "$VLAN" ] && NET0+=",tag=$VLAN"
  FEATURES="nesting=$NESTING"; [ "$UNPRIV" = 1 ] && FEATURES+=",keyctl=1"
  ARGS=(--hostname "$HN" --ostype "$OSTYPE" --cores "$CORES" --memory "$RAM" --swap "$SWAP"
        --rootfs "$STORAGE:$DISK" --net0 "$NET0" --unprivileged "$UNPRIV" --onboot "$ONBOOT"
        --features "$FEATURES" --description "Easydoc — éditeur Markdown collaboratif ($DESC_TAG)")
  [ -n "$DNS" ] && ARGS+=(--nameserver "$DNS")
  [ -n "$PASSWORD" ] && ARGS+=(--password "$PASSWORD")
  run pct create "$CTID" "$TSTORAGE:vztmpl/$TEMPLATE" "${ARGS[@]}" >/dev/null
  ok "Conteneur créé"
  run pct start "$CTID"
  ok "Conteneur démarré"
fi

# -- accès Internet du conteneur ---------------------------------------------------------------------
info "Accès Internet du conteneur"
if [ -z "$DRY" ]; then
  for i in $(seq 1 60); do
    pct exec "$CTID" -- getent hosts github.com >/dev/null 2>&1 && break
    sleep 2
    [ "$i" = 60 ] && die "Le conteneur n'a pas accès à Internet (vérifie le pont réseau, la passerelle et le DNS)."
  done
fi
ok "Internet accessible"

# -- installation / mise à jour ----------------------------------------------------------------------
# Le modèle LXC n'a pas curl : le script d'installation est téléchargé sur l'hôte puis transmis
# au conteneur. Téléchargement par SHA de commit (le cache de GitHub peut servir une version périmée).
info "Installation d'Easydoc (une à deux minutes)"
TMP_PROV="$(mktemp /tmp/easydoc-provision.XXXXXX.sh)"
trap 'rm -f "$TMP_PROV"' EXIT
fetch_prov() { curl -fsSL -m 25 "https://raw.githubusercontent.com/$REPO/$1/deploy/provision.sh" -o "$TMP_PROV" 2>/dev/null && grep -q "PROVISION_VERSION=" "$TMP_PROV"; }
GOT=""
for attempt in 1 2 3; do
  SHA="$(curl -fsSL -m 15 "https://api.github.com/repos/$REPO/commits/$BRANCH" -H "Accept: application/vnd.github.sha" 2>/dev/null || true)"
  if [[ "$SHA" =~ ^[0-9a-f]{40}$ ]] && fetch_prov "$SHA"; then GOT=1; break; fi
  if fetch_prov "$BRANCH"; then GOT=1; break; fi
  [ "$attempt" -lt 3 ] && { warn "Script d'installation indisponible, nouvel essai dans 5 s ($attempt/3)"; sleep 5; }
done
[ -n "$GOT" ] || die "Impossible de télécharger deploy/provision.sh depuis GitHub."

PASS_ENV=(DEBIAN_FRONTEND=noninteractive "EASYDOC_REPO=$REPO" "EASYDOC_BRANCH=$BRANCH")
[ -n "${EASYDOC_PORT:-}" ] && PASS_ENV+=("EASYDOC_PORT=$EASYDOC_PORT")
if [ -n "${EASYDOC_DOCS_REPO:-}" ] && [ -n "${EASYDOC_TOKEN:-}" ]; then PASS_ENV+=("EASYDOC_DOCS_REPO=$EASYDOC_DOCS_REPO" "EASYDOC_TOKEN=$EASYDOC_TOKEN"); fi
if [ -n "$DRY" ]; then
  echo "    [simulation] pct exec $CTID -- env EASYDOC_REPO=$REPO EASYDOC_BRANCH=$BRANCH bash -s < provision.sh" >&2
else
  pct exec "$CTID" -- env "${PASS_ENV[@]}" bash -s < "$TMP_PROV"
fi

if [ -n "$DRY" ]; then IP="IP"; PORT=3000; else IP="$(ct_ip "$CTID")"; PORT="$(ct_port "$CTID")"; PORT="${PORT:-3000}"; fi
echo
ok "${B}Easydoc est prêt : http://${IP}:${PORT}${N}"
echo "   Conteneur $CTID ($HN) — console : pct enter $CTID"
echo "   Mise à jour : bash $0 update    ·    État : bash $0 status"
echo "   Mot de passe oublié : bash $0 reset-password <identifiant>"
[ -z "$DRY" ] && [ "$ACTION" = create ] && msg "Easydoc est installé !\n\nOuvre : http://${IP}:${PORT}\n\nLa première personne qui ouvre cette adresse crée le compte administrateur : fais-le tout de suite.\nEnsuite : comptes et droits d'accès, puis dépôt GitHub, depuis Administration (en bas à gauche)." 15 70
exit 0
