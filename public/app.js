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
  unlink: '<path d="m18.84 12.25 1.72-1.71a4.95 4.95 0 0 0-7-7l-1.72 1.71"/><path d="m5.17 11.75-1.71 1.71a4.95 4.95 0 0 0 7 7l1.71-1.71"/><path d="M8 2v3"/><path d="M2 8h3"/><path d="M16 22v-3"/><path d="M22 16h-3"/>',
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
  if (!r.ok || d.ok === false) throw new Error(d.error || `Erreur ${r.status}`);
  return d;
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

const me = { name: (localStorage.getItem("ed-name") || "").slice(0, 40), color: "" };
me.color = colorFor(me.name || "?");
function renderMe() {
  $("#meName").textContent = me.name || "Anonyme";
  const a = $("#meAvatar");
  a.textContent = initials(me.name || "?");
  a.style.background = me.color;
}
function setName(name) {
  me.name = name.trim().slice(0, 40);
  me.color = colorFor(me.name);
  localStorage.setItem("ed-name", me.name);
  renderMe();
  sys.awareness.setLocalStateField("user", { name: me.name, color: me.color });
  if (S && S.provider) S.provider.awareness.setLocalStateField("user", { name: me.name, color: me.color });
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
function openModal({ title, subtitle = "", body = "", foot = "", locked = false, onMount }) {
  closeModal();
  const m = $("#modal"), card = $("#modalCard");
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

function askName(first = false) {
  openModal({
    title: first ? "Bienvenue sur Easydoc" : "Ton nom",
    subtitle: "Il est affiché aux autres participants et apparaît dans l'historique des enregistrements.",
    locked: first,
    body: `<div class="field"><label for="fName">Nom</label><input class="input" id="fName" maxlength="40" placeholder="Ex. Camille" value="${esc(me.name)}" /></div>`,
    foot: `${first ? "" : '<button class="btn" data-act="cancel">Annuler</button>'}<button class="btn btn-primary" data-act="ok">Continuer</button>`,
    onMount(card) {
      const input = $("#fName", card);
      const ok = () => { const v = input.value.trim(); if (!v) { input.focus(); return; } setName(v); closeModal(); };
      $('[data-act="ok"]', card).onclick = ok;
      const c = $('[data-act="cancel"]', card); if (c) c.onclick = closeModal;
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") ok(); });
    },
  });
}

/* ============================================================================================
 * Canal système : présence globale + notifications (liste des fichiers, changement de dépôt)
 * ========================================================================================== */
const sysDoc = new Y.Doc();
const sys = new WebsocketProvider(wsBase, "__system__", sysDoc, { disableBc: true });
const sysMap = sysDoc.getMap("sys");
let seenVersions = null;
sys.awareness.setLocalStateField("user", { name: me.name || "Anonyme", color: me.color });
sys.on("sync", (ok) => {
  if (ok && !seenVersions) seenVersions = { tree: sysMap.get("treeVersion"), config: sysMap.get("configVersion") };
});
sysMap.observe(() => {
  if (!seenVersions) return;
  const cfg = sysMap.get("configVersion"), tree = sysMap.get("treeVersion");
  if (cfg !== undefined && cfg !== seenVersions.config) { toast("Le dépôt connecté a changé — rechargement…"); setTimeout(() => location.reload(), 800); return; }
  if (tree !== seenVersions.tree) { seenVersions.tree = tree; refreshTree(); }
});
sys.awareness.on("change", () => { renderPresence(); renderTree(); });

function othersByPath() {
  const out = new Map();
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

async function refreshTree() {
  try {
    const d = await api("GET", "/api/files");
    fileInfo.clear();
    for (const f of d.files) fileInfo.set(f.path, f);
    files = d.files.map((f) => f.path).sort((a, b) => a.localeCompare(b, "fr", { sensitivity: "base" }));
    renderTree();
    if (F && !fileInfo.has(F.path)) { toast("Ce fichier a été supprimé."); showEmpty(); }
    else if (F) { F.size = fileInfo.get(F.path).size; renderStatus(); }
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
  const dots = (others.get(p) || []).slice(0, 3).map((u) => `<i style="background:${esc(u.color)}" title="${esc(u.name)}"></i>`).join("");
  const where = showDir && dirName(p) ? ` <span class="ext">· ${esc(dirName(p))}</span>` : "";
  el.innerHTML = `${iconFor(p)}<span class="name">${esc(displayName(p))}${where}</span><span class="dots">${dots}</span>`;
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
      row.innerHTML = `<span class="chev">${svg("chevron")}</span>${svg("folder")}<span class="name">${esc(name)}</span>`;
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
  $("#paneFile").innerHTML = "";
  if (!S) return;
  const s = S;
  S = null;
  clearTimeout(s.fallbackTimer); clearTimeout(s.offlineTimer); clearInterval(s.retryTimer);
  try { s.provider && s.provider.destroy(); } catch (_e) {}
  try { s.ydoc.destroy(); } catch (_e) {}
  sys.awareness.setLocalStateField("path", null);
}

function showEmpty() {
  closeSession();
  sys.awareness.setLocalStateField("path", null);
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
  sys.awareness.setLocalStateField("path", path);
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
  provider.awareness.setLocalStateField("user", { name: me.name || "Anonyme", color: me.color }); // nom dans l'historique

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
    if (keys.has("externalAt") && s.loaded) toast("Document mis à jour depuis le dépôt (modification externe).");
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
  ta.readOnly = false;
  ta.placeholder = s.kind === "text" ? "Commence à écrire…" : "Commence à écrire… (Markdown)";
  ta.value = s.ytext.toString();
  autosize();
  if (s.pendingText != null && s.pendingText !== ta.value) {
    ta.value = s.pendingText;
    applyLocal(s.pendingText);
    s.dirty = true; s.lastLocalEdit = Date.now();
    toast("Tes modifications faites pendant la coupure ont été réintégrées.");
  }
  s.pendingText = null;
  s.savedSeen = Date.now();
  renderPreview(); renderStatus(); updateButtons();
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
      const r = await fetch("/api/health", { cache: "no-store" });
      if (!r.ok) return;
      clearInterval(s.retryTimer);
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
    ta.readOnly = false;
    ta.placeholder = "Commence à écrire…";
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
  const body = { path: s.path, author: me.name };
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
  autosize(); schedulePreview(); renderStatus(); publishLine();
});

ta.addEventListener("keydown", (e) => {
  if (!S || !S.loaded) return;
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
    sys.awareness.setLocalStateField("line", line);
  }, 250);
}
["keyup", "click", "select"].forEach((ev) => ta.addEventListener(ev, publishLine));
window.addEventListener("resize", () => { if (S && S.loaded) autosize(); });

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
          const d = await api("POST", "/api/convert", { path, author: me.name });
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
      const r = await fetch(`/api/upload?path=${encodeURIComponent(p)}&author=${encodeURIComponent(me.name)}`, {
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
}
for (const b of $$("#viewSwitch button")) b.onclick = () => setView(b.dataset.view);

/* ============================================================================================
 * Statut, présence, boutons
 * ========================================================================================== */
function renderStatus() {
  const el = $("#status");
  let text = "", tone = "", title = "";
  if (F) {
    text = `${KIND_LABEL[F.kind]}${F.size != null ? " · " + fmtSize(F.size) : ""}`;
    const line = $("#fileMetaLine");
    if (line) line.textContent = text;
  } else if (S) {
    const err = S.meta.get("saveError");
    if (!S.loaded) { text = "Chargement…"; tone = "busy"; }
    else if (S.offline) { text = S.dirty ? "Hors ligne · enregistrement…" : "Hors ligne · enregistré"; tone = "busy"; }
    else if (S.reconnecting || !S.connected) { text = "Reconnexion…"; tone = "busy"; }
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
  const list = othersByPath().get(p) || [];
  const shown = list.slice(0, 4).map((u) => avatarHTML(u, `title="${esc(u.name)}${u.line && S ? ` — ligne ${esc(u.line)}` : ""}"`)).join("");
  const more = list.length > 4 ? `<span class="avatar more" title="${list.length - 4} autres">+${list.length - 4}</span>` : "";
  box.innerHTML = shown + more;
}

function updateButtons() {
  $("#btnSave").disabled = !(S && S.loaded);
  $("#btnSave").style.display = F ? "none" : "";
  $("#btnDelete").disabled = !currentPath();
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
      $('[data-act="cancel"]', c).onclick = () => openSettings();
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

async function openSettings() {
  let s = {};
  try { s = await api("GET", "/api/settings"); } catch (_e) {}
  const gh = s.mode === "github";
  const card = gh
    ? `<div class="card">${svg("branch")}<div style="flex:1;min-width:0"><div class="t">${esc(s.repo)}</div><div class="s">Branche ${esc(s.branch)}${s.login ? ` · connecté en tant que ${esc(s.login)}` : ""}</div></div>
        <button class="btn btn-danger-soft" data-act="disconnect">${svg("unlink")}Déconnecter</button></div>`
    : `<div class="card">${svg("database")}<div><div class="t">Dépôt local</div><div class="s">Aucun dépôt GitHub : les fichiers sont enregistrés sur ce serveur.</div></div></div>`;
  openModal({
    title: "Dépôt",
    subtitle: gh ? "Pour passer à un autre dépôt, indique-le ci-dessous puis clique sur Connecter." : "Connecte un dépôt GitHub pour y enregistrer les fichiers (un commit par enregistrement).",
    body: `${card}
      <div class="field"><label for="fRepo">${gh ? "Autre dépôt GitHub" : "Dépôt GitHub"}</label>
        <input class="input" id="fRepo" placeholder="propriétaire/dépôt ou URL GitHub" value="" /></div>
      <div class="field"><label for="fToken">Jeton d'accès</label>
        <input class="input" id="fToken" type="password" autocomplete="off" placeholder="${s.hasToken ? "Laisser vide pour garder le jeton actuel" : "ghp_… ou github_pat_…"}" />
        <span class="hint">Jeton avec accès en écriture au dépôt (classique : permission <code>repo</code> ; fin : Contents en lecture/écriture). <a href="https://github.com/settings/tokens" target="_blank" rel="noopener">Créer un jeton</a></span></div>
      <div class="field"><label for="fBranch">Branche <span style="color:var(--muted);font-weight:400">(facultatif)</span></label>
        <input class="input" id="fBranch" placeholder="branche par défaut du dépôt" value="" /></div>
      <div class="msg"></div>`,
    foot: '<button class="btn" data-act="test">Tester</button><button class="btn btn-primary" data-act="save">Connecter</button>',
    onMount(c) {
      const vals = () => ({ githubRepo: $("#fRepo", c).value, githubToken: $("#fToken", c).value, githubBranch: $("#fBranch", c).value });
      const busy = (on) => $$(".m-foot button", c).forEach((b) => { b.disabled = on; });
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
    },
  });
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
$("#btnSettings").onclick = openSettings;
$("#workspace").onclick = openSettings;
$("#btnMe").onclick = () => askName(false);
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
  renderMe();
  if (!me.name) askName(true);
  await loadConfig();
  await refreshTree();
  const wanted = pathFromHash();
  const target = (wanted && files.includes(wanted) && wanted) || (files.includes("README.md") && "README.md") || files.find(isEditable) || files[0];
  if (target) openFile(target); else showEmpty();
  updateButtons();
})();
