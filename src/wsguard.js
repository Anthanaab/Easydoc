/**
 * wsguard.js — contrôle des messages temps réel envoyés par les navigateurs.
 *
 *  - Modifications (Yjs) : un navigateur ne peut toucher QUE le texte du document. Les autres
 *    données partagées (« meta » : chargé, supprimé, déplacé…) sont écrites par le serveur seul ;
 *    une modification qui les viserait (ajout, remplacement ou suppression) est refusée en entier.
 *  - Présence (awareness) : le nom affiché est celui du compte de la connexion, la couleur doit
 *    être une vraie couleur, et une connexion ne peut ni remplacer ni effacer la présence d'une autre.
 */
"use strict";
const Y = require("yjs");
const decoding = require("lib0/decoding");
const encoding = require("lib0/encoding");

const TEXT_CONTENT = new Set([Y.ContentString, Y.ContentFormat, Y.ContentDeleted]);
const COLOR_RE = /^#[0-9a-f]{6}$/i;

/** Structure du document (déjà intégrée) qui contient l'identifiant `id`, ou null. */
function storeStruct(doc, id) {
  const structs = doc.store.clients.get(id.client);
  if (!structs || !structs.length) return null;
  const last = structs[structs.length - 1];
  if (id.clock < structs[0].id.clock || id.clock >= last.id.clock + last.length) return null;
  return structs[Y.findIndexSS(structs, id.clock)];
}

/** Contenu Yjs d'un message de synchronisation (step 2 ou update), ou null. */
function syncUpdate(u8) {
  try {
    const d = decoding.createDecoder(u8);
    if (decoding.readVarUint(d) !== 0) return null;
    const kind = decoding.readVarUint(d);
    if (kind !== 1 && kind !== 2) return null;
    return decoding.readVarUint8Array(d);
  } catch (_e) { return null; }
}

/** true si la mise à jour `update` ne modifie que le texte `textName` de `doc`. */
function textOnly(doc, update, textName) {
  const ytext = doc.getText(textName);
  let dec;
  try { dec = Y.decodeUpdate(update); } catch (_e) { return false; }
  const byClient = new Map();
  for (const s of dec.structs) {
    let l = byClient.get(s.id.client);
    if (!l) byClient.set(s.id.client, (l = []));
    l.push(s);
  }
  const inUpdate = (id) => {
    const l = byClient.get(id.client);
    if (l) for (const s of l) if (s.id.clock <= id.clock && id.clock < s.id.clock + s.length) return s;
    return null;
  };
  const known = (s) => { const st = Y.getState(doc.store, s.id.client); return s.id.clock + s.length <= st; };
  // verdict de chaque élément : true (dans le texte, ou sans effet), false (ailleurs)
  const verdict = new Map();
  const direct = (s) => {
    if (!(s instanceof Y.Item)) return true;                    // GC / Skip : aucun contenu
    if (!TEXT_CONTENT.has(s.content.constructor)) return false; // valeur, objet, type imbriqué…
    if (typeof s.parent === "string") return s.parent === textName;
    if (s.parent) return false;                                 // type imbriqué : jamais dans ce document
    const ref = s.origin || s.rightOrigin;
    if (!ref) return false;
    const st = storeStruct(doc, ref);
    if (st) return st instanceof Y.GC ? true : st.parent === ytext;
    const u = inUpdate(ref);
    if (!u || u === s) return true;                             // dépendance absente : mise en attente par Yjs
    return u;                                                   // à résoudre (même mise à jour)
  };
  for (const s of dec.structs) {
    if (verdict.has(s) || known(s)) continue;
    // chaîne d'éléments qui dépendent les uns des autres : résolue sans récursion
    const chain = new Set();
    let cur = s, v;
    for (;;) {
      if (verdict.has(cur)) { v = verdict.get(cur); break; }
      const r = direct(cur);
      if (r === true || r === false) { v = r; verdict.set(cur, r); break; }
      chain.add(cur);
      if (chain.has(r)) { v = false; break; }                   // boucle : mise à jour invalide
      cur = r;
    }
    for (const c of chain) verdict.set(c, v);
    if (!v) return false;
  }
  // suppressions : seulement des éléments du texte
  for (const [client, ranges] of dec.ds.clients) {
    const structs = doc.store.clients.get(client);
    if (!structs || !structs.length) continue;
    const end = structs[structs.length - 1].id.clock + structs[structs.length - 1].length;
    for (const { clock, len } of ranges) {
      if (clock >= end) continue;
      let i = clock < structs[0].id.clock ? 0 : Y.findIndexSS(structs, clock);
      for (; i < structs.length && structs[i].id.clock < clock + len; i++) {
        const s = structs[i];
        if (s instanceof Y.Item && s.parent !== ytext) return false;
      }
    }
  }
  return true;
}

/**
 * Message de présence réécrit pour la connexion `conn` du compte `user`, ou null s'il ne reste
 * rien à transmettre. `owners` : identifiant de présence → connexion qui l'a utilisé la première.
 */
function rewriteAwareness(u8, conn, owners, user) {
  if (!user) return null;
  try {
    const d = decoding.createDecoder(u8);
    if (decoding.readVarUint(d) !== 1) return null;
    const upd = decoding.createDecoder(decoding.readVarUint8Array(d));
    const n = decoding.readVarUint(upd);
    const out = [];
    for (let i = 0; i < n; i++) {
      const clientID = decoding.readVarUint(upd);
      const clock = decoding.readVarUint(upd);
      let state = JSON.parse(decoding.readVarString(upd));
      const owner = owners.get(clientID);
      if (owner && owner !== conn) continue; // présence d'une autre connexion : ni remplacée ni effacée
      if (!owner) { owners.set(clientID, conn); (conn.edAwareIds || (conn.edAwareIds = new Set())).add(clientID); }
      if (state !== null && typeof state !== "object") state = null;
      if (state && state.user) {
        const color = COLOR_RE.test(String(state.user.color || "")) ? state.user.color : "#6b7280";
        state.user = { name: user.displayName || user.username, color, colorLight: color + "33" };
      }
      out.push([clientID, clock, state]);
    }
    if (!out.length) return null;
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, out.length);
    for (const [id, clock, state] of out) {
      encoding.writeVarUint(e, id);
      encoding.writeVarUint(e, clock);
      encoding.writeVarString(e, JSON.stringify(state));
    }
    const msg = encoding.createEncoder();
    encoding.writeVarUint(msg, 1);
    encoding.writeVarUint8Array(msg, encoding.toUint8Array(e));
    return encoding.toUint8Array(msg);
  } catch (_e) { return null; }
}

/** Connexion fermée : ses identifiants de présence sont libérés. */
function releaseAwareness(conn, owners) {
  for (const id of conn.edAwareIds || []) if (owners.get(id) === conn) owners.delete(id);
}

module.exports = { syncUpdate, textOnly, rewriteAwareness, releaseAwareness };
