# Déploiement sur Proxmox VE (conteneur LXC)

Deux scripts :

| Script | Où | Rôle |
|---|---|---|
| `easydoc-lxc.sh` | **hôte Proxmox** (root) | crée le conteneur (menus), l'installe, le met à jour, affiche son état, le supprime |
| `provision.sh` | **dans le conteneur** (root) | installe Node.js, le code, les dépendances et le service systemd ; sert aussi aux mises à jour |

Aucun jeton n'est demandé : une fois installé, ouvre l'adresse affichée et connecte ton dépôt
GitHub depuis **Réglages** (en bas à gauche de l'interface).

## Installer

Sur l'hôte Proxmox, en root :

```bash
curl -fsSL https://raw.githubusercontent.com/Anthanaab/Easydoc/main/deploy/easydoc-lxc.sh -o easydoc-lxc.sh
bash easydoc-lxc.sh
```

- **Simple** : Debian 12, 2 cœurs, 1 Go de RAM, 8 Go de disque, DHCP, non privilégié, démarrage auto.
- **Avancé** : système (Debian 12/13, Ubuntu 24.04), numéro, ressources, stockages, pont,
  IP fixe, VLAN, mot de passe root.

Un récapitulatif est affiché avant toute création. À la fin, le script affiche l'adresse
(`http://IP:3000`).

## Gérer

```bash
bash easydoc-lxc.sh update     # met à jour : code, dépendances, redémarrage du service
bash easydoc-lxc.sh status     # état du conteneur et adresse
bash easydoc-lxc.sh destroy    # supprime le conteneur (confirmation demandée)
```

Le conteneur est retrouvé automatiquement ; s'il y en a plusieurs, indique son numéro :
`bash easydoc-lxc.sh update 115`. La mise à jour conserve la configuration (dépôt connecté,
jeton, documents du dépôt local).

Options : `EASYDOC_DRYRUN=1` (simulation, rien n'est créé), `EASYDOC_PORT=8080` (autre port),
`EASYDOC_DOCS_REPO=moi/docs EASYDOC_TOKEN=…` (préconfigurer un dépôt de documents).

## Ce que fait provision.sh

1. Installe Node.js ≥ 18 (NodeSource, sinon le paquet de la distribution).
2. Récupère le code dans `/opt/easydoc` (clone, ou mise à jour forcée sur la branche : un fichier
   modifié localement ne bloque plus la mise à jour).
3. Crée `/opt/easydoc/.env` au premier passage uniquement ; `data/` (dépôt connecté, jeton,
   dépôt local) n'est jamais touché.
4. Installe les dépendances (`npm ci`), crée l'utilisateur système `easydoc`.
5. Écrit le service `easydoc.service`, le **redémarre** et vérifie qu'il répond.

## Dépannage

- Journal : `pct exec <ctid> -- journalctl -u easydoc -n 50`
- Console du conteneur : `pct enter <ctid>`
- Pas d'Internet dans le conteneur : vérifier le pont réseau, la passerelle et le DNS.
- Accès par nom de domaine / HTTPS : le proxy doit relayer le WebSocket (voir le README principal).
