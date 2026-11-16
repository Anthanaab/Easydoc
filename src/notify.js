/**
 * notify.js — ce qui s'est passé, pour la page d'accueil et les notifications.
 *
 *  - ActivityLog : derniers documents modifiés (enregistrement, création, import, déplacement…),
 *    affichés sur la page d'accueil. Persisté dans data/activity.json.
 *  - NotificationStore : notifications de chaque compte (mention « @identifiant » dans un
 *    commentaire, réponse dans une discussion à laquelle on participe). data/notifications.json.
 * Ces fichiers ne sont jamais poussés sur GitHub.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_e) { return fallback; } }
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

class Persisted {
  constructor(file) { this.file = file; this.timer = null; }
  saveSoon() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 500);
    if (this.timer.unref) this.timer.unref();
  }
  flush() {
    clearTimeout(this.timer); this.timer = null;
    try { writeJson(this.file, this.data()); } catch (e) { console.error(`[${path.basename(this.file)}] ${e.message}`); }
  }
}

class ActivityLog extends Persisted {
  constructor(file, max = 300) {
    super(file);
    this.max = max;
    const d = readJson(file, { items: [] });
    this.items = Array.isArray(d.items) ? d.items : [];
  }
  data() { return { items: this.items }; }
  add(p, by, what = "modifié") {
    this.items.unshift({ path: p, at: Date.now(), by: String(by || "").slice(0, 80), what });
    if (this.items.length > this.max) this.items.length = this.max;
    this.saveSoon();
  }
  movePath(from, to) {
    let n = 0;
    for (const it of this.items) {
      if (it.path === from) { it.path = to; n++; } else if (it.path.startsWith(from + "/")) { it.path = to + it.path.slice(from.length); n++; }
    }
    if (n) this.saveSoon();
  }
  removePath(p) {
    const before = this.items.length;
    this.items = this.items.filter((it) => it.path !== p);
    if (this.items.length !== before) this.saveSoon();
  }
  /** Un élément par document (le plus récent), parmi ceux que `visible(path)` accepte. */
  recent(visible, n = 20) {
    const seen = new Set(), out = [];
    for (const it of this.items) {
      if (seen.has(it.path) || !visible(it.path)) continue;
      seen.add(it.path); out.push(it);
      if (out.length >= n) break;
    }
    return out;
  }
}

class NotificationStore extends Persisted {
  constructor(file, max = 100) {
    super(file);
    this.max = max;
    const d = readJson(file, { users: {} });
    this.users = d && d.users && typeof d.users === "object" ? d.users : {};
  }
  data() { return { users: this.users }; }
  list(userId) { return own(this.users, userId) ? this.users[userId] : []; }
  add(userId, n) {
    if (!own(this.users, userId)) this.users[userId] = [];
    const l = this.users[userId];
    l.unshift({ id: crypto.randomBytes(6).toString("hex"), at: Date.now(), read: false, ...n });
    if (l.length > this.max) l.length = this.max;
    this.saveSoon();
  }
  markRead(userId, ids) {
    let n = 0;
    for (const it of this.list(userId)) if (!it.read && (ids === "all" || ids.includes(it.id))) { it.read = true; n++; }
    if (n) this.saveSoon();
    return n;
  }
  movePath(from, to) {
    let n = 0;
    for (const l of Object.values(this.users)) for (const it of l) {
      if (it.path === from) { it.path = to; n++; } else if (it.path && it.path.startsWith(from + "/")) { it.path = to + it.path.slice(from.length); n++; }
    }
    if (n) this.saveSoon();
  }
  removeUser(userId) { if (own(this.users, userId)) { delete this.users[userId]; this.saveSoon(); } }
}

/** Identifiants cités dans un texte : « @alice », « @jean.dupont » (en minuscules, sans doublon). */
function mentionsIn(text) {
  const out = new Set();
  for (const m of String(text || "").matchAll(/(^|[^\p{L}\p{N}_.@-])@([a-z0-9][a-z0-9._-]{1,31})/giu)) out.add(m[2].toLowerCase().replace(/[.]+$/, ""));
  return [...out];
}

module.exports = { ActivityLog, NotificationStore, mentionsIn };
