/**
 * auth.js — comptes, sessions et droits d'accès d'Easydoc.
 *
 *  - Comptes : data/users.json (mots de passe hachés avec scrypt, jamais stockés en clair).
 *  - Sessions : data/sessions.json (seule l'empreinte SHA-256 du jeton de session est conservée).
 *  - Droits : data/access.json — une règle par dossier ou fichier :
 *        { "rules": { "": { "*": "write" }, "interne": { "*": "none", "group:direction": "write" } } }
 *    Niveaux : none (masqué), read (lecture seule), write (lecture et modification).
 *    La règle la plus précise l'emporte (fichier, puis dossier, puis parents, puis racine « »).
 *    Dans une règle : l'utilisateur cité > ses groupes (le droit le plus élevé) > « * » (tout le monde).
 *    Les administrateurs ont toujours accès à tout.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { promisify } = require("util");

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const LEVELS = ["none", "read", "write"];
const RANK = { none: 0, read: 1, write: 2 };
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;
const GROUP_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,31}$/u;
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 jours, prolongée à l'usage

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_e) { return fallback; }
}

/** Écriture atomique, lisible uniquement par le propriétaire. */
function writeJsonSecure(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (_e) {}
  // outil en ligne de commande lancé en root : le fichier doit rester lisible par le service
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    try { const s = fs.statSync(dir); fs.chownSync(file, s.uid, s.gid); } catch (_e) {}
  }
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}
async function verifyPassword(password, stored) {
  const [alg, s, h] = String(stored || "").split("$");
  if (alg !== "scrypt" || !s || !h) {
    await scrypt(String(password), "easydoc-dummy-salt", 64, SCRYPT); // même durée : ne révèle pas si le compte existe
    return false;
  }
  const expected = Buffer.from(h, "base64");
  const got = await scrypt(String(password), Buffer.from(s, "base64"), expected.length, SCRYPT);
  return crypto.timingSafeEqual(expected, got);
}

function generatePassword() {
  // 14 caractères faciles à recopier (sans 0/O, 1/l/I)
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(14);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

// ---- Validation --------------------------------------------------------------------------------
function cleanUsername(v) {
  const u = String(v || "").trim().toLowerCase();
  if (!USERNAME_RE.test(u)) throw new Error("Identifiant invalide : 2 à 32 caractères, lettres minuscules, chiffres, point, tiret ou _.");
  return u;
}
function cleanDisplayName(v, fallback) {
  const d = String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, 40);
  if (!d && fallback) return fallback;
  if (!d) throw new Error("Le nom affiché est obligatoire.");
  return d;
}
function checkPassword(v) {
  const p = String(v || "");
  if (p.length < 8) throw new Error("Mot de passe trop court : 8 caractères minimum.");
  if (p.length > 200) throw new Error("Mot de passe trop long.");
  return p;
}
function cleanGroups(v) {
  const list = Array.isArray(v) ? v : String(v || "").split(",");
  const out = [];
  for (const g of list) {
    const s = String(g).replace(/\s+/g, " ").trim();
    if (!s) continue;
    if (!GROUP_RE.test(s)) throw new Error(`Nom de groupe invalide : « ${s.slice(0, 40)} ».`);
    if (!out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return out.slice(0, 20);
}
const cleanRole = (v) => (v === "admin" ? "admin" : "member");

const publicUser = (u) => u && ({
  id: u.id, username: u.username, displayName: u.displayName, role: u.role,
  groups: u.groups || [], disabled: !!u.disabled, createdAt: u.createdAt,
});

// ---- Comptes -----------------------------------------------------------------------------------
class UserStore {
  constructor(file) {
    this.file = file;
    this.users = [];
    this.mtime = 0;
    this.checkedAt = 0;
    this.load();
  }
  load() {
    const d = readJson(this.file, { users: [] });
    this.users = Array.isArray(d.users) ? d.users : [];
    try { this.mtime = fs.statSync(this.file).mtimeMs; } catch (_e) { this.mtime = 0; }
  }
  /** Relit le fichier s'il a été modifié ailleurs (outil en ligne de commande). */
  refresh() {
    const now = Date.now();
    if (now - this.checkedAt < 1000) return;
    this.checkedAt = now;
    let m = 0;
    try { m = fs.statSync(this.file).mtimeMs; } catch (_e) {}
    if (m !== this.mtime) this.load();
  }
  save() {
    writeJsonSecure(this.file, { users: this.users });
    try { this.mtime = fs.statSync(this.file).mtimeMs; } catch (_e) {}
  }
  all() { this.refresh(); return this.users; }
  count() { return this.all().length; }
  byId(id) { return id ? this.all().find((u) => u.id === id) || null : null; }
  byUsername(name) {
    const n = String(name || "").trim().toLowerCase();
    return this.all().find((u) => u.username === n) || null;
  }
  activeAdmins() { return this.all().filter((u) => u.role === "admin" && !u.disabled); }
  groups() {
    const set = new Map();
    for (const u of this.all()) for (const g of u.groups || []) set.set(g.toLowerCase(), g);
    return [...set.values()].sort((a, b) => a.localeCompare(b, "fr"));
  }

  async create(input, { onlyIfEmpty = false } = {}) {
    const username = cleanUsername(input.username);
    const displayName = cleanDisplayName(input.displayName, username);
    const password = checkPassword(input.password);
    const groups = cleanGroups(input.groups);
    const hash = await hashPassword(password);
    this.refresh();
    if (onlyIfEmpty && this.users.length) throw Object.assign(new Error("Le compte administrateur existe déjà."), { status: 409 });
    if (this.byUsername(username)) throw Object.assign(new Error(`L'identifiant « ${username} » est déjà utilisé.`), { status: 409 });
    const u = {
      id: crypto.randomUUID(), username, displayName, role: cleanRole(input.role), groups,
      disabled: false, hash, epoch: 1, createdAt: new Date().toISOString(),
    };
    this.users.push(u);
    this.save();
    return u;
  }

  /** Modifie un compte. Changer le mot de passe ou désactiver ferme ses sessions (epoch). */
  async update(id, patch) {
    const u = this.byId(id);
    if (!u) throw Object.assign(new Error("Compte introuvable."), { status: 404 });
    const next = { ...u };
    if (patch.displayName !== undefined) next.displayName = cleanDisplayName(patch.displayName);
    if (patch.groups !== undefined) next.groups = cleanGroups(patch.groups);
    if (patch.role !== undefined) next.role = cleanRole(patch.role);
    if (patch.disabled !== undefined) next.disabled = !!patch.disabled;
    if (patch.password) next.hash = await hashPassword(checkPassword(patch.password));
    const losesAdmin = u.role === "admin" && !u.disabled && (next.role !== "admin" || next.disabled);
    if (losesAdmin && this.activeAdmins().length <= 1) {
      throw Object.assign(new Error("Il doit rester au moins un administrateur actif."), { status: 409 });
    }
    if (patch.password || (next.disabled && !u.disabled)) next.epoch = (u.epoch || 1) + 1;
    Object.assign(u, next);
    this.save();
    return u;
  }

  remove(id) {
    const u = this.byId(id);
    if (!u) throw Object.assign(new Error("Compte introuvable."), { status: 404 });
    if (u.role === "admin" && !u.disabled && this.activeAdmins().length <= 1) {
      throw Object.assign(new Error("Impossible de supprimer le dernier administrateur."), { status: 409 });
    }
    this.users = this.users.filter((x) => x.id !== id);
    this.save();
    return u;
  }
}

// ---- Sessions ----------------------------------------------------------------------------------
class SessionStore {
  constructor(file) {
    this.file = file;
    const d = readJson(file, { sessions: {} });
    this.map = new Map(Object.entries((d && d.sessions) || {}));
    this.timer = null;
    const now = Date.now();
    for (const [k, s] of this.map) if (!s || s.expires < now) this.map.delete(k);
  }
  static key(token) { return crypto.createHash("sha256").update(String(token)).digest("hex"); }
  create(user) {
    const token = crypto.randomBytes(32).toString("base64url");
    this.map.set(SessionStore.key(token), { userId: user.id, epoch: user.epoch || 1, expires: Date.now() + SESSION_TTL_MS });
    this.persist();
    return token;
  }
  get(token) {
    if (!token || typeof token !== "string" || token.length > 200) return null;
    const k = SessionStore.key(token);
    const s = this.map.get(k);
    if (!s) return null;
    const now = Date.now();
    if (s.expires < now) { this.map.delete(k); this.persist(); return null; }
    if (s.expires - now < SESSION_TTL_MS / 2) { s.expires = now + SESSION_TTL_MS; this.persist(); } // prolongation
    return s;
  }
  destroy(token) {
    if (!token) return;
    if (this.map.delete(SessionStore.key(token))) this.persist();
  }
  destroyUser(userId) {
    let n = 0;
    for (const [k, s] of this.map) if (s.userId === userId) { this.map.delete(k); n++; }
    if (n) this.persist();
  }
  persist() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
    if (this.timer.unref) this.timer.unref();
  }
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    try { writeJsonSecure(this.file, { sessions: Object.fromEntries(this.map) }); }
    catch (e) { console.error("[sessions]", e.message); }
  }
}

// ---- Droits d'accès ----------------------------------------------------------------------------
class AccessStore {
  constructor(file) {
    this.file = file;
    const d = readJson(file, null);
    this.rules = d && d.rules && typeof d.rules === "object" ? d.rules : { "": { "*": "write" } };
  }
  save() { writeJsonSecure(this.file, { rules: this.rules }); }

  /** Niveau effectif d'un utilisateur sur un chemin (fichier ou dossier). */
  level(user, p) {
    if (!user || user.disabled) return "none";
    if (user.role === "admin") return "write";
    const segs = p ? String(p).split("/") : [];
    for (let i = segs.length; i >= 0; i--) {
      const r = this.rules[segs.slice(0, i).join("/")];
      if (!r) continue;
      const own = r[`user:${user.username}`];
      if (own) return own;
      let best = null;
      for (const g of user.groups || []) {
        const l = r[`group:${g}`];
        if (l && (best === null || RANK[l] > RANK[best])) best = l;
      }
      if (best) return best;
      if (r["*"]) return r["*"];
    }
    return "write"; // aucune règle : comportement historique (tout le monde modifie)
  }
  can(user, p, need) { return RANK[this.level(user, p)] >= RANK[need]; }

  /** Remplace la règle d'un chemin. Sans entrée : la règle est retirée (le parent s'applique). */
  setRule(p, entries) {
    const clean = {};
    for (const [who, lvl] of Object.entries(entries || {})) {
      if (!LEVELS.includes(lvl)) throw new Error(`Niveau d'accès inconnu : ${lvl}`);
      if (who === "*" || /^user:[a-z0-9][a-z0-9._-]{1,31}$/.test(who) || (who.startsWith("group:") && GROUP_RE.test(who.slice(6)))) clean[who] = lvl;
      else throw new Error(`Destinataire invalide : ${who}`);
    }
    if (Object.keys(clean).length) this.rules[p] = clean;
    else delete this.rules[p];
    this.save();
  }
  removeUser(username) {
    let changed = false;
    for (const [p, r] of Object.entries(this.rules)) {
      if (r[`user:${username}`]) { delete r[`user:${username}`]; changed = true; }
      if (!Object.keys(r).length) delete this.rules[p];
    }
    if (changed) this.save();
  }
  groups() {
    const out = new Set();
    for (const r of Object.values(this.rules)) for (const k of Object.keys(r)) if (k.startsWith("group:")) out.add(k.slice(6));
    return [...out];
  }
}

module.exports = {
  UserStore, SessionStore, AccessStore, LEVELS, RANK, SESSION_TTL_MS,
  hashPassword, verifyPassword, generatePassword, publicUser,
  cleanUsername, cleanDisplayName, checkPassword, cleanGroups, writeJsonSecure,
};
