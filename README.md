# Easydoc

Éditeur Markdown **collaboratif en temps réel**, auto-hébergé, dont les documents sont les
fichiers d'un **dépôt GitHub** (ou d'un dépôt git local).

Plusieurs personnes écrivent dans le même document en même temps ; chaque enregistrement
devient un commit. Un agent IA (Claude, un script, un autre outil) peut travailler sur le même
dépôt : ses modifications apparaissent en direct chez tout le monde, fusionnées avec ce qui est
en train d'être tapé.

## Fonctionnalités

- **Édition à plusieurs en temps réel** (CRDT Yjs) : aucune frappe perdue, le curseur reste en place.
- **Présence** : qui est connecté, sur quel document ; **curseur et sélection de chacun** dans le
  texte, avec son nom, en direct.
- **Qui a écrit quoi** (bouton surligneur) : chaque passage est coloré selon son auteur, avec la
  part de chacun et, au survol, le nom et la date. Les modifications de **Claude** (commits avec
  `Co-Authored-By: Claude`, ajouté par défaut par Claude Code) apparaissent sous son nom.
- **Historique** : chaque enregistrement d'un fichier, avec son auteur et le détail des lignes
  ajoutées ou supprimées.
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
- **Comptes et droits d'accès** : chaque personne a son compte. Pour chaque dossier ou fichier,
  l'administrateur choisit qui le voit et qui peut le modifier (*Masqué*, *Lecture seule*,
  *Lecture et modification*), par personne, par groupe ou pour tout le monde. Les changements
  s'appliquent immédiatement, même sur un document déjà ouvert.
- Dépôt GitHub **connecté depuis l'interface** (Administration → Dépôt) : aucun jeton à l'installation.
  **Déconnecter** efface le jeton du serveur et revient aux fichiers locaux (le dépôt GitHub n'est pas touché).
- Fonctionne aussi sans GitHub (dépôt git local) et sans Internet sur le réseau local.

## Démarrage rapide

```bash
npm install
npm start              # http://localhost:3000
```

**Au premier accès, Easydoc demande de créer le compte administrateur** : la première personne
qui ouvre l'adresse le crée (fais-le dès l'installation). Il crée ensuite les comptes des
autres participants dans **Administration → Utilisateurs**.

Easydoc utilise d'abord un dépôt git local (`data/localrepo`) avec quelques documents de
départ. Pour travailler sur GitHub : **Administration** (en bas à gauche) → **Dépôt** → dépôt
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

## Qui a écrit quoi

- Chaque caractère tapé dans Easydoc est attribué **par le serveur** au compte connecté (impossible
  à usurper), avec la date. L'attribution est conservée dans `data/authorship/` (hors du dépôt).
- Le texte modifié par un commit extérieur (Claude, `git push`, autre outil) est attribué à
  l'auteur du commit — **seulement le passage modifié**, pas tout le paragraphe.
- Commits reconnus comme **Claude** : auteur « Claude », adresse `@anthropic.com`, ou ligne
  `Co-Authored-By: Claude …` dans le message (Claude Code l'ajoute par défaut ; le `CLAUDE.md`
  créé par Easydoc demande de la garder). Les autres commits sont attribués à leur auteur git,
  rattaché au compte Easydoc du même identifiant ou du même nom s'il existe.
- Documents existants : à la première ouverture, l'attribution est reconstituée ligne par ligne
  à partir de l'historique git (*blame*).
- Les modifications faites hors d'Easydoc pendant qu'un document est fermé sont attribuées à
  l'auteur du dernier commit du fichier. Une modification du dépôt local sans commit est
  marquée « Modification externe ».

## Comptes et droits d'accès

- **Rôles** : *administrateur* (voit et modifie tout, gère les comptes, les droits et le dépôt)
  ou *membre* (selon les droits). Un compte peut appartenir à des **groupes** (`graphisme`,
  `direction`…) pour donner des droits à plusieurs personnes d'un coup.
- **Droits** (Administration → Droits d'accès, ou le cadenas en haut d'un document ouvert) :
  une règle par dossier ou fichier, avec une ligne par personne, groupe ou « Tout le monde » :
  - *Masqué* : le dossier ou fichier n'apparaît pas du tout (le serveur répond « introuvable ») ;
  - *Lecture seule* : consultation, téléchargement ; toute modification est refusée par le serveur ;
  - *Lecture et modification*.
- **Quelle règle s'applique ?** La plus précise : celle du fichier, sinon de son dossier, puis
  des dossiers parents, puis « Tout le dépôt ». Dans une règle, une ligne pour la personne passe
  avant ses groupes (le droit le plus élevé), qui passent avant « Tout le monde ». Sans aucune
  règle, tous les membres peuvent tout lire et modifier.
- Le panneau affiche, pour chaque compte, le **résultat** effectif sur le dossier ou fichier choisi.
- Retirer un droit, désactiver un compte ou changer un mot de passe coupe **immédiatement** les
  connexions concernées.

**Important : les droits s'appliquent dans Easydoc.** Sur GitHub, toute personne (ou tout agent)
ayant accès au dépôt voit tous les fichiers. Pour des documents vraiment confidentiels, utilise
un dépôt privé et limite qui y a accès sur GitHub.

**Mot de passe oublié** : sur le serveur, `node cli.js reset-password <identifiant>` (ou, sur
Proxmox, `bash easydoc-lxc.sh reset-password <identifiant>`) affiche un nouveau mot de passe.
`node cli.js users` liste les comptes.

## Sécurité

- Mots de passe hachés avec **scrypt** ; seule l'empreinte des jetons de session est conservée.
  Fichiers `data/users.json`, `data/sessions.json`, `data/access.json` en droits 600.
- Session par cookie `HttpOnly`, `SameSite=Lax` (et `Secure` derrière HTTPS), valable 30 jours,
  prolongée à l'usage. Requêtes et WebSocket venant d'un autre site refusés.
- Connexion bloquée 15 min après 8 échecs depuis une même adresse.
- Les droits sont vérifiés côté serveur sur chaque requête et chaque message temps réel ; le nom
  inscrit dans les commits est celui du compte connecté (impossible à usurper).
- Les chemins de fichiers sont validés (impossible de lire ou d'écrire en dehors du dépôt, ni
  les fichiers cachés comme `.git` ou `.env`).
- Sans HTTPS, les mots de passe circulent en clair sur le réseau : en dehors d'un réseau local
  de confiance ou d'un VPN, place Easydoc derrière un proxy HTTPS (voir ci-dessus).

## Configuration (variables d'environnement, toutes facultatives)

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3000` | Port HTTP |
| `DATA_DIR` | `./data` | Configuration, comptes, sessions, droits, auteurs et dépôt local |
| `LOCAL_REPO_DIR` | `$DATA_DIR/localrepo` | Dépôt git local (mode sans GitHub) |
| `AUTOSAVE_MS` | `5000` | Délai d'enregistrement après la dernière frappe |
| `POLL_MS` | `20000` | Fréquence de détection des modifications externes |
| `MAX_UPLOAD_MB` | `25` | Taille maximale d'un fichier importé |
| `GITHUB_TOKEN`, `GITHUB_REPO`, `GITHUB_BRANCH` | — | Préconfiguration, utilisée tant qu'aucun réglage n'a été enregistré depuis l'interface |

## Développement

- `server.js` — serveur HTTP + WebSocket, enregistrement, fusion des modifications externes
- `src/repo.js` — accès au dépôt (API GitHub ou git local) · `src/paths.js` — validation des chemins
- `src/convert.js` — aperçu et conversion des fichiers Word et PDF
- `src/auth.js` — comptes, sessions, droits d'accès · `cli.js` — administration en ligne de commande
- `src/authorship.js` — attribution des auteurs (marquage Yjs, diff, blame, fichiers annexes)
- `public/` — interface (HTML/CSS/JS sans framework)
- `client/libs.js` → `public/vendor/libs.js` : bibliothèques navigateur (Yjs, y-websocket, marked,
  DOMPurify) regroupées en un fichier, servi localement. Après une mise à jour : `npm run build`.
