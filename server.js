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
const wsguard = require("./src/wsguard");
const links = require("./src/links");
const { RepoService } = require("./src/repo");
const { SettingsStore } = require("./src/settings");
const paths = require("./src/paths");
const { isEditable, kindOf } = paths;
const convert = require("./src/convert");
const auth = require("./src/auth");
const authorship = require("./src/authorship");
const { CommentStore, locate: locateQuote, context: quoteContext } = require("./src/comments");
const { TunnelManager } = require("./src/tunnel");
const { Updater, bootGuard } = require("./src/updater");
const { BackupManager } = require("./src/backup");
const pkg = require("./package.json");

const ENV_FILE = process.env.ENV_FILE || path.join(__dirname, ".env");
require("dotenv").config({ path: ENV_FILE });

const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 25);
const PUBLIC = path.join(__dirname, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const LOCAL_DIR = process.env.LOCAL_REPO_DIR || path.join(DATA_DIR, "localrepo");
// nouvelle version installée par une mise à jour qui ne démarre pas : retour à la précédente
bootGuard({ appDir: __dirname, dataDir: DATA_DIR });
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
access.caseInsensitive = () => repo.caseInsensitive();
// Tout chemin reçu (API, WebSocket) est validé puis ramené au nom réel du fichier : sur un disque
// insensible à la casse, « INTERNE/x.md » et « Interne/x.md » sont un seul fichier, avec les mêmes droits.
const safeFilePath = (input) => { const p = paths.safeFilePath(input); return p && repo.canonical(p); };
const safeDocPath = (input) => { const p = paths.safeDocPath(input); return p && repo.canonical(p); };
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
// ---- Tunnel Cloudflare et proxys de confiance ------------------------------------------------------
const tunnel = new TunnelManager({ dataDir: DATA_DIR, port: PORT });
const isLoopback = (a) => /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/.test(String(a || ""));
/**
 * Adresse « de confiance » pour lire X-Forwarded-For / -Proto : les TRUST_PROXY premiers proxys,
 * et cloudflared quand le tunnel est actif (il tourne sur cette machine : connexion locale).
 */
function trustProxy(addr, i) {
  if (TRUST_PROXY > 0 && i < TRUST_PROXY) return true;
  return i === 0 && tunnel.enabled && isLoopback(addr);
}
const isHttps = (req) => req.socket.encrypted || (trustProxy(req.socket.remoteAddress, 0) && String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https");
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
  // X-Forwarded-Host n'est cru que s'il vient d'un proxy de confiance (sinon n'importe qui l'invente)
  const fwd = trustProxy(req.socket.remoteAddress, 0) ? String(req.headers["x-forwarded-host"] || "").split(",")[0].trim() : "";
  if (host === req.headers.host || (fwd && host === fwd)) return true;
  // requête arrivée par le tunnel sous l'un de ses noms publics
  return trustProxy(req.socket.remoteAddress, 0) && tunnel.hostnames.includes(host.replace(/:443$/, ""));
}

// ---- Auteurs (qui a écrit quoi) ----------------------------------------------------------------
const authorStore = new authorship.AuthorshipStore(path.join(DATA_DIR, "authorship"));
// ---- Commentaires (façon Google Docs, par document) --------------------------------------------
const comments = new CommentStore(path.join(DATA_DIR, "comments.json"));
const { ActivityLog, NotificationStore, mentionsIn } = require("./src/notify");
const activity = new ActivityLog(path.join(DATA_DIR, "activity.json"));
const notifications = new NotificationStore(path.join(DATA_DIR, "notifications.json"));
/** Prévient les navigateurs qui ont le document ouvert : ils rechargent ses commentaires. */
function notifyComments(name) {
  const doc = yws.docs.get(name);
  if (doc) doc.transact(() => doc.getMap("meta").set("commentsAt", Date.now()), SERVER);
}
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
      if (!u || u.disabled || (u.epoch || 1) !== conn.edEpoch || (conn.edToken && !sessions.get(conn.edToken))) { try { conn.close(4001, "session terminée"); } catch (_e) {} continue; }
      if (name !== SYSTEM_DOC && !access.can(u, name, "read")) { try { conn.close(4003, "accès retiré"); } catch (_e) {} }
    }
  }
}
setInterval(enforceAccess, 5000).unref(); // prend aussi en compte les changements faits en ligne de commande

// ---- Enregistrement (commit) --------------------------------------------------------------------
function scheduleSave(name) {
  const s = st(name);
  clearTimeout(s.timer);
  if (s.moving) return; // en cours de déplacement : enregistré sous le nouveau nom
  const now = Date.now();
  const delay = Math.max(0, Math.min(AUTOSAVE_MS, s.firstDirty + AUTOSAVE_MAX_MS - now));
  s.timer = setTimeout(() => { commitDoc(name).catch(() => {}); }, delay);
}

/**
 * Intègre une nouvelle version du dépôt (agent IA, git push, autre outil) dans un document
 * ouvert, sans perdre la saisie en cours : chaque commit intervenu depuis le dernier état connu
 * est rejoué sur une copie de cet état, puis fusionné (CRDT) dans le document, avec son auteur.
 * À appeler dans serialize(name).
 */
async function mergeExternal(name, doc, newContent) {
  const s = st(name);
  let steps = [];
  try { steps = await withTimeout(externalSteps(name, s.lastRemote, newContent), 8000); } catch (_e) {}
  if (!steps.length || steps[steps.length - 1].text !== newContent) {
    let who = { a: repo.mode === "local" ? "x:Modification externe" : "", t: authorship.nowMin() };
    if (repo.mode !== "local" || !steps.length) {
      try { const c = await withTimeout(repo.lastCommit(name), 8000); if (c) who = { a: keyOfCommit(c), t: authorship.toMin(c.date) }; } catch (_e) {}
    }
    steps.push({ text: newContent, a: who.a, t: who.t });
  }
  const who = steps[steps.length - 1];
  const ytext = doc.getText(TEXT);
  // L'état de référence doit toujours correspondre exactement au texte du dépôt (lastRemote) :
  // s'il contenait la saisie pas encore enregistrée, la fusion suivante l'effacerait.
  let base = null;
  if (s.baseUpdate) {
    const tmp = new Y.Doc();
    Y.applyUpdate(tmp, s.baseUpdate);
    const before = Y.encodeStateVector(tmp);
    tmp.transact(() => { for (const x of steps) authorship.applyFineDiff(tmp.getText(TEXT), x.text, x.a ? { a: x.a, t: x.t } : {}); });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(tmp, before), SERVER);
    base = Y.encodeStateAsUpdate(tmp); // = la nouvelle version du dépôt, sans la saisie locale
    tmp.destroy();
  } else {
    // pas d'état de référence (ne devrait pas arriver) : fusion du texte ligne à ligne
    const merged = authorship.merge3(s.lastRemote || "", ytext.toString(), newContent);
    const target = merged === null ? ytext.toString() : merged;
    if (merged === null) console.error(`[sync] ${name} : conflit, la version du dépôt reste dans l'historique`);
    doc.transact(() => authorship.applyFineDiff(ytext, target, who.a ? { a: who.a, t: who.t } : {}), SERVER);
  }
  s.lastRemote = newContent;
  s.lastCommitted = newContent;
  s.baseUpdate = base; // sans état exact : la prochaine fusion se fera ligne à ligne
  if (!base && ytext.toString() === newContent) s.baseUpdate = Y.encodeStateAsUpdate(doc);
  if (ytext.toString() !== newContent) { // il reste de la saisie locale à enregistrer
    s.dirty = true; s.firstDirty = s.firstDirty || Date.now();
  }
  doc.transact(() => {
    doc.getMap("meta").set("externalBy", authorship.nameOfKey(who.a, users) || "");
    doc.getMap("meta").set("externalAt", Date.now());
  }, SERVER);
  authorStore.save(repoKey(), name, ytext.toString(), authorship.runsFromYText(ytext), s.attrV || ATTR_V);
}

function commitDoc(name, extraAuthor, docArg) {
  return serialize(name, async () => {
    const s = st(name);
    clearTimeout(s.timer);
    // docArg : à la fermeture, y-websocket a déjà retiré le document de sa table
    const doc = docArg || yws.docs.get(name);
    if (!doc || s.moving) return { committed: false };
    const meta = doc.getMap("meta");
    if (!meta.get("loaded")) return { committed: false };
    const ytext = doc.getText(TEXT);
    if (extraAuthor) s.authors.add(String(extraAuthor).slice(0, 40));
    if (ytext.toString() === s.lastCommitted) {
      s.dirty = false; s.firstDirty = 0; s.authors.clear();
      doc.transact(() => { meta.set("savedAt", Date.now()); meta.delete("saveError"); }, SERVER); // « à jour »
      dropRecovery(name);
      return { committed: false };
    }
    const authors = [...s.authors];
    const msg = `Easydoc : ${name} (${authors.length ? authors.join(", ") : "modification"})`;
    try {
      let content, snapshot, r;
      for (let attempt = 0; ; attempt++) {
        content = ytext.toString();
        snapshot = Y.encodeStateAsUpdate(doc); // état exact correspondant à `content`
        try {
          // `base` : on n'écrase jamais une version du dépôt qu'on n'a pas encore intégrée
          r = await repo.writeFile(name, content, msg, { base: s.lastRemote == null ? "" : s.lastRemote });
          break;
        } catch (e) {
          if (e.code !== "STALE" || attempt >= 2) throw e;
          console.log(`[save] ${name} : modifié dans le dépôt entre-temps, fusion avant enregistrement`);
          await mergeExternal(name, doc, e.current);
          if (ytext.toString() === e.current) { r = { committed: false }; content = e.current; snapshot = Y.encodeStateAsUpdate(doc); break; }
        }
      }
      authorStore.save(repoKey(), name, content, authorship.runsFromYText(ytext), s.attrV || ATTR_V);
      if (r && r.committed) activity.add(name, authors.join(", "));
      s.lastCommitted = content;
      s.lastRemote = content;
      s.baseUpdate = snapshot;
      s.authors.clear();
      // d'autres frappes ont pu arriver pendant l'envoi
      const still = ytext.toString() !== content;
      s.dirty = still;
      s.firstDirty = still ? Date.now() : 0;
      if (still) scheduleSave(name);
      dropRecovery(name);
      comments.refresh(name, ytext.toString());
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

// ---- Secours : modifications pas encore enregistrées dans le dépôt -------------------------------
// Si l'enregistrement échoue au moment où le document quitte la mémoire (dernier participant parti,
// arrêt du serveur, mise à jour) — GitHub injoignable, quota dépassé… — l'état du document est gardé
// sur le disque (data/recovery) et renvoyé au dépôt dès que possible. Rouvert entre-temps, le
// document repart de cet état : rien de ce qui a été tapé n'est perdu.
const RECOVERY_DIR = path.join(DATA_DIR, "recovery");
const recoveryFile = (name) => path.join(RECOVERY_DIR, require("crypto").createHash("sha1").update(`${repoKey()}|${name}`).digest("hex") + ".json");
function keepRecovery(name, doc) {
  const s = st(name);
  s.recovery = { update: Y.encodeStateAsUpdate(doc), base: s.lastRemote, baseUpdate: s.baseUpdate };
  try {
    fs.mkdirSync(RECOVERY_DIR, { recursive: true });
    const b64 = (u) => (u ? Buffer.from(u).toString("base64") : null);
    fs.writeFileSync(recoveryFile(name), JSON.stringify({ name, repo: repoKey(), at: Date.now(), base: s.lastRemote,
      update: b64(s.recovery.update), baseUpdate: b64(s.baseUpdate) }), { mode: 0o600 });
  } catch (e) { console.error(`[secours] ${name} : ${e.message}`); }
  console.error(`[secours] ${name} : modifications gardées en attendant de pouvoir les enregistrer`);
  scheduleRecovery(name, 30000);
}
function dropRecovery(name) {
  const s = st(name);
  if (!s.recovery) return;
  s.recovery = null;
  clearTimeout(s.recoveryTimer);
  try { fs.unlinkSync(recoveryFile(name)); } catch (_e) {}
  console.log(`[secours] ${name} : modifications enregistrées dans le dépôt`);
}
function scheduleRecovery(name, delay) {
  const s = st(name);
  clearTimeout(s.recoveryTimer);
  s.recoveryTimer = setTimeout(() => retryRecovery(name).catch(() => {}), delay);
  s.recoveryTimer.unref();
}
async function retryRecovery(name) {
  const s = st(name);
  if (!s.recovery || yws.docs.get(name)) return; // rouvert : le document vivant s'en charge
  const tmp = new Y.Doc();
  Y.applyUpdate(tmp, s.recovery.update);
  s.dirty = true;
  try { await commitDoc(name, null, tmp); }
  catch (_e) { scheduleRecovery(name, 120000); }
  finally { tmp.destroy(); }
}
/** Au démarrage : reprise des modifications gardées par une exécution précédente. */
function loadRecoveries() {
  let list = [];
  try { list = fs.readdirSync(RECOVERY_DIR).filter((f) => f.endsWith(".json")); } catch (_e) { return; }
  for (const f of list) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(RECOVERY_DIR, f), "utf8"));
      if (j.repo !== repoKey() || !j.update) continue;
      const s = st(j.name);
      s.recovery = { update: new Uint8Array(Buffer.from(j.update, "base64")), base: j.base };
      s.lastRemote = j.base;
      s.lastCommitted = j.base;
      if (j.baseUpdate) s.baseUpdate = new Uint8Array(Buffer.from(j.baseUpdate, "base64"));
      console.log(`[secours] ${j.name} : modifications non enregistrées reprises`);
      scheduleRecovery(j.name, 5000);
    } catch (e) { console.error(`[secours] ${f} : ${e.message}`); }
  }
}

async function flushAll() {
  await Promise.all(openDocs().map(([name, doc]) => (st(name).dirty ? commitDoc(name).catch(() => keepRecovery(name, doc)) : null)));
}

// ---- Chargement / déchargement des documents (persistance y-websocket) --------------------------
yws.setPersistence({
  bindState: async (name, doc) => {
    if (name === SYSTEM_DOC) return;
    const s = st(name);
    await s.chain; // un enregistrement de ce document est peut-être en cours : on l'attend
    const meta = doc.getMap("meta");
    try {
      if (s.recovery) {
        // des modifications attendent encore d'être enregistrées : on repart de cet état
        Y.applyUpdate(doc, s.recovery.update, SERVER);
        doc.transact(() => { meta.set("loaded", true); meta.set("exists", true); }, SERVER);
        clearTimeout(s.recoveryTimer);
        comments.anchorAll(name, doc.getText(TEXT).toString());
        s.dirty = true; s.firstDirty = Date.now();
        scheduleSave(name);
      } else {
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
        comments.anchorAll(name, doc.getText(TEXT).toString());
        s.lastCommitted = file ? content : null;
        s.lastRemote = s.lastCommitted;
        s.baseUpdate = Y.encodeStateAsUpdate(doc);
        s.dirty = false;
      }
    } catch (e) {
      console.error(`[load] ${name} : ${e.message}`);
      doc.transact(() => meta.set("loadError", String(e.message).slice(0, 200)), SERVER);
    }
    // Texte tapé dans un navigateur : marqué au nom du compte de la connexion.
    const ytext = doc.getText(TEXT);
    // les passages commentés suivent toutes les modifications (frappe, dépôt, restauration…)
    ytext.observe((ev) => comments.shift(name, ev.delta));
    ytext.observe((ev) => {
      const origin = ev.transaction.origin;
      if (!origin || !origin.edUserId) return;
      const u = users.byId(origin.edUserId);
      if (!u) return;
      const ranges = [];
      let i = 0;
      for (const op of ev.delta) {
        // mise en forme modifiée par un navigateur (l'attribution d'un passage) : reprise au nom
        // de la connexion, personne ne peut attribuer son texte à quelqu'un d'autre
        if (op.retain) { if (op.attributes) ranges.push([i, op.retain]); i += op.retain; }
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
    const s = st(name);
    if (s.dirty) {
      try { await commitDoc(name, null, doc); }
      catch (_e) { keepRecovery(name, doc); } // rien n'est perdu : nouvel essai plus tard
      clearTimeout(s.timer); // le nouvel essai passe par le secours, le document n'est plus en mémoire
    }
    try {
      comments.refresh(name, doc.getText(TEXT).toString());
      comments.flush();
    } catch (e) { console.error(`[commentaires] ${name} : ${e.message}`); }
    // mémoire : l'état de référence n'est plus utile une fois le document enregistré et fermé
    // (sauf s'il vient d'être rouvert : y-websocket l'a alors déjà recréé dans sa table)
    if (!s.dirty && !s.recovery && !yws.docs.has(name)) states.delete(name);
  },
});

// ---- Modifications externes (agent IA, push git…) : fusion à 3 voies ---------------------------
let lastHead = null;
let lastLocalSig = null;
async function pollExternal(force = false) {
  let headChanged = false;
  let head = null;
  if (repo.mode === "github") {
    // une seule requête tant que rien n'a bougé sur la branche
    head = await repo.headSha();
    if (!force && head === lastHead) return { changed: 0 };
    headChanged = head !== lastHead;
  } else {
    // dépôt local : fichiers ajoutés / supprimés sur le disque (par un agent, un partage réseau…)
    const sig = (await repo.listFiles()).map((f) => `${f.path}:${f.size}`).sort().join("|");
    if (lastLocalSig !== null && sig !== lastLocalSig) headChanged = true;
    lastLocalSig = sig;
  }
  // mode local : lecture directe des fichiers ouverts (un agent peut les modifier sur le disque)
  let changed = 0, failed = 0;
  for (const [name, doc] of openDocs()) {
    const s = st(name);
    if (!doc.getMap("meta").get("loaded")) continue;
    try {
      await serialize(name, async () => {
        const file = await repo.readFile(name);
        if (s.moving || !file || file.content === s.lastRemote) return; // rien de nouveau (ou en cours de déplacement)
        await mergeExternal(name, doc, file.content);
        if (s.dirty) scheduleSave(name);
        changed++;
      });
    } catch (e) {
      failed++;
      console.error(`[sync] ${name} : ${e.message}`);
    }
  }
  // un échec sera retenté au prochain passage, même si la branche n'a plus bougé
  if (repo.mode === "github" && !failed) lastHead = head;
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
  for (const s of states.values()) { clearTimeout(s.timer); clearTimeout(s.recoveryTimer); }
  states.clear(); // les secours restent sur le disque, rattachés à leur dépôt
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
app.set("trust proxy", trustProxy);

// En-têtes de sécurité : pas d'affichage dans la page d'un autre site (clickjacking), scripts
// limités à ceux d'Easydoc (le petit script de thème en ligne est autorisé par son empreinte).
const INLINE_SCRIPT_HASHES = (() => {
  try {
    const html = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
    // le navigateur calcule l'empreinte après avoir ramené les fins de ligne à LF (fichier CRLF sous Windows)
    return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${require("crypto").createHash("sha256").update(m[1].replace(/\r\n?/g, "\n")).digest("base64")}'`);
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
app.use(express.static(PUBLIC, { maxAge: 0, etag: true }));

const bad = (res, code, error) => {
  if (res.headersSent) return;
  // jeton GitHub expiré / révoqué : message actionnable plutôt qu'une erreur technique
  if (/Bad credentials|Requires authentication/i.test(String(error))) {
    return res.status(502).json({ ok: false, error: "GitHub refuse le jeton d'accès (expiré ou révoqué). Un administrateur peut en saisir un nouveau (Administration → Dépôt) ou déconnecter le dépôt." });
  }
  return res.status(code).json({ ok: false, error });
};

const BOOT_ID = require("crypto").randomBytes(6).toString("hex"); // change à chaque démarrage
app.get("/api/health", (_req, res) => res.json({ ok: true, mode: repo.mode, version: pkg.version, boot: BOOT_ID }));

// Authentification : toute l'API exige une session, sauf ces routes.
const PUBLIC_API = new Set(["/api/health", "/api/auth/state", "/api/auth/login", "/api/auth/setup"]);
app.use("/api", (req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) return bad(res, 403, "Requête refusée (origine différente).");
  req.user = userFromReq(req);
  if (PUBLIC_API.has(req.originalUrl.split("?")[0])) return next();
  if (!req.user) return bad(res, 401, "Session expirée : reconnecte-toi.");
  next();
});
// corps JSON lu après la vérification de session : sans session, seuls de petits corps sont acceptés
const jsonBig = express.json({ limit: "5mb" }), jsonSmall = express.json({ limit: "32kb" });
app.use("/api", (req, res, next) => (req.user ? jsonBig : jsonSmall)(req, res, next));
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
// Essais de mot de passe limités par adresse IP ET par identifiant (derrière un proxy mal réglé,
// tout le monde partage la même adresse : la limite par identifiant protège quand même chaque
// compte). L'essai est compté AVANT la vérification : 500 essais envoyés d'un coup ne passent pas.
const loginFails = new Map(); // clé → { n, until }
const FAIL_WINDOW = 15 * 60 * 1000;
const FAIL_LIMIT = { ip: 30, user: 8, pw: 8 };
const clientIp = (req) => req.ip || req.socket.remoteAddress || "?";
function failCount(key) { const a = loginFails.get(key); return a && a.until > Date.now() ? a.n : 0; }
function noteFail(key, n = 1) {
  let a = loginFails.get(key);
  if (!a || a.until < Date.now()) a = { n: 0, until: Date.now() + FAIL_WINDOW };
  a.n = Math.max(0, a.n + n);
  if (a.n) loginFails.set(key, a); else loginFails.delete(key);
}
/** Réserve un essai sur chaque clé ; renvoie la fonction qui l'annule (mot de passe correct), ou null si la limite est atteinte. */
function reserveAttempt(keys) {
  if (keys.some(([k, kind]) => failCount(k) >= FAIL_LIMIT[kind])) return null;
  for (const [k] of keys) noteFail(k);
  return () => { for (const [k] of keys) noteFail(k, -1); };
}
setInterval(() => { const now = Date.now(); for (const [k, a] of loginFails) if (a.until < now) loginFails.delete(k); }, FAIL_WINDOW).unref();
// scrypt occupe les fils de travail de Node (aussi utilisés pour lire les fichiers) : vérifications
// simultanées limitées, les suivantes sont refusées tout de suite
let verifying = 0;
async function checkPassword(password, hash) {
  if (verifying >= 4) { const e = new Error("Serveur occupé : réessaie dans un instant."); e.status = 429; throw e; }
  verifying++;
  try { return await auth.verifyPassword(String(password || ""), hash); } finally { verifying--; }
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
  const name = String(req.body.username || "").trim().toLowerCase().slice(0, 64);
  const release = reserveAttempt([[`ip:${clientIp(req)}`, "ip"], [`user:${name}`, "user"]]);
  if (!release) return bad(res, 429, "Trop de tentatives : réessaie dans quelques minutes.");
  let ok = false;
  const u = users.byUsername(req.body.username);
  try { ok = await checkPassword(req.body.password, u && u.hash); }
  catch (e) { release(); return bad(res, errStatus(e, 500), e.message); }
  if (!u || !ok) return bad(res, 401, "Identifiant ou mot de passe incorrect.");
  release();
  if (u.disabled) return bad(res, 403, "Ce compte est désactivé. Contacte un administrateur.");
  if (auth.needsRehash(u.hash)) users.rehash(u.id, req.body.password).catch((e) => console.error("[auth] empreinte :", e.message));
  setSessionCookie(req, res, sessions.create(u));
  res.json({ ok: true, user: auth.publicUser(u) });
});

app.post("/api/auth/logout", (req, res) => {
  sessions.destroy(tokenOf(req));
  setImmediate(enforceAccess); // ferme tout de suite les connexions temps réel de cette session
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
    // une session volée ne doit pas permettre de deviner le mot de passe actuel
    const release = reserveAttempt([[`pw:${req.user.id}`, "pw"]]);
    if (!release) return bad(res, 429, "Trop de tentatives : réessaie dans quelques minutes.");
    let ok;
    try { ok = await checkPassword(req.body.current, req.user.hash); } catch (e) { release(); throw e; }
    if (!ok) return bad(res, 400, "Mot de passe actuel incorrect.");
    release();
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
    notifications.removeUser(u.id);
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

// ---- Tunnel Cloudflare (administrateurs) --------------------------------------------------------------
app.get("/api/admin/tunnel", adminOnly, (_req, res) => res.json({ ok: true, tunnel: tunnel.publicState() }));
app.post("/api/admin/tunnel", adminOnly, async (req, res) => {
  try {
    const st = await tunnel.configure({ token: req.body.token, enabled: req.body.enabled });
    console.log(`[tunnel] ${st.enabled ? "activé" : "désactivé"} par ${req.user.username}`);
    res.json({ ok: true, tunnel: st });
  } catch (e) { bad(res, 400, e.message); }
});
app.delete("/api/admin/tunnel", adminOnly, async (req, res) => {
  const st = await tunnel.forget();
  console.log(`[tunnel] jeton effacé par ${req.user.username}`);
  res.json({ ok: true, tunnel: st });
});

// ---- Mise à jour d'Easydoc (administrateurs) ------------------------------------------------------------
// ---- Sauvegardes des données (administrateurs) ---------------------------------------------------
const backups = new BackupManager({
  dataDir: DATA_DIR, localRepoDir: LOCAL_DIR,
  meta: () => ({ version: pkg.version, mode: repo.mode, depot: repo.mode === "github" ? repo.options.githubRepo : "local" }),
  // documents ouverts enregistrés et fichiers en attente écrits : la sauvegarde est cohérente
  beforeBackup: async () => { await flushAll(); sessions.flush(); comments.flush(); activity.flush(); notifications.flush(); },
});
app.get("/api/admin/backups", adminOnly, (_req, res) => res.json({
  ok: true, ...backups.settings, list: backups.list(), running: !!backups.running, lastError: backups.lastError, dir: backups.dir,
}));
app.post("/api/admin/backups", adminOnly, async (_req, res) => {
  try { const r = await backups.create("manuelle"); res.json({ ok: true, ...r }); }
  catch (e) { bad(res, 500, "Sauvegarde impossible : " + e.message); }
});
app.put("/api/admin/backups", adminOnly, (req, res) => {
  try { backups.save({ auto: req.body.auto, keep: Number(req.body.keep) }); res.json({ ok: true, ...backups.settings, list: backups.list() }); }
  catch (e) { bad(res, 500, e.message); }
});
app.get("/api/admin/backups/download", adminOnly, (req, res) => {
  const p = backups.pathOf(req.query.name);
  if (!p || !fs.existsSync(p)) return bad(res, 404, "Sauvegarde introuvable.");
  res.set("Cache-Control", "no-store");
  res.download(p, path.basename(p));
});
app.delete("/api/admin/backups", adminOnly, (req, res) => {
  res.json({ ok: backups.remove(String(req.query.name || "")) });
});

app.get("/api/admin/update", adminOnly, async (req, res) => {
  try {
    if (req.query.refresh === "1" || !updater.check) await updater.checkNow();
    res.json({ ok: true, ...updater.status() });
  } catch (e) { bad(res, 500, e.message); }
});
app.post("/api/admin/update", adminOnly, (req, res) => {
  try {
    const job = updater.start();
    console.log(`[mise à jour] lancée par ${req.user.username}`);
    res.json({ ok: true, job });
  } catch (e) { bad(res, 409, e.message); }
});

app.get("/api/config", (_req, res) => res.json({
  boot: BOOT_ID,
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
    const inline = req.query.download !== "1" && INLINE_KINDS.has(kind);
    if (kind === "markdown" || kind === "text") res.set("Content-Type", `${kind === "markdown" ? "text/markdown" : "text/plain"}; charset=utf-8`);
    // un .js ou .html importé ne doit jamais pouvoir servir de script ou de page à Easydoc
    else if (inline) res.type(ext || "bin");
    else res.set("Content-Type", "application/octet-stream");
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
    activity.add(target, author, "importé");
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
      // dossier d'images libre (jamais celui d'un autre document) et modifiable par cette personne
      let imgDir = `${targetStem} - images`;
      const taken = new Set((await repo.listFiles()).map((x) => x.path.toLowerCase()));
      const used = (d) => [...taken].some((t) => t.startsWith(joinPath(dir, d).toLowerCase() + "/"));
      for (let i = 2; used(imgDir) && i < 100; i++) imgDir = `${targetStem} - images (${i})`;
      const r = await convert.docxToMarkdown(f.buf, imgDir);
      const files = r.images.map((im) => ({ rel: joinPath(dir, imgDir, im.name), buf: im.data }));
      if (files.length) {
        if (used(imgDir)) return bad(res, 409, "Impossible de trouver un dossier libre pour les images de ce document.");
        if (!access.can(req.user, files[0].rel, "write")) return bad(res, 403, "Tu n'as pas le droit d'ajouter les images de ce document dans ce dossier.");
        await repo.addFiles(files, `Easydoc : ${files.length} image(s) extraite(s) de ${p}`);
      }
      markdown = r.markdown;
      images = files.length;
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
      // `base` : le texte dont ce client est parti. Ses modifications sont rejouées sur la
      // version actuelle (celle des autres participants et du dépôt) au lieu de l'écraser.
      const mine = req.body.content;
      const base = typeof req.body.base === "string" ? req.body.base : null;
      if (doc && doc.getMap("meta").get("loaded")) {
        const cur = doc.getText(TEXT).toString();
        const merged = base === null ? mine : authorship.merge3(base, mine, cur);
        if (merged === null) return bad(res, 409, "Conflit : ce passage a aussi été modifié par quelqu'un d'autre.");
        doc.transact(() => authorship.applyFineDiff(doc.getText(TEXT), merged, userAttrs(req.user)), "offline-client");
        const r = await commitDoc(p, author);
        return res.json({ ok: true, committed: r.committed, content: merged });
      }
      const out = await serialize(p, async () => {
        const f = await repo.readFile(p);
        const cur = f ? f.content : "";
        const merged = base === null ? mine : authorship.merge3(base, mine, cur);
        if (merged === null) return null;
        const r = await repo.writeFile(p, merged, `Easydoc : ${p} (${author || "modification"})`, { base: cur });
        return { committed: r.committed, content: merged };
      });
      if (!out) return bad(res, 409, "Conflit : ce passage a aussi été modifié par quelqu'un d'autre.");
      return res.json({ ok: true, ...out });
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

// ---- Recherche dans le contenu ------------------------------------------------------------------
// Respecte les droits (les fichiers masqués sont ignorés), ignore majuscules ET accents (« ete »
// trouve « été »). Le texte est gardé en mémoire avec l'empreinte de sa version (sha avec GitHub,
// taille + date en local) : seuls les fichiers modifiés depuis la recherche précédente sont relus.
const SEARCH_MAX_FILES = 1000, SEARCH_MAX_BYTES = 2 * 1024 * 1024, SEARCH_PER_FILE = 5, SEARCH_MAX_RESULTS = 80;
const searchCache = new Map(); // chemin → { sig, content }
const versionSig = (f) => f.sha || (f.mtime ? `${f.size}:${f.mtime}` : "");
async function searchText(f) {
  const live = yws.docs.get(f.path);
  if (live && live.getMap("meta").get("loaded")) return live.getText(TEXT).toString();
  if (f.size > SEARCH_MAX_BYTES) return null; // très gros fichier texte importé : ignoré
  const sig = versionSig(f);
  const c = searchCache.get(f.path);
  if (c && sig && c.sig === sig) return c.content;
  const r = await repo.readFile(f.path);
  if (!r) return null;
  if (sig) searchCache.set(f.path, { sig, content: r.content });
  return r.content;
}
/** Texte sans accents ni majuscules, et pour chaque caractère sa position dans le texte d'origine. */
const MARKS = /[\u0300-\u036f]/g;
function foldText(text) {
  if (/^[\x00-\x7f]*$/.test(text)) return { s: text.toLowerCase(), map: null };
  let s = "";
  const map = [];
  for (let i = 0; i < text.length; i++) {
    let ch = text[i];
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) ch += text[++i]; // emoji, etc. : 2 unités
    const f = ch.normalize("NFD").replace(MARKS, "").toLowerCase();
    for (let k = 0; k < f.length; k++) map.push(i - ch.length + 1);
    s += f;
  }
  map.push(text.length);
  return { s, map };
}
const foldQuery = (q) => q.normalize("NFD").replace(MARKS, "").toLowerCase();

app.get("/api/search", async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 120);
  if (!q) return res.json({ ok: true, results: [] });
  try {
    const all = (await repo.listFiles()).filter((f) => isEditable(f.path) && access.can(req.user, f.path, "read")).slice(0, SEARCH_MAX_FILES);
    const keep = new Set(all.map((f) => f.path));
    for (const k of searchCache.keys()) if (!keep.has(k)) searchCache.delete(k);
    // lecture en parallèle (6 à la fois) des documents pas encore en mémoire
    const texts = new Map();
    let next = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (next < all.length) {
        const f = all[next++];
        try { texts.set(f.path, await searchText(f)); } catch (_e) {}
      }
    }));
    const needle = foldQuery(q);
    const groups = [];
    let total = 0;
    // le nom du document compte aussi : un document dont le nom correspond passe en premier
    const ranked = all.map((f) => ({ f, byName: foldQuery(displayNameOf(f.path)).includes(needle) }))
      .sort((a, b) => b.byName - a.byName);
    for (const { f, byName } of ranked) {
      const text = texts.get(f.path);
      if (!text && !byName) continue;
      const { s, map } = foldText(text || "");
      const orig = (j) => (map ? map[j] : j);
      const matches = [];
      let count = 0, from = 0;
      for (;;) {
        const idx = needle ? s.indexOf(needle, from) : -1;
        if (idx < 0) break;
        count++;
        if (matches.length < SEARCH_PER_FILE) {
          const a = orig(idx), b = orig(idx + needle.length);
          const ls = text.lastIndexOf("\n", a - 1) + 1;
          let le = text.indexOf("\n", a);
          if (le < 0) le = text.length;
          const start = Math.max(ls, a - 30), end = Math.min(le, b + 50);
          const clean = (str) => str.replace(/\*\*|__|`/g, ""); // balises markdown retirées de l'extrait
          matches.push({
            line: text.slice(0, ls).split("\n").length,
            before: (start > ls ? "…" : "") + clean(text.slice(start, a)),
            match: text.slice(a, Math.min(b, le)),
            after: clean(text.slice(Math.min(b, le), end)) + (end < le ? "…" : ""),
          });
        }
        from = idx + Math.max(needle.length, 1);
        if (count > 999) break;
      }
      if (!count && !byName) continue;
      groups.push({ path: f.path, count, byName, matches });
      total += Math.max(matches.length, 1);
      if (total >= SEARCH_MAX_RESULTS) break;
    }
    res.json({ ok: true, results: groups, truncated: total >= SEARCH_MAX_RESULTS });
  } catch (e) { bad(res, 500, "Recherche impossible : " + e.message); }
});
const displayNameOf = (p) => path.posix.basename(p).replace(/\.(md|markdown|txt)$/i, "");

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

// Texte complet d'un document à une version donnée (aperçu avant de le restaurer).
app.get("/api/history/content", async (req, res) => {
  const p = safeDocPath(String(req.query.path || ""));
  const sha = String(req.query.sha || "");
  if (!p) return bad(res, 400, "Chemin invalide.");
  if (!allow(req, res, p, "read")) return;
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return bad(res, 400, "Version invalide.");
  try {
    const content = await repo.readAt(p, sha);
    if (content === null) return bad(res, 404, "Ce document n'existe pas à cette version.");
    res.json({ ok: true, content: content.slice(0, 2 * 1024 * 1024) });
  } catch (e) { bad(res, 400, e.message); }
});

// ---- Commentaires -------------------------------------------------------------------------------
const commentKey = (u) => `u:${u.username}`;
const commentBody = (req) => req.body || {};
/** Chemin d'un document commentable (Markdown / texte), avec le droit demandé. */
function commentPath(req, res, raw, need) {
  const p = safeFilePath(String(raw || ""));
  if (!p || !isEditable(p)) { bad(res, 400, "Chemin invalide."); return null; }
  return allow(req, res, p, need) ? p : null;
}
/** Texte actuel du document : celui du document ouvert, sinon celui du dépôt. */
async function currentText(p) {
  const live = yws.docs.get(p);
  if (live && live.getMap("meta").get("loaded")) return live.getText(TEXT).toString();
  const f = await repo.readFile(p);
  return f ? f.content : "";
}
const canModerate = (req, item) => item.author === commentKey(req.user) || req.user.role === "admin";

app.get("/api/comments", (req, res) => {
  const p = commentPath(req, res, req.query.path, "read");
  if (!p) return;
  // document ouvert : passages à jour (texte modifié à l'intérieur d'un passage commenté)
  const live = yws.docs.get(p);
  if (live && live.getMap("meta").get("loaded")) comments.refresh(p, live.getText(TEXT).toString());
  res.json({ ok: true, comments: comments.all(p), path: p });
});

// Nouveau fil, ancré sur un passage du document.
app.post("/api/comments", async (req, res) => {
  const b = commentBody(req);
  const p = commentPath(req, res, b.path, "comment");
  if (!p) return;
  const text = String(b.text || "").trim();
  if (!text) return bad(res, 400, "Commentaire vide.");
  const quote = String(b.quote || "");
  if (!quote.trim()) return bad(res, 400, "Sélectionne d'abord le passage à commenter.");
  try {
    const doc = await currentText(p);
    // le texte a pu bouger depuis la sélection : on retrouve le passage autour de la position donnée
    const at = locateQuote(doc, { quote, start: Number.isInteger(b.start) ? b.start : 0, prefix: String(b.prefix || ""), suffix: String(b.suffix || "") });
    if (!at) return bad(res, 409, "Le passage sélectionné a changé entre-temps : sélectionne-le à nouveau.");
    const c = comments.add(p, {
      author: commentKey(req.user), authorName: req.user.displayName, color: b.color, text,
      start: at[0], end: at[1], quote, ...quoteContext(doc, at[0], at[1]),
    });
    notifyComments(p);
    notifyPeople(req.user, p, c, text, []);
    res.json({ ok: true, comment: c });
  } catch (e) { bad(res, 500, e.message); }
});

app.post("/api/comments/reply", (req, res) => {
  const b = commentBody(req);
  const p = commentPath(req, res, b.path, "comment");
  if (!p) return;
  const text = String(b.text || "").trim();
  if (!text) return bad(res, 400, "Réponse vide.");
  const r = comments.reply(p, String(b.id || ""), { author: commentKey(req.user), authorName: req.user.displayName, color: b.color, text });
  if (!r) return bad(res, 404, "Commentaire introuvable.");
  notifyComments(p);
  const thread = comments.get(p, String(b.id || ""));
  notifyPeople(req.user, p, thread, text, thread ? [thread.author, ...thread.replies.map((x) => x.author)] : []);
  res.json({ ok: true, reply: r });
});

/**
 * Notifications : les personnes citées (« @identifiant ») et celles qui participent déjà à la
 * discussion (réponse). Jamais l'auteur lui-même, jamais quelqu'un qui ne voit pas le document.
 */
function notifyPeople(author, p, thread, text, participants) {
  if (!thread) return;
  const targets = new Map(); // compte → type
  for (const name of mentionsIn(text)) { const u = users.byUsername(name); if (u) targets.set(u.id, "mention"); }
  for (const key of participants) {
    const u = String(key).startsWith("u:") ? users.byUsername(String(key).slice(2)) : null;
    if (u && !targets.has(u.id)) targets.set(u.id, "reply");
  }
  for (const [id, kind] of targets) {
    const u = users.byId(id);
    if (!u || u.disabled || u.id === author.id || !access.can(u, p, "read")) continue;
    notifications.add(u.id, { kind, path: p, cid: thread.id, by: author.displayName, text: String(text).slice(0, 300), quote: String(thread.quote || "").slice(0, 120) });
    bump(`notif:${u.id}`);
  }
}

app.get("/api/notifications", (req, res) => {
  const list = notifications.list(req.user.id).filter((n) => !n.path || access.can(req.user, n.path, "read"));
  res.json({ ok: true, notifications: list.slice(0, 50), unread: list.filter((n) => !n.read).length });
});
app.post("/api/notifications/read", (req, res) => {
  const ids = req.body && Array.isArray(req.body.ids) ? req.body.ids.map(String) : "all";
  res.json({ ok: true, marked: notifications.markRead(req.user.id, ids) });
});

// Page d'accueil : derniers documents modifiés (que cette personne peut voir et qui existent encore)
app.get("/api/recent", async (req, res) => {
  try {
    const existing = new Set((await repo.listFiles()).map((f) => f.path));
    res.json({ ok: true, recent: activity.recent((p) => existing.has(p) && access.can(req.user, p, "read"), 15) });
  } catch (e) { bad(res, 500, e.message); }
});

app.patch("/api/comments", (req, res) => {
  const b = commentBody(req);
  const p = commentPath(req, res, b.path, "comment");
  if (!p) return;
  const text = String(b.text || "").trim();
  if (!text) return bad(res, 400, "Commentaire vide.");
  const it = comments.item(p, String(b.id || ""), b.replyId ? String(b.replyId) : null);
  if (!it) return bad(res, 404, "Commentaire introuvable.");
  if (it.author !== commentKey(req.user)) return bad(res, 403, "Tu ne peux modifier que tes propres commentaires.");
  comments.edit(p, String(b.id), b.replyId ? String(b.replyId) : null, text);
  notifyComments(p);
  res.json({ ok: true });
});

app.post("/api/comments/resolve", (req, res) => {
  const b = commentBody(req);
  const p = commentPath(req, res, b.path, "comment");
  if (!p) return;
  const c = comments.setResolved(p, String(b.id || ""), b.resolved !== false, req.user.displayName);
  if (!c) return bad(res, 404, "Commentaire introuvable.");
  notifyComments(p);
  res.json({ ok: true, comment: c });
});

app.delete("/api/comments", (req, res) => {
  const p = commentPath(req, res, req.query.path, "comment");
  if (!p) return;
  const id = String(req.query.id || ""), replyId = req.query.replyId ? String(req.query.replyId) : null;
  const it = comments.item(p, id, replyId);
  if (!it) return bad(res, 404, "Commentaire introuvable.");
  if (!canModerate(req, it)) return bad(res, 403, "Tu ne peux supprimer que tes propres commentaires.");
  comments.remove(p, id, replyId);
  notifyComments(p);
  res.json({ ok: true });
});

// Restaure un document à une version antérieure de son historique.
app.post("/api/restore", async (req, res) => {
  const v = safeFilePath(String(req.body.path || ""));
  const sha = String(req.body.sha || "");
  if (!v) return bad(res, 400, "Chemin invalide.");
  if (!allow(req, res, v, "write")) return;
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return bad(res, 400, "Version invalide.");
  try {
    const raw = await repo.readRawAt(v, sha); // null si le fichier n'existe pas à ce commit
    if (raw === null) return bad(res, 404, "Ce document n'existe pas à cette version.");
    const text = isEditable(v);
    const content = text ? raw.toString("utf8") : raw; // PDF, images… : octets intacts
    const msg = `Easydoc : restauration de ${v} (${req.user.displayName})`;
    const r = await serialize(v, async () => {
      const w = await repo.writeFile(v, content, msg); // restauration voulue : écrase la version actuelle
      // recharge la version ouverte (si le document est ouvert) puis prévient les autres
      const live = text ? yws.docs.get(v) : null;
      if (live && live.getMap("meta").get("loaded")) {
        live.transact(() => { applyDiff(live.getText(TEXT), content); live.getMap("meta").set("restoredAt", Date.now()); }, SERVER);
        const s2 = st(v);
        s2.lastCommitted = content; s2.lastRemote = content;
        s2.baseUpdate = Y.encodeStateAsUpdate(live);
        s2.dirty = live.getText(TEXT).toString() !== content;
        if (s2.dirty) scheduleSave(v);
      }
      return w;
    });
    bump("treeVersion");
    res.json({ ok: true, committed: r.committed });
  } catch (e) { bad(res, 500, e.message); }
});

// Synchronisation demandée : une seule à la fois, au plus une toutes les 2 secondes (quota GitHub).
// Une demande arrivée pendant une synchronisation attend la suivante (qui verra ses changements).
let syncRun = null, syncAt = 0;
async function requestSync() {
  if (syncRun) await syncRun.catch(() => {});
  const wait = syncAt + 2000 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  if (!syncRun) {
    syncAt = Date.now();
    syncRun = pollExternal(true).finally(() => { syncRun = null; });
  }
  return syncRun;
}
app.post("/api/sync", async (_req, res) => {
  try {
    const r = await requestSync();
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
    // contenu de départ : modèle choisi ou copie d'un document (« Dupliquer ») ; sinon un titre
    const given = typeof req.body.content === "string" ? req.body.content.slice(0, 2 * 1024 * 1024) : null;
    const initial = given !== null ? given.replace(/\{\{titre\}\}/g, title).replace(/\{\{date\}\}/g, new Date().toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" }))
      : /\.txt$/i.test(p) ? "" : `# ${title}\n\n`;
    await serialize(p, () => repo.writeFile(p, initial, `Easydoc : création de ${p} (${req.user.displayName})`));
    activity.add(p, req.user.displayName, "créé");
    bump("treeVersion");
    res.json({ ok: true, path: p });
  } catch (e) { bad(res, 500, e.message); }
});

// ---- Renommer / déplacer un document ou un dossier -----------------------------------------------
// Un seul commit ; les documents ouverts sont enregistrés puis suivent (les participants basculent
// sur le nouveau nom) ; commentaires, « qui a écrit quoi » et droits d'accès suivent aussi. Le dossier
// « <document> - images » accompagne un document changé de dossier, pour que ses images s'affichent.
app.post("/api/move", async (req, res) => {
  const from = safeFilePath(String((req.body && req.body.from) || ""));
  if (!from) return bad(res, 400, "Chemin invalide.");
  const typed = paths.safeFilePath(String((req.body && req.body.to) || "").trim());
  if (!typed) return bad(res, 400, "Nom invalide : lettres, chiffres, espaces, - et _ ; dossiers séparés par /.");
  // le dossier de destination est ramené à son nom réel ; le nom final est gardé tel que saisi
  // (on peut ainsi changer seulement les majuscules d'un nom)
  const toDir = dirOf(typed);
  let to = joinPath(toDir ? repo.canonical(toDir) : "", path.posix.basename(typed));
  try {
    const all = await repo.listFiles();
    const isFile = all.some((f) => f.path === from);
    const inside = all.filter((f) => f.path.startsWith(from + "/"));
    if (!isFile && !inside.length) return bad(res, 404, "Document ou dossier introuvable.");
    if (isFile) {
      const ext = path.posix.extname(from);
      if (!path.posix.extname(to)) to += ext; // extension gardée si on ne l'a pas retapée
      if (isEditable(from) !== isEditable(to)) return bad(res, 400, `Garde l'extension « ${ext} » : elle détermine comment le fichier s'ouvre.`);
    }
    if (to === from) return res.json({ ok: true, path: to, moved: 0 });
    if (!isFile && (to + "/").toLowerCase().startsWith(from.toLowerCase() + "/")) return bad(res, 400, "Un dossier ne peut pas être déplacé à l'intérieur de lui-même.");
    const pairs = isFile ? [[from, to]] : inside.map((f) => [f.path, to + f.path.slice(from.length)]);
    const folderMoves = [[from, to]];
    if (isFile && isEditable(from) && dirOf(from) !== dirOf(to)) {
      const stem = path.posix.basename(from).replace(/\.[^.]+$/, "");
      const imgFrom = joinPath(dirOf(from), `${stem} - images`), imgTo = joinPath(dirOf(to), `${stem} - images`);
      const imgs = all.filter((f) => f.path.startsWith(imgFrom + "/"));
      if (imgs.length && !all.some((f) => f.path.startsWith(imgTo + "/"))) {
        for (const f of imgs) pairs.push([f.path, imgTo + f.path.slice(imgFrom.length)]);
        folderMoves.push([imgFrom, imgTo]);
      }
    }
    for (const [a, b] of pairs) {
      if (!paths.safeFilePath(b)) return bad(res, 400, `Nom invalide : ${b}`);
      if (!access.can(req.user, a, "write") || !access.can(req.user, b, "write")) {
        return bad(res, 403, `Tu n'as pas le droit de déplacer « ${a} » vers « ${b} ».`);
      }
    }
    const moving = new Set(pairs.map(([a]) => a.toLowerCase()));
    for (const [, b] of pairs) {
      if (all.some((f) => f.path.toLowerCase() === b.toLowerCase()) && !moving.has(b.toLowerCase())) return bad(res, 409, `« ${b} » existe déjà.`);
    }
    if (pairs.some(([a]) => st(a).recovery)) return bad(res, 409, "Des modifications attendent encore d'être enregistrées : réessaie dans un instant.");

    // 1. documents ouverts : enregistrés, puis plus d'enregistrement automatique sous l'ancien nom
    const live = pairs.map(([a, b]) => ({ a, b, doc: isEditable(a) ? yws.docs.get(a) : null }))
      .filter((x) => x.doc && x.doc.getMap("meta").get("loaded"));
    for (const x of live) {
      if (st(x.a).dirty) await commitDoc(x.a, req.user.displayName);
      st(x.a).moving = true;
      clearTimeout(st(x.a).timer);
    }
    // 2. déplacement dans le dépôt (un seul commit)
    const verb = isFile && dirOf(from) === dirOf(to) ? "renommage" : "déplacement";
    try { await repo.move(pairs, `Easydoc : ${verb} de ${from} en ${to} (${req.user.displayName})`); }
    catch (e) { for (const x of live) st(x.a).moving = false; throw e; }
    // 3. saisie arrivée pendant le déplacement : enregistrée sous le nouveau nom
    const rk = repoKey();
    for (const x of live) {
      x.written = x.doc.getText(TEXT).toString();
      if (x.written !== st(x.a).lastCommitted) await repo.writeFile(x.b, x.written, `Easydoc : ${x.b} (${req.user.displayName})`);
    }
    // 4. données rattachées au chemin
    for (const [a, b] of pairs) {
      comments.movePath(a, b);
      activity.movePath(a, b);
      notifications.movePath(a, b);
      const d = authorStore.load(rk, a);
      if (d) { authorStore.save(rk, b, d.text, d.runs, d.v); authorStore.remove(rk, a); }
      searchCache.delete(a);
    }
    for (const x of live) authorStore.save(rk, x.b, x.doc.getText(TEXT).toString(), authorship.runsFromYText(x.doc.getText(TEXT)), st(x.a).attrV || ATTR_V);
    for (const [a, b] of folderMoves) access.movePath(a, b);
    // 5. les participants basculent sur le nouveau nom
    for (const x of live) {
      x.doc.transact(() => x.doc.getMap("meta").set("movedTo", x.b), SERVER);
      const d = x.doc, name = x.a, who = req.user.displayName;
      setTimeout(async () => {
        // frappe arrivée juste avant la bascule : enregistrée sous le nouveau nom (détectée et fusionnée
        // comme une modification externe si quelqu'un l'a déjà rouvert)
        const text = d.getText(TEXT).toString();
        if (text !== x.written) { try { await repo.writeFile(x.b, text, `Easydoc : ${x.b} (${who})`); } catch (e) { console.error(`[déplacement] ${x.b} : ${e.message}`); } }
        detachDoc(name, d);
      }, 300);
      states.delete(x.a);
    }
    bump("treeVersion");
    // 6. les liens vers les fichiers déplacés (et ceux des documents déplacés) sont mis à jour,
    // une fois les anciens documents ouverts fermés
    const who = req.user;
    setTimeout(() => updateLinksAfterMove(pairs, all, who, `${verb} de ${from}`)
      .catch((e) => console.error(`[liens] ${e.message}`)), 800);
    res.json({ ok: true, path: to, moved: pairs.length });
  } catch (e) { bad(res, 500, e.message); }
});

/** Réécrit les liens relatifs touchés par un déplacement (documents que la personne peut modifier). */
async function updateLinksAfterMove(pairs, before, user, what) {
  const moved = new Map(pairs);
  const exists = new Set(before.map((f) => f.path));
  const names = [...moved.keys()].map((p) => path.posix.basename(p));
  const needles = [...new Set(names.flatMap((n) => [n, encodeURIComponent(n), n.replace(/ /g, "%20")]))];
  const writes = [];
  let liveChanged = 0;
  for (const f of before) {
    if (kindOf(f.path) !== "markdown") continue;
    const oldP = f.path, newP = moved.get(oldP) || oldP;
    if (!access.can(user, newP, "write")) continue;
    let text;
    const live = yws.docs.get(newP);
    const isLive = !!(live && live.getMap("meta").get("loaded"));
    try {
      if (isLive) text = live.getText(TEXT).toString();
      else if (newP === oldP) text = await searchText(f); // texte en cache si inchangé
      else { const r = await repo.readFile(newP); text = r && r.content; }
    } catch (_e) { continue; }
    if (!text || !text.includes("](") && !text.includes("]:")) continue;
    // document resté en place : seulement s'il cite le nom d'un fichier déplacé
    if (newP === oldP && !needles.some((n) => text.includes(n))) continue;
    const out = links.rewrite(text, oldP, newP, moved, exists);
    if (out === text) continue;
    if (isLive) {
      // document ouvert : modifié en direct (les personnes connectées voient le lien changer), puis enregistré
      live.transact(() => applyDiff(live.getText(TEXT), out), "liens");
      liveChanged++;
    } else writes.push({ rel: newP, buf: out });
  }
  if (writes.length) {
    await serialize(`liens:${what}`, () => repo.writeFiles(writes, `Easydoc : liens mis à jour (${what}, ${user.displayName})`));
    for (const w of writes) searchCache.delete(w.rel);
  }
  if (writes.length || liveChanged) console.log(`[liens] ${writes.length + liveChanged} document(s) mis à jour après ${what}`);
}

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
    comments.clearPath(p);
    activity.removePath(p);
    // un secours en attente recréerait le document supprimé au prochain redémarrage
    dropRecovery(p);
    try { fs.unlinkSync(recoveryFile(p)); } catch (_e) {}
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
      loadRecoveries();
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
    loadRecoveries();
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
    ws.edToken = tokenOf(req); // déconnexion ou session expirée : la connexion temps réel est coupée
    wss.emit("connection", ws, req);
  });
});

/**
 * Filtre les messages entrants selon les droits : la présence (awareness) et la demande d'état
 * (sync step 1) sont toujours admises ; les modifications (sync step 2 / update) seulement avec
 * le droit d'écriture. Personne n'écrit dans le canal système.
 */
// Une seule table par document, toujours relue au moment du message : une connexion ouverte
// pendant qu'une autre se ferme ne doit jamais se retrouver avec sa propre table (elle pourrait
// alors remplacer ou effacer la présence des autres).
const awareOwners = new Map(); // document → (identifiant de présence → connexion)
const ownersOf = (name) => { let m = awareOwners.get(name); if (!m) awareOwners.set(name, (m = new Map())); return m; };
function guardIncoming(conn, name) {
  const on = conn.on.bind(conn);
  on("close", () => {
    const owners = awareOwners.get(name);
    if (!owners) return;
    wsguard.releaseAwareness(conn, owners);
    if (!owners.size) awareOwners.delete(name);
  });
  conn.on = (event, fn) => {
    if (event !== "message") return on(event, fn);
    return on("message", (data, isBinary) => {
      const u8 = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength);
      if (u8.length < 2) return;
      const u = users.byId(conn.edUserId);
      if (u8[0] === 1) {                                           // présence : nom imposé par le compte
        const out = wsguard.rewriteAwareness(u8, conn, ownersOf(name), u);
        if (out) fn(out, isBinary);
        return;
      }
      if (u8[0] !== 0) return;                                     // type inconnu
      if (u8[1] === 0) return fn(data, isBinary);                  // demande d'état
      if (name === SYSTEM_DOC) return;
      if (!u || u.disabled || !access.can(u, name, "write")) return;
      // seul le texte peut être modifié : les informations du serveur (meta) restent intouchables
      const update = wsguard.syncUpdate(u8);
      const doc = yws.docs.get(name);
      if (!update || (doc && !wsguard.textOnly(doc, update, TEXT))) {
        console.warn(`[temps réel] ${name} : modification refusée (hors du texte) de ${u.username}`);
        return;
      }
      fn(data, isBinary);
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

/** Avant de quitter : enregistre les documents ouverts, les sessions, arrête le tunnel. */
async function beforeExit() {
  try { await Promise.race([flushAll(), new Promise((r) => setTimeout(r, 8000))]); } catch (_e) {}
  sessions.flush();
  try { comments.flush(); activity.flush(); notifications.flush(); } catch (_e) {}
  for (const [name, doc] of openDocs()) if (st(name).dirty) keepRecovery(name, doc); // enregistrement impossible : gardé
  try { await tunnel.stop(true); } catch (_e) {}
}
async function shutdown(sig) {
  console.log(`${sig} reçu : enregistrement des documents ouverts…`);
  await beforeExit();
  process.exit(0);
}

const updater = new Updater({
  appDir: __dirname, dataDir: DATA_DIR, currentVersion: pkg.version,
  tokenProvider: () => (repo.mode === "github" ? settings.get().githubToken || process.env.GITHUB_TOKEN || "" : ""),
  beforeRestart: async () => { console.log("[mise à jour] redémarrage sur la nouvelle version…"); await beforeExit(); },
  onEvent: (ev) => {
    if (ev.type === "restarting") bump("restartAt"); // les navigateurs affichent « mise à jour en cours »
    if (ev.type === "done") console.log(`[mise à jour] ${ev.job.ok ? (ev.job.upToDate ? "déjà à jour" : "terminée") : `échec : ${ev.job.error}${ev.job.rolledBack ? " (version précédente remise)" : ""}`}`);
  },
});
if (updater.last && updater.last.pending) {
  console.log(`[mise à jour] Easydoc ${updater.last.fromVersion} → ${updater.last.toVersion}`);
}
// vérification automatique de nouvelle version (affichée aux administrateurs)
if (updater.availability().ok) {
  setTimeout(() => updater.checkNow().catch(() => {}), 30000).unref();
  setInterval(() => updater.checkNow().catch(() => {}), 6 * 3600 * 1000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

async function main() {
  await repo.init();
  try { await repo.seedIfEmpty(); } catch (e) { console.error("[seed]", e.message); }
  try { lastHead = await repo.headSha(); } catch (_e) {}
  loadRecoveries(); // modifications non enregistrées lors de la dernière exécution
  backups.start(); // une sauvegarde par jour (réglable dans Administration → Sauvegardes)
  if (!users.count()) console.log("[auth] aucun compte : le premier visiteur crée le compte administrateur.");
  server.listen(PORT, () => {
    console.log(`Easydoc ${pkg.version} — http://localhost:${PORT} — ${repo.mode === "github"
      ? `GitHub ${repo.options.githubRepo} (${repo.options.githubBranch})` : `local ${LOCAL_DIR}`}`);
    if (tunnel.enabled) tunnel.start().catch((e) => console.error("[tunnel]", e.message));
    // une minute sans plantage : la mise à jour éventuelle est confirmée
    setTimeout(() => updater.confirmBoot(), 60000).unref();
  });
}

main().catch((e) => { console.error("Erreur au démarrage :", e); process.exit(1); });
