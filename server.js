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
const auth = require("./src/auth");
const authorship = require("./src/authorship");
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
// Derrière un reverse proxy : nombre de proxys de confiance (adresse réelle des visiteurs via X-Forwarded-For).
const TRUST_PROXY = (() => { const v = String(process.env.TRUST_PROXY || "").trim(); return /^\d+$/.test(v) ? Number(v) : v === "true" ? 1 : 0; })();
const SYSTEM_DOC = "__system__";
const SERVER = "easydoc-server";                                // origine des transactions du serveur
const TEXT = "content";
const ATTR = "easydoc-authorship";                              // origine des marquages d'auteur

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

// ---- Comptes, sessions, droits ----------------------------------------------------------------
const users = new auth.UserStore(path.join(DATA_DIR, "users.json"));
const sessions = new auth.SessionStore(path.join(DATA_DIR, "sessions.json"));
const access = new auth.AccessStore(path.join(DATA_DIR, "access.json"));
const COOKIE = "easydoc_session";

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    try { if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch (_e) {}
  }
  return out;
}
const tokenOf = (req) => parseCookies(req.headers.cookie)[COOKIE];
/** Compte de la requête (cookie de session valide, compte actif, mot de passe inchangé), sinon null. */
function userFromReq(req) {
  const token = tokenOf(req);
  const s = sessions.get(token);
  if (!s) return null;
  const u = users.byId(s.userId);
  if (!u || u.disabled || (u.epoch || 1) !== s.epoch) { sessions.destroy(token); return null; }
  return u;
}
const isHttps = (req) => req.socket.encrypted || (TRUST_PROXY > 0 && String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https");
function setSessionCookie(req, res, token) {
  const maxAge = Math.floor(auth.SESSION_TTL_MS / 1000);
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? "; Secure" : ""}`);
}
function clearSessionCookie(req, res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isHttps(req) ? "; Secure" : ""}`);
}
/** Protection contre les requêtes venant d'un autre site (CSRF, détournement de WebSocket). */
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true; // pas un navigateur, ou requête de la même page sans en-tête Origin
  let host;
  try { host = new URL(o).host; } catch (_e) { return false; }
  const fwd = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
  return host === req.headers.host || (fwd && host === fwd);
}

// ---- Auteurs (qui a écrit quoi) ----------------------------------------------------------------
const authorStore = new authorship.AuthorshipStore(path.join(DATA_DIR, "authorship"));
const repoKey = () => (repo.mode === "github" ? `github:${repo.options.githubRepo}@${repo.options.githubBranch}` : "local");
const keyOfCommit = (c) => authorship.keyFromCommit(c, users);
const keyOfUser = (u) => `u:${u.username}`;
const userAttrs = (u) => ({ a: keyOfUser(u), t: authorship.nowMin() });
const withTimeout = (p, ms) => Promise.race([p, new Promise((_r, rej) => setTimeout(() => rej(new Error("délai dépassé")), ms))]);

const ATTR_V = 2; // version des fichiers annexes : 2 = attribution reconstituée depuis l'historique complet

const historySegments = (name, content, opts) => authorship.historySegments(repo, name, content, keyOfCommit, opts);

/** Versions d'un fichier postérieures au contenu `fromText` : [{ text, a, t }] dans l'ordre. */
async function externalSteps(name, fromText, current) {
  const { list } = await repo.versions(name, { limit: 30 });
  const texts = new Map();
  const textAt = async (c) => { if (!texts.has(c.sha)) texts.set(c.sha, await repo.readAt(name, c.sha)); return texts.get(c.sha); };
  let k = list.length - 1;
  for (; k >= 0; k--) if ((await textAt(list[k])) === fromText) break;
  if (k < 0) return [];
  const steps = [];
  for (const c of list.slice(k + 1)) {
    const text = await textAt(c);
    if (text != null) steps.push({ text, a: keyOfCommit(c), t: authorship.toMin(c.date) });
  }
  return steps.length && steps[steps.length - 1].text === current ? steps : steps.concat([]);
}

/**
 * Attribution d'un document à son ouverture. Retourne { segs, v, later } : `later` est une
 * reconstitution encore en cours (appliquée au document dès qu'elle est prête).
 */
async function initialSegments(name, content) {
  const saved = authorStore.load(repoKey(), name);
  const savedSegs = saved ? authorship.segmentsFrom(saved.text, saved.runs) : null;
  if (saved && saved.v === ATTR_V) {
    if (saved.text === content) return { segs: savedSegs, v: ATTR_V };
    // modifié pendant que le document était fermé : on rejoue les versions postérieures
    try {
      const segs = await withTimeout(historySegments(name, content, { fromText: saved.text, base: savedSegs }), 6000);
      // la frappe en direct (compte précis) prime sur un commit à plusieurs noms
      return { segs: authorship.mergePreferLive(authorship.reconcileSegs(savedSegs, content, { a: "", t: 0 }), segs), v: ATTR_V };
    } catch (e) {
      console.error(`[auteurs] ${name} : ${e.message}`);
      let who = { a: "", t: authorship.nowMin() };
      try { const c = await withTimeout(repo.lastCommit(name), 4000); if (c) who = { a: keyOfCommit(c), t: authorship.toMin(c.date) }; } catch (_e) {}
      return { segs: authorship.reconcile(saved.text, saved.runs, content, who), v: ATTR_V };
    }
  }
  // première ouverture, ou attribution d'une version précédente d'Easydoc : historique complet
  const job = historySegments(name, content).then((segs) => (savedSegs ? authorship.mergePreferLive(savedSegs, segs) : segs));
  try {
    return { segs: await withTimeout(job, 3500), v: ATTR_V };
  } catch (_e) {
    // trop long : le document s'ouvre tout de suite, l'attribution arrive dès qu'elle est prête
    const quick = savedSegs && saved.text === content ? savedSegs : [{ text: content, a: "", t: 0 }];
    return { segs: quick, v: 1, later: job };
  }
}

/** Applique une attribution reconstituée en arrière-plan, si le texte n'a pas changé entre-temps. */
function applyLater(name, doc, content, segs) {
  const s = st(name);
  const live = yws.docs.get(name) === doc;
  if (live) {
    const t = doc.getText(TEXT);
    if (t.toString() !== content) return; // modifié entre-temps : nouvel essai à la prochaine ouverture
    doc.transact(() => {
      let i = 0;
      for (const x of segs) { if (x.a) t.format(i, x.text.length, { a: x.a, t: x.t || 0 }); i += x.text.length; }
    }, ATTR);
  } else if (s.lastCommitted !== content) return;
  s.attrV = ATTR_V;
  authorStore.save(repoKey(), name, content, live ? authorship.runsFromYText(doc.getText(TEXT)) : segs.map((x) => [x.text.length, x.a, x.t]), ATTR_V);
}

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

/** Auteur d'une modification temps réel : le compte de la connexion (non falsifiable). */
function namesFromOrigin(_doc, origin) {
  const u = origin && origin.edUserId ? users.byId(origin.edUserId) : null;
  return u ? [u.displayName] : [];
}

/**
 * Applique les changements de comptes et de droits aux connexions ouvertes :
 * compte supprimé / désactivé / mot de passe changé → déconnexion ; accès retiré → document fermé.
 */
function enforceAccess() {
  for (const [name, doc] of [...yws.docs.entries()]) {
    for (const conn of [...doc.conns.keys()]) {
      const u = users.byId(conn.edUserId);
      if (!u || u.disabled || (u.epoch || 1) !== conn.edEpoch) { try { conn.close(4001, "session terminée"); } catch (_e) {} continue; }
      if (name !== SYSTEM_DOC && !access.can(u, name, "read")) { try { conn.close(4003, "accès retiré"); } catch (_e) {} }
    }
  }
}
setInterval(enforceAccess, 5000).unref(); // prend aussi en compte les changements faits en ligne de commande

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
    const runs = authorship.runsFromYText(doc.getText(TEXT));
    const rk = repoKey();
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
      authorStore.save(rk, name, content, runs, s.attrV || ATTR_V);
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
      const init = content ? await initialSegments(name, content) : { segs: [], v: ATTR_V };
      doc.transact(() => {
        const t = doc.getText(TEXT);
        if (t.length === 0 && content) authorship.insertSegments(t, init.segs);
        meta.set("loaded", true);
        meta.set("exists", !!file);
      }, SERVER);
      s.attrV = init.v;
      if (content && init.v === ATTR_V) authorStore.save(repoKey(), name, content, authorship.runsFromYText(doc.getText(TEXT)), ATTR_V);
      if (init.later) {
        init.later.then((segs) => applyLater(name, doc, content, segs))
          .catch((e) => console.error(`[auteurs] historique de ${name} indisponible : ${e.message}`));
      }
      s.lastCommitted = file ? content : null;
      s.lastRemote = s.lastCommitted;
      s.baseUpdate = Y.encodeStateAsUpdate(doc);
      s.dirty = false;
    } catch (e) {
      console.error(`[load] ${name} : ${e.message}`);
      doc.transact(() => meta.set("loadError", String(e.message).slice(0, 200)), SERVER);
    }
    // Texte tapé dans un navigateur : marqué au nom du compte de la connexion.
    const ytext = doc.getText(TEXT);
    ytext.observe((ev) => {
      const origin = ev.transaction.origin;
      if (!origin || !origin.edUserId) return;
      const u = users.byId(origin.edUserId);
      if (!u) return;
      const ranges = [];
      let i = 0;
      for (const op of ev.delta) {
        if (op.retain) i += op.retain;
        else if (typeof op.insert === "string") { ranges.push([i, op.insert.length]); i += op.insert.length; }
      }
      if (!ranges.length) return;
      const attrs = userAttrs(u);
      doc.transact(() => { for (const [at, len] of ranges) ytext.format(at, len, attrs); }, ATTR);
    });
    doc.on("update", (_u, origin) => {
      if (origin === SERVER || origin === ATTR || !meta.get("loaded")) return;
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
        // chaque commit intervenu depuis le dernier état connu, dans l'ordre, avec son auteur
        let steps = [];
        try { steps = await withTimeout(externalSteps(name, s.lastRemote, file.content), 8000); } catch (_e) {}
        if (!steps.length || steps[steps.length - 1].text !== file.content) {
          let who = { a: repo.mode === "local" ? "x:Modification externe" : "", t: authorship.nowMin() };
          if (repo.mode !== "local" || !steps.length) {
            try { const c = await withTimeout(repo.lastCommit(name), 8000); if (c) who = { a: keyOfCommit(c), t: authorship.toMin(c.date) }; } catch (_e) {}
          }
          steps.push({ text: file.content, a: who.a, t: who.t });
        }
        const who = steps[steps.length - 1];
        const tmp = new Y.Doc();
        if (s.baseUpdate) Y.applyUpdate(tmp, s.baseUpdate);
        const before = Y.encodeStateVector(tmp);
        tmp.transact(() => { for (const x of steps) authorship.applyFineDiff(tmp.getText(TEXT), x.text, x.a ? { a: x.a, t: x.t } : {}); });
        const delta = Y.encodeStateAsUpdate(tmp, before);
        Y.applyUpdate(doc, delta, SERVER);
        tmp.destroy();
        s.lastRemote = file.content;
        s.lastCommitted = file.content;
        s.baseUpdate = Y.encodeStateAsUpdate(doc);
        if (doc.getText(TEXT).toString() !== file.content) { // il reste de la saisie locale à enregistrer
          s.dirty = true; s.firstDirty = s.firstDirty || Date.now(); scheduleSave(name);
        }
        doc.transact(() => {
          doc.getMap("meta").set("externalBy", authorship.nameOfKey(who.a, users) || "");
          doc.getMap("meta").set("externalAt", Date.now());
        }, SERVER);
        authorStore.save(repoKey(), name, doc.getText(TEXT).toString(), authorship.runsFromYText(doc.getText(TEXT)), s.attrV || ATTR_V);
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
app.set("trust proxy", TRUST_PROXY);

// En-têtes de sécurité : pas d'affichage dans la page d'un autre site (clickjacking), scripts
// limités à ceux d'Easydoc (le petit script de thème en ligne est autorisé par son empreinte).
const INLINE_SCRIPT_HASHES = (() => {
  try {
    const html = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
    return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${require("crypto").createHash("sha256").update(m[1]).digest("base64")}'`);
  } catch (_e) { return []; }
})();
const APP_CSP = [
  "default-src 'self'", `script-src 'self' ${INLINE_SCRIPT_HASHES.join(" ")}`.trim(), "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:", "connect-src 'self' ws: wss:", "frame-src 'self'", "object-src 'none'",
  "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join("; ");
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "same-origin");
  res.set("Cross-Origin-Opener-Policy", "same-origin");
  res.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // /api/raw sert des PDF affichés DANS Easydoc (même origine) : SAMEORIGIN au lieu de DENY
  if (req.path === "/api/raw") res.set("X-Frame-Options", "SAMEORIGIN");
  else { res.set("X-Frame-Options", "DENY"); res.set("Content-Security-Policy", APP_CSP); }
  next();
});
app.disable("x-powered-by");
app.use(express.json({ limit: "5mb" }));
app.use(express.static(PUBLIC, { maxAge: 0, etag: true }));

const bad = (res, code, error) => {
  if (res.headersSent) return;
  // jeton GitHub expiré / révoqué : message actionnable plutôt qu'une erreur technique
  if (/Bad credentials|Requires authentication/i.test(String(error))) {
    return res.status(502).json({ ok: false, error: "GitHub refuse le jeton d'accès (expiré ou révoqué). Un administrateur peut en saisir un nouveau (Administration → Dépôt) ou déconnecter le dépôt." });
  }
  return res.status(code).json({ ok: false, error });
};

app.get("/api/health", (_req, res) => res.json({ ok: true, mode: repo.mode, version: pkg.version }));

// Authentification : toute l'API exige une session, sauf ces routes.
const PUBLIC_API = new Set(["/api/health", "/api/auth/state", "/api/auth/login", "/api/auth/setup"]);
app.use("/api", (req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) return bad(res, 403, "Requête refusée (origine différente).");
  req.user = userFromReq(req);
  if (PUBLIC_API.has(req.originalUrl.split("?")[0])) return next();
  if (!req.user) return bad(res, 401, "Session expirée : reconnecte-toi.");
  next();
});
const adminOnly = (req, res, next) => (req.user && req.user.role === "admin" ? next() : bad(res, 403, "Réservé aux administrateurs."));
/** Vérifie un droit ; un fichier masqué répond « introuvable » (on ne révèle pas son existence). */
function allow(req, res, p, need) {
  const lvl = access.level(req.user, p);
  if (auth.RANK[lvl] >= auth.RANK[need]) return true;
  if (lvl === "none") bad(res, 404, "Fichier introuvable.");
  else bad(res, 403, "Tu as un accès en lecture seule ici : modification impossible.");
  return false;
}
const errStatus = (e, fallback = 400) => (e && e.status) || fallback;

// ---- Comptes ------------------------------------------------------------------------------------
const loginFails = new Map(); // ip → { n, until }
const clientIp = (req) => (TRUST_PROXY ? req.ip : req.socket.remoteAddress) || "?";
function tooManyFails(ip) { const a = loginFails.get(ip); return !!(a && a.until > Date.now() && a.n >= 8); }
function noteFail(ip) {
  let a = loginFails.get(ip);
  if (!a || a.until < Date.now()) a = { n: 0, until: Date.now() + 15 * 60 * 1000 };
  a.n++;
  loginFails.set(ip, a);
}

app.get("/api/auth/state", (req, res) => res.json({
  ok: true, setupRequired: users.count() === 0, user: req.user ? auth.publicUser(req.user) : null,
}));

// Premier démarrage : création du compte administrateur (possible une seule fois).
app.post("/api/auth/setup", async (req, res) => {
  if (users.count() > 0) return bad(res, 409, "Le compte administrateur existe déjà.");
  try {
    const u = await users.create({ ...req.body, role: "admin", groups: [] }, { onlyIfEmpty: true });
    setSessionCookie(req, res, sessions.create(u));
    console.log(`[auth] compte administrateur créé : ${u.username}`);
    res.json({ ok: true, user: auth.publicUser(u) });
  } catch (e) { bad(res, errStatus(e), e.message); }
});

app.post("/api/auth/login", async (req, res) => {
  const ip = clientIp(req);
  if (tooManyFails(ip)) return bad(res, 429, "Trop de tentatives : réessaie dans quelques minutes.");
  const u = users.byUsername(req.body.username);
  const ok = await auth.verifyPassword(String(req.body.password || ""), u && u.hash);
  if (!u || !ok) { noteFail(ip); return bad(res, 401, "Identifiant ou mot de passe incorrect."); }
  if (u.disabled) return bad(res, 403, "Ce compte est désactivé. Contacte un administrateur.");
  loginFails.delete(ip);
  setSessionCookie(req, res, sessions.create(u));
  res.json({ ok: true, user: auth.publicUser(u) });
});

app.post("/api/auth/logout", (req, res) => {
  sessions.destroy(tokenOf(req));
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.post("/api/auth/profile", async (req, res) => {
  try {
    const u = await users.update(req.user.id, { displayName: req.body.displayName });
    res.json({ ok: true, user: auth.publicUser(u) });
  } catch (e) { bad(res, errStatus(e), e.message); }
});

app.post("/api/auth/password", async (req, res) => {
  try {
    if (!(await auth.verifyPassword(String(req.body.current || ""), req.user.hash))) return bad(res, 400, "Mot de passe actuel incorrect.");
    const u = await users.update(req.user.id, { password: req.body.next });
    setSessionCookie(req, res, sessions.create(u)); // les autres sessions de ce compte sont fermées
    enforceAccess();
    res.json({ ok: true });
  } catch (e) { bad(res, errStatus(e), e.message); }
});

// ---- Administration des comptes -------------------------------------------------------------------
app.get("/api/admin/users", adminOnly, (_req, res) => res.json({ ok: true, users: users.all().map(auth.publicUser), groups: users.groups() }));

app.post("/api/admin/users", adminOnly, async (req, res) => {
  try {
    const u = await users.create(req.body);
    res.json({ ok: true, user: auth.publicUser(u) });
  } catch (e) { bad(res, errStatus(e), e.message); }
});

app.patch("/api/admin/users/:id", adminOnly, async (req, res) => {
  try {
    const b = req.body || {};
    if (req.params.id === req.user.id && b.disabled) return bad(res, 409, "Tu ne peux pas désactiver ton propre compte.");
    const u = await users.update(req.params.id, {
      displayName: b.displayName, groups: b.groups, role: b.role, disabled: b.disabled, password: b.password || undefined,
    });
    enforceAccess();
    bump("treeVersion"); // les listes de fichiers visibles peuvent changer (rôle, groupes)
    res.json({ ok: true, user: auth.publicUser(u) });
  } catch (e) { bad(res, errStatus(e), e.message); }
});

app.delete("/api/admin/users/:id", adminOnly, (req, res) => {
  try {
    if (req.params.id === req.user.id) return bad(res, 409, "Tu ne peux pas supprimer ton propre compte.");
    const u = users.remove(req.params.id);
    sessions.destroyUser(u.id);
    access.removeUser(u.username);
    enforceAccess();
    res.json({ ok: true });
  } catch (e) { bad(res, errStatus(e), e.message); }
});

// ---- Administration des droits d'accès ------------------------------------------------------------
const rulePath = (v) => {
  const s = String(v == null ? "" : v).trim().replace(/^\/+|\/+$/g, "");
  return s === "" ? "" : safeFilePath(s);
};
const effective = (p) => users.all().map((u) => ({ id: u.id, username: u.username, displayName: u.displayName, role: u.role, disabled: !!u.disabled, level: access.level(u, p) }));

app.get("/api/admin/access", adminOnly, (_req, res) => {
  const groups = new Map();
  for (const g of [...users.groups(), ...access.groups()]) groups.set(g.toLowerCase(), g);
  res.json({ ok: true, rules: access.rules, groups: [...groups.values()].sort((a, b) => a.localeCompare(b, "fr")), users: users.all().map(auth.publicUser) });
});

app.get("/api/admin/access/effective", adminOnly, (req, res) => {
  const p = rulePath(req.query.path);
  if (p === null) return bad(res, 400, "Chemin invalide.");
  res.json({ ok: true, path: p, users: effective(p) });
});

app.put("/api/admin/access", adminOnly, (req, res) => {
  const p = rulePath(req.body.path);
  if (p === null) return bad(res, 400, "Chemin invalide.");
  try {
    access.setRule(p, req.body.entries);
    enforceAccess();
    bump("treeVersion");
    res.json({ ok: true, path: p, rule: access.rules[p] || null, users: effective(p) });
  } catch (e) { bad(res, 400, e.message); }
});

app.get("/api/config", (_req, res) => res.json({
  mode: repo.mode,
  repo: repo.mode === "github" ? repo.options.githubRepo : null,
  branch: repo.mode === "github" ? repo.options.githubBranch : null,
  login: repo.mode === "github" ? settings.get().githubLogin || null : null,
  version: settings.get().version,
  appVersion: pkg.version,
  maxUploadMB: MAX_UPLOAD_MB,
}));

app.get("/api/files", async (req, res) => {
  try {
    const out = [];
    for (const f of await repo.listFiles()) {
      const level = access.level(req.user, f.path);
      if (level !== "none") out.push({ ...f, kind: kindOf(f.path), access: level });
    }
    res.json({ ok: true, files: out, role: req.user.role });
  }
  catch (e) { bad(res, 500, e.message); }
});

// Contenu brut d'un fichier : PDF et images affichés dans la page, le reste en téléchargement.
const INLINE_KINDS = new Set(["pdf", "image"]);
app.get("/api/raw", async (req, res) => {
  const p = safeFilePath(String(req.query.path || ""));
  if (!p) return bad(res, 400, "Chemin invalide.");
  if (!allow(req, res, p, "read")) return;
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
  if (!allow(req, res, wanted, "write")) return;
  const author = req.user.displayName;
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  try {
    const target = req.query.replace === "1" ? wanted : await uniquePath(wanted);
    if (target !== wanted && !allow(req, res, target, "write")) return;
    const live = isEditable(target) ? yws.docs.get(target) : null;
    if (live && live.getMap("meta").get("loaded")) {
      live.transact(() => authorship.applyFineDiff(live.getText(TEXT), buf.toString("utf8"), userAttrs(req.user)), "upload");
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
  if (!allow(req, res, p, "read")) return;
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
  if (!allow(req, res, p, "read")) return;
  const author = req.user.displayName;
  try {
    const f = await repo.readRaw(p);
    if (!f) return bad(res, 404, "Fichier introuvable.");
    const dir = dirOf(p);
    const stem = path.posix.basename(p).replace(/\.[^.]+$/, "");
    const target = await uniquePath(joinPath(dir, `${stem}.md`));
    if (!access.can(req.user, target, "write")) return bad(res, 403, "Tu n'as pas le droit d'ajouter des documents dans ce dossier.");
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
  if (!allow(req, res, p, "read")) return;
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
  if (!allow(req, res, p, "write")) return;
  const author = req.user.displayName;
  try {
    const doc = yws.docs.get(p);
    if (typeof req.body.content === "string") {
      const content = req.body.content;
      if (doc && doc.getMap("meta").get("loaded")) {
        doc.transact(() => authorship.applyFineDiff(doc.getText(TEXT), content, userAttrs(req.user)), "offline-client");
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

// ---- Auteurs et historique ------------------------------------------------------------------------
app.get("/api/people", (_req, res) => {
  res.json({ ok: true, people: users.all().map((u) => ({ key: keyOfUser(u), username: u.username, name: u.displayName })) });
});

app.get("/api/history", async (req, res) => {
  const p = safeFilePath(String(req.query.path || ""));
  if (!p) return bad(res, 400, "Chemin invalide.");
  if (!allow(req, res, p, "read")) return;
  try {
    const list = await repo.history(p, 60);
    res.json({
      ok: true, mode: repo.mode,
      commits: list.map((c) => {
        const key = keyOfCommit(c);
        return { sha: c.sha, date: c.date, key, name: authorship.nameOfKey(key, users), title: String(c.message || "").split("\n")[0].slice(0, 200), additions: c.additions, deletions: c.deletions };
      }),
    });
  } catch (e) { bad(res, 502, "Historique indisponible : " + e.message); }
});

app.get("/api/history/diff", async (req, res) => {
  const p = safeFilePath(String(req.query.path || ""));
  if (!p) return bad(res, 400, "Chemin invalide.");
  if (!allow(req, res, p, "read")) return;
  try {
    const d = await repo.commitDiff(p, String(req.query.sha || ""));
    res.json({ ok: true, patch: String(d.patch || "").slice(0, 400000), binary: !!d.binary, status: d.status });
  } catch (e) { bad(res, 400, e.message); }
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
  if (!access.can(req.user, p, "write")) return bad(res, 403, "Tu n'as pas le droit de créer un document à cet endroit.");
  try {
    if (await repo.readRaw(p)) return bad(res, 409, "Un document porte déjà ce nom.");
    const title = path.posix.basename(p).replace(/\.[^.]+$/, "");
    const initial = /\.txt$/i.test(p) ? "" : `# ${title}\n\n`;
    await serialize(p, () => repo.writeFile(p, initial, `Easydoc : création de ${p} (${req.user.displayName})`));
    bump("treeVersion");
    res.json({ ok: true, path: p });
  } catch (e) { bad(res, 500, e.message); }
});

app.delete("/api/file", async (req, res) => {
  const p = safeFilePath(String(req.query.path || ""));
  if (!p) return bad(res, 400, "Chemin invalide.");
  if (!allow(req, res, p, "write")) return;
  try {
    const doc = isEditable(p) ? yws.docs.get(p) : null;
    const s = st(p);
    clearTimeout(s.timer); s.dirty = false;
    const r = await serialize(p, () => repo.deleteFile(p, `Easydoc : suppression de ${p} (${req.user.displayName})`));
    if (doc) {
      doc.transact(() => doc.getMap("meta").set("deleted", Date.now()), SERVER);
      setTimeout(() => detachDoc(p, doc), 300); // laisse le temps aux clients de voir « supprimé »
    }
    states.delete(p); // l'annexe des auteurs est conservée : si le fichier est remis, son texte retrouve ses auteurs
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

app.get("/api/settings", adminOnly, (_req, res) => res.json({
  ok: true,
  mode: repo.mode,
  repo: repo.mode === "github" ? repo.options.githubRepo : null,
  branch: repo.mode === "github" ? repo.options.githubBranch : null,
  login: settings.get().githubLogin || null,
  hasToken: !!repo.options.githubToken,
}));

app.post("/api/settings/test", adminOnly, async (req, res) => {
  const token = String(req.body.githubToken || "").trim() || repo.options.githubToken || "";
  const name = cleanRepo(req.body.githubRepo);
  if (!token) return bad(res, 400, "Jeton GitHub requis.");
  if (name && !/^[\w.-]+\/[\w.-]+$/.test(name)) return bad(res, 400, "Format attendu : propriétaire/dépôt");
  try { res.json({ ok: true, ...(await testGithub(token, name)) }); }
  catch (e) { bad(res, 400, e.message); }
});

app.post("/api/settings", adminOnly, async (req, res) => {
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
  const user = userFromReq(req);
  if (!user || !sameOrigin(req)) {
    socket.write(`HTTP/1.1 ${user ? "403 Forbidden" : "401 Unauthorized"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.edUserId = user.id;
    ws.edEpoch = user.epoch || 1;
    wss.emit("connection", ws, req);
  });
});

/**
 * Filtre les messages entrants selon les droits : la présence (awareness) et la demande d'état
 * (sync step 1) sont toujours admises ; les modifications (sync step 2 / update) seulement avec
 * le droit d'écriture. Personne n'écrit dans le canal système.
 */
function guardIncoming(conn, name) {
  const on = conn.on.bind(conn);
  conn.on = (event, fn) => {
    if (event !== "message") return on(event, fn);
    return on("message", (data, isBinary) => {
      const u8 = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength);
      if (u8.length < 2 && u8[0] !== 1) return;
      if (u8[0] === 1) return fn(data, isBinary);                 // présence
      if (u8[0] !== 0) return;                                     // type inconnu
      if (u8[1] === 0) return fn(data, isBinary);                  // demande d'état
      if (name === SYSTEM_DOC) return;
      const u = users.byId(conn.edUserId);
      if (u && !u.disabled && access.can(u, name, "write")) fn(data, isBinary);
    });
  };
}

wss.on("connection", (conn, req) => {
  let name;
  try { name = decodeURIComponent((req.url || "").split("?")[0].replace(/^\/+/, "")); }
  catch (_e) { name = ""; }
  if (name !== SYSTEM_DOC) name = safeDocPath(name);
  if (!name) { conn.close(1008, "document invalide"); return; }
  if (name !== SYSTEM_DOC && !access.can(users.byId(conn.edUserId), name, "read")) { conn.close(4003, "accès refusé"); return; }
  guardIncoming(conn, name);
  yws.setupWSConnection(conn, req, { gc: true, docName: name });
});

async function shutdown(sig) {
  console.log(`${sig} reçu : enregistrement des documents ouverts…`);
  try { await Promise.race([flushAll(), new Promise((r) => setTimeout(r, 8000))]); } catch (_e) {}
  sessions.flush();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

async function main() {
  await repo.init();
  try { await repo.seedIfEmpty(); } catch (e) { console.error("[seed]", e.message); }
  try { lastHead = await repo.headSha(); } catch (_e) {}
  if (!users.count()) console.log("[auth] aucun compte : le premier visiteur crée le compte administrateur.");
  server.listen(PORT, () => {
    console.log(`Easydoc ${pkg.version} — http://localhost:${PORT} — ${repo.mode === "github"
      ? `GitHub ${repo.options.githubRepo} (${repo.options.githubBranch})` : `local ${LOCAL_DIR}`}`);
  });
}

main().catch((e) => { console.error("Erreur au démarrage :", e); process.exit(1); });
