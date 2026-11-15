// Stockage des commentaires façon « Google Docs » (par document / chemin).
// Persisté dans data/comments.json (jamais poussé sur GitHub).
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

class CommentStore {
  constructor(file) {
    this.file = file;
    this.map = {}; // path -> { id: comment }
    this._load();
  }
  _load() {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      this.map = JSON.parse(raw);
    } catch (_e) { this.map = {}; }
    if (typeof this.map !== "object" || this.map === null || Array.isArray(this.map)) this.map = {};
  }
  _save() {
    const dir = path.dirname(this.file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.map, null, 2));
  }
  all(pathName) {
    const list = this.map[pathName] || (this.map[pathName] = {});
    return Object.values(list).sort((a, b) => (a.created || 0) - (b.created || 0));
  }
  add(pathName, { author, authorName, color, text, line, start, end, snippet }) {
    const list = this.map[pathName] || (this.map[pathName] = {});
    const id = crypto.randomBytes(6).toString("hex");
    list[id] = {
      id, author, authorName, color,
      text: String(text).slice(0, 1000),
      line: Number.isFinite(+line) ? +line : 0,
      start: Number.isFinite(+start) ? +start : null,
      end: Number.isFinite(+end) ? +end : null,
      snippet: String(snippet || "").slice(0, 200),
      created: Date.now(), resolved: false,
    };
    this._save();
    return list[id];
  }
  remove(pathName, id) {
    const list = this.map[pathName];
    if (!list || !list[id]) return false;
    delete list[id];
    this._save();
    return true;
  }
  setResolved(pathName, id, resolved) {
    const c = this.map[pathName] && this.map[pathName][id];
    if (!c) return null;
    c.resolved = !!resolved;
    this._save();
    return c;
  }
  clearPath(pathName) {
    if (this.map[pathName]) { delete this.map[pathName]; this._save(); }
  }
}

module.exports = { CommentStore };