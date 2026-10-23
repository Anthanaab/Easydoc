// Easydoc — interface (éditeur collaboratif temps réel adossé à un dépôt git/GitHub).
import { Y, WebsocketProvider, Marked, DOMPurify } from "./vendor/libs.js";

/* ============================================================================================
 * Utilitaires
 * ========================================================================================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const LOCAL = { origin: "local-editor" }; // origine des modifications tapées dans cet onglet
const wsBase = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
const encPath = (p) => p.split("/").map(encodeURIComponent).join("/");
const fileName = (p) => p.split("/").pop();
const dirName = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const displayName = (p) => fileName(p).replace(/\.(md|markdown)$/i, "");
const norm = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const rawUrl = (p, download) => `/api/raw?path=${encodeURIComponent(p)}${download ? "&download=1" : ""}`;

const isEditable = (p) => /\.(md|markdown|txt)$/i.test(p);
const extOf = (p) => { const b = fileName(p); const i = b.lastIndexOf("."); return i > 0 ? b.slice(i + 1).toLowerCase() : ""; };
const KIND_EXT = {
  markdown: ["md", "markdown"], text: ["txt"], pdf: ["pdf"], image: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg"],
  docx: ["docx"], word: ["doc", "odt", "rtf", "pages"], sheet: ["xlsx", "xls", "ods", "csv", "numbers"], slides: ["pptx", "ppt", "odp", "key"],
};
const KIND_LABEL = { markdown: "Document", text: "Texte", pdf: "PDF", image: "Image", docx: "Word", word: "Document", sheet: "Tableur", slides: "Présentation", other: "Fichier" };
function kindOf(p) { const e = extOf(p); for (const [k, list] of Object.entries(KIND_EXT)) if (list.includes(e)) return k; return "other"; }
function fmtSize(n) {
  if (n == null) return "";
  if (n < 1024) return `${n} o`;
  if (n < 1048576) return `${Math.round(n / 1024)} Ko`;
  return `${(n / 1048576).toFixed(1).replace(".", ",")} Mo`;
}

const ICONS = {
  branch: '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
  fileBlank: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  settings: '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  menu: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',
  pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  columns: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  unlink: '<path d="m18.84 12.25 1.72-1.71a4.95 4.95 0 0 0-7-7l-1.72 1.71"/><path d="m5.17 11.75-1.71 1.71a4.95 4.95 0 0 0 7 7l1.71-1.71"/><path d="M8 2v3"/><path d="M2 8h3"/><path d="M16 22v-3"/><path d="M22 16h-3"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  highlight: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
};
const svg = (name, cls = "") => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ""}</svg>`;
function hydrateIcons(root = document) {
  for (const el of $$("[data-icon]", root)) {
    if (el.dataset.drawn !== el.dataset.icon) { el.innerHTML = svg(el.dataset.icon); el.dataset.drawn = el.dataset.icon; }
  }
}
function iconFor(p) {
  const k = kindOf(p);
  if (k === "markdown" || k === "text") return svg("file");
  if (k === "image") return svg("image", "k-image");
  return svg("fileBlank", `k-${k}`);
}

function toast(msg, opts = {}) {
  const t = document.createElement("div");
  t.className = "toast" + (opts.error ? " err" : "");
  t.textContent = msg;
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), opts.ms || (opts.error ? 6000 : 3200));
}

async function api(method, url, body) {
  let r;
  try {
    r = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch (_e) { throw new Error("Serveur injoignable."); }
  let d = {};
  try { d = await r.json(); } catch (_e) {}
  if (r.status === 401 && !url.startsWith("/api/auth/")) sessionLost();
  if (!r.ok || d.ok === false) throw new Error(d.error || `Erreur ${r.status}`);
  return d;
}
function sessionLost() {
  if (sessionLost.done) return;
  sessionLost.done = true;
  // plus de nouvelles tentatives de connexion temps réel : elles seraient refusées
  try { if (S && S.provider) S.provider.destroy(); } catch (_e) {}
  try { if (sys) sys.destroy(); } catch (_e) {}
  toast("Ta session a expiré : reconnexion…", { error: true });
  setTimeout(() => location.reload(), 1200);
}

function relTime(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 10) return "à l'instant";
  if (s < 60) return `il y a ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `il y a ${m} min`;
  return `il y a ${Math.round(m / 60)} h`;
}

/** Chemin d'un lien/image relatif dans un document, ou null (lien externe, ancre…). */
function resolveRel(href, fromPath) {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("//")) return null;
  try {
    const base = "http://x/" + (dirName(fromPath) ? encPath(dirName(fromPath)) + "/" : "");
    const u = new URL(href, base);
    return decodeURIComponent(u.pathname.slice(1));
  } catch (_e) { return null; }
}

/* ============================================================================================
 * Identité, thème
 * ========================================================================================== */
const PALETTE = ["#4f46e5", "#0891b2", "#059669", "#d97706", "#dc2626", "#db2777", "#7c3aed", "#2563eb", "#65a30d", "#ea580c"];
function colorFor(name) { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; }
function initials(name) {
  const p = name.trim().split(/\s+/).filter(Boolean);
  return ((p[0] || "?")[0] + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
}
function avatarHTML(user, extra = "") {
  return `<span class="avatar" style="background:${esc(user.color)}" ${extra}>${esc(initials(user.name))}</span>`;
}

let me = null;        // compte connecté
let adminRules = {};  // règles d'accès (affichées aux administrateurs)
const isAdmin = () => !!(me && me.role === "admin");
function setMe(u) {
  me = { id: u.id, username: u.username, name: u.displayName, role: u.role, groups: u.groups || [], color: colorFor(u.username) };
  renderMe();
  const user = { name: me.name, color: me.color };
  if (sys) sys.awareness.setLocalStateField("user", user);
  if (S && S.provider) S.provider.awareness.setLocalStateField("user", user);
}
function renderMe() {
  $("#meName").textContent = me ? me.name : "";
  const a = $("#meAvatar");
  a.textContent = initials(me ? me.name : "?");
  a.style.background = me ? me.color : "#888";
  $("#btnMe").title = me ? `${me.name} (${me.username}) — mon compte` : "";
}

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem("ed-theme", t);
  const b = $("#btnTheme [data-icon]");
  b.dataset.icon = t === "dark" ? "sun" : "moon";
  hydrateIcons($("#btnTheme"));
}

/* ============================================================================================
 * Fenêtres (modales)
 * ========================================================================================== */
let modalClose = null;
function openModal({ title, subtitle = "", body = "", foot = "", locked = false, wide = false, onMount }) {
  closeModal();
  const m = $("#modal"), card = $("#modalCard");
  card.classList.toggle("wide", wide);
  card.innerHTML = `<div class="m-head"><h3>${esc(title)}</h3>${subtitle ? `<p>${subtitle}</p>` : ""}</div>
    <div class="m-body">${body}</div>${foot ? `<div class="m-foot">${foot}</div>` : ""}`;
  hydrateIcons(card);
  m.classList.remove("hidden");
  const onKey = (e) => { if (e.key === "Escape" && !locked) closeModal(); };
  const onBg = (e) => { if (e.target === m && !locked) closeModal(); };
  document.addEventListener("keydown", onKey);
  m.addEventListener("mousedown", onBg);
  modalClose = () => {
    document.removeEventListener("keydown", onKey);
    m.removeEventListener("mousedown", onBg);
    m.classList.add("hidden");
    card.innerHTML = "";
  };
  if (onMount) onMount(card);
  const first = card.querySelector("input");
  if (first) setTimeout(() => first.focus(), 30);
}
function closeModal() { if (modalClose) { const f = modalClose; modalClose = null; f(); } }
function setMsg(card, text, kind = "info") { const m = $(".msg", card); m.className = `msg ${kind}`; m.textContent = text; }

/** Premier démarrage (création de l'administrateur) ou connexion. */
function showAuth(mode) {
  document.body.classList.add("auth-mode");
  const setup = mode === "setup";
  openModal({
    locked: true,
    title: setup ? "Bienvenue sur Easydoc" : "Connexion à Easydoc",
    subtitle: setup
      ? "Crée le compte administrateur. Tu pourras ensuite créer les comptes des autres participants et choisir qui voit quels dossiers."
      : "Connecte-toi pour accéder aux documents.",
    body: `<div class="field"><label for="aUser">Identifiant</label><input class="input" id="aUser" autocomplete="username" autocapitalize="none" spellcheck="false" ${setup ? 'placeholder="ex. camille"' : ""} /></div>
      ${setup ? '<div class="field"><label for="aName">Nom affiché</label><input class="input" id="aName" maxlength="40" placeholder="ex. Camille Martin" /><span class="hint">Visible par les autres participants et dans l\'historique des enregistrements.</span></div>' : ""}
      <div class="field"><label for="aPass">Mot de passe</label><input class="input" id="aPass" type="password" autocomplete="${setup ? "new-password" : "current-password"}" />${setup ? '<span class="hint">8 caractères minimum.</span>' : ""}</div>
      ${setup ? '<div class="field"><label for="aPass2">Confirmation du mot de passe</label><input class="input" id="aPass2" type="password" autocomplete="new-password" /></div>' : ""}
      <div class="msg"></div>`,
    foot: `<button class="btn btn-primary" data-act="ok">${setup ? "Créer le compte" : "Se connecter"}</button>`,
    onMount(card) {
      const go = async () => {
        const username = $("#aUser", card).value.trim(), password = $("#aPass", card).value;
        if (!username) return $("#aUser", card).focus();
        if (!password) return $("#aPass", card).focus();
        if (setup && password !== $("#aPass2", card).value) return setMsg(card, "Les deux mots de passe ne correspondent pas.", "err");
        const btn = $('[data-act="ok"]', card);
        btn.disabled = true;
        setMsg(card, setup ? "Création du compte…" : "Connexion…");
        try {
          await api("POST", setup ? "/api/auth/setup" : "/api/auth/login",
            setup ? { username, password, displayName: $("#aName", card).value } : { username, password });
          location.reload();
        } catch (e) { setMsg(card, e.message, "err"); btn.disabled = false; }
      };
      $('[data-act="ok"]', card).onclick = go;
      card.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("input")) go(); });
    },
  });
}

function openAccount() {
  openModal({
    title: "Mon compte",
    subtitle: `Identifiant : <strong>${esc(me.username)}</strong> · ${isAdmin() ? "administrateur" : "membre"}${me.groups.length ? ` · groupes : ${me.groups.map(esc).join(", ")}` : ""}`,
    body: `<div class="field"><label for="fDisp">Nom affiché</label><input class="input" id="fDisp" maxlength="40" value="${esc(me.name)}" /></div>
      <div class="section-t">Changer de mot de passe</div>
      <div class="field"><label for="fCur">Mot de passe actuel</label><input class="input" id="fCur" type="password" autocomplete="current-password" /></div>
      <div class="field"><label for="fNew">Nouveau mot de passe</label><input class="input" id="fNew" type="password" autocomplete="new-password" /><span class="hint">8 caractères minimum. Tes sessions sur les autres appareils seront fermées.</span></div>
      <div class="msg"></div>`,
    foot: `<button class="btn left" data-act="logout">${svg("logout")}Se déconnecter</button><button class="btn" data-act="cancel">Fermer</button><button class="btn btn-primary" data-act="save">Enregistrer</button>`,
    onMount(c) {
      $('[data-act="cancel"]', c).onclick = closeModal;
      $('[data-act="logout"]', c).onclick = async () => {
        sessionLost.done = true;
        try { await api("POST", "/api/auth/logout"); } catch (_e) {}
        location.reload();
      };
      $('[data-act="save"]', c).onclick = async () => {
        const name = $("#fDisp", c).value.trim(), cur = $("#fCur", c).value, next = $("#fNew", c).value;
        const busy = (on) => $$(".m-foot button", c).forEach((b) => { b.disabled = on; });
        busy(true);
        try {
          if (name && name !== me.name) setMe((await api("POST", "/api/auth/profile", { displayName: name })).user);
          if (cur || next) {
            if (!cur) throw new Error("Indique ton mot de passe actuel.");
            await api("POST", "/api/auth/password", { current: cur, next });
            sessionLost.done = true; // les connexions temps réel vont être renouvelées
            setMsg(c, "Mot de passe changé.", "ok");
            setTimeout(() => location.reload(), 900);
            return;
          }
          closeModal();
          toast("Compte mis à jour.");
        } catch (e) { setMsg(c, e.message, "err"); busy(false); }
      };
    },
  });
}

/* ============================================================================================
 * Canal système : présence globale + notifications (liste des fichiers, changement de dépôt)
 * ========================================================================================== */
let sysDoc = null, sys = null, sysMap = null;
let seenVersions = null;
function connectSystem() {
  sysDoc = new Y.Doc();
  sys = new WebsocketProvider(wsBase, "__system__", sysDoc, { disableBc: true });
  sysMap = sysDoc.getMap("sys");
  sys.awareness.setLocalStateField("user", { name: me.name, color: me.color });
  sys.on("sync", (ok) => {
    if (ok && !seenVersions) seenVersions = { tree: sysMap.get("treeVersion"), config: sysMap.get("configVersion"), restart: sysMap.get("restartAt") };
  });
  sys.on("connection-close", (ev) => { if (ev && ev.code === 4001) sessionLost(); });
  sysMap.observe(() => {
    if (!seenVersions) return;
    const cfg = sysMap.get("configVersion"), tree = sysMap.get("treeVersion");
    const rs = sysMap.get("restartAt");
    if (rs !== undefined && rs !== seenVersions.restart) { seenVersions.restart = rs; waitForNewVersion(); return; }
    if (cfg !== undefined && cfg !== seenVersions.config) { toast("Le dépôt connecté a changé — rechargement…"); setTimeout(() => location.reload(), 800); return; }
    if (tree !== seenVersions.tree) { seenVersions.tree = tree; refreshTree(); if (isAdmin()) loadRules(); }
  });
  sys.awareness.on("change", () => { renderPresence(); renderTree(); });
}
const setPresence = (k, v) => { if (sys) sys.awareness.setLocalStateField(k, v); };
/** Empreinte d'un chemin : la présence ne révèle pas aux autres le nom des fichiers qu'ils ne voient pas. */
function hashPath(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function othersByPath() {
  const out = new Map();
  if (!sys) return out;
  sys.awareness.getStates().forEach((s, id) => {
    if (id === sysDoc.clientID || !s.user || !s.path) return;
    if (!out.has(s.path)) out.set(s.path, []);
    out.get(s.path).push({ name: String(s.user.name || "Anonyme").slice(0, 40), color: s.user.color || "#888", line: s.line });
  });
  return out;
}

/* ============================================================================================
 * Liste des fichiers
 * ========================================================================================== */
let files = [];
const fileInfo = new Map(); // chemin → { size, kind }
const closed = new Set(JSON.parse(localStorage.getItem("ed-closed") || "[]"));
const currentPath = () => (S ? S.path : F ? F.path : null);
const canWrite = (p) => (fileInfo.get(p) || {}).access === "write";

async function refreshTree() {
  try {
    const d = await api("GET", "/api/files");
    fileInfo.clear();
    for (const f of d.files) fileInfo.set(f.path, f);
    files = d.files.map((f) => f.path).sort((a, b) => a.localeCompare(b, "fr", { sensitivity: "base" }));
    renderTree();
    const cur = currentPath();
    if (cur && !fileInfo.has(cur) && (F || (S && S.loaded))) { toast("Ce fichier n'est plus disponible (supprimé ou accès retiré)."); showEmpty(); }
    else if (F) { F.size = fileInfo.get(F.path).size; renderStatus(); updateButtons(); }
    else if (S && S.loaded && !S.offline) { ta.readOnly = !canWrite(S.path); renderStatus(); updateButtons(); }
  } catch (e) { toast("Impossible de lire la liste des fichiers : " + e.message, { error: true }); }
}

function buildTree(paths) {
  const root = { dirs: new Map(), files: [] };
  for (const p of paths) {
    const parts = p.split("/");
    let node = root, acc = "";
    for (const part of parts.slice(0, -1)) {
      acc = acc ? `${acc}/${part}` : part;
      if (!node.dirs.has(part)) node.dirs.set(part, { path: acc, dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push(p);
  }
  return root;
}

function fileNode(p, others, showDir) {
  const el = document.createElement("div");
  el.className = "node file" + (currentPath() === p ? " active" : "");
  el.title = p;
  el.dataset.path = p;
  const dots = (others.get(hashPath(p)) || []).slice(0, 3).map((u) => `<i style="background:${esc(u.color)}" title="${esc(u.name)}"></i>`).join("");
  const where = showDir && dirName(p) ? ` <span class="ext">· ${esc(dirName(p))}</span>` : "";
  const mark = isAdmin() && adminRules[p] ? `<span class="lockmark" title="Droits d'accès particuliers">${svg("lock")}</span>`
    : !isAdmin() && (fileInfo.get(p) || {}).access === "read" ? `<span class="lockmark" title="Lecture seule">${svg("eye")}</span>` : "";
  el.innerHTML = `${iconFor(p)}<span class="name">${esc(displayName(p))}${where}</span>${mark}<span class="dots">${dots}</span>`;
  el.onclick = () => { openFile(p); $("#app").classList.remove("nav-open"); };
  return el;
}

function renderTree() {
  const tree = $("#tree");
  const q = norm($("#search").value.trim());
  const others = othersByPath();
  tree.innerHTML = "";
  if (!files.length) { tree.innerHTML = '<div class="tree-empty">Aucun fichier pour l\'instant.</div>'; return; }
  if (q) {
    const hits = files.filter((p) => norm(p).includes(q));
    if (!hits.length) tree.innerHTML = '<div class="tree-empty">Aucun résultat.</div>';
    for (const p of hits) tree.appendChild(fileNode(p, others, true));
    return;
  }
  const draw = (node, parent) => {
    for (const [name, d] of [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0], "fr"))) {
      const open = !closed.has(d.path);
      const row = document.createElement("div");
      row.className = "node folder" + (open ? " open" : "");
      row.dataset.dir = d.path;
      const lock = isAdmin() && adminRules[d.path] ? `<span class="lockmark" title="Droits d'accès particuliers">${svg("lock")}</span>` : "";
      row.innerHTML = `<span class="chev">${svg("chevron")}</span>${svg("folder")}<span class="name">${esc(name)}</span>${lock}`;
      row.onclick = () => {
        if (closed.has(d.path)) closed.delete(d.path); else closed.add(d.path);
        localStorage.setItem("ed-closed", JSON.stringify([...closed]));
        renderTree();
      };
      parent.appendChild(row);
      if (open) {
        const kids = document.createElement("div");
        kids.className = "children";
        draw(d, kids);
        parent.appendChild(kids);
      }
    }
    for (const p of node.files) parent.appendChild(fileNode(p, others, false));
  };
  draw(buildTree(files), tree);
}

/* ============================================================================================
 * Session d'édition (document Markdown / texte ouvert)
 * ========================================================================================== */
const ta = $("#editor");
const paneEditor = $("#paneEditor");
const area = $("#area");
const marked = new Marked({ gfm: true, breaks: true });
let S = null; // document en cours d'édition
let F = null; // fichier affiché (PDF, Word, image…)

function setArea(state, kind = "") { area.dataset.state = state; area.dataset.kind = kind; }
function currentView() { return area.dataset.view; }

function autosize() {
  const st = paneEditor.scrollTop;
  ta.style.height = "auto";
  ta.style.height = Math.max(ta.scrollHeight, paneEditor.clientHeight) + "px";
  paneEditor.scrollTop = st;
}

/** Position d'un index après application d'un delta Yjs (garde le curseur en place). */
function shiftIndex(pos, delta) {
  let idx = 0;
  for (const op of delta) {
    if (op.retain) idx += op.retain;
    else if (op.insert !== undefined) {
      const len = typeof op.insert === "string" ? op.insert.length : 1;
      if (idx < pos) pos += len;
      idx += len;
    } else if (op.delete) {
      if (idx < pos) pos -= Math.min(op.delete, pos - idx);
    }
  }
  return pos;
}

/** Applique la valeur du textarea au Y.Text par un diff minimal guidé par le curseur. */
function applyLocal(value) {
  const yt = S.ytext;
  const cur = yt.toString();
  if (cur === value) return;
  const caret = ta.selectionEnd;
  let start = 0;
  const max = Math.min(cur.length, value.length);
  while (start < max && cur[start] === value[start]) start++;
  let eCur = cur.length, eNew = value.length;
  while (eCur > start && eNew > Math.max(start, caret) && cur[eCur - 1] === value[eNew - 1]) { eCur--; eNew--; }
  S.ydoc.transact(() => {
    if (eCur > start) yt.delete(start, eCur - start);
    if (eNew > start) yt.insert(start, value.slice(start, eNew));
  }, LOCAL);
}

function closeSession() {
  F = null;
  overlay.innerHTML = "";
  renderAuthorsBar(null);
  hideTip();
  $("#paneFile").innerHTML = "";
  if (!S) return;
  const s = S;
  S = null;
  clearTimeout(s.fallbackTimer); clearTimeout(s.offlineTimer); clearInterval(s.retryTimer);
  try { s.provider && s.provider.destroy(); } catch (_e) {}
  try { s.ydoc.destroy(); } catch (_e) {}
  setPresence("path", null);
}

function showEmpty() {
  closeSession();
  setPresence("path", null);
  setArea("empty");
  ta.value = "";
  $("#crumbs").innerHTML = "";
  history.replaceState(null, "", location.pathname);
  document.title = "Easydoc";
  renderStatus(); renderPresence(); renderTree(); updateButtons();
}

function renderCrumbs(p) {
  const parts = p.split("/");
  const segs = parts.slice(0, -1).map((x) => `<span class="seg">${esc(x)}</span><span class="sep">${svg("chevron")}</span>`).join("");
  $("#crumbs").innerHTML = `${segs}<span class="cur">${esc(displayName(p))}</span>`;
}

function enterPath(path) {
  renderCrumbs(path);
  document.title = `${displayName(path)} — Easydoc`;
  history.replaceState(null, "", "#/" + encPath(path));
  setPresence("path", hashPath(path));
}

function openFile(path, opts = {}) {
  if (!isEditable(path)) return openViewer(path);
  if (S && S.path === path && !opts.force) return;
  closeSession();
  const ydoc = new Y.Doc();
  const provider = new WebsocketProvider(wsBase, encPath(path), ydoc, { disableBc: true });
  const s = S = {
    path, ydoc, provider, kind: kindOf(path),
    ytext: ydoc.getText("content"), meta: ydoc.getMap("meta"),
    loaded: false, connected: false, offline: false, reconnecting: false,
    lastLocalEdit: 0, savedSeen: 0, dirty: false, pendingText: opts.pendingText ?? null,
  };
  s.undo = new Y.UndoManager(s.ytext, { trackedOrigins: new Set([LOCAL]), captureTimeout: 600 });
  provider.awareness.setLocalStateField("user", { name: me.name, color: me.color });

  setArea("loading", s.kind === "text" ? "text" : "");
  ta.readOnly = true;
  ta.value = "";
  ta.placeholder = "Chargement…";
  enterPath(path);
  renderTree(); renderStatus(); renderPresence(); updateButtons();

  provider.on("status", (e) => {
    if (S !== s) return;
    s.connected = e.status === "connected";
    if (!s.connected && s.loaded && !s.offline) startReconnect(s);
    renderStatus();
  });

  provider.on("connection-close", (ev) => {
    if (S !== s || !ev) return;
    if (ev.code === 4003) {
      setTimeout(() => {
        if (S !== s) return;
        toast("Ton accès à ce document a été retiré.", { error: true });
        showEmpty();
        refreshTree();
      }, 0);
    } else if (ev.code === 4001) sessionLost();
  });

  s.ytext.observe(() => { if (S === s) renderOverlay(); }); // couleurs des auteurs
  provider.awareness.on("change", () => { if (S === s) renderOverlay(); }); // curseurs des autres
  s.ytext.observe((event) => {
    if (S !== s || !s.loaded || event.transaction.origin === LOCAL) return;
    const val = s.ytext.toString();
    if (ta.value === val) return;
    const focused = document.activeElement === ta;
    const a = shiftIndex(ta.selectionStart, event.delta), b = shiftIndex(ta.selectionEnd, event.delta);
    ta.value = val;
    autosize();
    if (focused) ta.setSelectionRange(a, b);
    schedulePreview();
  });

  s.meta.observe((event) => {
    if (S !== s) return;
    const keys = event.keysChanged;
    if (s.meta.get("loaded") && !s.loaded) onLoaded(s);
    if (keys.has("savedAt")) { s.savedSeen = Date.now(); if (s.lastLocalEdit <= s.savedSeen) s.dirty = false; }
    if (keys.has("externalAt") && s.loaded) {
      const by = s.meta.get("externalBy");
      toast(by && by !== "Modification externe" ? `Document mis à jour depuis le dépôt par ${by}.` : "Document mis à jour depuis le dépôt (modification externe).");
    }
    if (keys.has("deleted")) { toast("Ce document a été supprimé."); refreshTree(); showEmpty(); return; }
    renderStatus();
  });

  // Temps réel injoignable (proxy sans WebSocket, pare-feu…) : on ouvre quand même via HTTP.
  s.fallbackTimer = setTimeout(() => { if (S === s && !s.loaded) startOffline(s); }, 6000);
}

function onLoaded(s) {
  s.loaded = true;
  clearTimeout(s.fallbackTimer);
  if (s.meta.get("exists") === false && !files.includes(s.path)) {
    toast("Ce document n'existe pas (ou plus) dans le dépôt.", { error: true });
    showEmpty();
    return;
  }
  setArea("doc", s.kind === "text" ? "text" : "");
  ta.readOnly = !canWrite(s.path);
  ta.placeholder = ta.readOnly ? "" : s.kind === "text" ? "Commence à écrire…" : "Commence à écrire… (Markdown)";
  ta.value = s.ytext.toString();
  autosize();
  if (s.pendingText != null && s.pendingText !== ta.value && !ta.readOnly) {
    ta.value = s.pendingText;
    applyLocal(s.pendingText);
    s.dirty = true; s.lastLocalEdit = Date.now();
    toast("Tes modifications faites pendant la coupure ont été réintégrées.");
  }
  s.pendingText = null;
  s.savedSeen = Date.now();
  renderPreview(); renderStatus(); updateButtons(); renderOverlay(); publishCursor();
}

/** Coupure du temps réel : on repart d'un document neuf à la reconnexion (évite les doublons). */
function startReconnect(s) {
  if (s.reconnecting) return;
  s.reconnecting = true;
  try { s.provider.disconnect(); } catch (_e) {}
  renderStatus();
  s.retryTimer = setInterval(async () => {
    if (S !== s) { clearInterval(s.retryTimer); return; }
    try {
      const r = await fetch("/api/auth/state", { cache: "no-store" });
      if (!r.ok) return;
      const state = await r.json();
      clearInterval(s.retryTimer);
      if (!state.user) { sessionLost(); return; }
      await refreshTree();
      if (S !== s) return;
      if (!fileInfo.has(s.path)) { toast("Ce document n'est plus disponible."); showEmpty(); return; }
      const pending = s.dirty || ta.value !== s.ytext.toString() ? ta.value : null;
      openFile(s.path, { force: true, pendingText: pending });
    } catch (_e) {}
  }, 2000);
}

/** Mode dégradé : pas de WebSocket — lecture et enregistrement par HTTP. */
async function startOffline(s) {
  s.offline = true;
  try { s.provider.disconnect(); } catch (_e) {}
  try {
    const d = await api("GET", "/api/file?path=" + encodeURIComponent(s.path));
    if (S !== s) return;
    s.loaded = true;
    setArea("doc", s.kind === "text" ? "text" : "");
    ta.readOnly = !canWrite(s.path);
    ta.placeholder = ta.readOnly ? "" : "Commence à écrire…";
    ta.value = d.content;
    autosize(); renderPreview(); renderStatus(); updateButtons();
    toast("Temps réel indisponible : le document est ouvert sans collaboration en direct (vérifie le relais WebSocket du proxy).", { error: true, ms: 9000 });
  } catch (e) {
    toast("Impossible d'ouvrir le document : " + e.message, { error: true });
  }
}

async function saveNow(manual) {
  if (!S || !S.loaded) return;
  const s = S;
  const body = { path: s.path };
  if (s.offline) body.content = ta.value;
  s.saving = true; renderStatus();
  try {
    const d = await api("POST", "/api/save", body);
    if (S !== s) return;
    s.savedSeen = Date.now(); s.dirty = false;
    if (manual) toast(d.committed ? "Enregistré dans le dépôt." : "Déjà à jour.");
  } catch (e) {
    toast("Échec de l'enregistrement : " + e.message, { error: true });
  } finally {
    s.saving = false; renderStatus();
  }
}

ta.addEventListener("input", () => {
  const s = S;
  if (!s || !s.loaded || ta.readOnly) return;
  s.lastLocalEdit = Date.now(); s.dirty = true;
  if (s.offline) {
    clearTimeout(s.offlineTimer);
    s.offlineTimer = setTimeout(() => saveNow(false), 3000);
  } else if (!s.reconnecting) {
    applyLocal(ta.value);
  }
  autosize(); schedulePreview(); renderStatus(); publishLine(); renderOverlay(); publishCursor();
});

ta.addEventListener("keydown", (e) => {
  if (!S || !S.loaded || ta.readOnly) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !S.offline && (e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y")) {
    e.preventDefault();
    if (e.key.toLowerCase() === "y" || e.shiftKey) S.undo.redo(); else S.undo.undo();
    return;
  }
  if (e.key === "Tab" && !mod && !e.altKey) {
    e.preventDefault();
    document.execCommand("insertText", false, "  ");
  }
});
let lineT = null;
function publishLine() {
  clearTimeout(lineT);
  lineT = setTimeout(() => {
    if (!S) return;
    const line = ta.value.slice(0, ta.selectionStart).split("\n").length;
    setPresence("line", line);
  }, 250);
}
["keyup", "click", "select"].forEach((ev) => ta.addEventListener(ev, publishLine));
window.addEventListener("resize", () => { if (S && S.loaded) { autosize(); renderOverlay(); } });

/* ============================================================================================
 * Visionneuse (PDF, Word, images, autres fichiers)
 * ========================================================================================== */
function openViewer(path) {
  if (F && F.path === path) return;
  closeSession();
  const info = fileInfo.get(path) || {};
  const kind = kindOf(path);
  F = { path, kind, size: info.size };
  const f = F;
  setArea("file");
  enterPath(path);
  const canConvert = kind === "docx" || kind === "pdf";
  const badge = esc((extOf(path) || "?").toUpperCase().slice(0, 4));
  const pane = $("#paneFile");
  pane.innerHTML = `<div class="fileview">
      <div class="filehead">
        <div class="fileicon k-${kind}">${badge}</div>
        <div class="filemeta"><div class="t">${esc(fileName(path))}</div><div class="s" id="fileMetaLine">${esc(KIND_LABEL[kind])}${info.size != null ? " · " + fmtSize(info.size) : ""}</div></div>
        <div class="fileactions">
          ${canConvert ? `<button class="btn" data-act="convert" title="Crée un document Markdown modifiable à plusieurs ; le fichier d'origine est conservé">${svg("pencil")}Créer une version modifiable</button>` : ""}
          <a class="btn" href="${rawUrl(path, true)}" download="${esc(fileName(path))}" data-act="download">${svg("download")}Télécharger</a>
        </div>
      </div>
      <div class="filebody" id="fileBody"></div>
    </div>`;
  const body = $("#fileBody", pane);
  if (kind === "pdf") {
    body.innerHTML = `<iframe class="pdf-frame" src="${rawUrl(path)}" title="${esc(fileName(path))}"></iframe>`;
  } else if (kind === "image") {
    body.innerHTML = `<div class="imgview"><img src="${rawUrl(path)}" alt="${esc(fileName(path))}" /></div>`;
  } else if (kind === "docx") {
    body.innerHTML = '<div class="loadingview">Préparation de l\'aperçu…</div>';
    api("GET", "/api/preview?path=" + encodeURIComponent(path)).then((d) => {
      if (F !== f) return;
      body.innerHTML = `<div class="docview"><article class="prose" id="docxPreview"></article></div>`;
      $("#docxPreview", body).innerHTML = DOMPurify.sanitize(d.html);
    }).catch((e) => {
      if (F !== f) return;
      body.innerHTML = `<div class="nopreview">${svg("fileBlank")}<div>${esc(e.message)}</div></div>`;
    });
  } else {
    body.innerHTML = `<div class="nopreview">${svg("fileBlank")}<div><strong>Pas d'aperçu pour ce type de fichier.</strong></div>
      <div>Télécharge-le pour l'ouvrir avec ton logiciel habituel.</div></div>`;
  }
  if (canConvert) $('[data-act="convert"]', pane).onclick = () => convertFile(path);
  renderTree(); renderStatus(); renderPresence(); updateButtons();
}

function convertFile(path) {
  const kind = kindOf(path);
  openModal({
    title: "Créer une version modifiable",
    subtitle: kind === "pdf"
      ? "Le texte du PDF est copié dans un nouveau document Markdown, modifiable à plusieurs. La mise en page n'est pas conservée ; le PDF d'origine reste intact."
      : "Le contenu du fichier Word est copié dans un nouveau document Markdown, modifiable à plusieurs. Titres, listes, gras, liens, tableaux et images sont conservés ; le fichier d'origine reste intact.",
    body: '<div class="msg"></div>',
    foot: '<button class="btn" data-act="cancel">Annuler</button><button class="btn btn-primary" data-act="ok">Créer</button>',
    onMount(card) {
      $('[data-act="cancel"]', card).onclick = closeModal;
      $('[data-act="ok"]', card).onclick = async () => {
        $$(".m-foot button", card).forEach((b) => { b.disabled = true; });
        setMsg(card, "Conversion en cours…");
        try {
          const d = await api("POST", "/api/convert", { path });
          closeModal();
          await refreshTree();
          openFile(d.path);
          toast(`Version modifiable créée : ${fileName(d.path)}${d.images ? ` (${d.images} image${d.images > 1 ? "s" : ""})` : ""}.`);
        } catch (e) {
          setMsg(card, e.message, "err");
          $$(".m-foot button", card).forEach((b) => { b.disabled = false; });
        }
      };
    },
  });
}

/* ============================================================================================
 * Import de fichiers (bouton + glisser-déposer)
 * ========================================================================================== */
let config = {};
const currentFolder = () => (currentPath() ? dirName(currentPath()) : "");
function cleanName(name) {
  let n = name.normalize("NFC").replace(/[^\p{L}\p{N} _.()&+,'@[\]!~=-]/gu, "-").replace(/-{2,}/g, "-").replace(/^[.\s-]+/, "").trim();
  if (!n) n = "fichier";
  return n.slice(0, 120);
}

async function uploadFiles(list, folder = currentFolder()) {
  const items = [...list].filter((f) => f && f.size !== undefined);
  if (!items.length) return;
  const maxMB = config.maxUploadMB || 25;
  const where = folder ? `dans « ${folder} »` : "à la racine";
  toast(items.length > 1 ? `Import de ${items.length} fichiers ${where}…` : `Import de « ${items[0].name} » ${where}…`);
  let done = 0, last = null;
  for (const f of items) {
    if (f.size > maxMB * 1048576) { toast(`« ${f.name} » dépasse ${maxMB} Mo : non importé.`, { error: true }); continue; }
    const name = cleanName(f.name);
    const p = folder ? `${folder}/${name}` : name;
    try {
      const r = await fetch(`/api/upload?path=${encodeURIComponent(p)}`, {
        method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: f,
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error || `erreur ${r.status}`);
      done++; last = d.path;
      if (d.renamed) toast(`« ${name} » existait déjà : importé sous « ${fileName(d.path)} ».`);
    } catch (e) {
      toast(`Échec de l'import de « ${f.name} » : ${e.message}`, { error: true });
    }
  }
  await refreshTree();
  if (done) {
    toast(done > 1 ? `${done} fichiers importés.` : "Fichier importé.");
    if (done === 1 && last) openFile(last);
  }
}

const fileInput = $("#fileInput");
const pickFiles = () => fileInput.click();
fileInput.addEventListener("change", () => { uploadFiles(fileInput.files); fileInput.value = ""; });

let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files");
window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  const folder = currentFolder();
  $("#dropzoneText").textContent = folder ? `Dépose tes fichiers pour les importer dans « ${folder} »` : "Dépose tes fichiers pour les importer";
  document.body.classList.add("dragging");
});
window.addEventListener("dragover", (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
window.addEventListener("dragleave", (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove("dragging");
});
window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  // déposé sur un dossier de la liste : import dans ce dossier
  const dirRow = e.target.closest && e.target.closest(".node.folder");
  uploadFiles(e.dataTransfer.files, dirRow ? dirRow.dataset.dir : currentFolder());
});

/* ============================================================================================
 * Auteurs : qui a écrit quoi (surlignage), qui écrit où (curseurs des autres), historique
 * ========================================================================================== */
const people = new Map(); // « u:identifiant » → { name }
let peopleVersion = 0;
let showAuthors = localStorage.getItem("ed-authors") === "1";
let focusAuthor = null;   // n'afficher qu'un auteur
const CLAUDE_COLOR = "#d97757";

async function loadPeople() {
  try {
    const d = await api("GET", "/api/people");
    people.clear();
    for (const p of d.people) people.set(p.key, p);
    peopleVersion++;
  } catch (_e) {}
}

let peopleT = null, peopleAt = 0;
/** Compte inconnu (créé après le chargement de la page) : on recharge l'annuaire, au plus toutes les 10 s. */
function refreshPeopleSoon() {
  if (peopleT || Date.now() - peopleAt < 10000) return;
  peopleT = setTimeout(async () => { peopleAt = Date.now(); await loadPeople(); peopleT = null; renderOverlay(); }, 200);
}
function personOf(key) {
  if (!key) return { key: "", name: "Auteur inconnu", color: "#9ca3af", unknown: true };
  if (key === "ai:claude") return { key, name: "Claude", color: CLAUDE_COLOR, ai: true };
  if (key.startsWith("u:")) {
    const u = key.slice(2), p = people.get(key);
    if (!p) refreshPeopleSoon();
    return { key, name: p ? p.name : u, color: colorFor(u), me: !!me && u === me.username };
  }
  const n = key.slice(2) || key;
  return { key, name: n, color: colorFor(n), ext: true };
}
function personAvatar(pr, extra = "") {
  if (pr.ai) return `<span class="avatar ai" style="background:${pr.color}" ${extra}>${svg("bot")}</span>`;
  return avatarHTML({ name: pr.name, color: pr.color }, extra);
}

function whenText(min) {
  if (!min) return "";
  const ms = min * 60000, d = new Date(ms), now = new Date();
  if (Date.now() - ms < 3600 * 1000 * 12) return relTime(ms);
  const time = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `aujourd'hui à ${time}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `hier à ${time}`;
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" }) + ` à ${time}`;
}

/* ---- Calque sous l'éditeur : couleurs des auteurs, curseurs et sélections des autres ---- */
const overlay = $("#overlay");
const OV_PROPS = ["fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "wordSpacing", "tabSize",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "boxSizing", "whiteSpace", "overflowWrap", "wordBreak", "textIndent", "fontVariantLigatures", "fontFeatureSettings"];
let ovRaf = 0;
function renderOverlay() { cancelAnimationFrame(ovRaf); ovRaf = requestAnimationFrame(drawOverlay); }

function remoteCursors() {
  const out = [];
  if (!S || !S.provider) return out;
  S.provider.awareness.getStates().forEach((st, id) => {
    if (id === S.ydoc.clientID || !st.cursor || !st.user) return;
    try {
      const abs = (j) => { const r = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(j), S.ydoc); return r ? r.index : null; };
      const a = abs(st.cursor.anchor), h = abs(st.cursor.head);
      if (a == null || h == null) return;
      out.push({ anchor: a, head: h, name: String(st.user.name || "").slice(0, 40), color: st.user.color || "#888" });
    } catch (_e) {}
  });
  return out;
}

function drawOverlay() {
  const live = S && S.loaded && !S.offline && !S.reconnecting && currentView() !== "preview";
  const text = live ? ta.value : "";
  if (!live || text !== S.ytext.toString()) { overlay.innerHTML = ""; renderAuthorsBar(null); return; }
  const cursors = remoteCursors();
  const runs = []; // [début, fin, auteur, minute]
  if (showAuthors) {
    let i = 0;
    for (const op of S.ytext.toDelta()) {
      if (typeof op.insert !== "string") continue;
      const at = op.attributes || {};
      runs.push([i, i + op.insert.length, at.a || "", at.t || 0]);
      i += op.insert.length;
    }
  }
  renderAuthorsBar(showAuthors ? runs : null);
  if (!runs.length && !cursors.length) { overlay.innerHTML = ""; return; }

  // copie exacte de la mise en page du textarea
  const cs = getComputedStyle(ta);
  for (const k of OV_PROPS) overlay.style[k] = cs[k];
  overlay.style.top = ta.offsetTop + "px";
  overlay.style.left = ta.offsetLeft + "px";
  overlay.style.width = ta.offsetWidth + "px";
  overlay.style.height = ta.offsetHeight + "px";

  const pts = new Set([0, text.length]);
  for (const r of runs) { pts.add(r[0]); pts.add(r[1]); }
  const caretsAt = new Map();
  const sels = [];
  for (const c of cursors) {
    const h = Math.min(c.head, text.length);
    pts.add(h);
    if (!caretsAt.has(h)) caretsAt.set(h, []);
    caretsAt.get(h).push(c);
    if (c.anchor !== c.head) {
      const s = Math.min(c.anchor, c.head), e = Math.min(Math.max(c.anchor, c.head), text.length);
      sels.push([s, e, c.color]); pts.add(s); pts.add(e);
    }
  }
  const sorted = [...pts].filter((p) => p >= 0 && p <= text.length).sort((a, b) => a - b);
  let html = "", ri = 0;
  for (let k = 0; k < sorted.length; k++) {
    const p = sorted[k];
    for (const c of caretsAt.get(p) || []) {
      html += `<span class="rc" style="--c:${esc(c.color)}"><span class="rc-flag">${esc(c.name)}</span></span>`;
    }
    if (k === sorted.length - 1) break;
    const q = sorted[k + 1];
    const seg = text.slice(p, q);
    while (ri < runs.length && runs[ri][1] <= p) ri++;
    const run = ri < runs.length && runs[ri][0] <= p ? runs[ri] : null;
    const sel = sels.find((x) => x[0] <= p && q <= x[1]);
    let attrs = "";
    const styles = [];
    const cls = [];
    if (run && run[2] && (!focusAuthor || focusAuthor === run[2])) {
      const pr = personOf(run[2]);
      cls.push("au");
      styles.push(`--c:${pr.color}`);
      attrs += ` data-a="${esc(run[2])}" data-t="${run[3]}"`;
    }
    if (sel) { cls.push("sel"); styles.push(`--s:${sel[2]}`); }
    html += cls.length ? `<span class="${cls.join(" ")}" style="${styles.join(";")}"${attrs}>${esc(seg)}</span>` : esc(seg);
  }
  overlay.innerHTML = html + "\u200b";
}

function renderAuthorsBar(runs) {
  const bar = $("#authorsBar");
  if (!runs) { if (!bar.hidden) { bar.hidden = true; bar.innerHTML = ""; } return; }
  const totals = new Map();
  let all = 0;
  for (const [s, e, a] of runs) {
    const n = S.ytext.toString().slice(s, e).replace(/\s/g, "").length;
    totals.set(a, (totals.get(a) || 0) + n);
    all += n;
  }
  const list = [...totals.entries()].filter(([, n]) => n > 0).sort((x, y) => y[1] - x[1]);
  const sig = JSON.stringify([list, focusAuthor, peopleVersion]);
  if (bar.dataset.sig === sig && !bar.hidden) return;
  bar.dataset.sig = sig;
  bar.hidden = false;
  const pct = (n) => (all ? Math.max(1, Math.round((n / all) * 100)) : 0);
  bar.innerHTML = `<span class="ab-title">${svg("highlight")}Qui a écrit quoi</span>
    ${list.map(([a, n]) => {
      const pr = personOf(a);
      return `<button class="chip${focusAuthor === a ? " on" : ""}${focusAuthor && focusAuthor !== a ? " dim" : ""}${pr.unknown ? " unknown" : ""}" data-k="${esc(a)}" title="${pr.unknown ? "Texte antérieur au suivi des auteurs" : "Cliquer pour n'afficher que ses passages"}">
        <i style="background:${pr.color}"></i>${pr.ai ? svg("bot") : ""}${esc(pr.name)}${pr.me ? " (toi)" : ""}<span class="pc">${pct(n)} %</span></button>`;
    }).join("") || '<span class="muted-sm">Document vide</span>'}
    <span class="spacer"></span>
    <button class="icon-btn sm" data-act="close" title="Masquer les auteurs">${svg("x")}</button>`;
  for (const b of $$(".chip", bar)) {
    b.onclick = () => { focusAuthor = focusAuthor === b.dataset.k ? null : b.dataset.k; renderOverlay(); };
  }
  $('[data-act="close"]', bar).onclick = () => toggleAuthors(false);
}

function toggleAuthors(on = !showAuthors) {
  showAuthors = on;
  focusAuthor = null;
  localStorage.setItem("ed-authors", on ? "1" : "0");
  const b = $("#btnAuthors");
  b.classList.toggle("on", on);
  b.setAttribute("aria-pressed", String(on));
  if (on && currentView() === "preview") setView("edit");
  hideTip();
  renderOverlay();
  if (S && S.loaded) autosize();
}

/* ---- Info-bulle au survol d'un passage ---- */
const tip = $("#authTip");
let tipRaf = 0;
function hideTip() { tip.hidden = true; }
$("#paneEditor").addEventListener("mousemove", (e) => {
  if (!showAuthors) return;
  cancelAnimationFrame(tipRaf);
  const { clientX: x, clientY: y } = e;
  tipRaf = requestAnimationFrame(() => {
    overlay.style.pointerEvents = "auto"; ta.style.pointerEvents = "none";
    const el = document.elementFromPoint(x, y);
    overlay.style.pointerEvents = ""; ta.style.pointerEvents = "";
    const span = el && el.closest ? el.closest("#overlay .au") : null;
    if (!span) return hideTip();
    const pr = personOf(span.dataset.a);
    const when = whenText(Number(span.dataset.t));
    tip.innerHTML = `${personAvatar(pr)}<div><div class="t">${esc(pr.name)}${pr.me ? " (toi)" : ""}</div>${when ? `<div class="s">${pr.ai ? "via le dépôt · " : ""}${esc(when)}</div>` : ""}</div>`;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = Math.min(x + 14, innerWidth - r.width - 8) + "px";
    tip.style.top = (y + 18 + r.height > innerHeight ? y - r.height - 10 : y + 18) + "px";
  });
});
$("#paneEditor").addEventListener("mouseleave", hideTip);
$("#paneEditor").addEventListener("scroll", hideTip, { passive: true });

/* ---- Mon curseur, visible des autres ---- */
let curT = null;
function publishCursor() {
  clearTimeout(curT);
  curT = setTimeout(() => {
    if (!S || !S.loaded || S.offline || !S.provider || ta.value !== S.ytext.toString()) return;
    const rel = (i) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(S.ytext, i));
    S.provider.awareness.setLocalStateField("cursor", { anchor: rel(ta.selectionStart), head: rel(ta.selectionEnd) });
  }, 60);
}
document.addEventListener("selectionchange", () => { if (document.activeElement === ta) publishCursor(); });

/* ---- Historique des modifications ---- */
function cleanTitle(t) {
  const m = String(t || "").match(/^Easydoc\s*:\s*(création|import|suppression|conversion)?/i);
  if (!m) return t || "(sans titre)";
  const k = (m[1] || "").toLowerCase();
  return k === "création" ? "Création du document" : k === "import" ? "Import du fichier" : k === "suppression" ? "Suppression"
    : k === "conversion" ? "Version modifiable créée" : "Modifications enregistrées";
}
function patchHTML(patch) {
  const rows = [];
  for (const line of String(patch).split("\n")) {
    if (line.startsWith("\\")) continue;
    const c = line[0];
    const cls = line.startsWith("@@") ? "hunk" : c === "+" ? "add" : c === "-" ? "del" : "ctx";
    const body = line.startsWith("@@") ? "⋯" : line.slice(1);
    rows.push(`<div class="dl ${cls}"><span class="dm">${cls === "add" ? "+" : cls === "del" ? "−" : ""}</span><span class="dt">${esc(body) || " "}</span></div>`);
  }
  return rows.join("");
}

async function openHistory() {
  const p = currentPath();
  if (!p) return;
  openModal({
    title: "Historique",
    subtitle: `<strong>${esc(fileName(p))}</strong> · chaque enregistrement, avec son auteur (y compris Claude et les autres outils qui écrivent dans le dépôt)`,
    wide: true,
    body: '<div class="hist" id="hist"><div class="loadingview">Chargement…</div></div>',
    foot: `${S && S.loaded && !S.offline ? `<button class="btn left" data-act="authors">${svg("highlight")}Voir qui a écrit quoi dans le texte</button>` : ""}<button class="btn" data-act="close">Fermer</button>`,
    async onMount(card) {
      $('[data-act="close"]', card).onclick = closeModal;
      const ab = $('[data-act="authors"]', card);
      if (ab) ab.onclick = () => { closeModal(); toggleAuthors(true); };
      const box = $("#hist", card);
      let d;
      try { d = await api("GET", "/api/history?path=" + encodeURIComponent(p)); }
      catch (e) { box.innerHTML = `<div class="msg err">${esc(e.message)}</div>`; return; }
      if (!d.commits.length) { box.innerHTML = '<div class="arows-empty">Pas encore d\'enregistrement pour ce fichier.</div>'; return; }
      box.innerHTML = d.commits.map((c) => {
        const pr = personOf(c.key);
        const date = new Date(c.date);
        const stats = c.additions != null ? `<span class="hstat"><b class="add">+${c.additions}</b> <b class="del">−${c.deletions}</b></span>` : "";
        return `<div class="hitem" data-sha="${esc(c.sha)}">
          <button class="hrow">${personAvatar(pr)}
            <span class="hmeta"><span class="t">${esc(c.name || pr.name)}${pr.ai ? ' <span class="tag tag-ai">IA</span>' : ""}</span>
              <span class="s">${esc(cleanTitle(c.title))}</span></span>
            ${stats}<span class="hdate" title="${esc(date.toLocaleString("fr-FR"))}">${esc(whenText(Math.floor(date.getTime() / 60000)))}</span>
            <span class="chev">${svg("chevron")}</span></button>
          <div class="hdiff" hidden></div></div>`;
      }).join("");
      for (const item of $$(".hitem", box)) {
        $(".hrow", item).onclick = async () => {
          const diff = $(".hdiff", item);
          const open = item.classList.toggle("open");
          diff.hidden = !open;
          if (!open || diff.dataset.loaded) return;
          diff.innerHTML = '<div class="loadingview">Chargement…</div>';
          try {
            const r = await api("GET", `/api/history/diff?path=${encodeURIComponent(p)}&sha=${encodeURIComponent(item.dataset.sha)}`);
            diff.dataset.loaded = "1";
            diff.innerHTML = r.patch ? patchHTML(r.patch) : `<div class="muted-sm" style="padding:10px 12px">${r.binary ? "Fichier binaire : pas de détail ligne par ligne." : "Aucune modification de contenu dans cette version."}</div>`;
          } catch (e) { diff.innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
        };
      }
    },
  });
}

/* ============================================================================================
 * Aperçu Markdown
 * ========================================================================================== */
let previewT = null;
function schedulePreview() { clearTimeout(previewT); previewT = setTimeout(renderPreview, 150); }
function renderPreview() {
  if (!S || S.kind !== "markdown" || currentView() === "edit") return;
  const el = $("#preview");
  el.innerHTML = DOMPurify.sanitize(marked.parse(ta.value || ""));
  for (const a of $$("a[href]", el)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(a.getAttribute("href"))) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
  }
  // images du dépôt (chemins relatifs) servies par Easydoc
  for (const img of $$("img[src]", el)) {
    const target = resolveRel(img.getAttribute("src"), S.path);
    if (target) img.src = rawUrl(target);
  }
}
$("#preview").addEventListener("click", (e) => {
  const a = e.target.closest("a[href]");
  if (!a || !S) return;
  const target = resolveRel(a.getAttribute("href"), S.path);
  if (target && files.includes(target)) { e.preventDefault(); openFile(target); }
});

function setView(v) {
  area.dataset.view = v;
  localStorage.setItem("ed-view", v);
  for (const b of $$("#viewSwitch button")) b.classList.toggle("on", b.dataset.view === v);
  renderPreview();
  if (S && S.loaded) autosize();
  renderOverlay();
}
for (const b of $$("#viewSwitch button")) b.onclick = () => setView(b.dataset.view);

/* ============================================================================================
 * Statut, présence, boutons
 * ========================================================================================== */
function renderStatus() {
  const el = $("#status");
  let text = "", tone = "", title = "";
  if (F) {
    text = `${KIND_LABEL[F.kind]}${F.size != null ? " · " + fmtSize(F.size) : ""}${canWrite(F.path) ? "" : " · lecture seule"}`;
    const line = $("#fileMetaLine");
    if (line) line.textContent = text;
  } else if (S) {
    const err = S.meta.get("saveError");
    if (!S.loaded) { text = "Chargement…"; tone = "busy"; }
    else if (S.offline) { text = S.dirty ? "Hors ligne · enregistrement…" : "Hors ligne · enregistré"; tone = "busy"; }
    else if (S.reconnecting || !S.connected) { text = "Reconnexion…"; tone = "busy"; }
    else if (ta.readOnly) { text = "Lecture seule"; title = "Tu peux lire ce document mais pas le modifier."; }
    else if (err) { text = "Échec de l'enregistrement"; tone = "err"; title = err; }
    else if (S.saving || S.dirty) { text = "Modifications en cours…"; tone = "busy"; }
    else { text = "Enregistré · " + relTime(S.savedSeen || Date.now()); tone = "ok"; }
  }
  el.textContent = text;
  el.dataset.tone = tone;
  el.title = title;
}
setInterval(renderStatus, 10000);

function renderPresence() {
  const box = $("#presence");
  const p = currentPath();
  if (!p) { box.innerHTML = ""; return; }
  const list = othersByPath().get(hashPath(p)) || [];
  const shown = list.slice(0, 4).map((u) => avatarHTML(u, `title="${esc(u.name)}${u.line && S ? ` — ligne ${esc(u.line)}` : ""}"`)).join("");
  const more = list.length > 4 ? `<span class="avatar more" title="${list.length - 4} autres">+${list.length - 4}</span>` : "";
  box.innerHTML = shown + more;
}

function updateButtons() {
  const p = currentPath();
  const writable = !!p && canWrite(p);
  $("#btnSave").disabled = !(S && S.loaded) || !writable;
  $("#btnSave").style.display = F || (S && !writable) ? "none" : "";
  $("#btnDelete").disabled = !writable;
  $("#btnDelete").style.display = p && !writable ? "none" : "";
  $("#btnAccess").hidden = !(isAdmin() && p);
  $("#btnAuthors").hidden = !(S && S.loaded && !S.offline);
  $("#btnHistory").hidden = !p;
  $("#viewSwitch").style.visibility = S && S.kind === "markdown" ? "visible" : "hidden";
}

/* ============================================================================================
 * Actions
 * ========================================================================================== */
function newDocument() {
  const folder = currentFolder();
  openModal({
    title: "Nouveau document",
    subtitle: "Utilise « / » pour ranger dans un dossier. L'extension .md est ajoutée automatiquement (ou termine par .txt pour un texte brut).",
    body: `<div class="field"><label for="fPath">Nom</label><input class="input" id="fPath" placeholder="notes/compte-rendu" value="${esc(folder ? folder + "/" : "")}" /></div><div class="msg"></div>`,
    foot: '<button class="btn" data-act="cancel">Annuler</button><button class="btn btn-primary" data-act="ok">Créer</button>',
    onMount(card) {
      const input = $("#fPath", card);
      input.setSelectionRange(input.value.length, input.value.length);
      const go = async () => {
        const v = input.value.trim().replace(/^\/+|\/+$/g, "");
        if (!v) return input.focus();
        $('[data-act="ok"]', card).disabled = true;
        try {
          const d = await api("POST", "/api/create", { path: v });
          closeModal();
          await refreshTree();
          openFile(d.path);
        } catch (e) { setMsg(card, e.message, "err"); $('[data-act="ok"]', card).disabled = false; }
      };
      $('[data-act="ok"]', card).onclick = go;
      $('[data-act="cancel"]', card).onclick = closeModal;
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    },
  });
}

function deleteDocument() {
  const p = currentPath();
  if (!p) return;
  openModal({
    title: isEditable(p) ? "Supprimer ce document ?" : "Supprimer ce fichier ?",
    subtitle: `« ${esc(p)} » sera supprimé du dépôt (un commit de suppression est créé ; il reste récupérable dans l'historique git).`,
    foot: '<button class="btn" data-act="cancel">Annuler</button><button class="btn btn-danger" data-act="ok">Supprimer</button>',
    onMount(card) {
      $('[data-act="cancel"]', card).onclick = closeModal;
      $('[data-act="ok"]', card).onclick = async () => {
        $('[data-act="ok"]', card).disabled = true;
        try {
          await api("DELETE", "/api/file?path=" + encodeURIComponent(p));
          closeModal();
          showEmpty();
          await refreshTree();
          toast("Supprimé.");
        } catch (e) { closeModal(); toast("Suppression impossible : " + e.message, { error: true }); }
      };
    },
  });
}

async function syncNow() {
  const b = $("#btnSync");
  b.disabled = true;
  try {
    const d = await api("POST", "/api/sync");
    await refreshTree();
    toast(d.changed ? `${d.changed} document(s) mis à jour depuis le dépôt.` : "Tout est à jour.");
  } catch (e) { toast("Synchronisation impossible : " + e.message, { error: true }); }
  finally { b.disabled = false; }
}

async function loadConfig() {
  try { config = await api("GET", "/api/config"); } catch (_e) { config = {}; }
  $("#workspaceLabel").textContent = config.mode === "github" ? `${config.repo}${config.branch && config.branch !== "main" ? ` (${config.branch})` : ""}` : "Dépôt local";
}

function confirmDisconnect(s) {
  openModal({
    title: "Déconnecter ce dépôt ?",
    subtitle: `Easydoc oublie <strong>${esc(s.repo)}</strong> : le jeton d'accès est effacé de ce serveur et les fichiers ne sont plus lus ni enregistrés sur GitHub.`,
    body: `<div class="note">Le dépôt sur GitHub n'est ni modifié ni supprimé : tout ce qui y a été enregistré reste disponible.
      Easydoc revient aux fichiers stockés sur ce serveur ; tu pourras connecter un autre dépôt quand tu veux.</div><div class="msg"></div>`,
    foot: '<button class="btn" data-act="cancel">Annuler</button><button class="btn btn-danger" data-act="ok">Déconnecter</button>',
    onMount(c) {
      $('[data-act="cancel"]', c).onclick = () => openAdmin("repo");
      $('[data-act="ok"]', c).onclick = async () => {
        $$(".m-foot button", c).forEach((b) => { b.disabled = true; });
        try {
          await api("POST", "/api/settings", { mode: "local" });
          setMsg(c, "Dépôt déconnecté. Rechargement…", "ok");
          setTimeout(() => location.reload(), 700);
        } catch (e) { setMsg(c, e.message, "err"); $$(".m-foot button", c).forEach((b) => { b.disabled = false; }); }
      };
    },
  });
}

/* ============================================================================================
 * Administration : utilisateurs, droits d'accès, dépôt
 * ========================================================================================== */
const LEVEL_LBL = { none: "Masqué", read: "Lecture seule", write: "Lecture et modification" };
const ROLE_LBL = { admin: "Administrateur", member: "Membre" };

async function loadRules() {
  try { adminRules = (await api("GET", "/api/admin/access")).rules || {}; } catch (_e) { adminRules = {}; }
  renderTree();
}

function genPassword() {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

function openAdmin(tab = "users", opts = {}) {
  const tabs = [["users", "Utilisateurs", "users"], ["access", "Droits d'accès", "lock"], ["repo", "Dépôt", "branch"], ["internet", "Accès Internet", "globe"], ["update", "Mise à jour", "download"]];
  openModal({
    title: "Administration",
    wide: true,
    body: `<div class="tabs" role="tablist">${tabs.map(([k, l, i]) => `<button data-tab="${k}" role="tab">${svg(i)}${l}</button>`).join("")}</div>
      <div class="tab-body" id="tabBody"></div>`,
    onMount(card) {
      const show = (k, o = {}) => {
        for (const b of $$(".tabs button", card)) b.classList.toggle("on", b.dataset.tab === k);
        const box = $("#tabBody", card);
        box.dataset.tab = k;
        box.innerHTML = '<div class="loadingview">Chargement…</div>';
        const render = { users: renderUsersTab, access: renderAccessTab, repo: renderRepoTab, internet: renderInternetTab, update: renderUpdateTab }[k];
        render(box, o).catch((e) => { box.innerHTML = `<div class="msg err">${esc(e.message)}</div>`; });
      };
      for (const b of $$(".tabs button", card)) b.onclick = () => show(b.dataset.tab);
      const ub = $('.tabs [data-tab="update"]', card);
      if (ub && updateInfo && updateInfo.check && updateInfo.check.available) ub.classList.add("has-badge");
      show(tab, opts);
    },
  });
}

/* ---- Utilisateurs ---- */
async function renderUsersTab(box, opts = {}) {
  const d = await api("GET", "/api/admin/users");
  box.innerHTML = `<div class="row-between"><p class="muted-sm">${d.users.length} compte${d.users.length > 1 ? "s" : ""} · les administrateurs ont accès à tout, les membres selon les droits d'accès.</p>
      <button class="btn btn-primary" data-act="new">${svg("plus")}Nouvel utilisateur</button></div>
    <div class="msg"></div>
    <div class="ulist">${d.users.map((u) => `<div class="urow${u.disabled ? " off" : ""}" data-id="${esc(u.id)}">
        ${avatarHTML({ name: u.displayName, color: colorFor(u.username) })}
        <div class="umeta"><div class="t">${esc(u.displayName)}${u.id === me.id ? ' <span class="tag">toi</span>' : ""}${u.disabled ? ' <span class="tag tag-off">désactivé</span>' : ""}</div>
          <div class="s">${esc(u.username)} · ${ROLE_LBL[u.role]}${u.groups.length ? " · " + u.groups.map(esc).join(", ") : ""}</div></div>
        <button class="btn" data-act="edit">Modifier</button>
      </div>`).join("")}</div>`;
  if (opts.notice) setMsg(box, opts.notice, "ok");
  $('[data-act="new"]', box).onclick = () => userForm(box, null, d.groups);
  for (const row of $$(".urow", box)) {
    $('[data-act="edit"]', row).onclick = () => userForm(box, d.users.find((u) => u.id === row.dataset.id), d.groups);
  }
}

function userForm(box, u, groups) {
  const isNew = !u, self = !!u && u.id === me.id;
  box.innerHTML = `<div class="section-t">${isNew ? "Nouvel utilisateur" : `Modifier le compte de ${esc(u.displayName)}`}</div>
    <div class="grid2">
      <div class="field"><label for="uLogin">Identifiant</label>
        <input class="input" id="uLogin" ${isNew ? "" : "disabled"} value="${esc(u ? u.username : "")}" placeholder="ex. alex" autocapitalize="none" spellcheck="false" autocomplete="off" />
        <span class="hint">${isNew ? "Sert à se connecter : minuscules, chiffres, point ou tiret." : "Ne peut pas être modifié."}</span></div>
      <div class="field"><label for="uName">Nom affiché</label>
        <input class="input" id="uName" maxlength="40" value="${esc(u ? u.displayName : "")}" placeholder="ex. Alex Durand" /></div>
      <div class="field"><label for="uRole">Rôle</label>
        <select class="input" id="uRole" ${self ? "disabled" : ""}><option value="member">Membre</option><option value="admin">Administrateur (accès à tout)</option></select></div>
      <div class="field"><label for="uGroups">Groupes</label>
        <input class="input" id="uGroups" list="groupList" value="${esc(u ? u.groups.join(", ") : "")}" placeholder="ex. graphisme, direction" autocomplete="off" />
        <datalist id="groupList">${groups.map((g) => `<option value="${esc(g)}"></option>`).join("")}</datalist>
        <span class="hint">Séparés par des virgules. Pour donner des droits à plusieurs personnes d'un coup.</span></div>
    </div>
    <div class="field"><label for="uPass">${isNew ? "Mot de passe" : "Nouveau mot de passe"}</label>
      <div class="inline"><input class="input" id="uPass" type="text" autocomplete="off" spellcheck="false" placeholder="${isNew ? "8 caractères minimum" : "Laisser vide pour ne pas le changer"}" />
        <button class="btn" data-act="gen">Générer</button></div>
      <span class="hint">${isNew ? "Communique-le à la personne : elle pourra le changer depuis « Mon compte »." : "Ses sessions ouvertes seront fermées."}</span></div>
    ${isNew || self ? "" : `<label class="check"><input type="checkbox" id="uOff" ${u.disabled ? "checked" : ""} /> Compte désactivé (connexion impossible, accès coupé immédiatement)</label>`}
    <div class="msg"></div>
    <div class="row-end">
      ${isNew || self ? "" : `<button class="btn btn-danger-soft left" data-act="del">${svg("trash")}Supprimer le compte</button>`}
      <button class="btn" data-act="back">Retour</button>
      <button class="btn btn-primary" data-act="save">${isNew ? "Créer le compte" : "Enregistrer"}</button>
    </div>`;
  $("#uRole", box).value = u ? u.role : "member";
  (isNew ? $("#uLogin", box) : $("#uName", box)).focus();
  const busy = (on) => $$(".row-end button", box).forEach((b) => { b.disabled = on; });
  $('[data-act="gen"]', box).onclick = () => { $("#uPass", box).value = genPassword(); };
  $('[data-act="back"]', box).onclick = () => renderUsersTab(box);
  $('[data-act="save"]', box).onclick = async () => {
    const body = { displayName: $("#uName", box).value, role: $("#uRole", box).value, groups: $("#uGroups", box).value };
    const pw = $("#uPass", box).value;
    busy(true);
    try {
      if (isNew) {
        const username = $("#uLogin", box).value.trim().toLowerCase();
        const d = await api("POST", "/api/admin/users", { ...body, username, password: pw });
        await renderUsersTab(box, { notice: `Compte créé pour ${d.user.displayName}. Identifiant : ${d.user.username} · mot de passe : ${pw}` });
      } else {
        if (pw) body.password = pw;
        if ($("#uOff", box)) body.disabled = $("#uOff", box).checked;
        const d = await api("PATCH", `/api/admin/users/${encodeURIComponent(u.id)}`, body);
        if (self) setMe(d.user);
        await renderUsersTab(box, { notice: pw ? `Compte mis à jour. Nouveau mot de passe : ${pw}` : "Compte mis à jour." });
      }
    } catch (e) { setMsg(box, e.message, "err"); busy(false); }
  };
  const del = $('[data-act="del"]', box);
  if (del) {
    del.onclick = async () => {
      if (!del.dataset.confirm) {
        del.dataset.confirm = "1";
        del.innerHTML = `${svg("trash")}Confirmer la suppression`;
        setMsg(box, `Le compte de ${u.displayName} sera supprimé définitivement (ses enregistrements restent dans l'historique). Clique de nouveau pour confirmer.`, "err");
        return;
      }
      busy(true);
      try {
        await api("DELETE", `/api/admin/users/${encodeURIComponent(u.id)}`);
        await renderUsersTab(box, { notice: `Compte de ${u.displayName} supprimé.` });
      } catch (e) { setMsg(box, e.message, "err"); busy(false); }
    };
  }
}

/* ---- Droits d'accès ---- */
function allFolders() {
  const set = new Set();
  for (const p of files) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join("/"));
  }
  return [...set].sort((a, b) => a.localeCompare(b, "fr", { sensitivity: "base" }));
}

async function renderAccessTab(box, opts = {}) {
  const d = await api("GET", "/api/admin/access");
  adminRules = d.rules || {};
  renderTree();
  const target = opts.path != null ? opts.path : box.dataset.path || "";
  box.dataset.path = target;
  const rule = adminRules[target];
  const mark = (v) => (adminRules[v] ? "● " : "");
  const opt = (v, label) => `<option value="${esc(v)}"${v === target ? " selected" : ""}>${mark(v)}${esc(label)}</option>`;
  const folders = allFolders();
  const known = [["*", "Tout le monde"],
    ...d.groups.map((g) => [`group:${g}`, `Groupe « ${g} »`]),
    ...d.users.filter((u) => u.role !== "admin").map((u) => [`user:${u.username}`, `${u.displayName} (${u.username})`])];
  const whoOptions = (who) => {
    const list = known.some(([v]) => v === who) ? known : [[who, who.replace(/^(user|group):/, "")], ...known];
    return list.map(([v, l]) => `<option value="${esc(v)}"${v === who ? " selected" : ""}>${esc(l)}</option>`).join("");
  };
  const rowHTML = (who, lvl) => `<div class="arow">
      <select class="input a-who" aria-label="Qui">${whoOptions(who)}</select>
      <select class="input a-lvl" aria-label="Accès">${Object.entries(LEVEL_LBL).map(([v, l]) => `<option value="${v}"${v === lvl ? " selected" : ""}>${l}</option>`).join("")}</select>
      <button class="icon-btn" data-act="rm" title="Retirer cette ligne">${svg("x")}</button></div>`;
  const emptyText = target === ""
    ? "Aucune règle générale : tous les membres peuvent lire et modifier tout ce qui n'a pas de règle particulière."
    : "Aucune règle ici : les droits du dossier parent (ou de « Tout le dépôt ») s'appliquent.";
  const kindLbl = target === "" ? "l'ensemble du dépôt" : folders.includes(target) ? `le dossier « ${target} » et tout son contenu` : `le fichier « ${target} »`;

  box.innerHTML = `
    <div class="field"><label for="aPath">Dossier ou fichier</label>
      <select class="input" id="aPath">${opt("", "Tout le dépôt (règle générale)")}
        ${folders.length ? `<optgroup label="Dossiers">${folders.map((f) => opt(f, f + "/")).join("")}</optgroup>` : ""}
        <optgroup label="Fichiers">${files.map((f) => opt(f, f)).join("")}</optgroup></select>
      <span class="hint">● = règle déjà définie. Cette règle s'applique à ${esc(kindLbl)}.</span></div>
    <div class="arows" id="aRows">${rule ? Object.entries(rule).map(([w, l]) => rowHTML(w, l)).join("") : `<div class="arows-empty">${emptyText}</div>`}</div>
    <button class="btn btn-ghost btn-add" data-act="add">${svg("plus")}Ajouter une ligne</button>
    <div class="note">La règle la plus précise s'applique : celle du fichier, sinon celle de son dossier, puis des dossiers parents, puis « Tout le dépôt ».
      Dans une règle, une ligne pour une personne passe avant ses groupes, qui passent avant « Tout le monde ». Les administrateurs ont toujours accès à tout.</div>
    <div class="msg"></div>
    <div class="row-end">
      ${rule ? `<button class="btn left" data-act="clear">${target === "" ? "Revenir au réglage par défaut" : "Retirer cette règle"}</button>` : ""}
      <button class="btn btn-primary" data-act="save">Enregistrer</button></div>
    <div class="section-t">Résultat pour chaque compte</div>
    <div class="eff" id="aEff"><div class="erow muted-sm">Calcul…</div></div>`;

  const rows = $("#aRows", box);
  $("#aPath", box).onchange = (e) => renderAccessTab(box, { path: e.target.value });
  $('[data-act="add"]', box).onclick = () => {
    const empty = $(".arows-empty", rows);
    if (empty) empty.remove();
    const used = new Set($$(".a-who", rows).map((x) => x.value));
    const next = known.find(([v]) => !used.has(v));
    rows.insertAdjacentHTML("beforeend", rowHTML(next ? next[0] : "*", "read"));
  };
  rows.addEventListener("click", (e) => {
    const rm = e.target.closest('[data-act="rm"]');
    if (!rm) return;
    rm.closest(".arow").remove();
    if (!$(".arow", rows)) rows.innerHTML = `<div class="arows-empty">${emptyText}</div>`;
  });
  const busy = (on) => $$(".row-end button", box).forEach((b) => { b.disabled = on; });
  const save = async (entries) => {
    busy(true);
    try {
      const r = await api("PUT", "/api/admin/access", { path: target, entries });
      await renderAccessTab(box, { path: target });
      setMsg(box, Object.keys(entries).length ? "Droits enregistrés et appliqués immédiatement." : "Règle retirée.", "ok");
      renderEffective(r.users);
    } catch (e) { setMsg(box, e.message, "err"); busy(false); }
  };
  $('[data-act="save"]', box).onclick = () => {
    const entries = {};
    for (const row of $$(".arow", rows)) {
      const who = $(".a-who", row).value;
      if (entries[who]) {
        const label = $(".a-who", row).selectedOptions[0].textContent;
        return setMsg(box, `« ${label} » apparaît deux fois : garde une seule ligne.`, "err");
      }
      entries[who] = $(".a-lvl", row).value;
    }
    save(entries);
  };
  const clear = $('[data-act="clear"]', box);
  if (clear) clear.onclick = () => save({});

  function renderEffective(list) {
    $("#aEff", box).innerHTML = list.map((u) => `<div class="erow">${avatarHTML({ name: u.displayName, color: colorFor(u.username) })}
        <span class="n">${esc(u.displayName)} <span class="muted-sm">${esc(u.username)}${u.role === "admin" ? " · administrateur" : ""}${u.disabled ? " · désactivé" : ""}</span></span>
        <span class="lvl lvl-${u.level}">${LEVEL_LBL[u.level]}</span></div>`).join("");
  }
  api("GET", `/api/admin/access/effective?path=${encodeURIComponent(target)}`).then((r) => renderEffective(r.users)).catch(() => {});
}

/* ---- Accès Internet : tunnel Cloudflare ---- */
const TUNNEL_STATUS = {
  off: ["Désactivé", "off"], installing: ["Installation de cloudflared…", "busy"], starting: ["Connexion à Cloudflare…", "busy"],
  connected: ["Connecté", "ok"], error: ["Problème", "err"],
};
function tabAlive(box, tab) { return box.isConnected && box.dataset.tab === tab; }

async function renderInternetTab(box) {
  const d = await api("GET", "/api/admin/tunnel");
  const t = d.tunnel;
  const [label, tone] = TUNNEL_STATUS[t.status] || [t.status, ""];
  const links = t.hostnames.map((h) => `<a href="https://${esc(h)}" target="_blank" rel="noopener">https://${esc(h)}</a>`).join(" · ");
  const keep = { token: ($("#tToken", box) || {}).value || "", logsOpen: !!($("details.tlogs", box) || {}).open };
  box.innerHTML = `
    <div class="card tcard">
      <span class="tdot t-${tone}"></span>
      <div style="flex:1;min-width:0">
        <div class="t">${esc(label)}${t.status === "connected" ? ` · ${t.connections} connexion${t.connections > 1 ? "s" : ""} à Cloudflare` : ""}</div>
        <div class="s">${t.status === "connected" && links ? `Easydoc est accessible sur ${links}`
          : t.status === "connected" ? "Ajoute un nom public au tunnel dans Cloudflare pour obtenir l'adresse."
          : t.hasToken ? `Tunnel ${esc(t.tunnelId.slice(0, 8))}…${t.enabled ? "" : " (arrêté)"}` : "Aucun tunnel configuré : Easydoc n'est accessible que sur ton réseau."}</div>
      </div>
      ${t.enabled ? '<button class="btn" data-act="stop">Arrêter</button>' : t.hasToken ? '<button class="btn btn-primary" data-act="start">Démarrer</button>' : ""}
    </div>
    ${t.lastError && t.status !== "connected" ? `<div class="msg err">${esc(t.lastError)}</div>` : ""}
    ${t.wrongService ? `<div class="msg err">Dans Cloudflare, le nom public pointe vers <code>${esc(t.services.join(", "))}</code> : indique plutôt <code>${esc(t.expectedService)}</code>.</div>` : ""}
    <div class="field"><label for="tToken">${t.hasToken ? "Remplacer le jeton du tunnel" : "Jeton du tunnel Cloudflare"}</label>
      <input class="input" id="tToken" type="password" autocomplete="off" spellcheck="false" placeholder="${t.hasToken ? "Laisser vide pour garder le jeton actuel" : "eyJ… (ou colle la commande « cloudflared … » entière)"}" />
      <span class="hint">Le jeton reste sur ce serveur : il n'est jamais réaffiché ni envoyé aux navigateurs.</span></div>
    <details class="help">
      <summary>Comment obtenir le jeton ?</summary>
      <ol>
        <li>Sur <a href="https://one.dash.cloudflare.com/" target="_blank" rel="noopener">one.dash.cloudflare.com</a> : <strong>Networks → Tunnels → Create a tunnel</strong>, type <strong>Cloudflared</strong>, donne-lui un nom (ex. « easydoc »).</li>
        <li>À l'étape d'installation, copie la commande affichée (elle contient le jeton <code>eyJ…</code>) et colle-la ci-dessus : inutile d'installer quoi que ce soit, Easydoc s'en charge.</li>
        <li>Onglet <strong>Public Hostname</strong> : choisis ton nom de domaine (ex. <code>docs.mondomaine.fr</code>), type <strong>HTTP</strong>, URL <code>${esc(t.expectedService.replace("http://", ""))}</code>.</li>
        <li>Enregistre : l'adresse s'affiche ici en quelques secondes, en HTTPS.</li>
      </ol>
      <p class="muted-sm">Conseils : n'ouvre l'accès Internet qu'après avoir créé tous les comptes, avec des mots de passe solides. Tu peux ajouter une protection Cloudflare Access (code par e-mail) devant Easydoc.</p>
    </details>
    <div class="msg"></div>
    <div class="row-end">
      ${t.hasToken ? `<button class="btn btn-danger-soft left" data-act="forget">${svg("trash")}Effacer le jeton</button>` : ""}
      <button class="btn btn-primary" data-act="save">${t.hasToken ? "Enregistrer et redémarrer" : "Activer le tunnel"}</button>
    </div>
    ${t.logs.length ? `<details class="tlogs"${keep.logsOpen ? " open" : ""}><summary>Journal de cloudflared${t.version ? ` (version ${esc(t.version)})` : ""}</summary><pre>${esc(t.logs.join("\n"))}</pre></details>` : ""}`;
  $("#tToken", box).value = keep.token;
  const busy = (on) => $$(".row-end button, .tcard button", box).forEach((b) => { b.disabled = on; });
  const send = async (method, body, okMsg) => {
    busy(true);
    try {
      await api(method, "/api/admin/tunnel", body);
      $("#tToken", box).value = "";
      await renderInternetTab(box);
      if (okMsg) setMsg(box, okMsg, "ok");
    } catch (e) { setMsg(box, e.message, "err"); busy(false); }
  };
  $('[data-act="save"]', box).onclick = () => {
    const token = $("#tToken", box).value.trim();
    if (!token && !t.hasToken) { setMsg(box, "Colle d'abord le jeton du tunnel.", "err"); $("#tToken", box).focus(); return; }
    send("POST", { token: token || undefined, enabled: true }, "Tunnel démarré : la connexion à Cloudflare prend quelques secondes.");
  };
  const on = (act, fn) => { const b = $(`[data-act="${act}"]`, box); if (b) b.onclick = fn; };
  on("start", () => send("POST", { enabled: true }));
  on("stop", () => send("POST", { enabled: false }, "Tunnel arrêté : Easydoc n'est plus accessible depuis Internet."));
  on("forget", () => send("DELETE", null, "Jeton effacé."));
  // actualisation tant que l'onglet est affiché (sauf pendant une saisie ou une action)
  clearTimeout(box._tunnelTimer);
  const tick = () => {
    if (!tabAlive(box, "internet")) return;
    const inp = $("#tToken", box);
    if ((inp && (inp.value || document.activeElement === inp)) || $(".row-end button:disabled", box)) { box._tunnelTimer = setTimeout(tick, 2000); return; }
    renderInternetTab(box).catch(() => {});
  };
  box._tunnelTimer = setTimeout(tick, t.status === "connected" || t.status === "off" ? 5000 : 1500);
}

/* ---- Mise à jour d'Easydoc ---- */
let updateInfo = null;
async function checkUpdateBadge() {
  if (!isAdmin()) return;
  try { updateInfo = await api("GET", "/api/admin/update"); } catch (_e) { return; }
  const avail = !!(updateInfo.check && updateInfo.check.available);
  $("#btnSettings").classList.toggle("has-badge", avail);
  $("#btnSettings").title = avail ? `Administration — Easydoc ${updateInfo.check.latestVersion || ""} disponible` : "Administration : utilisateurs, droits d'accès, dépôt";
}

const STEP_ICON = { todo: "○", doing: "◌", done: "✓", skip: "–", error: "✕", manual: "!" };
async function renderUpdateTab(box, opts = {}) {
  const d = updateInfo = await api("GET", `/api/admin/update${opts.refresh ? "?refresh=1" : ""}`);
  const c = d.check || {}, job = d.job, av = d.availability;
  $("#btnSettings").classList.toggle("has-badge", !!c.available);
  const when = (ts) => new Date(ts).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  let main = "";
  if (job && (job.running || job.error || (job.ok && !job.upToDate))) {
    main = `<div class="card ucard"><div style="flex:1">
        <div class="t">${job.running ? `Mise à jour vers ${esc(job.to || "la nouvelle version")}…` : job.error ? "La mise à jour a échoué" : "Mise à jour installée"}</div>
        <ol class="steps">${job.steps.map((s) => `<li class="st-${s.status}"><span class="si">${STEP_ICON[s.status] || ""}</span>${esc(s.label)}${s.detail ? ` <span class="muted-sm">· ${esc(s.detail)}</span>` : ""}</li>`).join("")}</ol>
      </div></div>
      ${job.error ? `<div class="msg err">${esc(job.error)}${job.rolledBack ? " La version précédente a été remise en place : Easydoc fonctionne comme avant." : ""}</div>` : ""}`;
  } else if (c.error) {
    main = `<div class="msg err">${esc(c.error)}</div>`;
  } else if (c.available) {
    main = `<div class="card ucard"><span class="tdot t-busy"></span><div style="flex:1;min-width:0">
        <div class="t">Easydoc ${esc(c.latestVersion || c.remote)} est disponible</div>
        <div class="s">${c.behind} modification${c.behind > 1 ? "s" : ""} depuis ta version</div></div></div>
      <ul class="changes">${c.changes.map((x) => `<li><span>${esc(x.title)}</span><span class="muted-sm">${esc(when(x.date))}</span></li>`).join("")}</ul>
      ${c.blocked ? `<div class="msg err">${esc(c.blocked)}</div>` : `<div class="note">Easydoc redémarre pendant environ 30 secondes : les personnes connectées sont reconnectées automatiquement et rien de ce qui a été écrit n'est perdu. Si la nouvelle version ne démarre pas, l'ancienne est remise en place.</div>`}`;
  } else if (c.at) {
    main = `<div class="card ucard"><span class="tdot t-ok"></span><div><div class="t">Easydoc est à jour</div><div class="s">Dernière vérification ${esc(relTime(c.at))}</div></div></div>`;
  }
  box.innerHTML = `
    <div class="row-between"><p class="muted-sm">Version installée : <strong>${esc(d.currentVersion)}</strong>${c.local ? ` (${esc(c.local)})` : ""}${d.last && d.last.ok ? ` · mise à jour depuis la ${esc(d.last.fromVersion)} le ${esc(when(d.last.at))}` : ""}</p>
      <button class="btn" data-act="check" ${job && job.running ? "disabled" : ""}>${svg("refresh")}Vérifier</button></div>
    ${!av.ok ? `<div class="note">${esc(av.reasons[0])}</div>` : ""}
    ${main}
    <div class="msg"></div>
    ${c.available && !c.blocked && !(job && job.running) && av.ok ? `<div class="row-end"><button class="btn btn-primary" data-act="update">${svg("download")}Mettre à jour maintenant</button></div>` : ""}`;
  $('[data-act="check"]', box).onclick = async (e) => {
    e.currentTarget.disabled = true;
    setMsg(box, "Vérification…");
    try { await renderUpdateTab(box, { refresh: true }); } catch (err) { setMsg(box, err.message, "err"); }
  };
  const u = $('[data-act="update"]', box);
  if (u) u.onclick = async () => {
    u.disabled = true;
    try { await api("POST", "/api/admin/update"); await renderUpdateTab(box); }
    catch (e) { setMsg(box, e.message, "err"); u.disabled = false; }
  };
  if (job && job.running && tabAlive(box, "update")) {
    const restarting = job.steps.some((s) => s.id === "restart" && s.status === "doing");
    if (restarting) { waitForNewVersion(); return; }
    clearTimeout(box._updTimer);
    box._updTimer = setTimeout(() => { if (tabAlive(box, "update")) renderUpdateTab(box).catch(() => waitForNewVersion()); }, 1000);
  }
}

/** Redémarrage pour mise à jour : on attend la nouvelle version, puis on recharge la page. */
let waitingVersion = false;
function waitForNewVersion() {
  if (waitingVersion) return;
  waitingVersion = true;
  sessionLost.done = true; // la coupure est normale : pas de message « session expirée »
  const banner = document.createElement("div");
  banner.className = "update-banner";
  banner.innerHTML = `${svg("download")}<span>Mise à jour d'Easydoc en cours : reconnexion automatique dans quelques secondes…</span>`;
  document.body.appendChild(banner);
  const started = Date.now();
  const poll = async () => {
    try {
      const r = await fetch("/api/health", { cache: "no-store", signal: AbortSignal.timeout(4000) });
      if (r.ok) {
        const h = await r.json();
        if (h.boot && h.boot !== config.boot) { banner.querySelector("span").textContent = `Easydoc ${h.version} est prêt : rechargement…`; setTimeout(() => location.reload(), 600); return; }
      }
    } catch (_e) {}
    if (Date.now() - started > 180000) { banner.querySelector("span").textContent = "La mise à jour prend plus de temps que prévu : recharge la page dans un instant."; return; }
    setTimeout(poll, 1500);
  };
  setTimeout(poll, 2500);
}

/* ---- Dépôt ---- */
async function renderRepoTab(box) {
  const s = await api("GET", "/api/settings");
  const gh = s.mode === "github";
  const card = gh
    ? `<div class="card">${svg("branch")}<div style="flex:1;min-width:0"><div class="t">${esc(s.repo)}</div><div class="s">Branche ${esc(s.branch)}${s.login ? ` · connecté en tant que ${esc(s.login)}` : ""}</div></div>
        <button class="btn btn-danger-soft" data-act="disconnect">${svg("unlink")}Déconnecter</button></div>`
    : `<div class="card">${svg("database")}<div><div class="t">Dépôt local</div><div class="s">Aucun dépôt GitHub : les fichiers sont enregistrés sur ce serveur.</div></div></div>`;
  box.innerHTML = `${card}
    <p class="muted-sm">${gh ? "Pour passer à un autre dépôt, indique-le ci-dessous puis clique sur Connecter." : "Connecte un dépôt GitHub pour y enregistrer les fichiers (un commit par enregistrement)."}</p>
    <div class="field"><label for="fRepo">${gh ? "Autre dépôt GitHub" : "Dépôt GitHub"}</label>
      <input class="input" id="fRepo" placeholder="propriétaire/dépôt ou URL GitHub" value="" /></div>
    <div class="field"><label for="fToken">Jeton d'accès</label>
      <input class="input" id="fToken" type="password" autocomplete="off" placeholder="${s.hasToken ? "Laisser vide pour garder le jeton actuel" : "ghp_… ou github_pat_…"}" />
      <span class="hint">Jeton avec accès en écriture au dépôt (classique : permission <code>repo</code> ; fin : Contents en lecture/écriture). <a href="https://github.com/settings/tokens" target="_blank" rel="noopener">Créer un jeton</a></span></div>
    <div class="field"><label for="fBranch">Branche <span style="color:var(--muted);font-weight:400">(facultatif)</span></label>
      <input class="input" id="fBranch" placeholder="branche par défaut du dépôt" value="" /></div>
    <div class="note">Les droits d'accès s'appliquent dans Easydoc. Sur GitHub, toute personne ayant accès au dépôt voit tous les fichiers.</div>
    <div class="msg"></div>
    <div class="row-end"><button class="btn" data-act="test">Tester</button><button class="btn btn-primary" data-act="save">Connecter</button></div>`;
  const c = box;
  const vals = () => ({ githubRepo: $("#fRepo", c).value, githubToken: $("#fToken", c).value, githubBranch: $("#fBranch", c).value });
  const busy = (on) => $$(".row-end button", c).forEach((b) => { b.disabled = on; });
  $('[data-act="test"]', c).onclick = async () => {
    busy(true); setMsg(c, "Vérification…");
    try {
      const d = await api("POST", "/api/settings/test", vals());
      setMsg(c, d.repo ? `Jeton valide (${d.login}). Dépôt ${d.repo.full_name} accessible en écriture, branche par défaut : ${d.repo.default_branch}.` : `Jeton valide (${d.login}).`, "ok");
    } catch (e) { setMsg(c, e.message, "err"); }
    busy(false);
  };
  $('[data-act="save"]', c).onclick = async () => {
    if (!$("#fRepo", c).value.trim()) { setMsg(c, "Indique le dépôt à connecter.", "err"); $("#fRepo", c).focus(); return; }
    busy(true); setMsg(c, "Connexion…");
    try {
      const d = await api("POST", "/api/settings", { mode: "github", ...vals() });
      setMsg(c, `Connecté à ${d.repo}${d.seeded ? " (documents de départ créés)" : ""}. Rechargement…`, "ok");
      setTimeout(() => location.reload(), 700);
    } catch (e) { setMsg(c, e.message, "err"); busy(false); }
  };
  const dc = $('[data-act="disconnect"]', c);
  if (dc) dc.onclick = () => confirmDisconnect(s);
}

/* ============================================================================================
 * Branchements et démarrage
 * ========================================================================================== */
$("#btnNew").onclick = newDocument;
$("#btnNewEmpty").onclick = newDocument;
$("#btnUpload").onclick = pickFiles;
$("#btnUploadEmpty").onclick = pickFiles;
$("#btnDelete").onclick = deleteDocument;
$("#btnSave").onclick = () => saveNow(true);
$("#btnSync").onclick = syncNow;
$("#btnSettings").onclick = () => openAdmin("users");
$("#workspace").onclick = () => { if (isAdmin()) openAdmin("repo"); };
$("#btnMe").onclick = openAccount;
$("#btnAccess").onclick = () => openAdmin("access", { path: currentPath() || "" });
$("#btnAuthors").onclick = () => toggleAuthors();
$("#btnHistory").onclick = openHistory;
$("#btnTheme").onclick = () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
$("#btnMenu").onclick = () => $("#app").classList.toggle("nav-open");
$("#scrim").onclick = () => $("#app").classList.remove("nav-open");
$("#search").addEventListener("input", renderTree);
$("#search").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { const first = $("#tree .node.file"); if (first) first.click(); }
  if (e.key === "Escape") { e.target.value = ""; renderTree(); e.target.blur(); }
});
window.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); saveNow(true); }
  if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); $("#search").focus(); $("#search").select(); }
});
window.addEventListener("hashchange", () => {
  const p = pathFromHash();
  if (p && p !== currentPath()) openFile(p);
});
window.addEventListener("error", (ev) => toast("Erreur de l'interface : " + (ev.message || "inconnue"), { error: true }));

function pathFromHash() {
  const h = location.hash.replace(/^#\/?/, "");
  if (!h) return null;
  try { return decodeURIComponent(h); } catch (_e) { return null; }
}

(async function start() {
  hydrateIcons();
  applyTheme(document.documentElement.dataset.theme);
  setView(localStorage.getItem("ed-view") || "edit");
  let state;
  try { state = await api("GET", "/api/auth/state"); }
  catch (e) { toast("Serveur injoignable : " + e.message, { error: true }); return; }
  if (state.setupRequired) return showAuth("setup");
  if (!state.user) return showAuth("login");
  setMe(state.user);
  for (const el of $$(".admin-only")) el.hidden = !isAdmin();
  document.body.classList.remove("auth-mode");
  connectSystem();
  await loadConfig();
  if (isAdmin()) await loadRules();
  await loadPeople();
  toggleAuthors(showAuthors);
  checkUpdateBadge();
  await refreshTree();
  const wanted = pathFromHash();
  const target = (wanted && files.includes(wanted) && wanted) || (files.includes("README.md") && "README.md") || files.find(isEditable) || files[0];
  if (target) openFile(target); else showEmpty();
  updateButtons();
})();
