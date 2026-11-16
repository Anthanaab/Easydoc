/**
 * links.js — liens entre documents (Markdown).
 *
 * Après un renommage ou un déplacement, les liens relatifs qui menaient aux fichiers déplacés sont
 * réécrits vers leur nouvel emplacement ; les liens d'un document déplacé dans un autre dossier
 * sont recalculés depuis ce dossier. Les liens externes, les ancres seules et les liens qui ne
 * menaient à aucun fichier connu ne sont jamais modifiés.
 */
"use strict";

const encSeg = (s) => encodeURIComponent(s).replace(/\(/g, "%28").replace(/\)/g, "%29");
const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/** Fichier du dépôt désigné par `href` depuis le document `fromPath` : { target, suffix, root } ou null. */
function resolve(href, fromPath) {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("//")) return null;
  const cut = href.search(/[?#]/);
  const suffix = cut >= 0 ? href.slice(cut) : "";
  const bare = cut >= 0 ? href.slice(0, cut) : href;
  if (!bare) return null;
  try {
    const dir = dirOf(fromPath);
    const base = "http://x/" + (dir ? dir.split("/").map(encSeg).join("/") + "/" : "");
    const u = new URL(bare.replace(/ /g, "%20"), base);
    return { target: decodeURIComponent(u.pathname.slice(1)), suffix, root: bare.startsWith("/") };
  } catch (_e) { return null; }
}

/** Chemin relatif de `to` vu depuis le dossier `fromDir`, chaque partie encodée comme dans un lien Markdown. */
function relative(fromDir, to) {
  const a = fromDir ? fromDir.split("/") : [];
  const b = to.split("/");
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].map((s) => (s === ".." ? s : encSeg(s))).join("/");
}

// [texte](adresse "titre") et ![image](adresse) ; adresse entre < > possible ; une paire de
// parenthèses permise dans l'adresse (« compte rendu (v2).md »)
const INLINE = /(!?\[(?:[^\]\\\n]|\\.)*\]\()(\s*)(<[^>\n]*>|(?:[^()\s]|\([^()\s]*\))+)((?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\))/g;
// [étiquette]: adresse (définition de référence)
const REFDEF = /^( {0,3}\[[^\]\n]+\]:[ \t]*)(<[^>\n]*>|\S+)/gm;

/**
 * Texte de `text` (document anciennement `oldPath`, désormais `newPath`) avec ses liens mis à jour.
 * `moved` : Map ancien chemin → nouveau ; `exists` : chemins connus AVANT le déplacement.
 */
function rewrite(text, oldPath, newPath, moved, exists) {
  const fix = (raw) => {
    const angle = raw.startsWith("<") && raw.endsWith(">");
    const href = angle ? raw.slice(1, -1) : raw;
    const r = resolve(href, oldPath);
    if (!r || !exists.has(r.target)) return raw;               // lien externe ou cassé : on n'y touche pas
    const target = moved.get(r.target) || r.target;
    if (target === r.target && oldPath === newPath) return raw; // rien n'a bougé pour ce lien
    const rel = r.root ? "/" + target.split("/").map(encSeg).join("/") : relative(dirOf(newPath), target);
    const out = rel + r.suffix;
    if (resolve(href, newPath) && resolve(href, newPath).target === target) return raw; // déjà juste (même écrit autrement)
    return angle ? `<${decodeURIComponent(out)}>` : out;
  };
  return text
    .replace(INLINE, (m, open, sp, url, close) => open + sp + fix(url) + close)
    .replace(REFDEF, (m, head, url) => head + fix(url));
}

module.exports = { resolve, relative, rewrite };
