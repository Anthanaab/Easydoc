# 🎮 Easydoc — plateau collaboratif Markdown pour ton jeu

Une plateforme **auto-hébergée**, faite sur mesure, pour éditer **en temps réel** les fichiers
Markdown de ton projet, **synchronisés avec un dépôt GitHub** — et où un **agent IA (Claude)**
peut lire, proposer et écrire les mêmes documents.

Conçue pour développer un jeu en équipe : le repository GitHub est la **source de vérité**,
tout le monde (humains + Claude) écrit dans les mêmes `.md`, et chacun voit les mises à jour
de l'autre.

---

## ✨ Ce que ça fait

- 🕐 **Édition temps réel** : plusieurs personnes éditent le même document en même temps
  (fusion sans perte via CRDT **Yjs**, like Google Docs).
- 👥 **Présence + curseurs** : tu vois qui est connecté et où chacun tape (curseurs colorés).
- 📝 **Éditeur Markdown** : saisie en Markdown + **aperçu rendu** en direct.
- 🔗 **Synchronisation GitHub** : appliquer = `commit` + `push` sur ton dépôt ;
  **« Sync agent »** récupère les mises à jour écrites par Claude.
- 📂 **Arborescence du dépôt** : ouvre/édite/crée les documents `.md`, organisés par dossier
  (design-doc, gameplay, roadmap, idées, canal Claude…).
- 🖥️ **Auto-hébergé** : Docker ou `node server.js`, tes fichiers restent chez toi.
- 💾 Sauvegarde auto (1,5 s après modification), **Ctrl+S** pour publier, undo/redo.

## 📁 Structure initiale (créée automatiquement)

```
docs/design-doc.md       vision globale du jeu
docs/gameplay.md         systèmes de gameplay
docs/roadmap.md          phases de développement
ideas/idees.md           liste d'idées
ideas/notes-claude.md    canal où Claude écrit ses notes/propositions
```

## 🚀 Démarrage rapide (mode local, zéro config)

```
cd Easydoc
npm install
cp .env.example .env      # optionnel : renseigne GITHUB_TOKEN / GITHUB_REPO
npm start                 # → http://localhost:3000
```

Sans token GitHub, ça tourne sur un **dépôt git local** (`data/localrepo`) : tout est
auto-hébergé et testable immédiatement.

## 🔗 Pour synchroniser avec ton dépôt GitHub (et collaborer avec Claude)

1. Crée un **Personal Access Token** (classique, scope `repo`) :
   https://github.com/settings/tokens
2. Mets-le dans `.env` (ou les variables d'environnement Docker) :
   ```
   GITHUB_TOKEN=ghp_xxx
   GITHUB_REPO=Anthanaab/mon-jeu
   GITHUB_BRANCH=main
   ```
3. Relance. Easydoc crée alors l'arborescence de docs **dans ton repo GitHub** et lit/écrit
   dedans. Chaque « Publier » = un commit `Easydoc: <auteur>` poussé.

## 🤖 Intégration de Claude (le cœur de ta demande)

- **Claude écrit** dans le même dépôt : clone-le sur une machine où tu lui donnes accès,
  dis-lui de lire `ideas/*.md`, `docs/*.md`, de compléter/écrire. Il fait ses commits.
- **Tu vois ses mises à jour** : ouvre le doc concerné (ou `ideas/notes-claude.md`) puis
  clique **⟳ Sync agent**. Le serveur récupère ses derniers commits et injecte le contenu
  en **temps réel** dans ton éditeur ouvert.
- **Claude voit tes idées** : dès que tu publies, elles sont poussées dans le repo → Claude
  les lit à son prochain `git pull`.
- Tout est un **cycle unique repo GitHub** : pas de silo entre l'outil d'édition et l'IA.

## 🐳 Docker

```
docker compose up -d
```
Variables passées dans `docker-compose.yml` (GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH).
Les données auto-hébergées sont dans le volume `easydoc_data`.

## 🐧 Déploiement LXC (Proxmox) — un seul script

```
curl -fsSL https://raw.githubusercontent.com/Anthanaab/Easydoc/main/deploy/easydoc-lxc.sh -o easydoc-lxc.sh
bash easydoc-lxc.sh        # → conteneur prêt, service auto, URL affichée (http://IP:3000)
```

Création complète du conteneur (menus), déploiement du code, configuration du jeton, service
systemd et health check, avec mise à jour / suppression automatiques.
Détails : [`deploy/README.md`](deploy/README.md).

## ⚙️ Configuration

| Variable | Défaut | Description |
|---|---|---|
| `PORT` | `3000` | Port HTTP de l'interface |
| `GITHUB_TOKEN` | *(vide)* | Token GitHub (scope repo) |
| `GITHUB_REPO` | *(vide)* | Format `proprietaire/repo` |
| `GITHUB_BRANCH` | `main` | Branche de travail |
| `LOCAL_REPO_DIR` | `./data/localrepo` | Dépôt local (si pas de token) |

## 🧪 Tests (temps réel vérifié)

Le cœur "temps réel + fusion" a été validé avec deux clients connectés sur le même doc :
chargement initial du dépôt, écritures croisées visibles en direct, fusion d'éditions
simultanées sans perte, persistance après redémarrage. (Exécutable via un client Yjs / WS.)

## 📦 Stack

Node.js · Express · **Yjs** (CRDT temps réel via WebSocket) · @octokit/rest (GitHub) ·
simple-git (mode local) · marked + DOMPurify (aperçu) · import-map CDN côté client.