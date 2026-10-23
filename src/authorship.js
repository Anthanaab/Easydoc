/**
 * authorship.js — « qui a écrit quoi ».
 *
 * Chaque caractère du document Yjs porte deux attributs de mise en forme invisibles :
 *    a : auteur   « u:<identifiant> » (compte Easydoc), « ai:claude », « x:<nom> » (commit externe)
 *    t : date     en minutes depuis 1970
 * Ils sont posés par le serveur (impossible à falsifier depuis un navigateur) et conservés entre
 * deux ouvertures dans data/authorship/ (fichier annexe, hors du dépôt). Sans fichier annexe,
 * l'attribution est reconstituée à partir de l'historique git (blame).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Diff = require("diff");

const CLAUDE = "ai:claude";
const nowMin = () => Math.floor(Date.now() / 60000);
const toMin = (d) => { const x = new Date(d).getTime(); return Number.isFinite(x) ? Math.floor(x / 60000) : nowMin(); };

/** Opérations minimales pour passer de oldText à newText : [{eq|del|ins, len, text}]. */
function diffOps(oldText, newText) {
  if (oldText === newText) return [{ op: "eq", len: oldText.length }];
  const parts = Diff.diffLines(oldText, newText, { stripTrailingCr: false });
  const ops = [];
  const push = (op, text) => { if (text) ops.push({ op, len: text.length, text }); };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const next = parts[i + 1];
    // bloc remplacé : on affine au mot près (garde l'attribution des mots inchangés)
    if (p.removed && next && next.added && p.value.length + next.value.length < 40000) {
      for (const w of Diff.diffWordsWithSpace(p.value, next.value)) push(w.added ? "ins" : w.removed ? "del" : "eq", w.value);
      i++;
    } else push(p.added ? "ins" : p.removed ? "del" : "eq", p.value);
  }
  return ops;
}

/**
 * Remplace le contenu d'un Y.Text par newValue en ne touchant que ce qui a changé ; le texte
 * inséré reçoit les attributs `attrs` (auteur). À appeler dans une transaction.
 */
function applyFineDiff(ytext, newValue, attrs) {
  const cur = ytext.toString();
  if (cur === newValue) return false;
  let i = 0;
  for (const o of diffOps(cur, newValue)) {
    if (o.op === "eq") i += o.len;
    else if (o.op === "del") ytext.delete(i, o.len);
    else { ytext.insert(i, o.text, attrs || {}); i += o.len; }
  }
  return true;
}

/** Délimitation compacte d'un Y.Text : [[longueur, auteur, minute], …]. */
function runsFromYText(ytext) {
  const runs = [];
  for (const op of ytext.toDelta()) {
    if (typeof op.insert !== "string") continue;
    const a = (op.attributes && op.attributes.a) || "";
    const t = (op.attributes && op.attributes.t) || 0;
    const last = runs[runs.length - 1];
    if (last && last[1] === a && last[2] === t) last[0] += op.insert.length;
    else runs.push([op.insert.length, a, t]);
  }
  return runs;
}

/** Segments [{text, a, t}] à partir d'un texte et de ses runs (tolère un léger décalage). */
function segmentsFrom(text, runs) {
  const out = [];
  let i = 0;
  for (const [len, a, t] of runs || []) {
    if (i >= text.length) break;
    const n = Math.min(len, text.length - i);
    if (n > 0) out.push({ text: text.slice(i, i + n), a, t });
    i += n;
  }
  if (i < text.length) out.push({ text: text.slice(i), a: "", t: 0 });
  return out;
}

/** Remplit un Y.Text vide avec des segments attribués. */
function insertSegments(ytext, segs) {
  let i = 0;
  for (const s of segs) {
    if (!s.text) continue;
    ytext.insert(i, s.text, s.a ? { a: s.a, t: s.t || 0 } : {});
    i += s.text.length;
  }
}

/**
 * Réconcilie une attribution connue (ancien texte) avec le contenu actuel : le texte inchangé
 * garde son auteur, le nouveau texte est attribué à `author` (dernier commit).
 */
function reconcile(oldText, oldRuns, newText, author) {
  return reconcileSegs(segmentsFrom(oldText, oldRuns), newText, author);
}

/** Comme reconcile, à partir de segments [{text, a, t}]. */
function reconcileSegs(segs, newText, author) {
  const oldText = segs.map((x) => x.text).join("");
  // positions → attribution de l'ancien texte
  const out = [];
  let si = 0, off = 0; // segment courant, décalage dans ce segment
  const take = (len, keep) => {
    while (len > 0 && si < segs.length) {
      const s = segs[si];
      const n = Math.min(len, s.text.length - off);
      if (keep) out.push({ text: s.text.slice(off, off + n), a: s.a, t: s.t });
      off += n; len -= n;
      if (off >= s.text.length) { si++; off = 0; }
    }
  };
  for (const o of diffOps(oldText, newText)) {
    if (o.op === "eq") take(o.len, true);
    else if (o.op === "del") take(o.len, false);
    else out.push({ text: o.text, a: author.a, t: author.t });
  }
  // fusion des segments contigus identiques
  const merged = [];
  for (const s of out) {
    const l = merged[merged.length - 1];
    if (l && l.a === s.a && l.t === s.t) l.text += s.text; else merged.push({ ...s });
  }
  return merged;
}

/** Nombre de caractères identiques entre deux textes (mesure de ressemblance). */
function commonChars(a, b) {
  let n = 0;
  for (const o of diffOps(a, b)) if (o.op === "eq") n += o.len;
  return n;
}

/**
 * Rejoue l'historique d'un fichier : versions [{key, t, text|null}] du plus ancien au plus récent
 * (text null = fichier supprimé à cette version). À chaque version, le texte inchangé garde son
 * auteur, seuls les mots ajoutés ou modifiés vont à l'auteur de la version. Un fichier supprimé
 * puis remis repart de sa dernière version connue ; `base` sert de point de départ (fichier
 * copié d'une autre branche, ou début d'un historique trop long).
 * Retourne { segs, lastAlive } (segs null si le fichier n'existe plus à la fin).
 */
function replay(versions, base) {
  let cur = null, lastAlive = base || null;
  for (const v of versions) {
    if (v.text == null) { if (cur) lastAlive = cur; cur = null; continue; }
    const from = cur || lastAlive;
    if (from && from.map((x) => x.text).join("") === v.text) { cur = from; continue; }
    cur = from ? reconcileSegs(from, v.text, { a: v.key, t: v.t }) : (v.text ? [{ text: v.text, a: v.key, t: v.t }] : []);
  }
  return { segs: cur, lastAlive: cur || lastAlive };
}

/**
 * Fusion d'une attribution reconstituée avec l'ancienne (même texte) : on garde l'ancienne quand
 * elle désigne précisément un compte (frappe en direct) et que la reconstitution est moins précise
 * (commit à plusieurs noms, auteur inconnu).
 */
function mergePreferLive(oldSegs, newSegs) {
  const text = newSegs.map((x) => x.text).join("");
  if (oldSegs.map((x) => x.text).join("") !== text) return newSegs;
  const at = (segs) => { const out = new Array(text.length); let i = 0; for (const x of segs) for (let k = 0; k < x.text.length; k++) out[i++] = x; return out; };
  const A = at(oldSegs), B = at(newSegs);
  const merged = [];
  for (let i = 0; i < text.length; i++) {
    const o = A[i], n = B[i];
    const vague = !n.a || (n.a.startsWith("x:") && n.a.includes(","));
    const w = o && o.a && o.a.startsWith("u:") && vague ? o : n;
    const l = merged[merged.length - 1];
    if (l && l.a === w.a && l.t === w.t) l.text += text[i]; else merged.push({ text: text[i], a: w.a, t: w.t });
  }
  return merged;
}

/** map asynchrone avec au plus `n` appels simultanés (API GitHub). */
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const k = next++; out[k] = await fn(items[k], k); }
  }));
  return out;
}


/** Fichier apparu sur cette branche sans version précédente : copié d'une autre branche ? */
async function donorFromBranches(repo, name, firstText, keyOfCommit) {
  const versionOf = (c, text) => ({ key: keyOfCommit(c), t: toMin(c.date), text });
  let branches = [];
  try { branches = await repo.otherBranches(4); } catch (_e) { return null; }
  let best = null, bestScore = 0;
  for (const b of branches) {
    try {
      const { list } = await repo.versions(name, { branch: b, limit: 100 });
      if (!list.length) continue;
      const texts = await mapLimit(list, 6, (c) => repo.readAt(name, c.sha));
      const { lastAlive } = replay(list.map((c, k) => versionOf(c, texts[k])), null);
      if (!lastAlive) continue;
      const score = commonChars(lastAlive.map((x) => x.text).join(""), firstText);
      if (score > bestScore) { best = lastAlive; bestScore = score; }
    } catch (e) { console.error(`[auteurs] branche ${b} : ${e.message}`); }
  }
  return bestScore >= firstText.length * 0.3 ? best : null;
}

/**
 * Attribution d'un fichier reconstituée en rejouant son historique (mot à mot) : suppressions et
 * remises en place, copies depuis une autre branche, historique très long (départ du blame).
 * `since` + `base` : ne rejoue que les versions postérieures à une attribution connue.
 */
async function historySegments(repo, name, content, keyOfCommit, { fromText = null, base = null } = {}) {
  const versionOf = (c, text) => ({ key: keyOfCommit(c), t: toMin(c.date), text });
  const { list, truncated } = await repo.versions(name, { limit: 200 });
  let vs = list, start = null, since = false;
  if (fromText != null && base) {
    // attribution connue pour `fromText` : on retrouve cette version (par son contenu, pas par sa
    // date : l'horloge de l'auteur d'un commit peut être décalée) et on ne rejoue que la suite
    for (let k = list.length - 1; k >= Math.max(0, list.length - 40); k--) {
      if ((await repo.readAt(name, list[k].sha)) === fromText) { vs = list.slice(k + 1); start = base; since = true; break; }
    }
    if (!since && !list.length) { vs = []; start = base; since = true; }
  }
  if (!since && truncated && vs.length) {
    const first = vs.shift();
    const text = await repo.readAt(name, first.sha);
    if (text != null) {
      let ranges = [];
      try { ranges = await repo.blame(name, first.sha); } catch (_e) {}
      start = ranges.length ? segmentsFromBlame(text, ranges, keyOfCommit) : [{ text, a: keyOfCommit(first), t: toMin(first.date) }];
    }
  }
  const texts = await mapLimit(vs, 6, (c) => repo.readAt(name, c.sha));
  if (!since && !start) {
    const firstText = texts.find((t) => t != null && t.length > 0);
    if (firstText) start = await donorFromBranches(repo, name, firstText, keyOfCommit);
  }
  const r = replay(vs.map((c, k) => versionOf(c, texts[k])), start);
  let segs = r.segs || r.lastAlive || [];
  const text = segs.map((x) => x.text).join("");
  if (text !== content) { // modification pas encore commitée (dépôt local) ou version plus récente
    const last = vs[vs.length - 1];
    const who = repo.mode === "local" ? { a: "x:Modification externe", t: nowMin() }
      : last ? { a: keyOfCommit(last), t: toMin(last.date) } : { a: "", t: 0 };
    segs = text ? reconcileSegs(segs, content, who) : [{ text: content, a: who.a, t: who.t }];
  }
  return segs;
}

/** Plages de lignes d'un blame → segments de caractères. */
function segmentsFromBlame(text, ranges, keyOf) {
  const lines = text.split("\n");
  const lineAuthor = new Array(lines.length).fill(null);
  for (const r of ranges || []) {
    const who = { a: keyOf(r), t: toMin(r.date) };
    for (let l = r.start; l <= r.end && l <= lines.length; l++) if (l >= 1) lineAuthor[l - 1] = who;
  }
  const segs = [];
  lines.forEach((line, idx) => {
    const piece = line + (idx < lines.length - 1 ? "\n" : "");
    if (!piece) return;
    const w = lineAuthor[idx] || { a: "", t: 0 };
    const last = segs[segs.length - 1];
    if (last && last.a === w.a && last.t === w.t) last.text += piece;
    else segs.push({ text: piece, a: w.a, t: w.t });
  });
  return segs;
}

/**
 * Auteur d'un commit :
 *  - Claude (auteur « Claude », adresse anthropic, ou ligne « Co-Authored-By: Claude » ajoutée
 *    par Claude Code) ;
 *  - commits d'Easydoc : noms entre parenthèses à la fin du titre ;
 *  - sinon l'auteur git, rattaché à un compte Easydoc si le nom correspond.
 */
function keyFromCommit(c, users) {
  const name = String((c && c.name) || "").trim();
  const email = String((c && c.email) || "");
  const message = String((c && c.message) || "");
  const title = message.split("\n")[0];
  if (/\bclaude\b/i.test(name) || /anthropic\.com/i.test(email) || /co-authored-by:\s*claude\b/i.test(message)) return CLAUDE;
  if (c && c.uncommitted) return "x:Modification externe";
  const match = (n) => {
    const s = String(n || "").trim().toLowerCase();
    if (!s) return null;
    const u = users.all().find((x) => x.username === s || x.displayName.toLowerCase() === s);
    return u ? `u:${u.username}` : null;
  };
  if (/^Easydoc\s*:/.test(title)) {
    const m = title.match(/\(([^()]*)\)\s*$/);
    if (m && m[1].trim() && m[1].trim() !== "modification") {
      const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
      if (names.length === 1) return match(names[0]) || `x:${names[0].slice(0, 40)}`;
      return `x:${names.join(", ").slice(0, 60)}`;
    }
    const old = title.match(/^Easydoc\s*:\s*([^/()]{1,40})$/); // ancien format « Easydoc: Nom »
    if (old && !/\.\w+$/.test(old[1].trim())) return match(old[1]) || `x:${old[1].trim()}`;
    return "x:Easydoc";
  }
  return match(c && c.login) || match(name) || `x:${(name || (c && c.login) || "Inconnu").slice(0, 40)}`;
}

/** Nom lisible d'une clé d'auteur. */
function nameOfKey(key, users) {
  if (!key) return "";
  if (key === CLAUDE) return "Claude";
  if (key.startsWith("u:")) { const u = users.byUsername(key.slice(2)); return u ? u.displayName : key.slice(2); }
  if (key.startsWith("x:")) return key.slice(2);
  return key;
}

/** Fichiers annexes d'attribution : data/authorship/<dépôt>/<empreinte du chemin>.json */
class AuthorshipStore {
  constructor(dir) { this.dir = dir; }
  file(repoKey, p) {
    const r = crypto.createHash("sha1").update(repoKey).digest("hex").slice(0, 16);
    const h = crypto.createHash("sha1").update(p).digest("hex");
    return path.join(this.dir, r, `${h}.json`);
  }
  load(repoKey, p) {
    try {
      const d = JSON.parse(fs.readFileSync(this.file(repoKey, p), "utf8"));
      return d && d.path === p && typeof d.text === "string" && Array.isArray(d.runs) ? d : null;
    } catch (_e) { return null; }
  }
  save(repoKey, p, text, runs, v) { // v = 2 : attribution reconstituée depuis l'historique complet
    const f = this.file(repoKey, p);
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ v: v || 1, path: p, text, runs, savedAt: Date.now() }), { mode: 0o600 });
      fs.renameSync(tmp, f);
    } catch (e) { console.error(`[auteurs] ${p} : ${e.message}`); }
  }
  remove(repoKey, p) { try { fs.unlinkSync(this.file(repoKey, p)); } catch (_e) {} }
}

module.exports = {
  CLAUDE, nowMin, toMin, diffOps, applyFineDiff, runsFromYText, segmentsFrom, insertSegments,
  historySegments, donorFromBranches, mapLimit,
  reconcile, reconcileSegs, commonChars, replay, mergePreferLive, segmentsFromBlame, keyFromCommit, nameOfKey, AuthorshipStore,
};
