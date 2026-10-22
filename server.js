/**
 * server.js — Easydoc
 * Éditeur Markdown collaboratif temps réel (Yjs/WebSocket) adossé à un dépôt git/GitHub.
 *
 * Principes :
 *  - Le document Yjs du serveur fait foi. Les navigateurs s'y synchronisent.
 *  - Le serveur enregistre lui-même (commit) quelques secondes après la dernière
 *    modification, et à la fermeture du document : un seul commit, quel que soit
 *    le nombre de participants.
 *  - Les modifications faites ailleurs (agent IA, autre outil, push git) sont détectées
 *    et fusionnées en direct (fusion à 3 voies via Yjs, sans écraser la saisie en cours).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const Y = require("yjs");
const { Octokit } = require("@octokit/rest");
const yws = require("y-websocket/bin/utils");
const { RepoService } = require("./src/repo");
const { SettingsStore } = require("./src/settings");
const { safeDocPath, safeFilePath, isEditable, kindOf } = require("./src/paths");
const convert = require("./src/convert");
const pkg = require("./package.json");

const ENV_FILE = process.env.ENV_FILE || path.join(__dirname, ".env");
require("dotenv").config({ path: ENV_FILE });

const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 25);
const PUBLIC = path.join(__dirname, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const LOCAL_DIR = process.env.LOCAL_REPO_DIR || path.join(DATA_DIR, "localrepo");
const AUTOSAVE_MS = Number(process.env.AUTOSAVE_MS || 5000);   // délai après la dernière frappe
const AUTOSAVE_MAX_MS = 60000;                                  // au plus tard, même si on tape sans arrêt
const POLL_MS = Number(process.env.POLL_MS || 20000);           // détection des modifications externes
const SYSTEM_DOC = "__system__";
const SERVER = "easydoc-server";                                // origine des transactions du serveur
const TEXT = "content";

// ---- Configuration (connectée depuis l'interface ; .env = valeurs initiales) -----------------
const settings = new SettingsStore(path.join(DATA_DIR, "config.json"));
settings.load();
const fromFile = settings.exists();
const repo = new RepoService({
  githubToken: fromFile ? settings.get().githubToken : process.env.GITHUB_TOKEN || "",
  githubRepo: fromFile ? settings.get().githubRepo : process.env.GITHUB_REPO || "",
  githubBranch: (fromFile ? settings.get().githubBranch : process.env.GITHUB_BRANCH) || "main",
  localRepoDir: LOCAL_DIR,
});

// ---- État par document (survit à la destruction du Y.Doc en mémoire) -------------------------
// name -> { lastCommitted, lastRemote, baseUpdate, dirty, firstDirty, timer, authors:Set, chain:Promise }
const states = new Map();
function st(name) {
  let s = states.get(name);
  if (!s) {
    s = { lastCommitted: null, lastRemote: null, baseUpdate: null, dirty: false, firstDirty: 0,
      timer: null, authors: new Set(), chain: Promise.resolve() };
    states.set(name, s);
  }
  return s;
}
function serialize(name, fn) {
  const s = st(name);
  const run = s.chain.then(fn, fn);
  s.chain = run.catch(() => {});
  return run;
}

/** Remplace le texte par newValue avec un diff préfixe/suffixe (modification minimale). */
function applyDiff(ytext, newValue) {
  const cur = ytext.toString();
  if (cur === newValue) return false;
  let start = 0;
  const max = Math.min(cur.length, newValue.length);
  while (start < max && cur.charCodeAt(start) === newValue.charCodeAt(start)) start++;
  let eCur = cur.length, eNew = newValue.length;
  while (eCur > start && eNew > start && cur.charCodeAt(eCur - 1) === newValue.charCodeAt(eNew - 1)) { eCur--; eNew--; }
  if (eCur > start) ytext.delete(start, eCur - start);
  if (eNew > start) ytext.insert(start, newValue.slice(start, eNew));
  return true;
}

function openDocs() {
  return [...yws.docs.entries()].filter(([name]) => name !== SYSTEM_DOC);
}

function sysMap() {
  return yws.getYDoc(SYSTEM_DOC).getMap("sys");
}
function bump(key) {
  const d = yws.getYDoc(SYSTEM_DOC);
  d.transact(() => d.getMap("sys").set(key, Date.now()), SERVER);
}

function namesFromOrigin(doc, origin) {
  const ids = doc.conns && doc.conns.get(origin);
  const out = [];
  if (ids) {
    for (const id of ids) {
      const s = doc.awareness.getStates().get(id);
      if (s && s.user && s.user.name) out.push(String(s.user.name).slice(0, 40));
    }
  }
  return out;
}

// ---- Enregistrement (commit) --------------------------------------------------------------------
function scheduleSave(name) {
  const s = st(name);
  clearTimeout(s.timer);
  const now = Date.now();
  const delay = Math.max(0, Math.min(AUTOSAVE_MS, s.firstDirty + AUTOSAVE_MAX_MS - now));
  s.timer = setTimeout(() => { commitDoc(name).catch(() => {}); }, delay);
}

function commitDoc(name, extraAuthor, docArg) {
  return serialize(name, async () => {
    const s = st(name);
    clearTimeout(s.timer);
    // docArg : à la fermeture, y-websocket a déjà retiré le document de sa table
    const doc = docArg || yws.docs.get(name);
    if (!doc) return { committed: false };
    const meta = doc.getMap("meta");
    if (!meta.get("loaded")) return { committed: false };
    const content = doc.getText(TEXT).toString();
    const snapshot = Y.encodeStateAsUpdate(doc); // état exact correspondant à `content`
    if (extraAuthor) s.authors.add(String(extraAuthor).slice(0, 40));
    if (content === s.lastCommitted) {
      s.dirty = false; s.firstDirty = 0; s.authors.clear();
      doc.transact(() => { meta.set("savedAt", Date.now()); meta.delete("saveError"); }, SERVER); // « à jour »
      return { committed: false };
    }
    const authors = [...s.authors];
    const msg = `Easydoc : ${name} (${authors.length ? authors.join(", ") : "modification"})`;
    try {
      const r = await repo.writeFile(name, content, msg);
      s.lastCommitted = content;
      s.lastRemote = content;
      s.baseUpdate = snapshot;
      s.authors.clear();
      // d'autres frappes ont pu arriver pendant l'envoi
      const still = doc.getText(TEXT).toString() !== content;
      s.dirty = still;
      s.firstDirty = still ? Date.now() : 0;
      if (still) scheduleSave(name);
      doc.transact(() => {
        meta.set("savedAt", Date.now());
        meta.set("savedBy", authors.join(", "));
        meta.delete("saveError");
      }, SERVER);
      return { committed: r.committed };
    } catch (e) {
      console.error(`[save] ${name} : ${e.message}`);
      doc.transact(() => meta.set("saveError", String(e.message).slice(0, 200)), SERVER);
      clearTimeout(s.timer);
      s.timer = setTimeout(() => { commitDoc(name).catch(() => {}); }, 15000); // nouvel essai
      throw e;
    }
  });
}

async function flushAll() {
  await Promise.all(openDocs().map(([name]) => (st(name).dirty ? commitDoc(name).catch(() => {}) : null)));
}

// ---- Chargement / déchargement des documents (persistance y-websocket) --------------------------
yws.setPersistence({
  bindState: async (name, doc) => {
    if (name === SYSTEM_DOC) return;
    const s = st(name);
    await s.chain; // un enregistrement de ce document est peut-être en cours : on l'attend
    const meta = doc.getMap("meta");
    try {
      const file = await repo.readFile(name);
      const content = file ? file.content : "";
      doc.transact(() => {
        const t = doc.getText(TEXT);
        if (t.length === 0 && content) t.insert(0, content);
        meta.set("loaded", true);
        meta.set("exists", !!file);
      }, SERVER);
      s.lastCommitted = file ? content : null;
      s.lastRemote = s.lastCommitted;
      s.baseUpdate = Y.encodeStateAsUpdate(doc);
      s.dirty = false;
    } catch (e) {
      console.error(`[load] ${name} : ${e.message}`);
      doc.transact(() => meta.set("loadError", String(e.message).slice(0, 200)), SERVER);
    }
    doc.on("update", (_u, origin) => {
      if (origin === SERVER || !meta.get("loaded")) return;
      const s2 = st(name);
      for (const n of namesFromOrigin(doc, origin)) s2.authors.add(n);
      if (!s2.dirty) { s2.dirty = true; s2.firstDirty = Date.now(); }
      scheduleSave(name);
    });
  },
  // dernier participant parti : on enregistre avant de libérer la mémoire
  writeState: async (name, doc) => {
    if (name === SYSTEM_DOC) return;
    if (st(name).dirty) await commitDoc(name, null, doc).catch(() => {});
  },
});

// ---- Modifications externes (agent IA, push git…) : fusion à 3 voies ---------------------------
let lastHead = null;
let lastLocalSig = null;
async function pollExternal(force = false) {
  let headChanged = false;
  if (repo.mode === "github") {
    // une seule requête tant que rien n'a bougé sur la branche
    const head = await repo.headSha();
    if (!force && head === lastHead) return { changed: 0 };
    headChanged = head !== lastHead;
    lastHead = head;
  } else {
    // dépôt local : fichiers ajoutés / supprimés sur le disque (par un agent, un partage réseau…)
    const sig = (await repo.listFiles()).map((f) => `${f.path}:${f.size}`).sort().join("|");
    if (lastLocalSig !== null && sig !== lastLocalSig) headChanged = true;
    lastLocalSig = sig;
  }
  // mode local : lecture directe des fichiers ouverts (un agent peut les modifier sur le disque)
  let changed = 0;
  for (const [name, doc] of openDocs()) {
    const s = st(name);
    if (!doc.getMap("meta").get("loaded")) continue;
    try {
      await serialize(name, async () => {
        const file = await repo.readFile(name);
        if (!file) return;
        if (file.content === s.lastRemote) return; // rien de nouveau
        // base = dernier état connu du dépôt ; on applique base→distant sur une copie,
        // puis on fusionne cette copie dans le document vivant (CRDT : la saisie en cours est préservée)
        const tmp = new Y.Doc();
        if (s.baseUpdate) Y.applyUpdate(tmp, s.baseUpdate);
        const before = Y.encodeStateVector(tmp);
        tmp.transact(() => applyDiff(tmp.getText(TEXT), file.content));
        const delta = Y.encodeStateAsUpdate(tmp, before);
        Y.applyUpdate(doc, delta, SERVER);
        tmp.destroy();
        s.lastRemote = file.content;
        s.lastCommitted = file.content;
        s.baseUpdate = Y.encodeStateAsUpdate(doc);
        if (doc.getText(TEXT).toString() !== file.content) { // il reste de la saisie locale à enregistrer
          s.dirty = true; s.firstDirty = s.firstDirty || Date.now(); scheduleSave(name);
        }
        doc.transact(() => doc.getMap("meta").set("externalAt", Date.now()), SERVER);
        changed++;
      });
    } catch (e) {
      console.error(`[sync] ${name} : ${e.message}`);
    }
  }
  if (headChanged || changed) bump("treeVersion");
  return { changed };
}
setInterval(() => { pollExternal().catch((e) => console.error("[sync]", e.message)); }, POLL_MS).unref();

/**
 * Retire un document de la mémoire et coupe ses connexions. On vide `conns` AVANT de
 * fermer : sinon le gestionnaire de fermeture de y-websocket supprimerait plus tard,
 * par son nom, un éventuel nouveau document ouvert entre-temps.
 */
function detachDoc(name, doc) {
  const conns = [...doc.conns.keys()];
  doc.conns.clear();
  if (yws.docs.get(name) === doc) yws.docs.delete(name);
  for (const c of conns) { try { c.close(4000, "document fermé"); } catch (_e) {} }
  try { doc.destroy(); } catch (_e) {}
}

/** Ferme toutes les sessions (changement de dépôt) après avoir enregistré. */
async function resetDocs() {
  await flushAll();
  for (const [name, doc] of [...yws.docs.entries()]) {
    if (name === SYSTEM_DOC) continue;
    detachDoc(name, doc);
  }
  for (const s of states.values()) clearTimeout(s.timer);
  states.clear();
  lastHead = null;
  lastLocalSig = null;
}

/** Retire le jeton et le dépôt GitHub éventuellement écrits dans le fichier .env. */
function purgeEnvCredentials() {
  try {
    if (!fs.existsSync(ENV_FILE)) return;
    const lines = fs.readFileSync(ENV_FILE, "utf8").split("\n");
    const kept = lines.filter((l) => !/^\s*GITHUB_(TOKEN|REPO|BRANCH)\s*=/.test(l));
    if (kept.length !== lines.length) fs.writeFileSync(ENV_FILE, kept.join("\n"));
  } catch (e) {
    console.error("[settings] nettoyage de .env impossible :", e.message);
  }
  delete process.env.GITHUB_TOKEN; delete process.env.GITHUB_REPO; delete process.env.GITHUB_BRANCH;
}

/** Nom libre : « rapport.pdf » → « rapport (2).pdf » s'il existe déjà (insensible à la casse). */
async function uniquePath(p) {
  const taken = new Set((await repo.listFiles()).map((f) => f.path.toLowerCase()));
  if (!taken.has(p.toLowerCase())) return p;
  const ext = path.posix.extname(p);
  const stem = p.slice(0, p.length - ext.length);
  for (let i = 2; i < 1000; i++) {
    const c = `${stem} (${i})${ext}`;
    if (!taken.has(c.toLowerCase())) return c;
  }
  throw new Error("Trop de fichiers portent ce nom.");
}
const joinPath = (...xs) => xs.filter(Boolean).join("/");
const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const encSeg = (s) => encodeURIComponent(s).replace(/\(/g, "%28").replace(/\)/g, "%29");

// ---- API HTTP ------------------------------------------------------------------------------------
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "5mb" }));
app.use(express.static(PUBLIC, { maxAge: 0, etag: true }));

const bad = (res, code, error) => {
  // jeton GitHub expiré / révoqué : message actionnable plutôt qu'une erreur technique
  if (/Bad credentials|Requires authentication/i.test(String(error))) {
    return res.status(502).json({ ok: false, error: "GitHub refuse le jeton d'accès (expiré ou révoqué). Ouvre Réglages pour en saisir un nouveau ou déconnecter le dépôt." });
  }
  return res.status(code).json({ ok: false, error });
};

app.get("/api/health", (_req, res) => res.json({ ok: true, mode: repo.mode, version: pkg.version }));

app.get("/api/config", (_req, res) => res.json({
  mode: repo.mode,
  repo: repo.mode === "github" ? repo.options.githubRepo : null,
  branch: repo.mode === "github" ? repo.options.githubBranch : null,
  login: repo.mode === "github" ? settings.get().githubLogin || null : null,
  version: settings.get().version,
  appVersion: pkg.version,
  maxUploadMB: MAX_UPLOAD_MB,
}));

app.get("/api/files", async (_req, res) => {
  try { res.json({ ok: true, files: (await repo.listFiles()).map((f) => ({ ...f, kind: kindOf(f.path) })) }); }
  catch (e) { bad(res, 500, e.message); }
});

// Contenu brut d'un fichier : PDF et images affichés dans la page, le reste en téléchargement.
const INLINE_KINDS = new Set(["pdf", "image"]);
app.get("/api/raw", async (req, res) => {
  const p = safeFilePath(String(req.query.path || ""));
  if (!p) return bad(res, 400, "Chemin invalide.");
  try {
    let buf;
    const live = isEditable(p) ? yws.docs.get(p) : null;
    if (live && live.getMap("meta").get("loaded")) buf = Buffer.from(live.getText(TEXT).toString(), "utf8");
    else {
      const f = await repo.readRaw(p);
      if (!f) return bad(res, 404, "Fichier introuvable.");
      buf = f.buf;
    }
    const kind = kindOf(p);
    const ext = path.posix.extname(p).toLowerCase();
    if (kind === "markdown" || kind === "text") res.set("Content-Type", `${kind === "markdown" ? "text/markdown" : "text/plain"}; charset=utf-8`);
    else res.type(ext || "bin");
    const inline = req.query.download !== "1" && INLINE_KINDS.has(kind);
    res.set("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(path.posix.basename(p))}`);
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Cache-Control", "no-store");
    // un SVG ou un fichier HTML ouvert directement ne doit jamais pouvoir exécuter de script
    if (!inline || ext === ".svg") res.set("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    res.send(buf);
  } catch (e) { bad(res, 500, e.message); }
});

// Import d'un fichier (corps de la requête = contenu brut). Un nom déjà pris est complété : « x (2).pdf ».
app.post("/api/upload", express.raw({ type: () => true, limit: MAX_UPLOAD_MB * 1024 * 1024 }), async (req, res) => {
  const wanted = safeFilePath(String(req.query.path || ""));
  if (!wanted) return bad(res, 400, "Nom de fichier non pris en charge.");
  const author = String(req.query.author || "").slice(0, 40);
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  try {
    const target = req.query.replace === "1" ? wanted : await uniquePath(wanted);
    const live = isEditable(target) ? yws.docs.get(target) : null;
    if (live && live.getMap("meta").get("loaded")) {
      live.transact(() => applyDiff(live.getText(TEXT), buf.toString("utf8")), "upload");
      await commitDoc(target, author);
    } else {
      await serialize(target, () => repo.writeFile(target, buf, `Easydoc : import de ${target}${author ? ` (${author})` : ""}`));
    }
    bump("treeVersion");
    res.json({ ok: true, path: target, renamed: target !== wanted });
  } catch (e) { bad(res, 500, e.message); }
});

// Aperçu d'un fichier Word (.docx) en HTML (nettoyé ensuite par le navigateur).
app.get("/api/preview", async (req, res) => {
  const p = safeFilePath(String(req.query.path || ""));
  if (!p || kindOf(p) !== "docx") return bad(res, 400, "Aperçu disponible uniquement pour les fichiers Word (.docx).");
  try {
    const f = await repo.readRaw(p);
    if (!f) return bad(res, 404, "Fichier introuvable.");
    res.json({ ok: true, html: await convert.docxToHtml(f.buf) });
  } catch (e) { bad(res, 422, `Impossible de lire ce fichier Word : ${e.message}`); }
});

// Crée une version modifiable (Markdown) d'un fichier Word ou PDF. L'original n'est pas modifié.
app.post("/api/convert", async (req, res) => {
  const p = safeFilePath(String(req.body.path || ""));
  const kind = p && kindOf(p);
  if (!p || (kind !== "docx" && kind !== "pdf")) return bad(res, 400, "Conversion possible uniquement pour les fichiers Word (.docx) et PDF.");
  const author = String(req.body.author || "").slice(0, 40);
  try {
    const f = await repo.readRaw(p);
    if (!f) return bad(res, 404, "Fichier introuvable.");
    const dir = dirOf(p);
    const stem = path.posix.basename(p).replace(/\.[^.]+$/, "");
    const target = await uniquePath(joinPath(dir, `${stem}.md`));
    const targetStem = path.posix.basename(target).replace(/\.md$/i, "");
    let markdown, images = 0;
    if (kind === "docx") {
      const imgDir = `${targetStem} - images`;
      const pending = [];
      const r = await convert.docxToMarkdown(f.buf, async (name, data) => {
        pending.push({ p: joinPath(dir, imgDir, name), data });
        return `${encSeg(imgDir)}/${encSeg(name)}`;
      });
      for (const im of pending) {
        await serialize(im.p, () => repo.writeFile(im.p, im.data, `Easydoc : image extraite de ${p}`));
      }
      markdown = r.markdown;
      images = r.images;
    } else {
      markdown = await convert.pdfToMarkdown(f.buf, stem);
    }
    await serialize(target, () => repo.writeFile(target, markdown, `Easydoc : version modifiable de ${p}${author ? ` (${author})` : ""}`));
    bump("treeVersion");
    res.json({ ok: true, path: target, images });
  } catch (e) { bad(res, 422, e.message); }
});

app.get("/api/file", async (req, res) => {
  const p = safeDocPath(String(req.query.path || ""));
  if (!p) return bad(res, 400, "Chemin invalide.");
  try {
    const live = yws.docs.get(p);
    if (live && live.getMap("meta").get("loaded")) return res.json({ ok: true, path: p, exists: true, content: live.getText(TEXT).toString() });
    const f = await repo.readFile(p);
    res.json({ ok: true, path: p, exists: !!f, content: f ? f.content : "" });
  } catch (e) { bad(res, 500, e.message); }
});

// Enregistrement immédiat (bouton / Ctrl+S). `content` n'est envoyé que par un client hors ligne.
app.post("/api/save", async (req, res) => {
  const p = safeDocPath(String(req.body.path || ""));
  if (!p) return bad(res, 400, "Chemin invalide.");
  const author = String(req.body.author || "").slice(0, 40);
  try {
    const doc = yws.docs.get(p);
    if (typeof req.body.content === "string") {
      const content = req.body.content;
      if (doc && doc.getMap("meta").get("loaded")) {
        doc.transact(() => applyDiff(doc.getText(TEXT), content), "offline-client");
      } else {
        const r = await serialize(p, () => repo.writeFile(p, content, `Easydoc : ${p} (${author || "modification"})`));
        return res.json({ ok: true, committed: r.committed });
      }
    }
    if (!doc) return res.json({ ok: true, committed: false });
    const r = await commitDoc(p, author);
    res.json({ ok: true, committed: r.committed });
  } catch (e) { bad(res, 500, e.message); }
});

app.post("/api/sync", async (_req, res) => {
  try {
    const r = await pollExternal(true);
    bump("treeVersion");
    res.json({ ok: true, changed: r.changed, mode: repo.mode });
  } catch (e) { bad(res, 500, e.message); }
});

app.post("/api/create", async (req, res) => {
  let raw = String(req.body.path || "").trim();
  if (raw && !/\.(md|markdown|txt)$/i.test(raw)) raw += ".md";
  const p = safeDocPath(raw);
  if (!p) return bad(res, 400, "Nom invalide : lettres, chiffres, espaces, - et _ ; dossiers séparés par /.");
  try {
    if (await repo.readRaw(p)) return bad(res, 409, "Un document porte déjà ce nom.");
    const title = path.posix.basename(p).replace(/\.[^.]+$/, "");
    const initial = /\.txt$/i.test(p) ? "" : `# ${title}\n\n`;
    await serialize(p, () => repo.writeFile(p, initial, `Easydoc : création de ${p}`));
    bump("treeVersion");
    res.json({ ok: true, path: p });
  } catch (e) { bad(res, 500, e.message); }
});

app.delete("/api/file", async (req, res) => {
  const p = safeFilePath(String(req.query.path || ""));
  if (!p) return bad(res, 400, "Chemin invalide.");
  try {
    const doc = isEditable(p) ? yws.docs.get(p) : null;
    const s = st(p);
    clearTimeout(s.timer); s.dirty = false;
    const r = await serialize(p, () => repo.deleteFile(p, `Easydoc : suppression de ${p}`));
    if (doc) {
      doc.transact(() => doc.getMap("meta").set("deleted", Date.now()), SERVER);
      setTimeout(() => detachDoc(p, doc), 300); // laisse le temps aux clients de voir « supprimé »
    }
    states.delete(p);
    bump("treeVersion");
    res.json({ ok: true, deleted: r.deleted });
  } catch (e) { bad(res, 500, e.message); }
});

// ---- Réglages : connecter / changer de dépôt depuis l'interface ----------------------------------
const cleanRepo = (s) => String(s || "").trim()
  .replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");

async function testGithub(token, repoName) {
  const ok = new Octokit({ auth: token });
  let me;
  try { me = await ok.rest.users.getAuthenticated(); }
  catch (e) { throw new Error(e.status === 401 ? "Jeton refusé par GitHub (invalide ou expiré)." : e.message); }
  let info = null;
  if (repoName) {
    const [owner, name] = repoName.split("/");
    try {
      const r = await ok.rest.repos.get({ owner, repo: name });
      info = { full_name: r.data.full_name, default_branch: r.data.default_branch || "main",
        private: r.data.private, canPush: !!(r.data.permissions && r.data.permissions.push) };
    } catch (e) {
      if (e.status === 404) throw new Error(`Dépôt « ${repoName} » introuvable (ou inaccessible avec ce jeton).`);
      throw e;
    }
    if (!info.canPush) throw new Error(`Ce jeton n'a pas le droit d'écrire dans « ${repoName} ».`);
  }
  return { login: me.data.login, repo: info };
}

app.get("/api/settings", (_req, res) => res.json({
  ok: true,
  mode: repo.mode,
  repo: repo.mode === "github" ? repo.options.githubRepo : null,
  branch: repo.mode === "github" ? repo.options.githubBranch : null,
  login: settings.get().githubLogin || null,
  hasToken: !!repo.options.githubToken,
}));

app.post("/api/settings/test", async (req, res) => {
  const token = String(req.body.githubToken || "").trim() || repo.options.githubToken || "";
  const name = cleanRepo(req.body.githubRepo);
  if (!token) return bad(res, 400, "Jeton GitHub requis.");
  if (name && !/^[\w.-]+\/[\w.-]+$/.test(name)) return bad(res, 400, "Format attendu : propriétaire/dépôt");
  try { res.json({ ok: true, ...(await testGithub(token, name)) }); }
  catch (e) { bad(res, 400, e.message); }
});

app.post("/api/settings", async (req, res) => {
  try {
    if (req.body.mode === "local") {
      // déconnexion complète : jeton et dépôt effacés du serveur (config + .env).
      // Le dépôt sur GitHub n'est ni modifié ni supprimé.
      await resetDocs();
      settings.save({ githubToken: "", githubRepo: "", githubBranch: "", githubLogin: "" });
      purgeEnvCredentials();
      await repo.switch({ githubToken: "", githubRepo: "", githubBranch: "" });
      await repo.seedIfEmpty();
      bump("configVersion");
      return res.json({ ok: true, mode: "local" });
    }
    const name = cleanRepo(req.body.githubRepo);
    if (!/^[\w.-]+\/[\w.-]+$/.test(name)) return bad(res, 400, "Format attendu : propriétaire/dépôt");
    const token = String(req.body.githubToken || "").trim() || repo.options.githubToken || "";
    if (!token) return bad(res, 400, "Jeton GitHub requis.");
    const t = await testGithub(token, name);
    const branch = String(req.body.githubBranch || "").trim() || t.repo.default_branch;
    await resetDocs();
    settings.save({ githubToken: token, githubRepo: name, githubBranch: branch, githubLogin: t.login });
    await repo.switch({ githubToken: token, githubRepo: name, githubBranch: branch });
    const seeded = await repo.seedIfEmpty();
    bump("configVersion");
    res.json({ ok: true, mode: "github", repo: name, branch, login: t.login, seeded });
  } catch (e) {
    console.error("[settings]", e.message);
    bad(res, 400, e.message);
  }
});

// Erreurs (fichier trop gros, JSON invalide…) : toujours une réponse JSON lisible.
app.use((err, _req, res, _next) => {
  if (err && err.type === "entity.too.large") return bad(res, 413, `Fichier trop volumineux (maximum ${MAX_UPLOAD_MB} Mo).`);
  if (err && err.type === "entity.parse.failed") return bad(res, 400, "Requête invalide.");
  console.error("[http]", err && err.message);
  bad(res, (err && err.status) || 500, "Erreur interne du serveur.");
});

// ---- Serveur HTTP + WebSocket --------------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 10 * 1024 * 1024 });

server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (conn, req) => {
  let name;
  try { name = decodeURIComponent((req.url || "").split("?")[0].replace(/^\/+/, "")); }
  catch (_e) { name = ""; }
  if (name !== SYSTEM_DOC) name = safeDocPath(name);
  if (!name) { conn.close(1008, "document invalide"); return; }
  yws.setupWSConnection(conn, req, { gc: true, docName: name });
});

async function shutdown(sig) {
  console.log(`${sig} reçu : enregistrement des documents ouverts…`);
  try { await Promise.race([flushAll(), new Promise((r) => setTimeout(r, 8000))]); } catch (_e) {}
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

async function main() {
  await repo.init();
  try { await repo.seedIfEmpty(); } catch (e) { console.error("[seed]", e.message); }
  try { lastHead = await repo.headSha(); } catch (_e) {}
  server.listen(PORT, () => {
    console.log(`Easydoc ${pkg.version} — http://localhost:${PORT} — ${repo.mode === "github"
      ? `GitHub ${repo.options.githubRepo} (${repo.options.githubBranch})` : `local ${LOCAL_DIR}`}`);
  });
}

main().catch((e) => { console.error("Erreur au démarrage :", e); process.exit(1); });
