// Commentaires façon « Google Docs » : un fil (commentaire + réponses) ancré sur un passage.
// Persistés dans data/comments.json (jamais poussés sur GitHub).
//
// Ancrage : chaque fil garde la plage [start, end) du passage dans le texte, le passage lui-même
// (`quote`) et quelques caractères autour (`prefix`, `suffix`).
//  - Document ouvert : la plage suit chaque modification (shift), quel qu'en soit l'auteur.
//  - Document rechargé (redémarrage, modification hors d'Easydoc) : le passage est retrouvé par
//    son texte et son contexte (locate). Introuvable → le fil est « détaché » (orphan) et reste
//    visible dans la liste avec le passage d'origine.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MAX_TEXT = 4000;
const MAX_QUOTE = 2000;
const CTX = 40;
const COLOR_RE = /^#[0-9a-f]{3,8}$/i;
const newId = () => crypto.randomBytes(6).toString("hex");
const cleanText = (t) => String(t == null ? "" : t).replace(/\r\n?/g, "\n").trim().slice(0, MAX_TEXT);
const cleanColor = (c) => (COLOR_RE.test(String(c || "")) ? String(c) : "#6b7280");

/** Contexte avant / après une plage, pour retrouver le passage plus tard. */
function context(text, s, e) {
  return { prefix: text.slice(Math.max(0, s - CTX), s), suffix: text.slice(e, e + CTX) };
}

/** Longueur commune de deux chaînes, comparées depuis la fin (a) et depuis le début (b). */
function commonTail(a, b) { let n = 0; while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++; return n; }
function commonHead(a, b) { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n; }

/**
 * Retrouve le passage d'un fil dans `text` : [start, end] ou null.
 * Priorité à la position connue ; sinon l'occurrence dont le contexte correspond le mieux,
 * puis la plus proche de l'ancienne position.
 */
function locate(text, c) {
  const q = c.quote || "";
  if (!q) return null;
  if (Number.isInteger(c.start) && text.slice(c.start, c.start + q.length) === q) return [c.start, c.start + q.length];
  let best = null, bestScore = -1, bestDist = Infinity;
  let i = text.indexOf(q), n = 0;
  while (i >= 0 && n < 500) {
    const score = commonTail(text.slice(Math.max(0, i - CTX), i), c.prefix || "") + commonHead(text.slice(i + q.length, i + q.length + CTX), c.suffix || "");
    const dist = Math.abs(i - (c.start || 0));
    if (score > bestScore || (score === bestScore && dist < bestDist)) { best = i; bestScore = score; bestDist = dist; }
    i = text.indexOf(q, i + 1); n++;
  }
  return best == null ? null : [best, best + q.length];
}

/** Position après un delta Yjs. `insertBefore` : une insertion exactement à `pos` se place avant (la position avance). */
function shiftPos(pos, delta, insertBefore) {
  let idx = 0;
  for (const op of delta) {
    if (op.retain) idx += op.retain;
    else if (op.insert !== undefined) {
      const len = typeof op.insert === "string" ? op.insert.length : 1;
      if (idx < pos || (insertBefore && idx === pos)) pos += len;
      idx += len;
    } else if (op.delete) {
      if (idx < pos) pos -= Math.min(op.delete, pos - idx);
    }
  }
  return pos;
}

class CommentStore {
  constructor(file) {
    this.file = file;
    this.map = {}; // chemin -> { id: fil }
    this.saveTimer = null;
    this._load();
  }

  _load() {
    try { this.map = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch (_e) { this.map = {}; }
    if (typeof this.map !== "object" || this.map === null || Array.isArray(this.map)) this.map = {};
    for (const list of Object.values(this.map)) for (const c of Object.values(list || {})) this._upgrade(c);
  }

  /** Fils enregistrés par les versions ≤ 0.9.4 (snippet, sans réponses). */
  _upgrade(c) {
    if (!Array.isArray(c.replies)) c.replies = [];
    if (c.quote == null) c.quote = c.snippet || "";
    if (c.prefix == null) c.prefix = "";
    if (c.suffix == null) c.suffix = "";
    if (!Number.isInteger(c.start)) c.start = 0;
    if (!Number.isInteger(c.end)) c.end = c.start + c.quote.length;
    if (!c.quote || c.end <= c.start) c.orphan = true;
    delete c.snippet; delete c.line;
  }

  _save() {
    clearTimeout(this.saveTimer); this.saveTimer = null;
    const dir = path.dirname(this.file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.map, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  /** Enregistrement différé (les plages bougent à chaque frappe). */
  saveSoon() { if (!this.saveTimer) this.saveTimer = setTimeout(() => { try { this._save(); } catch (e) { console.error("[commentaires]", e.message); } }, 2000); }
  flush() { if (this.saveTimer) this._save(); }

  _list(p) { return this.map[p] || null; }
  has(p) { const l = this._list(p); return !!(l && Object.keys(l).length); }
  get(p, id) { const l = this._list(p); return (l && l[id]) || null; }
  all(p) { return Object.values(this._list(p) || {}).sort((a, b) => a.created - b.created); }

  add(p, { author, authorName, color, text, start, end, quote, prefix, suffix }) {
    const list = this.map[p] || (this.map[p] = {});
    const id = newId();
    list[id] = {
      id, author, authorName, color: cleanColor(color), text: cleanText(text), created: Date.now(), edited: 0,
      quote: String(quote).slice(0, MAX_QUOTE), prefix: prefix || "", suffix: suffix || "",
      start, end, orphan: false, resolved: false, resolvedBy: "", resolvedAt: 0, replies: [],
    };
    this._save();
    return list[id];
  }

  reply(p, id, { author, authorName, color, text }) {
    const c = this.get(p, id);
    if (!c) return null;
    const r = { id: newId(), author, authorName, color: cleanColor(color), text: cleanText(text), created: Date.now(), edited: 0 };
    c.replies.push(r);
    if (c.resolved) { c.resolved = false; c.resolvedBy = ""; c.resolvedAt = 0; } // répondre rouvre la discussion
    this._save();
    return r;
  }

  /** Élément d'un fil : le commentaire principal ou l'une de ses réponses. */
  item(p, id, replyId) {
    const c = this.get(p, id);
    if (!c) return null;
    return replyId ? c.replies.find((r) => r.id === replyId) || null : c;
  }

  edit(p, id, replyId, text) {
    const it = this.item(p, id, replyId);
    if (!it) return null;
    it.text = cleanText(text);
    it.edited = Date.now();
    this._save();
    return it;
  }

  remove(p, id, replyId) {
    const c = this.get(p, id);
    if (!c) return false;
    if (replyId) {
      const n = c.replies.length;
      c.replies = c.replies.filter((r) => r.id !== replyId);
      if (c.replies.length === n) return false;
    } else delete this.map[p][id];
    if (!Object.keys(this.map[p]).length) delete this.map[p];
    this._save();
    return true;
  }

  setResolved(p, id, resolved, byName) {
    const c = this.get(p, id);
    if (!c) return null;
    c.resolved = !!resolved;
    c.resolvedBy = resolved ? String(byName || "") : "";
    c.resolvedAt = resolved ? Date.now() : 0;
    this._save();
    return c;
  }

  clearPath(p) { if (this.map[p]) { delete this.map[p]; this._save(); } }

  /** Document renommé / déplacé : ses discussions le suivent. */
  movePath(from, to) {
    if (!this.map[from] || from === to) return;
    this.map[to] = this.map[from];
    delete this.map[from];
    this._save();
  }

  /** Document (re)chargé : chaque fil retrouve son passage dans le texte, ou est détaché. */
  anchorAll(p, text) {
    const list = this._list(p);
    if (!list) return;
    let changed = false;
    for (const c of Object.values(list)) {
      if (c.orphan) continue;
      const at = locate(text, c);
      if (!at) { c.orphan = true; changed = true; continue; }
      if (at[0] !== c.start || at[1] !== c.end) { c.start = at[0]; c.end = at[1]; changed = true; }
    }
    if (changed) this._save();
  }

  /** Modification du document ouvert : les plages suivent le texte. */
  shift(p, delta) {
    const list = this._list(p);
    if (!list) return;
    let changed = false;
    for (const c of Object.values(list)) {
      if (c.orphan) continue;
      const s = shiftPos(c.start, delta, true), e = shiftPos(c.end, delta, false);
      if (s === c.start && e === c.end) continue;
      c.start = s; c.end = Math.max(s, e);
      if (c.end <= c.start) c.orphan = true; // tout le passage a été supprimé
      changed = true;
    }
    if (changed) this.saveSoon();
  }

  /** Passage et contexte mis à jour d'après le texte courant (à l'enregistrement du document). */
  refresh(p, text) {
    const list = this._list(p);
    if (!list) return;
    let changed = false;
    for (const c of Object.values(list)) {
      if (c.orphan || c.end > text.length) continue;
      const q = text.slice(c.start, c.end);
      const ctx = context(text, c.start, c.end);
      if (q !== c.quote || ctx.prefix !== c.prefix || ctx.suffix !== c.suffix) {
        c.quote = q.slice(0, MAX_QUOTE); c.prefix = ctx.prefix; c.suffix = ctx.suffix; changed = true;
      }
    }
    if (changed) this.saveSoon();
  }
}

module.exports = { CommentStore, locate, context, shiftPos };
