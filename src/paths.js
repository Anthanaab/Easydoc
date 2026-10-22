/**
 * paths.js — validation des chemins et types de fichiers.
 *
 * Tout chemin venant du navigateur (API ou WebSocket) passe par safeFilePath() :
 * pas de « .. », pas de chemin absolu, pas de dossier/fichier caché (.git, .env…).
 * Empêche la lecture du jeton ou l'écriture en dehors du dépôt.
 */
"use strict";

const path = require("path");

const MAX_LEN = 300;
const SEGMENT = /^[\p{L}\p{N} _.()&+,'@[\]!~=-]+$/u;
const EDITABLE = /\.(md|markdown|txt)$/i;

const KINDS = {
  markdown: ["md", "markdown"],
  text: ["txt"],
  pdf: ["pdf"],
  image: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg"],
  docx: ["docx"],
  word: ["doc", "odt", "rtf", "pages"],
  sheet: ["xlsx", "xls", "ods", "csv", "numbers"],
  slides: ["pptx", "ppt", "odp", "key"],
};
const BY_EXT = {};
for (const [kind, exts] of Object.entries(KINDS)) for (const e of exts) BY_EXT[e] = kind;

/** Chemin relatif sûr vers n'importe quel fichier du dépôt, ou null. */
function safeFilePath(input) {
  if (typeof input !== "string") return null;
  let p = input.replace(/\\/g, "/").trim();
  if (!p || p.length > MAX_LEN || p.includes("\0")) return null;
  p = p.replace(/^\/+/, "");
  const norm = path.posix.normalize(p);
  if (norm !== p.replace(/\/{2,}/g, "/")) return null; // contenait ./ ou ../
  for (const seg of norm.split("/")) {
    if (!seg || seg === "." || seg === ".." || seg.startsWith(".")) return null;
    if (!SEGMENT.test(seg)) return null;
  }
  return norm;
}

/** Chemin sûr vers un document modifiable en temps réel (.md, .txt), ou null. */
function safeDocPath(input) {
  const p = safeFilePath(input);
  return p && EDITABLE.test(p) ? p : null;
}

const isEditable = (p) => EDITABLE.test(p);
const isHidden = (p) => p.split("/").some((s) => s.startsWith("."));
function kindOf(p) {
  const ext = path.posix.extname(p).slice(1).toLowerCase();
  return BY_EXT[ext] || "other";
}

module.exports = { safeFilePath, safeDocPath, isEditable, isHidden, kindOf };
