# 🐧 Déploiement en LXC (Proxmox VE) — automatisé

Deux scripts, même logique que `Easy3D` :

| Script | Où il tourne | Rôle |
|---|---|---|
| `deploy/easydoc-lxc.sh` | **Hôte Proxmox** (root) | crée le conteneur (menus whiptail), le démarre, y déploie Easydoc |
| `deploy/provision.sh` | **Dans le conteneur** | installe Node.js, clone le code, configure `.env`, crée le service systemd, vérifie la santé |

## Prérequis (hôte Proxmox)

- Un nœud Proxmox VE 7/8/9 accessible en shell root.
- Des stockages « rootdir » et « vztmpl » (presque toujours là).
- Un **jeton GitHub** (scope `repo`) pour que l'app publie les documents — celui que tu utilises déjà.

## Utilisation (hôte Proxmox)

```bash
# 1. Récupérer le script (repo public, aucun jeton requis pour ça)
curl -fsSL https://raw.githubusercontent.com/Anthanaab/Easydoc/main/deploy/easydoc-lxc.sh -o easydoc-lxc.sh
bash easydoc-lxc.sh                 # création guidée : mode « simple » ou « avancé »
```

Le mode **simple** : Debian 12, 2 cœurs, 2 Go, 8 Go, DHCP, non privilégié, démarrage auto.
Le mode **avancé** : tu choisis tout (système Debian 12/13 ou Ubuntu 24.04, IP fixe, ressources,
stockages, réseau…). Un récapitulatif est affiché avant toute création.

Le script : télécharge le template si absent → `pct create` → `pct start` → attend l'accès
Internet → lance `provision.sh` (téléchargé depuis GitHub, donc toujours à jour) → vérifie que
le service répond → affiche **l'URL finale** (`http://IP:3000`).

```bash
bash easydoc-lxc.sh status            # état + URL du service
bash easydoc-lxc.sh update <ctid>     # mise à jour (git pull + npm + restart) — préserve ton jeton
bash easydoc-lxc.sh destroy <ctid>    # supprime le conteneur (avec confirmation)

EASYDOC_DRYRUN=1 bash easydoc-lxc.sh  # simulation : affiche les commandes sans rien créer
EASYDOC_TOKEN=ghp_... bash easydoc-lxc.sh   # fournit le jeton sans le taper dans le menu
```

## Ce que provision.sh fait dans le conteneur

1. Installe **Node.js ≥ 18** (NodeSource, sinon paquet Debian/Ubuntu).
2. Clone `Anthanaab/Easydoc` → `/opt/easydoc` (ou `git pull` si déjà présent).
3. Écrit `/opt/easydoc/.env` (`PORT`, `GITHUB_TOKEN`, `GITHUB_REPO`, `GITHUB_BRANCH`), chmod 600.
   → **le jeton reste dans le conteneur**, jamais dans le repo.
4. `npm install` (production), utilisateur système `easydoc` (sans shell).
5. Service **systemd `easydoc.service`** : redémarrage automatique (`Restart=on-failure`),
   démarrage au boot, `NoNewPrivileges`/`PrivateTmp`.
6. Health check `GET /api/health` avant de conclure.

## Astuces

- **Ton jeton est passé en mode « avancé » ?** Il est stocké dans `/opt/easydoc/.env`
  (lisible seulement par root) — modifiable là ou via `EASYDOC_TOKEN` à la prochaine mise à jour.
- **Service** : `pct enter <ctid>` puis `systemctl status easydoc`, logs : `journalctl -u easydoc -f`.
- **Mise à jour du code** : `bash easydoc-lxc.sh update <ctid>` (ou relancer `provision.sh`).
- **Données** : tout est dans le repo GitHub (mode connecté) ; rien de critique sur le disque du conteneur.