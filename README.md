# Easydoc

[![Tests](https://github.com/Anthanaab/Easydoc/actions/workflows/tests.yml/badge.svg)](https://github.com/Anthanaab/Easydoc/actions/workflows/tests.yml)

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
- **Commentaires façon Google Docs** : sélectionne un passage puis le
  bouton **+** qui apparaît à droite (ou `Ctrl+Alt+M`). Les discussions s'affichent dans la marge,
  en face de leur passage ; on peut répondre, modifier ses messages, résoudre ou rouvrir une
  discussion. Le passage commenté suit les modifications de tout le monde (y compris celles de
  Claude ou d'un `git push`) et les nouveaux commentaires apparaissent en direct chez chacun.
  Le bouton *Commentaires* liste toutes les discussions (ouvertes ou résolues). Les commentaires
  restent sur le serveur (`data/comments.json`), jamais dans le dépôt.
- **Mentions et notifications** : `@` dans un commentaire propose les personnes (`@identifiant`).
  La personne citée, et celles qui participent déjà à une discussion quand quelqu'un y répond,
  reçoivent une notification (cloche en bas à gauche, et un message en direct si elles sont
  connectées) qui ouvre la discussion. Personne n'est prévenu d'un document qu'il ne voit pas.
- **Historique** : chaque enregistrement d'un fichier, avec son auteur et le détail des lignes
  ajoutées ou supprimées ; *Voir le document à cette version* l'affiche en entier avant de le restaurer.
  Quand quelqu'un restaure une version, les personnes qui ont le document ouvert en sont prévenues.
- **Enregistrement automatique** quelques secondes après la dernière frappe : un seul commit
  pour tous les participants, avec leurs noms dans le message. `Ctrl+S` enregistre tout de suite.
- **Modifications externes** (agent IA, `git push`, autre outil) détectées toutes les 20 s
  et fusionnées en direct, sans écraser la saisie en cours. Un enregistrement ne remplace jamais
  une version du dépôt qu'Easydoc n'a pas encore intégrée : il la fusionne d'abord.
- **Rien ne se perd** :
  - fermer l'onglet alors que des modifications ne sont pas arrivées au serveur (connexion
    coupée) demande une confirmation ;
  - si l'enregistrement échoue (GitHub injoignable, quota dépassé…) au moment où le document
    est fermé ou le serveur arrêté, ses modifications sont gardées dans `data/recovery` et envoyées
    au dépôt dès que possible ; rouvert entre-temps, le document repart de cet état ;
  - ce qui est tapé pendant une coupure de connexion est fusionné, au retour, avec ce que les
    autres ont écrit entre-temps ; si les mêmes lignes ont changé des deux côtés, ta version
    s'affiche pour être recopiée. Ouvert sans temps réel (proxy mal réglé, réseau lent), un document
    repasse tout seul en direct dès que la connexion le permet.
- **Texte mis en forme pendant l'écriture** : titres en grand, gras, italique, listes à puces, cases à
  cocher cliquables, liens, images, citations et blocs de code s'affichent directement ; les symboles
  Markdown (`**`, `#`, `[…](…)`) ne réapparaissent que sur la ligne où se trouve le curseur. Barre de
  mise en forme (gras, titres, listes, tableau, lien…) et raccourcis : `Ctrl+B`, `Ctrl+I`,
  `Ctrl+Maj+1/2/3` (titres), `Ctrl+Maj+7/8/9` (listes), `Ctrl+E` — ils marchent aussi avec un clavier
  AZERTY. `Entrée` continue une liste. Le nombre de mots s'affiche à côté de l'état du document. Les
  fichiers restent du Markdown standard.
- **Tableaux** : affichés en vrai tableau ; un clic fait réapparaître leur texte pour les modifier.
  Le bouton *Tableau* en insère un.
- **Rechercher et remplacer** dans le document ouvert : `Ctrl+F` (`F3` : résultat suivant), avec respect
  de la casse, mot entier ou expression régulière.
- **Plan du document** à gauche du texte, ouvert par défaut quand la place le permet : les titres
  du document, le titre de la partie affichée mis en évidence, un clic pour y aller. Sur un écran
  plus étroit, le bouton *Plan* l'ouvre par-dessus le texte.
- **Liens entre documents** : le bouton *Lien* propose les documents du dépôt (recherche par nom)
  ou une adresse web. `Ctrl+clic` ouvre un lien (sur écran tactile : le toucher, puis *Ouvrir*).
  Le bouton *Précédent* du navigateur revient au document précédent.
- **Page d'accueil** (bouton maison) : favoris (étoile à côté du nom d'un document), documents
  ouverts récemment, documents modifiés récemment par l'équipe.
- **Modèles** à la création d'un document (compte rendu de réunion, note de projet, procédure,
  liste de tâches) et **Dupliquer** (menu « ⋯ »).
- **Recherche** (`Ctrl+K`) dans les noms et le contenu, sans tenir compte des accents ni des
  majuscules (« ete » trouve « Été »), résultats regroupés par document.
- **Exporter ou imprimer** (menu « ⋯ ») : impression ou PDF du document entier mis en page, page
  web `.html` (un seul fichier, images comprises, qui s'ouvre aussi dans Word ou LibreOffice), ou
  le fichier d'origine.
- Dossiers, création et suppression de documents, adresse partageable par document, thème clair ou sombre.
- **Renommer ou déplacer** un document ou un dossier : clic sur le titre du document, `F2`, clic droit
  dans la liste ou menu « ⋯ ». Un seul commit ; commentaires, auteurs, droits d'accès et images du
  document suivent, et les participants qui l'ont ouvert basculent sur le nouveau nom. L'historique
  affiché repart du déplacement (les versions antérieures restent dans git sous l'ancien nom).
  **Les liens qui menaient au document sont mis à jour** dans les autres documents (et ceux du
  document déplacé recalculés depuis son nouveau dossier), en un seul commit.
- **Images dans le texte** : colle une capture d'écran (`Ctrl+V`) ou glisse une image sur le document :
  elle est enregistrée dans le dossier « *nom du document* - images » et s'affiche à cet endroit.
  Un autre fichier glissé sur le texte (PDF, tableur…) est importé à côté du document et un lien
  vers lui est inséré.
- **Autres fichiers** : import par bouton ou glisser-déposer (25 Mo max par fichier). Les PDF et les
  images s'affichent dans la page, les fichiers Word (.docx) en aperçu, les autres (Excel, PowerPoint…)
  se téléchargent. Un Word ou un PDF peut être transformé en **version modifiable** (document
  Markdown, modifiable à plusieurs) ; le fichier d'origine est conservé.
- **Comptes et droits d'accès** : chaque personne a son compte. Pour chaque dossier ou fichier,
  l'administrateur choisit qui le voit et qui peut le modifier (*Masqué*, *Lecture seule*,
  *Lecture et commentaires*, *Lecture et modification*), par personne, par groupe ou pour tout le monde. Les changements
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
- **Docker** : `docker compose up -d` (données dans le volume `easydoc_data`). Easydoc y tourne sous
  le compte `node`, jamais en root (un volume créé par une version précédente lui est rendu au démarrage).
- **Derrière un reverse proxy** (nom de domaine, HTTPS) : le WebSocket doit être relayé, sinon
  l'édition se fait sans temps réel. Exemple nginx :
  ```nginx
  location / {
      proxy_pass http://127.0.0.1:3000;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
  }
  ```
  Et ajoute `TRUST_PROXY=1` dans le `.env` d'Easydoc (`/opt/easydoc/.env` dans le conteneur),
  puis `systemctl restart easydoc` : l'anti-force brute utilise alors l'adresse réelle de chaque
  visiteur (sinon tout le monde aurait celle du proxy) et le cookie de session passe en `Secure`.
  Ne l'active **que** derrière un proxy : sans proxy, n'importe qui pourrait falsifier son adresse.

## Accès depuis Internet (tunnel Cloudflare)

Easydoc intègre un tunnel Cloudflare : accès en **HTTPS** depuis n'importe où, sans ouvrir de
port sur ta box ni installer de proxy.

1. Sur [one.dash.cloudflare.com](https://one.dash.cloudflare.com/) : **Networks → Tunnels →
   Create a tunnel**, type *Cloudflared*.
2. Copie la commande d'installation affichée (elle contient le jeton `eyJ…`) et colle-la dans
   **Administration → Accès Internet** → **Activer le tunnel**. Rien d'autre à installer :
   Easydoc télécharge `cloudflared` depuis les publications officielles de Cloudflare (empreinte
   SHA-256 vérifiée), le lance et le relance s'il s'arrête, y compris après une mise à jour.
3. Onglet **Public Hostname** du tunnel : ton nom de domaine, type *HTTP*, URL `localhost:3000`.
   L'adresse publique s'affiche dans Easydoc (et une erreur si l'URL locale est incorrecte).

Le jeton reste sur le serveur (`data/tunnel.json`, droits 600), n'est jamais réaffiché et est
transmis à `cloudflared` par variable d'environnement (invisible dans la liste des processus).
Les visiteurs passant par le tunnel sont identifiés par leur adresse réelle (anti-force brute)
et leur cookie de session est marqué `Secure`. Crée tous les comptes, avec des mots de passe
solides, avant d'ouvrir l'accès ; pour plus de sûreté, ajoute une règle *Cloudflare Access*
(code par e-mail) devant Easydoc.

## Mise à jour depuis l'interface

**Administration → Mise à jour** : Easydoc vérifie s'il existe une nouvelle version (une pastille
apparaît sur le bouton Administration), affiche la liste des changements et s'installe en un clic :
récupération du code, bibliothèques si elles ont changé, **essai de la nouvelle version** sur un
port et des données temporaires, puis redémarrage (≈ 30 s). Les documents ouverts sont enregistrés
avant le redémarrage, les participants sont reconnectés et la page se recharge toute seule. Si
l'essai échoue, l'ancienne version est remise en place (code et bibliothèques, sans rien
retélécharger). Si la nouvelle version démarre mais plante avec les vraies données, elle est
remplacée automatiquement par la précédente au troisième démarrage raté, et l'erreur s'affiche dans
cet onglet. La mise à jour est refusée si le code du serveur contient des modifications locales
(elle les effacerait).

Disponible pour l'installation Proxmox (clone git lancé par systemd). Le script Proxmox reste
nécessaire quand une version demande un Node.js plus récent (Easydoc le signale) ; avec Docker,
reconstruis l'image.

## Sauvegardes

Le dépôt GitHub garde les documents, mais pas le reste : comptes, droits d'accès, commentaires,
« qui a écrit quoi », réglages, modifications en attente d'enregistrement. En dépôt local, les
documents eux-mêmes ne sont que sur le serveur. **Administration → Sauvegardes** :

- **Sauvegarde automatique chaque jour** (activée par défaut), les 7 dernières gardées dans
  `data/backups/` (nombre réglable).
- **Sauvegarder et télécharger** : une archive à garder ailleurs que sur le serveur.
- En ligne de commande : `node cli.js backup [fichier.tar.gz]` (sur Proxmox, dans le conteneur :
  `cd /opt/easydoc && node cli.js backup`).

L'archive (`.tar.gz` standard) contient le jeton GitHub et les empreintes des mots de passe :
range-la en lieu sûr. Le programme `cloudflared` et les caches n'y sont pas (ils se retéléchargent).

**Restaurer** — Easydoc arrêté, extraire l'archive dans le dossier de données, puis relancer :

```bash
systemctl stop easydoc
tar -xzf easydoc-AAAA-MM-JJ-HHMM.tar.gz -C /opt/easydoc/data
chown -R easydoc:easydoc /opt/easydoc/data   # le service tourne sous l'utilisateur easydoc
systemctl start easydoc
```

## Qui a écrit quoi

- Chaque caractère tapé dans Easydoc est attribué **par le serveur** au compte connecté (impossible
  à usurper), avec la date. L'attribution est conservée dans `data/authorship/` (hors du dépôt).
- Le texte modifié par un commit extérieur (Claude, `git push`, autre outil) est attribué à
  l'auteur du commit — **seulement les mots ajoutés ou modifiés**, pas toute la ligne ni le
  paragraphe (une faute corrigée ne change l'auteur que du mot corrigé).
- Commits reconnus comme **Claude** : auteur « Claude », adresse `@anthropic.com`, ou ligne
  `Co-Authored-By: Claude …` dans le message (Claude Code l'ajoute par défaut ; le `CLAUDE.md`
  créé par Easydoc demande de la garder). Les autres commits sont attribués à leur auteur git,
  rattaché au compte Easydoc du même identifiant ou du même nom s'il existe.
- Documents existants : à la première ouverture, l'attribution est reconstituée en **rejouant
  tout l'historique du fichier**, mot à mot. Un fichier supprimé puis remis (par Claude ou un
  autre) retrouve les auteurs de son texte ; un fichier copié d'une autre branche (par exemple
  une branche `notes` créée par Claude) garde les auteurs de la branche d'origine. Au-delà de
  200 versions, le départ est pris dans l'historique ligne par ligne (*blame*).
- Les modifications faites hors d'Easydoc, document ouvert ou fermé, sont attribuées commit par
  commit à leur auteur. Une modification du dépôt local sans commit est marquée
  « Modification externe ».

## Comptes et droits d'accès

- **Rôles** : *administrateur* (voit et modifie tout, gère les comptes, les droits et le dépôt)
  ou *membre* (selon les droits). Un compte peut appartenir à des **groupes** (`graphisme`,
  `direction`…) pour donner des droits à plusieurs personnes d'un coup.
- **Droits** (Administration → Droits d'accès, ou le cadenas en haut d'un document ouvert) :
  une règle par dossier ou fichier, avec une ligne par personne, groupe ou « Tout le monde » :
  - *Masqué* : le dossier ou fichier n'apparaît pas du tout (le serveur répond « introuvable ») ;
  - *Lecture seule* : consultation, téléchargement ; toute modification est refusée par le serveur ;
  - *Lecture et commentaires* : comme *Lecture seule*, avec en plus les commentaires (relecteurs) ;
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

- Mots de passe hachés avec **scrypt** (paramètres recommandés par l'OWASP ; les anciennes
  empreintes sont refaites à la connexion suivante) ; seule l'empreinte des jetons de session est
  conservée. Fichiers `data/users.json`, `data/sessions.json`, `data/access.json` en droits 600.
- Session par cookie `HttpOnly`, `SameSite=Lax` (et `Secure` derrière HTTPS), valable 30 jours,
  prolongée à l'usage, 90 jours au plus. Requêtes et WebSocket venant d'un autre site refusés.
- Connexion bloquée 15 min après 8 échecs sur un même identifiant (ou 30 depuis une même adresse),
  essais simultanés compris ; même limite pour le mot de passe actuel lors d'un changement.
- Les droits sont vérifiés côté serveur sur chaque requête et chaque message temps réel ; le nom
  inscrit dans les commits est celui du compte connecté (impossible à usurper). Un navigateur ne
  peut modifier que le texte d'un document (jamais les informations tenues par le serveur), et le
  nom affiché dans la présence est toujours celui de son compte.
- Les conversions Word et PDF tournent à part, avec une mémoire et une durée limitées : un fichier
  piégé fait échouer sa conversion, pas le serveur. Les fusions de texte sont limitées dans le temps.
- Les chemins de fichiers sont validés (impossible de lire ou d'écrire en dehors du dépôt, ni
  les fichiers cachés comme `.git` ou `.env`). Un lien symbolique placé dans le dépôt local ne
  mène pas ailleurs sur le serveur. Sur un disque qui ne distingue pas les majuscules (Windows,
  macOS), `INTERNE/` et `Interne/` sont le même dossier, avec les mêmes droits ; les noms que
  Windows lit autrement (point ou espace final, noms courts `~1`) sont refusés.
- Les fichiers importés qui ne s'affichent pas dans la page (`.js`, `.html`…) sont toujours
  servis en téléchargement, jamais comme script ou page d'Easydoc.
- Se déconnecter coupe aussi les connexions temps réel de la session.
- En-têtes de sécurité : interdiction d'afficher Easydoc dans la page d'un autre site
  (*clickjacking*), scripts limités à ceux d'Easydoc (CSP), `nosniff`, pas de fuite d'adresse.
- Dépendances vérifiées avec `npm audit` (aucune vulnérabilité connue à la publication).
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
| `TRUST_PROXY` | `0` (`cloudflared` local toujours reconnu quand le tunnel est actif) | Nombre de reverse proxys de confiance devant Easydoc (`1` derrière nginx, Caddy, Cloudflare Tunnel…) |
| `GITHUB_TOKEN`, `GITHUB_REPO`, `GITHUB_BRANCH` | — | Préconfiguration, utilisée tant qu'aucun réglage n'a été enregistré depuis l'interface |

## Développement

- `server.js` — serveur HTTP + WebSocket, enregistrement, fusion des modifications externes
- `src/repo.js` — accès au dépôt (API GitHub ou git local) · `src/paths.js` — validation des chemins
- `src/convert.js` — aperçu et conversion des fichiers Word et PDF
- `src/auth.js` — comptes, sessions, droits d'accès · `cli.js` — administration en ligne de commande
- `src/authorship.js` — attribution des auteurs (marquage Yjs, diff, blame, fichiers annexes)
- `src/tunnel.js` — tunnel Cloudflare (téléchargement vérifié de cloudflared, supervision, journaux)
- `src/updater.js` — mise à jour depuis l'interface (essai de la nouvelle version, retour arrière)
- `src/backup.js` — sauvegardes des données (archive tar.gz, sauvegardes automatiques)
- `src/wsguard.js` — contrôle des messages temps réel (texte seulement, présence non usurpable)
- `src/links.js` — mise à jour des liens après un déplacement · `src/notify.js` — notifications,
  dernières modifications
- `client/markdown-html.js` — Markdown → HTML (impression, export, tableaux, anciennes versions)
- `public/` — interface (HTML/CSS/JS sans framework)
- `client/editor.js` — l'éditeur (CodeMirror 6 relié au texte partagé par y-codemirror.next) :
  rendu mis en forme, barre et raccourcis de mise en forme, surlignages des auteurs et commentaires
- `client/libs.js` → `public/vendor/libs.js` : bibliothèques navigateur (Yjs, y-websocket, CodeMirror,
  DOMPurify) et l'éditeur, regroupés en un fichier servi localement. **Après toute
  modification de `client/` : `npm run build`** (le fichier construit est versionné).

### Tests

```bash
npm test
```

Une soixantaine de tests (environ une minute, `git` requis), sans toucher aux données réelles : chaque
fichier démarre son propre serveur Easydoc dans un dossier temporaire, sur un port libre, avec un
compte administrateur et un compte membre.

- `test/unitaires.test.js` — ancrage des commentaires, fusion à trois voies, validation des chemins
- `test/securite.test.js` — droits d'accès (y compris les variantes de nom), fichiers importés,
  liens symboliques, origine des requêtes, déconnexion, CSP
- `test/pertes.test.js` — modification externe pendant la frappe, échec d'enregistrement (secours),
  enregistrement hors ligne et conflit, restauration
- `test/fonctions.test.js` — recherche, liens après déplacement, relecteurs, mentions et
  notifications, page d'accueil, modèles, anciennes versions
- `test/fusions.test.js`, `test/deplacement.test.js`, `test/sauvegarde.test.js` — fusions,
  renommage / déplacement, sauvegarde et restauration
- `test/helpers.js` — serveur de test, sessions, connexions temps réel, commits « externes »

À lancer avant chaque version ; un nouveau bug corrigé mérite son test. Sur GitHub, ils tournent
automatiquement à chaque envoi et à chaque demande de fusion (`.github/workflows/tests.yml` : Linux
avec Node 22 et 24, Windows), qui vérifient aussi que `public/vendor/libs.js` a bien été reconstruit.
