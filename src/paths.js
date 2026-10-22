/**
 * paths.js — validation des chemins de documents.
 *
 * Tout chemin venant du navigateur (API ou WebSocket) passe par safeDocPath() :
 * pas de « .. », pas de chemin absolu, pas de dossier/fichier caché (.git, .env…),
 * uniquement des fichiers Markdown. Empêche la lecture du jeton ou l'écriture
 * en dehors du dépôt.
 */
"use strict";

const path = require("path");

const MAX_LEN = 300;

function safeDocPath(input) {
  if (typeof input !== "string") return null;
  let p = input.replace(/\\/g, "/").trim();
  if (!p || p.length > MAX_LEN || p.includes("\0")) return null;
  p = p.replace(/^\/+/, "");
  const norm = path.posix.normalize(p);
  if (norm !== p.replace(/\/{2,}/g, "/")) return null; // contenait ./ ou ../
  const parts = norm.split("/");
  for (const seg of parts) {
    if (!seg || seg === "." || seg === ".." || seg.startsWith(".")) return null;
    if (!/^[\p{L}\p{N} _.()&+,'@-]+$/u.test(seg)) return null;
  }
  if (!/\.md$/i.test(norm)) return null;
  return norm;
}

module.exports = { safeDocPath };
