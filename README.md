# Easydoc

Éditeur Markdown **collaboratif en temps réel**, auto-hébergé, dont les documents sont les
fichiers d'un **dépôt GitHub** (ou d'un dépôt git local).

Plusieurs personnes écrivent dans le même document en même temps ; chaque enregistrement
devient un commit. Un agent IA (Claude, un script, un autre outil) peut travailler sur le même
dépôt : ses modifications apparaissent en direct chez tout le monde, fusionnées avec ce qui est
en train d'être tapé.

## Fonctionnalités

- **Édition à plusieurs en temps réel** (CRDT Yjs) : aucune frappe perdue, le curseur reste en place.
- **Présence** : qui est connecté, sur quel document, à quelle ligne.
- **Enregistrement automatique** quelques secondes après la dernière frappe : un seul commit
  pour tous les participants, avec leurs noms dans le message. `Ctrl+S` enregistre tout de suite.
- **Modifications externes** (agent IA, `git push`, autre outil) détectées toutes les 20 s
  et fusionnées en direct, sans écraser la saisie en cours.
- Aperçu Markdown (édition / côte à côte / aperçu), liens entre documents, thème clair ou sombre.
- Dossiers, recherche (`Ctrl+K`), création et suppression de documents, adresse partageable par document.
- **Autres fichiers** : import par bouton ou glisser-déposer (25 Mo max par fichier). Les PDF et les
  images s'affichent dans la page, les fichiers Word (.docx) en aperçu, les autres (Excel, PowerPoint…)
  se téléchargent. Un Word ou un PDF peut être transformé en **version modifiable** (document
  Markdown, modifiable à plusieurs) ; le fichier d'origine est conservé.
- Dépôt GitHub **connecté depuis l'interface** (Réglages) : aucun jeton à l'installation.
  **Déconnecter** efface le jeton du serveur et revient aux fichiers locaux (le dépôt GitHub n'est pas touché).
- Fonctionne aussi sans GitHub (dépôt git local) et sans Internet sur le réseau local.

## Démarrage rapide

```bash
npm install
npm start              # http://localhost:3000
```

Au premier lancement, Easydoc utilise un dépôt git local (`data/localrepo`) avec quelques
documents de départ. Pour travailler sur GitHub : **Réglages** (en bas à gauche) → dépôt
(`propriétaire/dépôt` ou URL) + jeton → **Tester** → **Connecter**. La bascule est immédiate.

Jeton : classique avec la permission `repo`, ou fin (*fine-grained*) avec **Contents :
lecture et écriture** sur le dépôt. Il est stocké côté serveur dans `data/config.json`
(droits 600) et n'est jamais renvoyé au navigateur.

## Travailler avec un agent IA

Easydoc crée un fichier `CLAUDE.md` dans un dépôt vide : ce sont les consignes que Claude Code
lit automatiquement. L'agent travaille sur un clone du même dépôt et pousse ses commits ;
Easydoc les récupère et les affiche en direct (ou tout de suite avec le bouton *Récupérer les
modifications*). En dépôt local, l'agent peut modifier directement les fichiers de `data/localrepo`.

## Déploiement

- **Proxmox (LXC)** — un script, aucun jeton demandé : voir [`deploy/README.md`](deploy/README.md).
  ```bash
  curl -fsSL https://raw.githubusercontent.com/Anthanaab/Easydoc/main/deploy/easydoc-lxc.sh -o easydoc-lxc.sh
  bash easydoc-lxc.sh
  ```
- **Docker** : `docker compose up -d` (données dans le volume `easydoc_data`).
- **Derrière un reverse proxy** (nom de domaine, HTTPS) : le WebSocket doit être relayé, sinon
  l'édition se fait sans temps réel. Exemple nginx :
  ```nginx
  location / {
      proxy_pass http://127.0.0.1:3000;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header Host $host;
  }
  ```

## Sécurité

Easydoc n'a **pas de comptes utilisateurs** : toute personne qui accède à l'adresse peut lire,
modifier et changer le dépôt connecté. Réserve-le à ton réseau local / VPN, ou place-le derrière
un proxy avec authentification. Les chemins de fichiers sont validés côté serveur (impossible de
lire ou d'écrire en dehors du dépôt, ni les fichiers cachés comme `.git` ou `.env`).

## Configuration (variables d'environnement, toutes facultatives)

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3000` | Port HTTP |
| `DATA_DIR` | `./data` | Configuration (`config.json`) et dépôt local |
| `LOCAL_REPO_DIR` | `$DATA_DIR/localrepo` | Dépôt git local (mode sans GitHub) |
| `AUTOSAVE_MS` | `5000` | Délai d'enregistrement après la dernière frappe |
| `POLL_MS` | `20000` | Fréquence de détection des modifications externes |
| `MAX_UPLOAD_MB` | `25` | Taille maximale d'un fichier importé |
| `GITHUB_TOKEN`, `GITHUB_REPO`, `GITHUB_BRANCH` | — | Préconfiguration, utilisée tant qu'aucun réglage n'a été enregistré depuis l'interface |

## Développement

- `server.js` — serveur HTTP + WebSocket, enregistrement, fusion des modifications externes
- `src/repo.js` — accès au dépôt (API GitHub ou git local) · `src/paths.js` — validation des chemins
- `src/convert.js` — aperçu et conversion des fichiers Word et PDF
- `public/` — interface (HTML/CSS/JS sans framework)
- `client/libs.js` → `public/vendor/libs.js` : bibliothèques navigateur (Yjs, y-websocket, marked,
  DOMPurify) regroupées en un fichier, servi localement. Après une mise à jour : `npm run build`.
