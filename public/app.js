// Easydoc — interface (éditeur collaboratif temps réel adossé à un dépôt git/GitHub).
import { Y, WebsocketProvider, DOMPurify, createEditor, structuredPatch, applyPatch, markdownToHtml } from "./vendor/libs.js";

/* ============================================================================================
 * Utilitaires
 * ========================================================================================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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
  move: '<path d="M5 9l-3 3 3 3"/><path d="M9 5l3-3 3 3"/><path d="M15 19l-3 3-3-3"/><path d="M19 9l3 3-3 3"/><path d="M2 12h20"/><path d="M12 2v20"/>',
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
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  highlight: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  comment: '<path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 8.5-8.5 8.38 8.38 0 0 1 8.5 8.5Z"/>',
  listUl: '<path d="M9 6h11"/><path d="M9 12h11"/><path d="M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  listOl: '<path d="M10 6h10"/><path d="M10 12h10"/><path d="M10 18h10"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>',
  task: '<rect width="7" height="7" x="3" y="4" rx="1.5"/><path d="m4.5 7.5 1.5 1.5 2.5-2.5"/><rect width="7" height="7" x="3" y="13" rx="1.5"/><path d="M14 7.5h7"/><path d="M14 16.5h7"/>',
  quote: '<path d="M7 7h4v4c0 3-1.5 5-4 6"/><path d="M14 7h4v4c0 3-1.5 5-4 6"/>',
  code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  table: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/><path d="M15 3v18"/>',
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9Z"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  copy: '<rect width="13" height="13" x="9" y="9" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  print: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect width="12" height="8" x="6" y="14"/>',
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
  const span = document.createElement("span");
  span.textContent = msg;
  t.appendChild(span);
  if (opts.action && opts.onAction) {
    const b = document.createElement("button");
    b.className = "toast-act";
    b.textContent = opts.action;
    b.onclick = () => { t.remove(); opts.onAction(); };
    t.appendChild(b);
  }
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), opts.ms || (opts.action ? 7000 : opts.error ? 6000 : 3200));
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
  const h = Math.round(m / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.round(h / 24);
  if (d < 7) return d === 1 ? "hier" : `il y a ${d} jours`;
  const date = new Date(ts);
  return "le " + date.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
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
// Assignation de couleur UNIQUE par personne (nom d'utilisateur / auteur externe) :
// dès qu'une identité est vue, elle reçoit la première couleur de la PALETTE encore libre.
// Deux personnes n'ont donc jamais la même couleur, et une même personne garde sa couleur.
const _colorUsed = new Set();
const _colorByPerso = new Map();
function colorFor(name) {
  if (_colorByPerso.has(name)) return _colorByPerso.get(name);
  let c = PALETTE[0];
  for (let i = 0; i < PALETTE.length; i++) {
    c = PALETTE[i];
    if (!_colorUsed.has(c)) break;
  }
  _colorByPerso.set(name, c);
  _colorUsed.add(c);
  return c;
}
function initials(name) {
  const p = name.trim().split(/\s+/).filter(Boolean);
  return ((p[0] || "?")[0] + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
}
/** Couleur placée dans un attribut style : uniquement « #rgb » à « #rrggbbaa » (rien d'autre ne passe). */
const safeColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(String(c || "")) ? c : "#888888");
function avatarHTML(user, extra = "") {
  return `<span class="avatar" style="background:${safeColor(user.color)}" ${extra}>${esc(initials(user.name))}</span>`;
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
  // valeur absente ou invalide (ex. « undefined » laissé par une ancienne version) : thème du système
  if (t !== "light" && t !== "dark") t = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
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
  const opener = modalClose ? modalOpener : document.activeElement; // fenêtre remplacée : on garde l'élément d'origine
  closeModal(true);
  modalOpener = opener;
  const m = $("#modal"), card = $("#modalCard");
  card.classList.toggle("wide", wide);
  card.innerHTML = `<div class="m-head"><h3 id="modalTitle">${esc(title)}</h3>${subtitle ? `<p>${subtitle}</p>` : ""}</div>
    <div class="m-body">${body}</div>${foot ? `<div class="m-foot">${foot}</div>` : ""}`;
  m.setAttribute("aria-labelledby", "modalTitle");
  hydrateIcons(card);
  m.classList.remove("hidden");
  const focusables = () => $$('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])', card)
    .filter((el) => el.offsetParent !== null);
  const onKey = (e) => {
    if (e.key === "Escape" && !locked) { e.stopPropagation(); closeModal(); return; }
    // Tab reste dans la fenêtre (on ne tombe pas sur la page derrière)
    if (e.key === "Tab") {
      const list = focusables();
      if (!list.length) { e.preventDefault(); return; }
      const i = list.indexOf(document.activeElement);
      if (e.shiftKey && (i <= 0)) { e.preventDefault(); list[list.length - 1].focus(); }
      else if (!e.shiftKey && (i === -1 || i === list.length - 1)) { e.preventDefault(); list[0].focus(); }
    }
  };
  const onBg = (e) => { if (e.target === m && !locked) closeModal(); };
  document.addEventListener("keydown", onKey, true);
  m.addEventListener("mousedown", onBg);
  modalClose = () => {
    document.removeEventListener("keydown", onKey, true);
    m.removeEventListener("mousedown", onBg);
    m.classList.add("hidden");
    m.removeAttribute("aria-labelledby");
    card.innerHTML = "";
  };
  if (onMount) onMount(card);
  // focus de départ : le premier champ, sinon le bouton principal, sinon le premier bouton
  setTimeout(() => {
    if (!card.contains(document.activeElement)) {
      const first = $("input:not([disabled]), textarea:not([disabled]), select:not([disabled])", card)
        || $(".m-foot .btn-primary:not([disabled]), .m-foot .btn-danger:not([disabled])", card) || focusables()[0];
      if (first) first.focus();
    }
  }, 30);
}
let modalOpener = null;
/** Ferme la fenêtre ; le focus revient à l'élément qui l'avait ouverte (sauf si une autre la remplace). */
function closeModal(replacing) {
  replacing = replacing === true; // souvent branchée en gestionnaire de clic : l'argument est alors l'événement
  if (!modalClose) return;
  const f = modalClose;
  modalClose = null;
  f();
  if (!replacing && modalOpener && modalOpener.isConnected && modalOpener.focus) modalOpener.focus();
  if (!replacing) modalOpener = null;
}
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
    if (ok && !seenVersions) seenVersions = { tree: sysMap.get("treeVersion"), config: sysMap.get("configVersion"), restart: sysMap.get("restartAt"), notif: sysMap.get("notif:" + me.id) };
  });
  sys.on("connection-close", (ev) => { if (ev && ev.code === 4001) sessionLost(); });
  // le temps réel revient : un document ouvert en mode dégradé (HTTP) repasse en direct
  sys.on("status", (e) => { if (e.status === "connected" && S && S.offline) setTimeout(() => S && retryRealtime(S), 1500); });
  sysMap.observe(() => {
    if (!seenVersions) return;
    const cfg = sysMap.get("configVersion"), tree = sysMap.get("treeVersion");
    const rs = sysMap.get("restartAt");
    if (rs !== undefined && rs !== seenVersions.restart) { seenVersions.restart = rs; waitForNewVersion(); return; }
    if (cfg !== undefined && cfg !== seenVersions.config) { toast("Le dépôt connecté a changé — rechargement…"); setTimeout(() => location.reload(), 800); return; }
    if (tree !== seenVersions.tree) { seenVersions.tree = tree; refreshTree(); if (isAdmin()) loadRules(); }
    const nk = me ? sysMap.get("notif:" + me.id) : undefined;
    if (nk !== undefined && nk !== seenVersions.notif) {
      seenVersions.notif = nk;
      loadNotifications();
      toast("Nouvelle notification : quelqu'un t'a cité ou t'a répondu.", { action: "Voir", onAction: openNotifications });
    }
  });
  // la liste des fichiers n'est redessinée que si quelqu'un change de document (pas à chaque
  // mouvement de curseur des autres, qui ne change que le numéro de ligne affiché en info-bulle)
  let presenceSig = "";
  sys.awareness.on("change", () => {
    renderPresence();
    const sig = [...othersByPath()].map(([p, l]) => p + ":" + l.map((u) => u.name + u.color).join(",")).sort().join("|");
    if (sig !== presenceSig) { presenceSig = sig; renderTree(); }
  });
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
/** Commenter : droit « lecture + commentaires » ou modification. */
const canComment = (p) => ["comment", "write"].includes((fileInfo.get(p) || {}).access);

async function refreshTree() {
  try {
    const d = await api("GET", "/api/files");
    fileInfo.clear();
    for (const f of d.files) fileInfo.set(f.path, f);
    files = d.files.map((f) => f.path).sort((a, b) => a.localeCompare(b, "fr", { sensitivity: "base" }));
    renderTree();
    const cur = currentPath();
    if (cur && !fileInfo.has(cur) && (F || (S && S.loaded))) {
      // Peut-être renommé / déplacé : l'annonce du nouveau nom (canal du document) peut arriver juste
      // après la nouvelle liste (canal système). On attend un instant avant de conclure.
      const was = S || F;
      setTimeout(() => {
        if ((S || F) !== was || currentPath() !== cur || fileInfo.has(cur)) return;
        if (S && S.meta.get("movedTo")) return; // le document suit son nouveau nom
        toast("Ce fichier n'est plus disponible (supprimé ou accès retiré)."); showEmpty();
      }, 1500);
    }
    else if (F) { F.size = fileInfo.get(F.path).size; renderStatus(); updateButtons(); }
    else if (S && S.loaded && !S.offline) { ED.setReadOnly(!canWrite(S.path)); renderStatus(); updateButtons(); }
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

function fileNode(p, others, showDir, level = 1) {
  const el = document.createElement("div");
  const active = currentPath() === p;
  el.className = "node file" + (active ? " active" : "");
  el.title = p;
  el.dataset.path = p;
  el.setAttribute("role", "treeitem");
  el.setAttribute("aria-level", String(level));
  el.tabIndex = -1;
  if (active) el.setAttribute("aria-current", "page");
  const people = others.get(hashPath(p)) || [];
  const dots = people.slice(0, 3).map((u) => `<i style="background:${safeColor(u.color)}" title="${esc(u.name)}"></i>`).join("");
  const where = showDir && dirName(p) ? ` <span class="ext">· ${esc(dirName(p))}</span>` : "";
  const acc = (fileInfo.get(p) || {}).access;
  const ro = !isAdmin() && ["read", "comment"].includes(acc);
  const roLabel = acc === "comment" ? "lecture et commentaires" : "lecture seule";
  const mark = isAdmin() && adminRules[p] ? `<span class="lockmark" title="Droits d'accès particuliers">${svg("lock")}</span>`
    : ro ? `<span class="lockmark" title="${roLabel[0].toUpperCase() + roLabel.slice(1)}">${svg(acc === "comment" ? "comment" : "eye")}</span>` : "";
  el.innerHTML = `${iconFor(p)}<span class="name">${esc(displayName(p))}${where}</span>${mark}<span class="dots">${dots}</span>`;
  // nom lu par un lecteur d'écran : le document, son dossier, la lecture seule et qui l'a ouvert
  el.setAttribute("aria-label", [displayName(p), showDir && dirName(p) ? `dans ${dirName(p)}` : "", ro ? roLabel : "",
    people.length ? `ouvert par ${people.map((u) => u.name).join(", ")}` : ""].filter(Boolean).join(", "));
  el.onclick = () => { openFile(p); $("#app").classList.remove("nav-open"); };
  return el;
}

function toggleFolder(path) {
  if (closed.has(path)) closed.delete(path); else closed.add(path);
  localStorage.setItem("ed-closed", JSON.stringify([...closed]));
  renderTree();
}

function renderTree() {
  const tree = $("#tree");
  // le focus clavier reste sur la même ligne quand la liste est redessinée
  const had = tree.contains(document.activeElement) ? document.activeElement : null;
  const keep = had && (had.dataset.path ? `[data-path="${CSS.escape(had.dataset.path)}"]` : had.dataset.dir ? `[data-dir="${CSS.escape(had.dataset.dir)}"]` : null);
  const q = norm($("#search").value.trim());
  const others = othersByPath();
  tree.innerHTML = "";
  tree.setAttribute("role", "tree");
  if (!files.length) { tree.innerHTML = '<div class="tree-empty">Aucun fichier pour l\'instant.</div>'; return; }
  if (q) {
    const hits = files.filter((p) => norm(p).includes(q));
    if (!hits.length) tree.innerHTML = '<div class="tree-empty">Aucun résultat.</div>';
    for (const p of hits) tree.appendChild(fileNode(p, others, true));
  } else {
    const draw = (node, parent, level) => {
      for (const [name, d] of [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0], "fr"))) {
        const open = !closed.has(d.path);
        const row = document.createElement("div");
        row.className = "node folder" + (open ? " open" : "");
        row.dataset.dir = d.path;
        row.setAttribute("role", "treeitem");
        row.setAttribute("aria-level", String(level));
        row.setAttribute("aria-expanded", String(open));
        row.tabIndex = -1;
        const lock = isAdmin() && adminRules[d.path] ? `<span class="lockmark" title="Droits d'accès particuliers">${svg("lock")}</span>` : "";
        row.innerHTML = `<span class="chev">${svg("chevron")}</span>${svg("folder")}<span class="name">${esc(name)}</span>${lock}`;
        row.onclick = () => toggleFolder(d.path);
        parent.appendChild(row);
        if (open) {
          const kids = document.createElement("div");
          kids.className = "children";
          kids.setAttribute("role", "group");
          draw(d, kids, level + 1);
          parent.appendChild(kids);
        }
      }
      for (const p of node.files) parent.appendChild(fileNode(p, others, false, level));
    };
    draw(buildTree(files), tree, 1);
  }
  // une seule ligne atteignable par Tab (le document ouvert, sinon la première) ; les flèches font le reste
  const rows = $$(".node", tree);
  const target = (keep && $(keep, tree)) || $(".node.active", tree) || rows[0];
  if (target) target.tabIndex = 0;
  if (had && target) target.focus();
}

/* ---- Liste des documents au clavier : flèches, Début/Fin, Entrée, comme un explorateur ---- */
$("#tree").addEventListener("keydown", (e) => {
  const row = e.target.closest && e.target.closest(".node");
  if (!row) return;
  const rows = $$(".node", $("#tree"));
  const i = rows.indexOf(row);
  const go = (r) => { if (!r) return; for (const x of rows) x.tabIndex = -1; r.tabIndex = 0; r.focus(); };
  const folder = row.classList.contains("folder");
  const open = folder && row.classList.contains("open");
  const parentRow = () => {
    const group = row.parentElement && row.parentElement.closest(".children");
    return group ? group.previousElementSibling : null;
  };
  switch (e.key) {
    case "ArrowDown": go(rows[i + 1]); break;
    case "ArrowUp": go(rows[i - 1]); break;
    case "Home": go(rows[0]); break;
    case "End": go(rows[rows.length - 1]); break;
    case "ArrowRight":
      if (folder && !open) toggleFolder(row.dataset.dir);
      else if (folder) go(rows[i + 1]);
      break;
    case "ArrowLeft":
      if (folder && open) toggleFolder(row.dataset.dir);
      else go(parentRow());
      break;
    case "Enter": case " ": row.click(); break;
    case "F2": openMoveDialog(row.dataset.path || row.dataset.dir); break;
    default: return;
  }
  e.preventDefault();
});

/* ============================================================================================
 * Session d'édition (document Markdown / texte ouvert)
 * ========================================================================================== */
const edHost = $("#editor");          // conteneur de l'éditeur (CodeMirror)
const paneEditor = $("#paneEditor");
const area = $("#area");
let S = null; // document en cours d'édition
let F = null; // fichier affiché (PDF, Word, image…)

function setArea(state, kind = "") { area.dataset.state = state; area.dataset.kind = kind; }

/* ---- L'éditeur : Markdown mis en forme, branché sur le texte partagé ---- */
const ED = createEditor(edHost, {
  marks: (from, to) => editorMarks(from, to),
  onUpdate: (u, local) => onEditorUpdate(u, local),
  onFiles: (files, pos) => { if (!canInsertFiles()) return false; insertFiles(files, pos); return true; }, // image collée
  resolveImage(src) {
    if (!S || /^[a-z][a-z0-9+.-]*:/i.test(src)) return src;
    const t = resolveRel(src, S.path);
    return t ? rawUrl(t) : src;
  },
  openLink(href) {
    if (!href) return;
    const target = S ? resolveRel(href, S.path) : null;
    if (target && files.includes(target)) return openFile(target);
    if (target && !/\.[a-z0-9]{1,5}$/i.test(target) && files.includes(target + ".md")) return openFile(target + ".md"); // lien sans « .md »
    if (/^(https?:|mailto:)/i.test(href)) return window.open(href, "_blank", "noopener,noreferrer");
    if (target) toast(`Document introuvable : ${target} (renommé, déplacé ou supprimé ?)`, { error: true });
  },
  linkTapped(href) {
    toast(`Lien : ${href}`, { action: "Ouvrir", onAction: () => this.openLink(href) });
  },
});
const docKind = (s) => (s.kind === "text" ? "text" : "markdown");
const placeholderFor = (s, ro) => (ro ? "" : s.kind === "text" ? "Commence à écrire…" : "Commence à écrire… (Markdown : # titre, **gras**, - liste)");

/** Après chaque changement dans l'éditeur (texte, sélection, focus, mise en page). */
function onEditorUpdate(u, local) {
  const s = S;
  if (!s || !s.loaded) return;
  if (u.docChanged) {
    if (local && !ED.readOnly) {
      s.lastLocalEdit = Date.now(); s.dirty = true;
      if (s.offline) { clearTimeout(s.offlineTimer); s.offlineTimer = setTimeout(() => saveNow(false), 3000); }
      renderStatus();
    } else if (!local && !s.dirty) s.confirmedText = ED.text; // modification des autres, rien d'à nous en attente
    scheduleToc();
  }
  if (u.docChanged || u.selectionSet) publishLine();
  if (u.selectionSet || u.focusChanged) {
    const pointer = u.transactions.some((t) => t.isUserEvent("select.pointer"));
    caretActivation(pointer);
    placeAddButton();
  }
  if (u.geometryChanged || u.viewportChanged) layoutSoon();
}
let layoutRaf = 0;
function layoutSoon() { cancelAnimationFrame(layoutRaf); layoutRaf = requestAnimationFrame(() => { layoutRail(); placeAddButton(); }); }

/* ---- Barre de mise en forme ---- */
for (const b of $$("#fmtBar [data-fmt]")) {
  b.addEventListener("mousedown", (e) => e.preventDefault()); // l'éditeur garde le curseur
  b.addEventListener("click", () => (b.dataset.fmt === "link" ? openLinkDialog() : ED.format(b.dataset.fmt)));
}
function updateFmtBar() {
  const show = !!(S && S.loaded && S.kind === "markdown" && !ED.readOnly);
  $("#fmtBar").hidden = !show;
}


function closeSession() {
  F = null;
  renderAuthorsBar(null);
  hideTip();
  closeToc();
  $("#paneFile").innerHTML = "";
  resetComments();
  if (!S) return;
  const s = S;
  S = null;
  ED.open({ kind: "markdown", text: "", readOnly: true }); // détache l'éditeur du document fermé
  updateFmtBar();
  clearTimeout(s.fallbackTimer); clearTimeout(s.offlineTimer); clearInterval(s.retryTimer); clearInterval(s.realtimeTimer);
  try { s.provider && s.provider.destroy(); } catch (_e) {}
  try { s.ydoc.destroy(); } catch (_e) {}
  setPresence("path", null);
}

function showEmpty() {
  closeSession();
  setPresence("path", null);
  setArea("empty");
  renderHome();
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
  // un nouveau document = une entrée d'historique : le bouton Précédent du navigateur y ramène
  const h = "#/" + encPath(path);
  if (location.hash !== h && location.hash) history.pushState(null, "", h); else history.replaceState(null, "", h);
  setPresence("path", hashPath(path));
  rememberRecent(path);
  updateFavButton();
}

function openFile(path, opts = {}) {
  if (!isEditable(path)) return openViewer(path);
  if (S && S.path === path && !opts.force) { if (opts.line) goToLine(opts.line); return; }
  closeSession();
  const ydoc = new Y.Doc();
  const provider = new WebsocketProvider(wsBase, encPath(path), ydoc, { disableBc: true });
  const s = S = {
    path, ydoc, provider, kind: kindOf(path),
    ytext: ydoc.getText("content"), meta: ydoc.getMap("meta"),
    loaded: false, connected: false, offline: false, reconnecting: false,
    lastLocalEdit: 0, savedSeen: 0, dirty: false, gotoLine: opts.line || 0,
    pendingText: opts.pendingText ?? null, pendingBase: opts.pendingBase ?? null, // frappe pendant une coupure
    realtimeTries: opts.realtimeTries || 0, wantComment: opts.comment || null,
  };
  // annuler / rétablir : seulement mes propres frappes (l'éditeur ajoute son origine)
  s.undo = new Y.UndoManager(s.ytext, { trackedOrigins: new Set(), captureTimeout: 600 });
  provider.awareness.setLocalStateField("user", { name: me.name, color: me.color, colorLight: me.color + "33" });

  setArea("loading", s.kind === "text" ? "text" : "");
  ED.open({ kind: docKind(s), text: "", readOnly: true, placeholder: "Chargement…" });
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

  s.ytext.observe((ev) => { if (S === s && s.loaded) shiftComments(ev.delta); }); // passages commentés
  s.ytext.observe(() => { if (S === s) renderOverlay(); }); // couleurs des auteurs

  s.meta.observe((event) => {
    if (S !== s) return;
    const keys = event.keysChanged;
    const wasLoaded = s.loaded; // à l'ouverture, toutes les clés arrivent : pas d'annonce pour d'anciens évènements
    if (s.meta.get("loaded") && !s.loaded) onLoaded(s);
    if (keys.has("savedAt")) {
      s.savedSeen = Date.now();
      if (s.lastLocalEdit <= s.savedSeen) { s.dirty = false; s.confirmedText = ED.text; } // tout est arrivé au serveur
    }
    if (keys.has("restoredAt") && wasLoaded && restoringPath !== s.path) {
      toast("Ce document vient d'être ramené à une version antérieure par quelqu'un (Historique pour le détail).", { ms: 7000 });
    }
    if (keys.has("externalAt") && wasLoaded) {
      const by = s.meta.get("externalBy");
      toast(by && by !== "Modification externe" ? `Document mis à jour depuis le dépôt par ${by}.` : "Document mis à jour depuis le dépôt (modification externe).");
    }
    if (keys.has("deleted")) { toast("Ce document a été supprimé."); refreshTree(); showEmpty(); return; }
    if (keys.has("movedTo")) {
      const to = s.meta.get("movedTo");
      if (to && to !== s.path) {
        toast(`Document déplacé : ${to}`);
        refreshTree().then(() => { if (S === s) openFile(to, { force: true }); });
        return;
      }
    }
    if (keys.has("commentsAt") && s.loaded) loadComments(); // commentaires ajoutés / modifiés par quelqu'un
    renderStatus();
  });

  // Temps réel injoignable (proxy sans WebSocket, pare-feu…) : on ouvre quand même via HTTP.
  s.fallbackTimer = setTimeout(() => { if (S === s && !s.loaded) startOffline(s); }, 6000);
  if (opts.focus) s.focusOnLoad = true;
}

/**
 * Mode dégradé (HTTP) : dès que le temps réel répond de nouveau (canal système connecté), le
 * document est rouvert en direct ; ce qui a été tapé entre-temps est réintégré.
 */
function retryRealtime(s) {
  if (S !== s || !s.offline || !s.loaded || s.saving) return;
  if (!sys || !sys.wsconnected) return;
  if ((s.realtimeTries = (s.realtimeTries || 0) + 1) > 5) return; // proxy qui coupe les documents seulement : on n'insiste pas
  openFile(s.path, { force: true, pendingText: s.dirty ? ED.text : null, pendingBase: s.offlineBase, realtimeTries: s.realtimeTries });
}

function onLoaded(s) {
  clearTimeout(s.fallbackTimer);
  if (s.meta.get("exists") === false && !files.includes(s.path)) {
    toast("Ce document n'existe pas (ou plus) dans le dépôt.", { error: true });
    showEmpty();
    return;
  }
  setArea("doc", s.kind === "text" ? "text" : "");
  const ro = !canWrite(s.path);
  ED.open({ kind: docKind(s), text: s.ytext.toString(), ytext: s.ytext, awareness: s.provider.awareness, undoManager: s.undo, readOnly: ro, placeholder: placeholderFor(s, ro) });
  s.loaded = true;
  s.confirmedText = ED.text; // dernier texte que le serveur a certainement reçu
  if (s.pendingText != null && !ro) reintegrate(s, ED.text); // passe par l'éditeur : partagé avec les autres
  s.pendingText = null;
  s.savedSeen = Date.now();
  renderTOC(); renderStatus(); updateButtons(); renderOverlay(); scheduleWordCount();
  if (s.gotoLine) goToLine(s.gotoLine); // ouvert depuis un résultat de recherche
  else if (s.focusOnLoad && !ro) { ED.setSelection(ED.length, ED.length); ED.focus(); } // document qu'on vient de créer
  if (s.realtimeTries) toast("Temps réel rétabli : la collaboration en direct reprend.");
  // charge les commentaires dès l'ouverture pour afficher les bulles dans la marge
  loadComments();
}

/** Fusion à trois voies, ligne à ligne : rejoue base → mine sur theirs ; null si les mêmes lignes ont changé. */
function merge3(base, mine, theirs) {
  if (mine === base || mine === theirs) return theirs;
  if (theirs === base) return mine;
  // fins de ligne Windows (CRLF) : fusion en LF, puis le texte garde ses fins de ligne (comme src/authorship.js)
  const crlf = /\r\n/.test(theirs);
  const lf = (t) => t.replace(/\r\n/g, "\n");
  let out = applyPatch(lf(theirs), structuredPatch("base", "mine", lf(base), lf(mine), "", "", { context: 1 }));
  if (out === false) {
    // lignes voisines : nouvel essai sans contexte si chaque modification remplace une ligne repérable
    const p0 = structuredPatch("base", "mine", lf(base), lf(mine), "", "", { context: 0 });
    if (p0.hunks.every((h) => h.lines.some((l) => l[0] === "-"))) out = applyPatch(lf(theirs), p0);
  }
  if (out === false) return null;
  return crlf ? out.replace(/\n/g, "\r\n") : out;
}
/**
 * Réintègre ce qui a été tapé pendant une coupure (s.pendingText, parti de s.pendingBase) dans
 * la version actuelle `theirs`, sans effacer ce que les autres ont écrit entre-temps.
 */
function reintegrate(s, theirs) {
  const merged = merge3(s.pendingBase == null ? theirs : s.pendingBase, s.pendingText, theirs);
  if (merged === null) { showConflict(s.pendingText); return; }
  if (merged === theirs) return;
  ED.setText(merged);
  s.dirty = true; s.lastLocalEdit = Date.now();
  toast("Tes modifications faites pendant la coupure ont été réintégrées.");
}
/** Deux versions incompatibles : la mienne est montrée pour être recopiée, rien n'est perdu. */
function showConflict(mine) {
  openModal({
    title: "Modifications en conflit",
    subtitle: "Pendant la coupure, quelqu'un a modifié les mêmes lignes que toi. Le document affiche sa version ; voici la tienne, à recopier où il faut.",
    body: `<textarea class="input conflict-text" readonly rows="12">${esc(mine)}</textarea>`,
    foot: '<button class="btn" data-act="close">Fermer</button><button class="btn btn-primary" data-act="copy">Copier ma version</button>',
    wide: true,
    onMount(card) {
      $('[data-act="close"]', card).onclick = closeModal;
      $('[data-act="copy"]', card).onclick = async () => {
        try { await navigator.clipboard.writeText(mine); toast("Ta version est copiée."); }
        catch (_e) { const t = $(".conflict-text", card); t.focus(); t.select(); toast("Sélectionne le texte puis Ctrl+C."); }
      };
    },
  });
}

/** Coupure du temps réel : on repart d'un document neuf à la reconnexion (évite les doublons). */
function startReconnect(s) {
  if (s.reconnecting) return;
  s.reconnecting = true;
  // Point de départ de la réintégration : le dernier texte que le serveur a certainement reçu.
  // Une coupure réseau n'est remarquée qu'au bout de ~30 s : ce qui a été tapé entre-temps n'est
  // jamais arrivé, il doit être réintégré lui aussi.
  s.reconnectBase = s.dirty && s.confirmedText != null ? s.confirmedText : ED.text;
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
      // la frappe pendant la coupure est restée dans l'éditeur : elle est fusionnée au retour
      const typed = ED.text !== s.reconnectBase;
      openFile(s.path, { force: true, pendingText: typed ? ED.text : null, pendingBase: s.reconnectBase });
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
    setArea("doc", s.kind === "text" ? "text" : "");
    const ro = !canWrite(s.path);
    ED.open({ kind: docKind(s), text: d.content, readOnly: ro, placeholder: placeholderFor(s, ro) });
    s.offlineBase = d.content; // version de départ : les enregistrements s'y comparent
    s.loaded = true;
    if (s.pendingText != null && !ro) reintegrate(s, d.content); // la frappe pendant la coupure n'est pas perdue
    s.pendingText = null;
    renderTOC(); renderStatus(); updateButtons();
    if (s.gotoLine) goToLine(s.gotoLine);
    if (!s.realtimeTries) toast("Temps réel indisponible : le document est ouvert sans collaboration en direct (vérifie le relais WebSocket du proxy).", { error: true, ms: 9000 });
    clearInterval(s.realtimeTimer);
    s.realtimeTimer = setInterval(() => retryRealtime(s), 20000 * Math.min(1 + s.realtimeTries, 4));
  } catch (e) {
    toast("Impossible d'ouvrir le document : " + e.message, { error: true });
  }
}

async function saveNow(manual) {
  if (!S || !S.loaded) return;
  const s = S;
  if (ED.readOnly) { if (manual) toast("Document en lecture seule : rien à enregistrer."); return; }
  // connexion temps réel coupée : le serveur n'a pas reçu la frappe récente, « Enregistré » serait faux
  if (!s.offline && (s.reconnecting || !s.connected)) {
    if (manual) toast("Connexion interrompue : tes modifications sont gardées ici et seront enregistrées dès son retour.", { error: true });
    return;
  }
  const body = { path: s.path };
  const sent = ED.text;
  if (s.offline) { body.content = sent; body.base = s.offlineBase; }
  s.saving = true; renderStatus();
  try {
    const d = await api("POST", "/api/save", body);
    if (S !== s) return;
    s.savedSeen = Date.now(); s.dirty = false;
    if (s.offline && typeof d.content === "string") {
      // le serveur a fusionné avec les modifications des autres : on affiche le résultat
      if (ED.text === sent) {
        s.offlineBase = d.content;
        if (d.content !== sent) { ED.setText(d.content); s.dirty = false; clearTimeout(s.offlineTimer); }
      } else {
        // frappe pendant l'enregistrement : elle est rejouée sur la version fusionnée, sinon la
        // version de départ reste celle envoyée (l'enregistrement suivant refera la fusion)
        const merged = merge3(sent, ED.text, d.content);
        if (merged !== null) { s.offlineBase = d.content; if (merged !== ED.text) ED.setText(merged); }
        s.dirty = true;
      }
    }
    if (manual) toast(d.committed ? "Enregistré dans le dépôt." : "Déjà à jour.");
  } catch (e) {
    if (s.offline && /^Conflit/.test(e.message)) {
      showConflict(sent);
      openFile(s.path, { force: true }); // repart de la version actuelle
    } else toast("Échec de l'enregistrement : " + e.message, { error: true });
  } finally {
    s.saving = false; renderStatus();
  }
}

let lineT = null;
function publishLine() {
  clearTimeout(lineT);
  lineT = setTimeout(() => {
    if (!S || !S.loaded) return;
    setPresence("line", ED.lineAt(ED.selection.head).number);
  }, 250);
}
window.addEventListener("resize", () => { if (S && S.loaded) renderRail(); });

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
  let n = name.normalize("NFC").replace(/[^\p{L}\p{N} _.()&+,'’@[\]!~=-]/gu, "-").replace(/~(?=\d)/g, "-")
    .replace(/-{2,}/g, "-").replace(/^[.\s-]+/, "").replace(/[.\s]+$/, "").trim();
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

/* ---- Images et fichiers insérés dans le texte (coller, glisser-déposer sur le document) ---- */
// Une image va dans le dossier « <document> - images » à côté du document, un autre fichier dans le
// dossier du document ; un lien relatif est inséré à l'endroit voulu (image affichée dans le texte).
const pad2 = (n) => String(n).padStart(2, "0");
const canInsertFiles = () => !!(S && S.loaded && S.kind === "markdown" && !S.offline && !ED.readOnly);
function insertedName(f) {
  const ext = (String(f.type).split("/")[1] || "png").replace("jpeg", "jpg").replace("svg+xml", "svg").replace(/[^a-z0-9]/gi, "") || "png";
  // capture d'écran collée (« image.png ») : nommée d'après la date ; sinon le nom du fichier
  if (f.name && !/^image\.\w+$/i.test(f.name)) return cleanName(f.name);
  const d = new Date();
  return `capture ${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}h${pad2(d.getMinutes())}m${pad2(d.getSeconds())}.${ext}`;
}
/** Lien relatif (encodé pour le Markdown) du dossier du document vers un fichier du dépôt. */
function relLink(fromDoc, target) {
  const a = dirName(fromDoc) ? dirName(fromDoc).split("/") : [];
  const b = target.split("/");
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  const enc = (s) => encodeURIComponent(s).replace(/\(/g, "%28").replace(/\)/g, "%29");
  return [...a.slice(i).map(() => ".."), ...b.slice(i).map(enc)].join("/");
}
async function insertFiles(files, pos) {
  const s = S;
  const list = [...files].filter((f) => f && f.size !== undefined);
  if (!list.length || !canInsertFiles()) return;
  const maxMB = config.maxUploadMB || 25;
  const stem = displayName(s.path);
  const dir = dirName(s.path);
  const jobs = [];
  for (const f of list) {
    if (f.size > maxMB * 1048576) { toast(`« ${f.name || "image"} » dépasse ${maxMB} Mo : non inséré.`, { error: true }); continue; }
    jobs.push({ f, name: insertedName(f), image: /^image\//.test(f.type) });
  }
  if (!jobs.length) return;
  // Endroit de l'insertion, suivi localement pendant l'envoi (rien n'est écrit dans le texte partagé
  // avant que le fichier soit dans le dépôt : pas de repère qui traînerait chez les autres).
  let at = pos == null ? ED.selection.head : pos;
  let lead = "";
  if (pos != null) {
    // déposé sur une ligne : inséré sur une nouvelle ligne juste en dessous, sans couper un mot
    const ln = ED.lineAt(pos);
    at = ln.to;
    if (ln.text.trim()) lead = "\n";
  }
  const spot = ED.track(at);
  toast(jobs.length > 1 ? `Envoi de ${jobs.length} fichiers…` : `Envoi de « ${jobs[0].name} »…`);
  const links = [];
  for (const j of jobs) {
    const folder = j.image ? [dir, `${stem} - images`].filter(Boolean).join("/") : dir;
    const want = folder ? `${folder}/${j.name}` : j.name;
    try {
      const r = await fetch(`/api/upload?path=${encodeURIComponent(want)}`, {
        method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: j.f,
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error || `erreur ${r.status}`);
      const label = fileName(d.path).replace(/[[\]]/g, "");
      links.push({ path: d.path, md: j.image ? `![${label.replace(/\.[^.]+$/, "")}](${relLink(s.path, d.path)})` : `[${label}](${relLink(s.path, d.path)})` });
    } catch (e) {
      toast(`Échec de l'envoi de « ${j.name} » : ${e.message}`, { error: true });
    }
  }
  ED.untrack(spot);
  if (!links.length) return;
  refreshTree();
  const text = lead + links.map((l) => l.md).join("\n");
  if (S && S.loaded && S.path === s.path && !ED.readOnly) {
    // même document : à l'endroit suivi (ou au curseur si le document a été rouvert entre-temps)
    ED.insertAt(S === s ? spot.pos : ED.selection.head, text);
    toast(links.length > 1 ? `${links.length} fichiers insérés dans le document.` : jobs[0].image ? "Image insérée." : "Fichier inséré.");
  } else {
    // l'utilisateur est passé à un autre document : le fichier est enregistré, rien n'est inséré ailleurs
    toast(`Enregistré dans « ${dirName(links[0].path) || "la racine"} » ; non inséré, car tu as changé de document.`, { ms: 8000 });
  }
}

let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files");
/** Le pointeur est-il au-dessus du texte du document (dépôt = insertion à cet endroit) ? */
function overEditor(e) {
  if (!canInsertFiles()) return false;
  const r = paneEditor.getBoundingClientRect();
  return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
}
function dropText(e) {
  if (overEditor(e)) return "Dépose ici pour insérer dans le document";
  const folder = currentFolder();
  return folder ? `Dépose tes fichiers pour les importer dans « ${folder} »` : "Dépose tes fichiers pour les importer";
}
window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  $("#dropzoneText").textContent = dropText(e);
  document.body.classList.add("dragging");
});
window.addEventListener("dragover", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
  const t = dropText(e);
  if ($("#dropzoneText").textContent !== t) $("#dropzoneText").textContent = t;
  document.body.classList.toggle("drop-insert", overEditor(e));
});
window.addEventListener("dragleave", (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove("dragging", "drop-insert");
});
window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging", "drop-insert");
  // déposé sur le texte : inséré à l'endroit du dépôt
  if (overEditor(e)) { insertFiles(e.dataTransfer.files, ED.posAtCoords(e.clientX, e.clientY)); return; }
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

/* ---- Surlignages dans l'éditeur : auteurs (« qui a écrit quoi ») et passages commentés ---- */
// Les curseurs et sélections des autres sont dessinés par l'éditeur lui-même (y-codemirror).
let ovRaf = 0;
let authorRuns = null; // [début, fin, auteur, minute] quand « qui a écrit quoi » est affiché
function renderOverlay() { cancelAnimationFrame(ovRaf); ovRaf = requestAnimationFrame(drawOverlay); }
function drawOverlay() {
  const live = S && S.loaded && !S.offline && !S.reconnecting;
  authorRuns = null;
  if (live && showAuthors && ED.length === S.ytext.length) {
    const runs = [];
    let i = 0;
    for (const op of S.ytext.toDelta()) {
      if (typeof op.insert !== "string") continue;
      const at = op.attributes || {};
      runs.push([i, i + op.insert.length, at.a || "", at.t || 0]);
      i += op.insert.length;
    }
    authorRuns = runs;
  }
  renderAuthorsBar(authorRuns);
  if (S && S.loaded) ED.refresh();
  afterOverlay();
}
/** Passages à surligner entre from et to (appelé par l'éditeur pour la partie affichée). */
function editorMarks(from, to) {
  const out = [];
  if (authorRuns) {
    for (const [s, e, a, t] of authorRuns) {
      if (e <= from || s >= to || !a || (focusAuthor && focusAuthor !== a)) continue;
      out.push({ from: s, to: e, cls: "au", attrs: { style: `--c:${personOf(a).color}`, "data-a": a, "data-t": String(t) } });
    }
  }
  for (const a of commentAnchors(ED.length)) {
    if (a.e <= from || a.s >= to) continue;
    out.push({ from: a.s, to: a.e, cls: a.on ? "ca on" : "ca", attrs: { style: `--ca:${a.color}`, "data-cids": a.id } });
  }
  return out;
}

function renderAuthorsBar(runs) {
  const bar = $("#authorsBar");
  if (!runs) { if (!bar.hidden) { bar.hidden = true; bar.innerHTML = ""; } return; }
  const totals = new Map();
  let all = 0;
  const text = S.ytext.toString();
  for (const [s, e, a] of runs) {
    const n = text.slice(s, e).replace(/\s/g, "").length;
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
  hideTip();
  renderOverlay();
}

/* ---- Info-bulle au survol d'un passage ---- */
const tip = $("#authTip");
let tipRaf = 0;
function hideTip() { tip.hidden = true; }
$("#paneEditor").addEventListener("mousemove", (e) => {
  if (!showAuthors) return;
  cancelAnimationFrame(tipRaf);
  const { clientX: x, clientY: y, target } = e;
  tipRaf = requestAnimationFrame(() => {
    const span = target && target.closest ? target.closest(".cm-content .au") : null;
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

/* ---- Historique des modifications ---- */
function cleanTitle(t) {
  const m = String(t || "").match(/^Easydoc\s*:\s*(création|import|suppression|conversion|renommage|déplacement)?/i);
  if (!m) return t || "(sans titre)";
  const k = (m[1] || "").toLowerCase();
  return k === "création" ? "Création du document" : k === "import" ? "Import du fichier" : k === "suppression" ? "Suppression"
    : k === "conversion" ? "Version modifiable créée" : k === "renommage" ? "Renommé" : k === "déplacement" ? "Déplacé" : "Modifications enregistrées";
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
      const writable = canWrite(p);
      for (const item of $$(".hitem", box)) {
        $(".hrow", item).onclick = () => {
          const diff = $(".hdiff", item);
          const open = item.classList.toggle("open");
          diff.hidden = !open;
          if (!open || diff.dataset.loaded) return;
          diff.innerHTML = '<div class="loadingview">Chargement…</div>';
          api("GET", `/api/history/diff?path=${encodeURIComponent(p)}&sha=${encodeURIComponent(item.dataset.sha)}`).then((r) => {
            diff.dataset.loaded = "1";
            diff.innerHTML = (r.patch ? patchHTML(r.patch) : `<div class="muted-sm" style="padding:10px 12px">${r.binary ? "Fichier binaire : pas de détail ligne par ligne." : "Aucune modification de contenu dans cette version."}</div>`)
              + `<div class="hist-restore">${isEditable(p) && r.status !== "removed" ? `<button class="btn" data-act="view">${svg("eye")}Voir le document à cette version</button>` : ""}`
              + (writable ? `<button class="btn btn-danger-soft" data-act="restore" data-sha="${esc(item.dataset.sha)}">${svg("download")}Revenir à cette version</button>` : "") + "</div>";
            const rb = $('[data-act="restore"]', diff);
            if (rb) rb.onclick = () => confirmRestore(p, rb.dataset.sha, item.dataset.date);
            const vb = $('[data-act="view"]', diff);
            if (vb) vb.onclick = async () => {
              const shown = diff.querySelector(".version-view");
              if (shown) { shown.remove(); vb.lastChild.textContent = "Voir le document à cette version"; return; }
              vb.disabled = true;
              try {
                const v = await api("GET", `/api/history/content?path=${encodeURIComponent(p)}&sha=${encodeURIComponent(item.dataset.sha)}`);
                const view = document.createElement("div");
                view.className = "prose version-view";
                view.innerHTML = renderMarkdown(v.content, p);
                diff.insertBefore(view, diff.querySelector(".hist-restore"));
                vb.lastChild.textContent = "Masquer le document";
              } catch (e) { toast(e.message, { error: true }); }
              finally { vb.disabled = false; }
            };
          }).catch((e) => { diff.innerHTML = `<div class="msg err">${esc(e.message)}</div>`; });
        };
      }
    },
  });
}

/* ============================================================================================
 * Confort : recherche dans le contenu, lien, table des matières, aide clavier
 * ========================================================================================== */
const srBox = $("#searchResults");
let srTimer = null, srSeq = 0;
function renderSearchResults() {
  const q = $("#search").value.trim();
  const tree = $("#tree");
  if (!q) { srBox.hidden = true; srBox.innerHTML = ""; renderTree(); return; }
  renderTree(); // la liste reste filtrée par nom pendant la recherche dans le contenu
  srBox.hidden = false;
  const seq = ++srSeq;
  srBox.innerHTML = '<div class="sr-hint">Recherche dans le contenu…</div>';
  clearTimeout(srTimer);
  srTimer = setTimeout(async () => {
    if (seq !== srSeq) return;
    try {
      const d = await api("GET", "/api/search?q=" + encodeURIComponent(q));
      if (seq !== srSeq) return;
      if (!d.results.length) { srBox.innerHTML = '<div class="sr-hint">Aucun résultat dans le contenu.</div>'; return; }
      // résultats regroupés par document ; le passage trouvé est mis en valeur (sans accents ni majuscules)
      srBox.innerHTML = d.results.map((g) => {
        const dot = dirName(g.path) ? `<span class="ln">· ${esc(dirName(g.path))}</span>` : "";
        const more = g.count > g.matches.length ? `<span class="ln">${g.count} passages</span>` : "";
        const head = `<button class="sr sr-doc" data-path="${esc(g.path)}" data-line="${g.matches[0] ? g.matches[0].line : 0}">
          <span class="p"><span>${iconFor(g.path)}${esc(displayName(g.path))}${dot}</span>${more}</span></button>`;
        return `<div class="sr-group" role="group" aria-label="${esc(displayName(g.path))}">${head}${g.matches.map((m) => `
          <button class="sr sr-line" data-path="${esc(g.path)}" data-line="${m.line}">
            <span class="x"><span class="ln">${m.line}</span>${esc(m.before)}<em>${esc(m.match)}</em>${esc(m.after)}</span></button>`).join("")}</div>`;
      }).join("") + (d.truncated ? '<div class="sr-hint">D\'autres résultats existent : précise la recherche.</div>' : "");
      for (const el of $$(".sr", srBox)) {
        el.onclick = () => { openFile(el.dataset.path, Number(el.dataset.line) ? { line: Number(el.dataset.line) } : {}); srBox.hidden = true; $("#search").value = ""; renderTree(); };
        el.onkeydown = (e) => {
          const all = $$(".sr", srBox), i = all.indexOf(el);
          if (e.key === "ArrowDown") { e.preventDefault(); (all[i + 1] || $("#tree .node") || el).focus(); }
          else if (e.key === "ArrowUp") { e.preventDefault(); (all[i - 1] || $("#search")).focus(); }
          else if (e.key === "Escape") { e.preventDefault(); $("#search").focus(); }
        };
      }
    } catch (e) { if (seq === srSeq) srBox.innerHTML = `<div class="sr-hint">${esc(e.message)}</div>`; }
  }, 250);
}
$("#search").addEventListener("input", renderSearchResults);
$("#search").addEventListener("focus", renderSearchResults);
$("#search").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { $("#search").value = ""; $("#search").blur(); renderSearchResults(); }
});
document.addEventListener("click", (e) => { if (srBox && !srBox.hidden && !e.target.closest(".search") && !e.target.closest(".sr")){ srBox.hidden = true; } });

async function copyLink() {
  const p = currentPath();
  if (!p) return;
  const url = location.origin + location.pathname + "#/" + encPath(p);
  try {
    await navigator.clipboard.writeText(url);
    toast("Lien copié : " + fileName(p));
  } catch (_e) {
    // repli sans permission (http non sécurisé…)
    const tx = document.createElement("textarea"); tx.value = url; document.body.appendChild(tx); tx.select();
    try { document.execCommand("copy"); toast("Lien copié : " + fileName(p)); } catch (_e2) { prompt("Lien du document :", url); }
    tx.remove();
  }
}
$("#btnCopyLink").onclick = copyLink;

/* ---- Plan du document : colonne à gauche du texte, comme dans Google Docs ---- */
// Ouvert par défaut quand la place le permet (choix mémorisé) ; sur un écran plus étroit il reste
// replié et le bouton l'ouvre par-dessus le texte, le temps d'aller à un titre.
const OUTLINE_MIN_MAIN = 1080; // largeur de la zone principale nécessaire pour plan + texte + marge des commentaires
let outlinePref = localStorage.getItem("ed-outline") !== "0";
let outlineOverlay = false;    // ouvert par-dessus le texte (écran étroit)
let tocT = null;
let tocHeadsSig = "";
/** Titres Markdown (# à ####) hors blocs de code : [{ level, text, line }]. */
function tocHeadings(md) {
  const out = [];
  let fence = null;
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i];
    const f = s.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const m = s.match(/^\s{0,3}(#{1,4})\s+(.+?)\s*#*\s*$/);
    if (m) out.push({ level: m[1].length, line: i + 1, text: m[2].replace(/\*\*|__|~~|`/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") });
  }
  return out;
}
const outlineWide = () => $(".main").clientWidth >= OUTLINE_MIN_MAIN;
const outlineShown = () => !!(S && S.loaded && S.kind === "markdown") && (outlineOverlay || (outlinePref && outlineWide()));

/** Affiche ou masque le plan selon le document, la place et le choix de l'utilisateur ; met à jour les titres. */
function renderTOC() {
  const box = $("#outline");
  const show = outlineShown();
  const wasShown = !box.hidden;
  box.hidden = !show;
  box.classList.toggle("overlay", show && outlineOverlay);
  const btn = $("#btnToc");
  btn.classList.toggle("on", show);
  btn.setAttribute("aria-pressed", String(show));
  btn.title = show ? "Masquer le plan du document" : "Afficher le plan du document";
  if (!show) { tocHeadsSig = ""; if (wasShown && S && S.loaded) renderRail(); return; }
  const heads = tocHeadings(ED.text);
  const sig = JSON.stringify(heads);
  if (sig !== tocHeadsSig) {
    tocHeadsSig = sig;
    $("#outlineList").innerHTML = heads.length
      ? heads.map((h) => `<button class="h${h.level}" data-line="${h.line}" title="${esc(h.text)}">${esc(h.text)}</button>`).join("")
      : '<p class="ol-empty">Les titres du document apparaîtront ici. Ajoutes-en avec T1, T2 ou T3.</p>';
    for (const b of $$("#outlineList button")) {
      b.onclick = () => {
        goToLine(Number(b.dataset.line));
        for (const x of $$("#outlineList button")) x.classList.toggle("on", x === b); // titre choisi mis en évidence tout de suite
        if (outlineOverlay) { outlineOverlay = false; renderTOC(); }
        setTimeout(updateTocCurrent, 120); // puis recalculé d'après la position réelle
      };
    }
  }
  if (!wasShown && S && S.loaded) renderRail(); // la largeur du texte a changé : marge des commentaires replacée
  updateTocCurrent();
}
/** Met en évidence le titre de la partie affichée (et le garde visible dans le plan). */
function updateTocCurrent() {
  const box = $("#outline");
  if (box.hidden || !S || !S.loaded) return;
  const limit = paneEditor.getBoundingClientRect().top + 90;
  const btns = $$("#outlineList button");
  let cur = btns[0] || null;
  for (const b of btns) {
    if (ED.topAt(ED.lineStart(Number(b.dataset.line))) <= limit) cur = b; else break;
  }
  for (const b of btns) {
    const on = b === cur;
    if (b.classList.contains("on") !== on) b.classList.toggle("on", on);
    if (on) b.setAttribute("aria-current", "location"); else b.removeAttribute("aria-current");
  }
  if (cur) {
    const list = $("#outlineList"), r = cur.getBoundingClientRect(), lr = list.getBoundingClientRect();
    if (r.top < lr.top || r.bottom > lr.bottom) cur.scrollIntoView({ block: "nearest" });
  }
}
function scheduleToc() {
  if (!$("#outline").hidden) { clearTimeout(tocT); tocT = setTimeout(renderTOC, 400); }
  scheduleWordCount();
}
/** Nombre de mots (affiché dans l'état du document), recalculé après une pause de frappe. */
let wordsT = null;
function scheduleWordCount() {
  clearTimeout(wordsT);
  wordsT = setTimeout(() => {
    if (!S || !S.loaded) return;
    const t = ED.text.replace(/^```[\s\S]*?^```/gm, " ").replace(/[#>*_`~|\[\]()!-]/g, " ");
    S.words = (t.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu) || []).length;
    renderStatus();
  }, 600);
}
/** Document fermé : le plan se vide (il réapparaît à l'ouverture du suivant). */
function closeToc() {
  clearTimeout(tocT);
  outlineOverlay = false;
  tocHeadsSig = "";
  $("#outlineList").innerHTML = "";
  $("#outline").hidden = true;
}
function toggleOutline() {
  if (outlineWide()) {
    outlinePref = !outlineShown();
    outlineOverlay = false;
    localStorage.setItem("ed-outline", outlinePref ? "1" : "0");
  } else outlineOverlay = !outlineOverlay;
  renderTOC();
  if (!$("#outline").hidden && outlineOverlay) { const b = $("#outlineList .on") || $("#outlineList button"); if (b) b.focus(); }
}
$("#btnToc").onclick = toggleOutline;
$("#btnOutlineClose").onclick = () => { if (outlineOverlay) { outlineOverlay = false; renderTOC(); } else toggleOutline(); ED.focus(); };
$("#outline").addEventListener("keydown", (e) => { if (e.key === "Escape" && outlineOverlay) { outlineOverlay = false; renderTOC(); ED.focus(); } });
let tocRaf = 0;
paneEditor.addEventListener("scroll", () => { if (!$("#outline").hidden) { cancelAnimationFrame(tocRaf); tocRaf = requestAnimationFrame(updateTocCurrent); } }, { passive: true });
// largeur de la fenêtre : le plan apparaît ou se replie selon la place
let outlineResizeT = null;
window.addEventListener("resize", () => { clearTimeout(outlineResizeT); outlineResizeT = setTimeout(() => { if (S && S.loaded) renderTOC(); }, 150); });


/* ---- Rendu, impression et export ---- */
/** Adresses des liens et images d'un document : relatives au dépôt → adresses d'Easydoc. */
function mdUrl(fromPath, absolute) {
  return (u, kind) => {
    if (!u || /^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith("#") || u.startsWith("//")) return u;
    const t = resolveRel(u, fromPath);
    if (!t) return u;
    if (kind === "image") return (absolute ? location.origin : "") + rawUrl(t);
    const doc = files.includes(t) ? t : files.includes(t + ".md") ? t + ".md" : t;
    return location.origin + location.pathname + "#/" + encPath(doc);
  };
}
/** Markdown → HTML nettoyé, prêt à insérer dans la page. */
function renderMarkdown(text, fromPath, absolute) {
  const html = kindOf(fromPath) === "text" ? `<pre>${esc(text)}</pre>` : markdownToHtml(text, { url: mdUrl(fromPath, absolute) });
  return DOMPurify.sanitize(html, { ADD_ATTR: ["start"] });
}
// Impression (Ctrl+P ou « Exporter ») : le document entier, mis en page, sans l'interface autour
// (l'éditeur ne dessine que la partie visible du texte : il ne peut pas être imprimé tel quel)
function fillPrintView() {
  const pv = $("#printView");
  if (!S || !S.loaded) { pv.innerHTML = ""; return false; }
  pv.innerHTML = `<article class="prose print-doc">${renderMarkdown(ED.text, S.path)}</article>`;
  return true;
}
window.addEventListener("beforeprint", fillPrintView);
window.addEventListener("afterprint", () => { $("#printView").innerHTML = ""; });
function printDoc() {
  if (!fillPrintView()) return;
  setTimeout(() => window.print(), 50); // laisse les images commencer à charger
}
async function inlineImages(root) {
  let budget = 15 * 1024 * 1024;
  for (const img of root.querySelectorAll("img[src]")) {
    const src = img.getAttribute("src");
    if (!src.startsWith(location.origin + "/api/raw")) continue;
    try {
      const r = await fetch(src);
      const b = await r.blob();
      if (!r.ok || b.size > budget) continue;
      budget -= b.size;
      img.src = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(b); });
    } catch (_e) {}
  }
}
const EXPORT_CSS = `body{margin:0;background:#fff;color:#1f2328;font:16px/1.65 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
article{max-width:760px;margin:40px auto;padding:0 24px}h1,h2,h3,h4{line-height:1.25;margin:1.6em 0 .6em}h1{font-size:2em}h2{font-size:1.5em}h3{font-size:1.2em}
a{color:#0969da}img{max-width:100%}code{font:.9em ui-monospace,Consolas,monospace;background:#f3f4f6;padding:.1em .3em;border-radius:4px}
pre{background:#f6f8fa;padding:12px 14px;border-radius:6px;overflow:auto}pre code{background:none;padding:0}
blockquote{margin:1em 0;padding:0 1em;color:#57606a;border-left:4px solid #d0d7de}table{border-collapse:collapse;margin:1em 0}
th,td{border:1px solid #d0d7de;padding:6px 12px}th{background:#f6f8fa}li.task{list-style:none}li.task input{margin:0 .4em 0 -1.3em}hr{border:0;border-top:1px solid #d0d7de;margin:2em 0}`;
function downloadBlob(name, type, data) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
async function exportHtml(p) {
  const box = document.createElement("article");
  box.innerHTML = renderMarkdown(ED.text, p, true);
  await inlineImages(box); // images incluses dans le fichier : il s'ouvre partout, même hors connexion
  const title = esc(displayName(p));
  downloadBlob(`${displayName(p)}.html`, "text/html;charset=utf-8",
    `<!doctype html>\n<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${EXPORT_CSS}</style></head>\n<body>${box.outerHTML}</body></html>\n`);
}
function openExport() {
  const p = currentPath();
  if (!p) return;
  const doc = !!(S && S.loaded && S.path === p);
  openModal({
    title: "Exporter ou imprimer",
    subtitle: `<strong>${esc(fileName(p))}</strong>`,
    body: `<div class="export-list">
      ${doc ? `<button class="exp" data-x="print">${svg("file")}<span><b>Imprimer ou enregistrer en PDF</b><small>Le document entier, mis en page, sans l'interface (choisir « Enregistrer au format PDF » comme imprimante).</small></span></button>
      <button class="exp" data-x="html">${svg("download")}<span><b>Page web (.html)</b><small>Un seul fichier, images comprises ; s'ouvre dans un navigateur, Word ou LibreOffice.</small></span></button>` : ""}
      <button class="exp" data-x="raw">${svg("download")}<span><b>Fichier d'origine (${esc(path2ext(p))})</b><small>Le fichier tel qu'il est enregistré dans le dépôt.</small></span></button>
    </div><div class="msg"></div>`,
    foot: '<button class="btn" data-act="close">Fermer</button>',
    onMount(card) {
      $('[data-act="close"]', card).onclick = closeModal;
      for (const b of $$(".exp", card)) b.onclick = async () => {
        const x = b.dataset.x;
        if (x === "print") { closeModal(); printDoc(); return; }
        if (x === "raw") { closeModal(); const a = document.createElement("a"); a.href = rawUrl(p, true); a.download = fileName(p); document.body.appendChild(a); a.click(); a.remove(); return; }
        b.disabled = true;
        try { await exportHtml(p); closeModal(); } catch (e) { setMsg(card, e.message, "err"); b.disabled = false; }
      };
    },
  });
}
const path2ext = (p) => (/\.[^./]+$/.exec(p) || [".md"])[0];
$("#btnExport").onclick = openExport;

/* ============================================================================================
 * Liens, accueil, favoris, modèles, duplication, notifications, mentions
 * ========================================================================================== */
const foldName = (s) => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** Fenêtre « Lien » : un document du dépôt (recherche par nom) ou une adresse web. */
function openLinkDialog() {
  if (!S || !S.loaded || ED.readOnly) return;
  const { from, to } = ED.selection;
  const selected = ED.slice(from, to);
  let chosen = null;
  openModal({
    title: "Insérer un lien",
    body: `<div class="field"><label for="lkQ">Document ou adresse web</label>
        <input class="input" id="lkQ" placeholder="Nom d'un document, ou https://…" autocomplete="off" role="combobox" aria-controls="lkList" aria-expanded="true" /></div>
      <div class="lk-list" id="lkList" role="listbox" aria-label="Documents"></div>
      <div class="field"><label for="lkText">Texte du lien</label><input class="input" id="lkText" value="${esc(selected.split("\n")[0])}" /></div>
      <div class="msg"></div>`,
    foot: '<button class="btn" data-act="cancel">Annuler</button><button class="btn btn-primary" data-act="ok">Insérer</button>',
    onMount(card) {
      const q = $("#lkQ", card), list = $("#lkList", card), txt = $("#lkText", card);
      const isUrl = (v) => /^(https?:\/\/|mailto:|www\.)/i.test(v.trim());
      const draw = () => {
        const v = q.value.trim();
        if (isUrl(v)) { chosen = null; list.innerHTML = `<div class="sr-hint">Adresse web : ${esc(v)}</div>`; return; }
        const n = foldName(v);
        const hits = files.filter((p) => p !== S.path && (!n || foldName(p).includes(n))).slice(0, 40);
        if (chosen && !hits.includes(chosen)) chosen = null;
        if (!chosen && hits.length && n) chosen = hits[0];
        list.innerHTML = hits.map((p) => `<button class="lk${p === chosen ? " on" : ""}" role="option" aria-selected="${p === chosen}" data-p="${esc(p)}">${iconFor(p)}<span>${esc(displayName(p))}</span><small>${esc(dirName(p))}</small></button>`).join("")
          || '<div class="sr-hint">Aucun document de ce nom.</div>';
        for (const b of $$(".lk", list)) {
          b.onclick = () => { chosen = b.dataset.p; draw(); txt.focus(); };
          b.ondblclick = () => { chosen = b.dataset.p; insert(); };
        }
      };
      const insert = () => {
        const v = q.value.trim();
        let href, label = txt.value.trim();
        if (isUrl(v)) { href = /^www\./i.test(v) ? "https://" + v : v; label = label || v; }
        else if (chosen) { href = relLink(S.path, chosen); label = label || displayName(chosen); }
        else { setMsg(card, "Choisis un document dans la liste ou tape une adresse web.", "err"); return; }
        const image = chosen && kindOf(chosen) === "image" && !isUrl(v);
        const md = `${image ? "!" : ""}[${label.replace(/[[\]]/g, "\\$&")}](${href.replace(/ /g, "%20")})`;
        closeModal();
        ED.replaceRange(from, to, md);
      };
      q.addEventListener("input", draw);
      q.addEventListener("keydown", (e) => {
        const items = $$(".lk", list), i = items.findIndex((b) => b.dataset.p === chosen);
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const next = items[Math.max(0, Math.min(items.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
          if (next) { chosen = next.dataset.p; draw(); $(".lk.on", list) && $(".lk.on", list).scrollIntoView({ block: "nearest" }); }
        } else if (e.key === "Enter") { e.preventDefault(); insert(); }
      });
      txt.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); insert(); } });
      $('[data-act="cancel"]', card).onclick = closeModal;
      $('[data-act="ok"]', card).onclick = insert;
      if (selected && isUrl(selected)) q.value = selected;
      draw();
      q.focus();
    },
  });
}

/* ---- Favoris et documents récents (gardés dans ce navigateur, par compte) ---- */
const listKey = (k) => `ed-${k}:${me ? me.username : ""}`;
function loadList(k) { try { const v = JSON.parse(localStorage.getItem(listKey(k)) || "[]"); return Array.isArray(v) ? v : []; } catch (_e) { return []; } }
function saveList(k, v) { try { localStorage.setItem(listKey(k), JSON.stringify(v)); } catch (_e) {} }
function rememberRecent(p) {
  const l = loadList("recent").filter((x) => x.p !== p);
  l.unshift({ p, at: Date.now() });
  saveList("recent", l.slice(0, 30));
}
const isFav = (p) => loadList("fav").includes(p);
function toggleFav(p = currentPath()) {
  if (!p) return;
  const l = loadList("fav");
  saveList("fav", l.includes(p) ? l.filter((x) => x !== p) : [p, ...l]);
  updateFavButton();
  toast(isFav(p) ? "Ajouté aux favoris (page d'accueil)." : "Retiré des favoris.");
}
function updateFavButton() {
  const b = $("#btnFav"), p = currentPath();
  if (!b) return;
  b.hidden = !p;
  const on = !!p && isFav(p);
  b.classList.toggle("on", on);
  b.setAttribute("aria-pressed", String(on));
  b.title = on ? "Retirer des favoris" : "Ajouter aux favoris";
}
$("#btnFav").onclick = () => toggleFav();
$("#btnHome").onclick = () => { showEmpty(); $("#app").classList.remove("nav-open"); };

/* ---- Page d'accueil ---- */
async function renderHome() {
  const box = $("#empty");
  if (!box || !me) return;
  const exists = new Set(files);
  const item = (p, meta) => `<button class="home-item" data-p="${esc(p)}">${iconFor(p)}<span class="hi-name">${esc(displayName(p))}</span><span class="hi-meta">${meta || esc(dirName(p))}</span></button>`;
  const favs = loadList("fav").filter((p) => exists.has(p));
  const recents = loadList("recent").filter((x) => exists.has(x.p)).slice(0, 8);
  const hour = new Date().getHours();
  box.innerHTML = `<div class="home">
    <h2>${hour < 18 && hour >= 5 ? "Bonjour" : "Bonsoir"} ${esc((me.name || "").split(" ")[0])}</h2>
    <div class="home-actions">
      <button class="btn btn-primary" data-h="new">${svg("plus")}Nouveau document</button>
      <button class="btn" data-h="upload">${svg("upload")}Importer des fichiers</button>
      ${files.includes("README.md") ? `<button class="btn" data-h="readme">${svg("file")}Lire le README</button>` : ""}
    </div>
    <section><h3>${svg("star")}Favoris</h3>${favs.length ? `<div class="home-grid">${favs.map((p) => item(p)).join("")}</div>`
      : '<p class="muted-sm">Ajoute un document à tes favoris avec l\'étoile à côté de son nom, en haut.</p>'}</section>
    <section><h3>${svg("history")}Ouverts récemment</h3>${recents.length ? `<div class="home-grid">${recents.map((x) => item(x.p, esc(relTime(x.at)))).join("")}</div>`
      : '<p class="muted-sm">Les documents que tu ouvres apparaîtront ici.</p>'}</section>
    <section><h3>${svg("pencil")}Modifiés récemment</h3><div class="home-grid" id="homeRecent"><p class="muted-sm">Chargement…</p></div></section>
  </div>`;
  const wire = (root) => { for (const b of $$(".home-item", root)) b.onclick = () => openFile(b.dataset.p); };
  wire(box);
  $('[data-h="new"]', box).onclick = newDocument;
  $('[data-h="upload"]', box).onclick = () => $("#fileInput").click();
  const rb = $('[data-h="readme"]', box);
  if (rb) rb.onclick = () => openFile("README.md");
  try {
    const d = await api("GET", "/api/recent");
    const el = $("#homeRecent");
    if (!el) return;
    el.innerHTML = d.recent.length ? d.recent.map((r) => item(r.path, `${esc(relTime(r.at))}${r.by ? " · " + esc(r.by) : ""}`)).join("")
      : '<p class="muted-sm">Aucune modification récente.</p>';
    wire(el);
  } catch (_e) { const el = $("#homeRecent"); if (el) el.innerHTML = '<p class="muted-sm">Indisponible pour le moment.</p>'; }
}

/* ---- Modèles de document ---- */
const TEMPLATES = {
  blank: { label: "Document vide", hint: "Seulement le titre", text: null },
  meeting: { label: "Compte rendu de réunion", hint: "Participants, ordre du jour, décisions, actions",
    text: "# {{titre}}\n\n**Date :** {{date}}  \n**Participants :** \n\n## Ordre du jour\n\n1. \n\n## Échanges\n\n\n## Décisions\n\n- \n\n## Actions\n\n- [ ] Action — @qui — pour quand\n" },
  project: { label: "Note de projet", hint: "Contexte, objectifs, étapes, points ouverts",
    text: "# {{titre}}\n\n> Créé le {{date}}\n\n## Contexte\n\n\n## Objectifs\n\n- \n\n## Étapes\n\n| Étape | Responsable | Échéance | État |\n| --- | --- | --- | --- |\n|  |  |  |  |\n\n## Points ouverts\n\n- \n" },
  howto: { label: "Procédure", hint: "Prérequis et étapes numérotées",
    text: "# {{titre}}\n\n> Objectif : …\n\n## Prérequis\n\n- \n\n## Étapes\n\n1. \n2. \n3. \n\n## En cas de problème\n\n\n_Mise à jour : {{date}}_\n" },
  todo: { label: "Liste de tâches", hint: "À faire, en cours, terminé",
    text: "# {{titre}}\n\n## À faire\n\n- [ ] \n\n## En cours\n\n- [ ] \n\n## Terminé\n\n- [x] Créer la liste\n" },
};

/* ---- Dupliquer ---- */
function duplicateDocument() {
  if (!S || !S.loaded) return;
  const p = S.path, ext = path2ext(p), stem = p.slice(0, p.length - ext.length);
  openModal({
    title: "Dupliquer le document",
    subtitle: "Une copie du texte actuel (sans les commentaires ni l'historique).",
    body: `<div class="field"><label for="dupName">Nom de la copie</label><input class="input" id="dupName" value="${esc(stem + " (copie)")}" /></div><div class="msg"></div>`,
    foot: '<button class="btn" data-act="cancel">Annuler</button><button class="btn btn-primary" data-act="ok">Dupliquer</button>',
    onMount(card) {
      const input = $("#dupName", card);
      input.select();
      const go = async () => {
        const v = input.value.trim();
        if (!v) return input.focus();
        $('[data-act="ok"]', card).disabled = true;
        try {
          const d = await api("POST", "/api/create", { path: /\.[a-z0-9]{1,5}$/i.test(v) ? v : v + ext, content: ED.text });
          closeModal();
          await refreshTree();
          openFile(d.path);
          toast("Copie créée.");
        } catch (e) { setMsg(card, e.message, "err"); $('[data-act="ok"]', card).disabled = false; }
      };
      $('[data-act="ok"]', card).onclick = go;
      $('[data-act="cancel"]', card).onclick = closeModal;
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    },
  });
}
$("#btnDuplicate").onclick = duplicateDocument;

/* ---- Notifications : mentions « @identifiant » et réponses ---- */
let notifList = [];
async function loadNotifications() {
  try {
    const d = await api("GET", "/api/notifications");
    notifList = d.notifications;
    const b = $("#notifBadge");
    b.textContent = d.unread > 99 ? "99+" : String(d.unread);
    b.hidden = !d.unread;
    $("#btnNotif").title = d.unread ? `Notifications : ${d.unread} non lue${d.unread > 1 ? "s" : ""}` : "Notifications : mentions et réponses";
  } catch (_e) {}
}
function openNotifications() {
  openModal({
    title: "Notifications",
    subtitle: "Quand quelqu'un te cite (@" + esc(me.username) + ") dans un commentaire ou répond à une discussion où tu participes.",
    body: `<div class="notif-list">${notifList.length ? notifList.map((n) => `
      <button class="notif${n.read ? "" : " unread"}" data-id="${esc(n.id)}" data-p="${esc(n.path)}" data-cid="${esc(n.cid || "")}">
        ${svg(n.kind === "mention" ? "comment" : "history")}
        <span><b>${esc(n.by)}</b> ${n.kind === "mention" ? "t'a cité" : "a répondu"} dans <b>${esc(displayName(n.path))}</b>
          <small>« ${esc(n.text)} » · ${esc(relTime(n.at))}</small></span></button>`).join("")
      : '<p class="muted-sm">Aucune notification pour le moment.</p>'}</div>`,
    foot: `${notifList.some((n) => !n.read) ? '<button class="btn left" data-act="all">Tout marquer comme lu</button>' : ""}<button class="btn" data-act="close">Fermer</button>`,
    onMount(card) {
      $('[data-act="close"]', card).onclick = closeModal;
      const all = $('[data-act="all"]', card);
      if (all) all.onclick = async () => { await api("POST", "/api/notifications/read", {}).catch(() => {}); closeModal(); loadNotifications(); };
      for (const b of $$(".notif", card)) b.onclick = async () => {
        closeModal();
        api("POST", "/api/notifications/read", { ids: [b.dataset.id] }).then(loadNotifications).catch(() => {});
        if (!files.includes(b.dataset.p)) { toast("Ce document n'existe plus.", { error: true }); return; }
        openFile(b.dataset.p, { force: S && S.path === b.dataset.p, comment: b.dataset.cid || null });
      };
    },
  });
}
$("#btnNotif").onclick = openNotifications;

/* ---- Mentions dans les commentaires : « @ » propose les personnes ---- */
function mentionify(html) {
  return html.replace(/(^|[\s(>])@([a-z0-9][a-z0-9._-]{1,31})/gi, (m, pre, name) => {
    const p = people.get("u:" + name.toLowerCase());
    return p ? `${pre}<span class="mention" title="${esc(p.name)}">@${esc(name)}</span>` : m;
  });
}
let mentionPop = null;
function closeMentions() { if (mentionPop) { mentionPop.el.remove(); mentionPop = null; } }
document.addEventListener("input", (e) => {
  const ta = e.target;
  if (!(ta instanceof HTMLTextAreaElement) || !ta.closest(".c-card")) return;
  const before = ta.value.slice(0, ta.selectionStart);
  const m = /(^|\s)@([a-z0-9._-]{0,31})$/i.exec(before);
  if (!m) return closeMentions();
  const q = foldName(m[2]);
  const list = [...people.values()].filter((p) => p.username && (foldName(p.username).startsWith(q) || foldName(p.name).includes(q))).slice(0, 6);
  if (!list.length) return closeMentions();
  closeMentions();
  const el = document.createElement("div");
  el.className = "mention-pop";
  el.setAttribute("role", "listbox");
  el.innerHTML = list.map((p, i) => `<button role="option" data-u="${esc(p.username)}" class="${i === 0 ? "on" : ""}">${avatarHTML({ name: p.name, color: colorFor(p.username) })}<span>${esc(p.name)}</span><small>@${esc(p.username)}</small></button>`).join("");
  document.body.appendChild(el);
  const r = ta.getBoundingClientRect();
  el.style.left = Math.min(r.left, innerWidth - el.offsetWidth - 8) + "px";
  el.style.top = (r.bottom + 4 + el.offsetHeight > innerHeight ? r.top - el.offsetHeight - 4 : r.bottom + 4) + "px";
  mentionPop = { el, ta, start: ta.selectionStart - m[2].length - 1 };
  for (const b of $$("button", el)) {
    b.onmousedown = (ev) => ev.preventDefault();
    b.onclick = () => pickMention(b.dataset.u);
  }
});
function pickMention(username) {
  if (!mentionPop) return;
  const { ta, start } = mentionPop;
  const end = ta.selectionStart;
  ta.value = ta.value.slice(0, start) + "@" + username + " " + ta.value.slice(end);
  const caret = start + username.length + 2;
  ta.setSelectionRange(caret, caret);
  closeMentions();
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.focus();
}
document.addEventListener("keydown", (e) => {
  if (!mentionPop || e.target !== mentionPop.ta) return;
  const items = $$("button", mentionPop.el), i = items.findIndex((b) => b.classList.contains("on"));
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault(); e.stopPropagation();
    items[i].classList.remove("on");
    items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].classList.add("on");
  } else if (e.key === "Enter" || e.key === "Tab") {
    e.preventDefault(); e.stopPropagation();
    pickMention(items[Math.max(0, i)].dataset.u);
  } else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMentions(); }
}, true);
document.addEventListener("focusout", (e) => { if (mentionPop && e.target === mentionPop.ta) setTimeout(closeMentions, 150); });

/* ---- Aide raccourcis ---- */
function showShortcuts() {
  openModal({
    title: "Raccourcis clavier",
    body: `<table class="khelp">
      <tr><td>${svg("search")} ${kbd("Ctrl K")}</td><td>Rechercher un document / dans le contenu</td></tr>
      <tr><td>${svg("search")} ${kbd("Ctrl F")}</td><td>Rechercher et remplacer dans le document ouvert (${kbd("F3")} : suivant)</td></tr>
      <tr><td>${svg("link")} ${kbd("Ctrl L")}</td><td>Copier le lien du document ouvert</td></tr>
      <tr><td>${svg("check")} ${kbd("Ctrl S")}</td><td>Enregistrer maintenant</td></tr>
      <tr><td>${svg("comment")} ${kbd("Ctrl Alt M")}</td><td>Commenter le passage sélectionné</td></tr>
      <tr><td>${svg("pencil")} ${kbd("Ctrl Z")} / ${kbd("Ctrl Maj Z")}</td><td>Annuler / rétablir</td></tr>
      <tr><td>${kbd("Ctrl B")} / ${kbd("Ctrl I")} / ${kbd("Ctrl E")}</td><td>Gras / italique / code</td></tr>
      <tr><td>${kbd("Ctrl Maj 1")} à ${kbd("3")}</td><td>Titre 1, 2, 3</td></tr>
      <tr><td>${kbd("Ctrl Maj 7")} / ${kbd("8")} / ${kbd("9")}</td><td>Liste numérotée / à puces / à cocher</td></tr>
      <tr><td>${kbd("Ctrl")} + clic</td><td>Ouvrir un lien (sur écran tactile : toucher le lien, puis « Ouvrir »)</td></tr>
      <tr><td>${kbd("Échap")} puis ${kbd("Tab")}</td><td>Sortir de l'éditeur au clavier</td></tr>
      <tr><td>${kbd("F2")}</td><td>Renommer ou déplacer le document (ou la ligne choisie dans la liste)</td></tr>
      <tr><td>${kbd("↑")} ${kbd("↓")} ${kbd("←")} ${kbd("→")}</td><td>Parcourir la liste des documents (Entrée : ouvrir)</td></tr>
      <tr><td>${kbd("Tab")} / ${kbd("Maj Tab")}</td><td>Indenter / dé-indenter</td></tr>
      <tr><td>${kbd("?")}</td><td>Cette aide</td></tr>
    </table>`,
    foot: '<button class="btn" data-act="close">Fermer</button>',
    onMount(card) { $('[data-act="close"]', card).onclick = closeModal; },
  });
}
function kbd(t) { return `<span class="kbd">${esc(t)}</span>`; }

/* ---- Aller à une ligne dans le document ouvert ---- */
/** Curseur au début de la ligne n, amenée en haut de l'écran (plan, résultats de recherche). */
function goToLine(n) {
  if (!S || !S.loaded) return;
  const pos = ED.lineStart(n);
  ED.setSelection(pos, pos, "top"); ED.focus();
}

let restoringPath = null;
async function confirmRestore(p, sha) {
  openModal({
    title: "Revenir à cette version ?",
    subtitle: `<strong>${esc(fileName(p))}</strong> : le contenu actuel sera remplacé par cette version plus ancienne. Un enregistrement de restauration est créé à la fin de l\'historique (tu pourras toujours revenir en arrière).`,
    body: '<div class="msg"></div>',
    foot: '<button class="btn" data-act="cancel">Annuler</button><button class="btn btn-danger" data-act="ok">Restaurer</button>',
    onMount(card) {
      $('[data-act="cancel"]', card).onclick = closeModal;
      $('[data-act="ok"]', card).onclick = async () => {
        const btn = $('[data-act="ok"]', card); btn.disabled = true; btn.textContent = "Restauration…";
        restoringPath = p; // c'est moi qui restaure : pas d'annonce « par quelqu'un »
        setTimeout(() => { if (restoringPath === p) restoringPath = null; }, 5000);
        try {
          const r = await api("POST", "/api/restore", { path: p, sha });
          closeModal();
          toast("Document restauré à cette version.");
          // recharge la version live
          refreshTree();
          if (currentPath() === p && S) openFile(p, { force: true });
        } catch (e) { setMsg(card, e.message, "err"); btn.disabled = false; btn.textContent = "Restaurer"; }
      };
    },
  });
}

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
    else if (ED.readOnly) {
      const c = canComment(S.path);
      text = c ? "Lecture et commentaires" : "Lecture seule";
      title = c ? "Tu peux lire et commenter ce document (sélectionne un passage), mais pas le modifier." : "Tu peux lire ce document mais pas le modifier.";
    }
    else if (err) { text = "Échec de l'enregistrement"; tone = "err"; title = err; }
    else if (S.saving || S.dirty) { text = "Modifications en cours…"; tone = "busy"; }
    else { text = "Enregistré · " + relTime(S.savedSeen || Date.now()); tone = "ok"; }
    if (S.loaded && S.words != null) {
      const w = `${S.words.toLocaleString("fr-FR")} mot${S.words > 1 ? "s" : ""}`;
      title = (title || text) + " · " + w;
      text += " · " + w;
    }
  }
  el.textContent = text;
  el.dataset.tone = tone;
  el.title = title || text; // sur écran étroit, seule la pastille de couleur reste visible
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
  $("#btnMove").hidden = !(p && writable);
  $("#crumbs").classList.toggle("renamable", !!(S && S.loaded && writable));
  $("#btnAccess").hidden = !(isAdmin() && p);
  $("#btnAuthors").hidden = !(S && S.loaded && !S.offline);
  $("#btnHistory").hidden = !p;
  $("#btnExport").hidden = !p;
  $("#btnDuplicate").hidden = !(S && S.loaded && isEditable(S.path));
  updateFavButton();
  $("#btnCopyLink").hidden = !p;
  $("#btnComments").hidden = !(p && S && S.kind === "markdown");
  $("#btnToc").hidden = !(S && S.kind === "markdown");
  if ($("#btnToc").hidden) closeToc();
  updateFmtBar();
  if ($("#btnComments").hidden) closeComments();
}

/* ============================================================================================
 * Commentaires (façon Google Docs) : des fils ancrés sur un passage, en cartes dans la marge
 *  - le passage suit les modifications de tout le monde (plage décalée à chaque changement) ;
 *  - marge à droite du texte (éditeur ou aperçu) quand la place le permet, sinon panneau ;
 *  - bouton « + » à côté de la sélection (ou Ctrl+Alt+M), réponses, modification, résolution ;
 *  - mise à jour en direct : le serveur signale chaque changement dans le document partagé.
 * ========================================================================================== */
let commentsPath = null;        // document dont les commentaires sont chargés
let commentsList = [];          // fils du serveur ; _s/_e : plage dans le texte local (null : non ancré)
let activeCid = null;           // fil sélectionné
let draft = null;               // nouveau commentaire : { s, e, quote, text, top }
let cEditing = null;            // modification en cours : { id, replyId, text }
const replyDrafts = new Map();  // fil → réponse en cours de saisie
let panelTab = "open";          // panneau : « open » ou « resolved »
let commentsSeq = 0;
const RAIL_MIN_PANE = 760;      // largeur minimale du panneau de texte pour afficher la marge
const C_CTX = 40;

const rail = document.createElement("div");
rail.className = "c-rail";
const addBtn = document.createElement("button");
addBtn.type = "button";
addBtn.className = "c-add";
addBtn.title = "Ajouter un commentaire (Ctrl+Alt+M)";
addBtn.setAttribute("aria-label", "Commenter le passage sélectionné");
addBtn.innerHTML = `${svg("comment")}<b>+</b>`;
addBtn.hidden = true;

const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const linkify = (html) => html.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)»"']/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
function autoGrow(el) { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight + 2, 240) + "px"; }
const docText = () => (S ? ED.text : "");

/* ---- Ancrage (mêmes règles que src/comments.js côté serveur) ---- */
function cTail(a, b) { let n = 0; while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++; return n; }
function cHead(a, b) { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n; }
function locateQuote(text, c) {
  const q = c.quote || "";
  if (!q) return null;
  if (Number.isInteger(c.start) && text.slice(c.start, c.start + q.length) === q) return [c.start, c.start + q.length];
  let best = null, bestScore = -1, bestDist = Infinity;
  for (let i = text.indexOf(q), n = 0; i >= 0 && n < 500; i = text.indexOf(q, i + 1), n++) {
    const score = cTail(text.slice(Math.max(0, i - C_CTX), i), c.prefix || "") + cHead(text.slice(i + q.length, i + q.length + C_CTX), c.suffix || "");
    const dist = Math.abs(i - (c.start || 0));
    if (score > bestScore || (score === bestScore && dist < bestDist)) { best = i; bestScore = score; bestDist = dist; }
  }
  return best == null ? null : [best, best + q.length];
}
/** Position après un delta Yjs ; `before` : une insertion exactement à cette position passe avant. */
function shiftAt(pos, delta, before) {
  let idx = 0;
  for (const op of delta) {
    if (op.retain) idx += op.retain;
    else if (op.insert !== undefined) {
      const len = typeof op.insert === "string" ? op.insert.length : 1;
      if (idx < pos || (before && idx === pos)) pos += len;
      idx += len;
    } else if (op.delete && idx < pos) pos -= Math.min(op.delete, pos - idx);
  }
  return pos;
}
function anchorComment(c, text) {
  c._s = c._e = null;
  if (c.orphan || c.resolved) return;
  let at = locateQuote(text, c);
  // pas retrouvé tel quel : la plage tenue à jour par le serveur, si elle tombe dans le texte
  if (!at && c.end > c.start && c.end <= text.length) at = [c.start, c.end];
  if (at) { c._s = at[0]; c._e = at[1]; }
}
/** Le texte a changé : chaque passage commenté (et le brouillon) suit. */
function shiftComments(delta) {
  let lost = false;
  for (const c of commentsList) {
    if (c._s == null) continue;
    c._s = shiftAt(c._s, delta, true);
    c._e = shiftAt(c._e, delta, false);
    if (c._e <= c._s) { c._s = c._e = null; lost = true; } // passage supprimé
  }
  if (draft) {
    draft.s = shiftAt(draft.s, delta, true);
    draft.e = shiftAt(draft.e, delta, false);
    if (draft.e <= draft.s) { draft = null; lost = true; toast("Le passage que tu commentais a été supprimé."); }
  }
  if (lost) renderRail();
}
const openThreads = () => commentsList.filter((c) => !c.resolved && c._s != null).sort((a, b) => a._s - b._s);

/* ---- Surlignage dans l'éditeur (dessiné par drawOverlay) ---- */
function commentAnchors(len) {
  if (!S || S.kind !== "markdown") return [];
  const out = [];
  for (const c of commentsList) {
    if (c._s != null && !c.resolved && c._e <= len) out.push({ s: c._s, e: c._e, id: c.id, color: c.color || "#888", on: c.id === activeCid });
  }
  if (draft && draft.e <= len) out.push({ s: draft.s, e: draft.e, id: "draft", color: me.color, on: true });
  return out;
}
function afterOverlay() { layoutRail(); placeAddButton(); }

/* ---- Marge des commentaires ---- */
function panelOpen() { return !$("#commentsPanel").hidden; }
function railHost() {
  if (!S || !S.loaded || S.kind !== "markdown" || S.offline || panelOpen()) return null;
  return paneEditor.clientWidth >= RAIL_MIN_PANE ? paneEditor : null;
}
/** Focus dans la marge des commentaires : retrouvé après qu'elle est redessinée (réponse, résolution…). */
function captureFocus(box) {
  const el = document.activeElement;
  const card = el && box.contains(el) && el.closest(".c-card");
  if (!card) return null;
  return { f: el.dataset.f || null, c: el.dataset.c || null, cid: card.dataset.cid, idx: $$(".c-card", box).indexOf(card), a: el.selectionStart, b: el.selectionEnd };
}
function restoreFocus(box, k) {
  if (!k) return;
  const card = box.querySelector(`.c-card[data-cid="${CSS.escape(k.cid)}"]`);
  let el = card && k.f ? card.querySelector(`[data-f="${k.f}"]`) : null;
  if (!el && card && k.c) el = card.querySelector(`[data-c="${k.c}"]`);
  if (!el && card) el = card;
  if (!el) { const cards = $$(".c-card", box); el = cards[Math.min(k.idx, cards.length - 1)] || null; } // fil résolu ou supprimé : le suivant
  if (!el) return;
  el.focus({ preventScroll: true });
  if (k.f) { try { el.setSelectionRange(k.a, k.b); } catch (_e) {} }
}

function itemHTML(c, it, isRoot, canW) {
  const mine = !!me && it.author === `u:${me.username}`;
  const editingThis = cEditing && cEditing.id === c.id && cEditing.replyId === (isRoot ? null : it.id);
  const acts = [];
  if (isRoot && canW) acts.push(`<button class="icon-btn sm" data-c="${c.resolved ? "reopen" : "resolve"}" title="${c.resolved ? "Rouvrir la discussion" : "Marquer comme résolu et masquer"}">${svg(c.resolved ? "refresh" : "check")}</button>`);
  if (mine && canW && !editingThis) acts.push(`<button class="icon-btn sm" data-c="edit" title="Modifier">${svg("pencil")}</button>`);
  if ((mine || isAdmin()) && canW) acts.push(`<button class="icon-btn sm" data-c="del" title="${isRoot ? "Supprimer la discussion" : "Supprimer cette réponse"}">${svg("trash")}</button>`);
  const body = editingThis
    ? `<div class="c-form"><textarea class="input c-in" data-f="edit" rows="2">${esc(cEditing.text)}</textarea>
        <div class="c-btns"><button class="btn sm" data-c="cancel-edit">Annuler</button><button class="btn btn-primary sm" data-c="save-edit">Enregistrer</button></div></div>`
    : `<div class="c-text">${mentionify(linkify(esc(it.text)))}</div>`;
  const when = new Date(it.created).toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "short" });
  return `<div class="c-item" data-rid="${isRoot ? "" : esc(it.id)}">
    <div class="c-head">${avatarHTML({ name: it.authorName || "?", color: it.color || "#888" })}
      <div class="c-who"><b>${esc(it.authorName || "?")}</b><span title="${esc(when)}">${relTime(it.created)}${it.edited ? " · modifié" : ""}</span></div>
      <div class="c-acts">${acts.join("")}</div></div>${body}</div>`;
}
function cardHTML(c, inPanel) {
  const canW = canComment(commentsPath);
  const active = c.id === activeCid;
  const reps = c.replies || [];
  const showAll = active || inPanel;
  let html = "";
  if (inPanel) {
    const lost = !c.resolved && c._s == null;
    html += `<div class="c-quote">${lost ? '<span class="c-lost">Passage supprimé</span>' : ""}${esc(trunc(c.quote || "", 160))}</div>`;
  }
  html += itemHTML(c, c, true, canW);
  if (showAll) html += reps.map((r) => itemHTML(c, r, false, canW)).join("");
  else if (reps.length) html += `<div class="c-more">${reps.length} réponse${reps.length > 1 ? "s" : ""}</div>`;
  if (c.resolved) html += `<div class="c-resolved">${svg("check")}Résolu${c.resolvedBy ? " par " + esc(c.resolvedBy) : ""}</div>`;
  if (active && canW && !c.resolved && !cEditing) {
    const t = replyDrafts.get(c.id) || "";
    html += `<div class="c-reply"><textarea class="input c-in" data-f="reply" rows="1" placeholder="Répondre…">${esc(t)}</textarea>
      <div class="c-btns"${t.trim() ? "" : " hidden"}><button class="btn sm" data-c="cancel-reply">Annuler</button><button class="btn btn-primary sm" data-c="reply">Répondre</button></div></div>`;
  }
  const cls = ["c-card", active ? "active" : "", c.resolved ? "resolved" : "", inPanel ? "in-panel" : ""].filter(Boolean).join(" ");
  const label = `Commentaire de ${c.authorName || "?"}${reps.length ? `, ${reps.length} réponse${reps.length > 1 ? "s" : ""}` : ""}${c.resolved ? ", résolu" : ""}`;
  return `<div class="${cls}" data-cid="${esc(c.id)}" style="--cc:${safeColor(c.color)}" tabindex="0" role="article" aria-label="${esc(label)}">${html}</div>`;
}
function draftHTML(inPanel) {
  return `<div class="c-card draft active${inPanel ? " in-panel" : ""}" data-cid="draft" style="--cc:${esc(me.color)}">
    ${inPanel ? `<div class="c-quote">${esc(trunc(draft.quote, 160))}</div>` : ""}
    <div class="c-head">${avatarHTML({ name: me.name, color: me.color })}<div class="c-who"><b>${esc(me.name)}</b></div></div>
    <textarea class="input c-in" data-f="draft" rows="2" placeholder="Ajouter un commentaire…  (Entrée pour publier)">${esc(draft.text)}</textarea>
    <div class="c-btns"><button class="btn sm" data-c="cancel-draft">Annuler</button><button class="btn btn-primary sm" data-c="submit-draft"${draft.text.trim() ? "" : " disabled"}>Commenter</button></div>
  </div>`;
}

/** Reconstruit les cartes (marge et panneau) ; la position est calculée ensuite par layoutRail. */
function renderRail() {
  const host = railHost();
  const want = !!host && (openThreads().length > 0 || !!draft);
  const changed = area.classList.contains("has-rail") !== want;
  area.classList.toggle("has-rail", want);
  document.body.classList.toggle("rail-on", want); // le sommaire flottant s'efface devant les cartes
  if (!want) rail.remove();
  else {
    if (rail.parentNode !== host) host.appendChild(rail);
    const keep = captureFocus(rail);
    rail.innerHTML = (draft ? draftHTML(false) : "") + openThreads().map((c) => cardHTML(c, false)).join("");
    for (const t of $$("textarea", rail)) autoGrow(t);
    restoreFocus(rail, keep);
  }
  renderCommentsPanel();
  updateCommentsBadge();
  renderOverlay(); // → afterOverlay → layoutRail
}

/** Hauteur de chaque passage commenté, dans le contenu défilant de l'éditeur. */
function measureTops() {
  const out = new Map();
  const base = paneEditor.scrollTop - paneEditor.getBoundingClientRect().top;
  for (const c of openThreads()) out.set(c.id, ED.topAt(c._s) + base);
  if (draft) out.set("draft", ED.topAt(draft.s) + base);
  return out;
}
/** Place les cartes en face de leur passage, sans chevauchement ; la carte active est alignée exactement. */
function layoutRail() {
  const host = rail.parentNode;
  if (!host || !area.classList.contains("has-rail")) return;
  rail.style.left = edHost.offsetLeft + edHost.offsetWidth + 12 + "px";
  const tops = measureTops();
  const cards = $$(".c-card", rail).map((el) => ({ el, id: el.dataset.cid, want: tops.get(el.dataset.cid) }));
  for (const x of cards) x.el.style.display = x.want == null ? "none" : "";
  const placed = cards.filter((x) => x.want != null).sort((a, b) => a.want - b.want);
  if (!placed.length) return;
  for (const x of placed) x.h = x.el.offsetHeight;
  const GAP = 8;
  const k = Math.max(0, placed.findIndex((x) => x.id === (draft ? "draft" : activeCid)));
  placed[k].top = placed[k].want;
  for (let i = k + 1; i < placed.length; i++) placed[i].top = Math.max(placed[i].want, placed[i - 1].top + placed[i - 1].h + GAP);
  for (let i = k - 1; i >= 0; i--) placed[i].top = Math.min(placed[i].want, placed[i + 1].top - placed[i].h - GAP);
  if (placed[0].top < 8) { let t = 8; for (const x of placed) { x.top = Math.max(x.top, t); t = x.top + x.h + GAP; } }
  for (const x of placed) x.el.style.top = Math.round(x.top) + "px";
}

/* ---- Bouton « + » à côté de la sélection ---- */
function placeAddButton() {
  const sel = ED.selection;
  const ok = S && S.loaded && S.kind === "markdown" && !S.offline && !draft && canComment(S.path) && ED.hasFocus
    && !sel.empty && ED.slice(sel.from, sel.to).trim();
  if (!ok) { addBtn.hidden = true; return; }
  if (addBtn.parentNode !== paneEditor) paneEditor.appendChild(addBtn);
  addBtn.style.top = ED.topAt(sel.from) - paneEditor.getBoundingClientRect().top + paneEditor.scrollTop - 6 + "px";
  addBtn.style.left = edHost.offsetLeft + edHost.offsetWidth - 42 + "px";
  addBtn.hidden = false;
}
addBtn.addEventListener("mousedown", (e) => e.preventDefault()); // garde la sélection
addBtn.addEventListener("click", () => startDraft());

/* ---- Actions ---- */
function startDraft() {
  if (!S || !S.loaded || S.kind !== "markdown" || !canComment(S.path) || S.offline) return;
  let { from: s, to: e } = ED.selection;
  const v = docText();
  if (e <= s) { // pas de sélection : toute la ligne du curseur
    s = v.lastIndexOf("\n", s - 1) + 1;
    e = v.indexOf("\n", s); if (e < 0) e = v.length;
  }
  while (s < e && /\s/.test(v[s])) s++;
  while (e > s && /\s/.test(v[e - 1])) e--;
  if (e <= s) return toast("Sélectionne d'abord le passage à commenter.");
  draft = { s, e, quote: v.slice(s, e), text: "" };
  activeCid = null;
  addBtn.hidden = true;
  if (!railHost()) openComments(); else renderRail();
  requestAnimationFrame(() => { const t = $('.c-card.draft textarea'); if (t) t.focus(); });
}
function cancelDraft() { draft = null; renderRail(); ED.focus(); }
async function submitDraft() {
  if (!draft || !draft.text.trim() || draft.busy) return;
  const full = docText();
  const { s, e } = draft;
  draft.busy = true;
  try {
    const d = await api("POST", "/api/comments", {
      path: S.path, text: draft.text, quote: full.slice(s, e), start: s, color: me.color,
      prefix: full.slice(Math.max(0, s - C_CTX), s), suffix: full.slice(e, e + C_CTX),
    });
    draft = null;
    activeCid = d.comment.id;
    await loadComments();
  } catch (err) { if (draft) draft.busy = false; toast(err.message, { error: true }); }
}
async function commentApi(method, url, body) {
  try { await api(method, url, body); await loadComments(); return true; }
  catch (e) { toast(e.message, { error: true }); return false; }
}
async function sendReply(id) {
  const text = (replyDrafts.get(id) || "").trim();
  if (!text) return;
  replyDrafts.delete(id);
  if (!(await commentApi("POST", "/api/comments/reply", { path: commentsPath, id, text, color: me.color }))) replyDrafts.set(id, text);
}
async function saveEdit() {
  if (!cEditing || !cEditing.text.trim()) return;
  const { id, replyId, text } = cEditing;
  cEditing = null;
  await commentApi("PATCH", "/api/comments", { path: commentsPath, id, replyId, text });
}
async function setResolved(id, resolved) {
  if (resolved && activeCid === id) activeCid = null;
  if (await commentApi("POST", "/api/comments/resolve", { path: commentsPath, id, resolved })) {
    toast(resolved ? "Discussion résolue (visible dans le panneau Commentaires → Résolus)." : "Discussion rouverte.");
  }
}
async function deleteCommentItem(id, replyId) {
  if (!confirm(replyId ? "Supprimer cette réponse ?" : "Supprimer toute la discussion ?")) return;
  if (!replyId && activeCid === id) activeCid = null;
  await commentApi("DELETE", `/api/comments?path=${encodeURIComponent(commentsPath)}&id=${encodeURIComponent(id)}${replyId ? "&replyId=" + encodeURIComponent(replyId) : ""}`);
}

function activateComment(id, opts = {}) {
  if (activeCid !== id) { activeCid = id; cEditing = null; renderRail(); }
  if (opts.scroll) scrollToComment(id);
  if (panelOpen()) requestAnimationFrame(() => { const el = $(`#commentsList .c-card[data-cid="${id}"]`); if (el) el.scrollIntoView({ block: "nearest" }); });
}
function scrollToComment(id) {
  const c = commentsList.find((x) => x.id === id);
  if (!c || c._s == null) return;
  const top = ED.topAt(c._s) - paneEditor.getBoundingClientRect().top + paneEditor.scrollTop;
  paneEditor.scrollTo({ top: top - paneEditor.clientHeight / 3, behavior: "smooth" });
}
/** Curseur posé dans un passage commenté → son fil devient actif (comme Google Docs). */
function caretActivation(fromClick) {
  if (!S || !S.loaded || draft || !ED.hasFocus || !ED.selection.empty) return;
  const pos = ED.selection.head;
  let hit = null;
  for (const c of openThreads()) if (c._s <= pos && pos <= c._e && (!hit || c._e - c._s < hit._e - hit._s)) hit = c;
  const id = hit ? hit.id : null;
  if (id !== activeCid) { activeCid = id; cEditing = null; renderRail(); }
  if (hit && fromClick && !railHost()) { if (!panelOpen()) openComments(); activateComment(hit.id); }
}

/** Clics, saisie et touches dans les cartes (marge et panneau). */
function bindCards(box) {
  box.addEventListener("click", (e) => {
    const card = e.target.closest(".c-card");
    if (!card) return;
    const id = card.dataset.cid;
    const btn = e.target.closest("[data-c]");
    if (!btn) {
      if (id !== "draft" && !e.target.closest("textarea, a")) activateComment(id, { scroll: true });
      return;
    }
    const item = btn.closest(".c-item");
    const replyId = (item && item.dataset.rid) || null;
    const c = commentsList.find((x) => x.id === id);
    switch (btn.dataset.c) {
      case "submit-draft": submitDraft(); break;
      case "cancel-draft": cancelDraft(); break;
      case "reply": sendReply(id); break;
      case "cancel-reply": replyDrafts.delete(id); renderRail(); break;
      case "resolve": setResolved(id, true); break;
      case "reopen": setResolved(id, false); break;
      case "del": deleteCommentItem(id, replyId); break;
      case "edit": {
        const it = replyId ? c.replies.find((r) => r.id === replyId) : c;
        activeCid = id; cEditing = { id, replyId, text: it.text }; renderRail();
        requestAnimationFrame(() => { const t = $(`.c-card[data-cid="${id}"] [data-f="edit"]`); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } });
        break;
      }
      case "save-edit": saveEdit(); break;
      case "cancel-edit": cEditing = null; renderRail(); break;
    }
  });
  box.addEventListener("input", (e) => {
    const f = e.target.dataset.f;
    const card = e.target.closest(".c-card");
    if (!f || !card) return;
    if (f === "draft" && draft) { draft.text = e.target.value; $('[data-c="submit-draft"]', card).disabled = !draft.text.trim(); }
    else if (f === "reply") { replyDrafts.set(card.dataset.cid, e.target.value); $(".c-reply .c-btns", card).hidden = !e.target.value.trim(); }
    else if (f === "edit" && cEditing) cEditing.text = e.target.value;
    autoGrow(e.target);
    layoutRail();
  });
  box.addEventListener("keydown", (e) => {
    // carte sélectionnée au clavier : Entrée l'ouvre (réponses, actions) et place le curseur dans « Répondre »
    if (e.target.classList && e.target.classList.contains("c-card") && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      const id = e.target.dataset.cid;
      if (id === "draft") return;
      activateComment(id, { scroll: true });
      requestAnimationFrame(() => {
        const card = box.querySelector(`.c-card[data-cid="${id}"]`);
        const t = card && (card.querySelector('[data-f="reply"]') || card);
        if (t) t.focus();
      });
      return;
    }
    const f = e.target.dataset && e.target.dataset.f;
    if (!f) return;
    const id = e.target.closest(".c-card").dataset.cid;
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (f === "draft") submitDraft(); else if (f === "reply") sendReply(id); else saveEdit();
    } else if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation();
      if (f === "draft") cancelDraft();
      else if (f === "reply") { replyDrafts.delete(id); renderRail(); }
      else { cEditing = null; renderRail(); }
    }
  });
}
bindCards(rail);
bindCards($("#commentsList"));

/* ---- Chargement ---- */
async function loadComments() {
  const p = S && S.loaded && S.kind === "markdown" ? S.path : null;
  const seq = ++commentsSeq;
  if (!p) { commentsPath = null; commentsList = []; renderRail(); return; }
  let list;
  try { list = (await api("GET", "/api/comments?path=" + encodeURIComponent(p))).comments || []; }
  catch (_e) { return; }
  if (seq !== commentsSeq || !S || S.path !== p) return;
  commentsPath = p;
  const text = docText();
  for (const c of list) anchorComment(c, text);
  commentsList = list;
  if (activeCid && !list.some((c) => c.id === activeCid && !c.resolved)) activeCid = null;
  if (cEditing && !list.some((c) => c.id === cEditing.id)) cEditing = null;
  for (const id of [...replyDrafts.keys()]) if (!list.some((c) => c.id === id)) replyDrafts.delete(id);
  renderRail();
  // ouvert depuis une notification : la discussion est affichée
  if (S.wantComment) {
    const id = S.wantComment, c = list.find((x) => x.id === id);
    S.wantComment = null;
    if (c) {
      if (c.resolved) { panelTab = "done"; openComments(); }
      else if (!railHost() && !panelOpen()) openComments();
      activateComment(id, { scroll: true });
    }
  }
}
function resetComments() {
  commentsSeq++;
  commentsPath = null; commentsList = []; activeCid = null; draft = null; cEditing = null;
  replyDrafts.clear();
  rail.remove(); addBtn.hidden = true;
  area.classList.remove("has-rail");
  document.body.classList.remove("rail-on");
  updateCommentsBadge();
}

/* ---- Panneau « tous les commentaires » ---- */
function renderCommentsPanel() {
  const open = commentsList.filter((c) => !c.resolved), done = commentsList.filter((c) => c.resolved);
  $("#ccOpenN").textContent = open.length || "";
  $("#ccDoneN").textContent = done.length || "";
  for (const b of $$("#commentsPanel [data-tab]")) { b.classList.toggle("on", b.dataset.tab === panelTab); b.setAttribute("aria-selected", String(b.dataset.tab === panelTab)); }
  if (!panelOpen()) return;
  const wrap = $("#commentsList");
  const keep = captureFocus(wrap);
  // ouverts : dans l'ordre du texte, les passages supprimés à la fin ; résolus : les plus récents d'abord
  const list = panelTab === "open"
    ? open.sort((a, b) => (a._s == null) - (b._s == null) || (a._s || 0) - (b._s || 0) || a.created - b.created)
    : done.sort((a, b) => (b.resolvedAt || 0) - (a.resolvedAt || 0));
  let html = draft && panelTab === "open" && !railHost() ? draftHTML(true) : "";
  html += list.map((c) => cardHTML(c, true)).join("");
  if (!html) {
    html = panelTab === "open"
      ? `<p class="muted-sm">Aucun commentaire ouvert.${canComment(currentPath()) ? ` Sélectionne un passage du texte puis clique sur le bouton <b>+</b> qui apparaît à droite (ou ${kbd("Ctrl Alt M")}).` : ""}</p>`
      : `<p class="muted-sm">Aucune discussion résolue.</p>`;
  }
  wrap.innerHTML = html;
  for (const t of $$("textarea", wrap)) autoGrow(t);
  restoreFocus(wrap, keep);
}
function updateCommentsBadge() {
  const n = commentsList.filter((c) => !c.resolved).length;
  const b = $("#ccBadge");
  b.textContent = n > 99 ? "99+" : String(n);
  b.hidden = !n;
}
function openComments() {
  if (!S || !S.loaded) return;
  $("#commentsPanel").hidden = false;
  $("#btnComments").classList.add("on");
  if (draft) panelTab = "open";
  renderRail();
}
function closeComments() {
  if ($("#commentsPanel").hidden) return;
  $("#commentsPanel").hidden = true;
  $("#btnComments").classList.remove("on");
  if (S && S.loaded) renderRail();
}
function toggleComments() { panelOpen() ? closeComments() : openComments(); }
$("#btnComments").onclick = toggleComments;
$("#btnCommentsClose").onclick = closeComments;
for (const b of $$("#commentsPanel [data-tab]")) b.onclick = () => { panelTab = b.dataset.tab; renderCommentsPanel(); };

/* ============================================================================================
 * Actions
 * ========================================================================================== */
function newDocument() {
  const folder = currentFolder();
  openModal({
    title: "Nouveau document",
    subtitle: "Utilise « / » pour ranger dans un dossier. L'extension .md est ajoutée automatiquement (ou termine par .txt pour un texte brut).",
    body: `<div class="field"><label for="fPath">Nom</label><input class="input" id="fPath" placeholder="notes/compte-rendu" value="${esc(folder ? folder + "/" : "")}" /></div>
      <fieldset class="tpl-list"><legend>Modèle</legend>${Object.entries(TEMPLATES).map(([k, t], i) => `
        <label class="tpl"><input type="radio" name="tpl" value="${k}"${i === 0 ? " checked" : ""}><span><b>${esc(t.label)}</b><small>${esc(t.hint)}</small></span></label>`).join("")}</fieldset>
      <div class="msg"></div>`,
    foot: '<button class="btn" data-act="cancel">Annuler</button><button class="btn btn-primary" data-act="ok">Créer</button>',
    onMount(card) {
      const input = $("#fPath", card);
      input.setSelectionRange(input.value.length, input.value.length);
      const go = async () => {
        const v = input.value.trim().replace(/^\/+|\/+$/g, "");
        if (!v) return input.focus();
        $('[data-act="ok"]', card).disabled = true;
        try {
          const tpl = TEMPLATES[($('input[name="tpl"]:checked', card) || {}).value];
          const d = await api("POST", "/api/create", { path: v, ...(tpl && tpl.text && !/\.txt$/i.test(v) ? { content: tpl.text } : {}) });
          closeModal();
          await refreshTree();
          openFile(d.path, { focus: true }); // le curseur va directement dans le nouveau document
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
const LEVEL_LBL = { none: "Masqué", read: "Lecture seule", comment: "Lecture et commentaires", write: "Lecture et modification" };
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
  const tabs = [["users", "Utilisateurs", "users"], ["access", "Droits d'accès", "lock"], ["repo", "Dépôt", "branch"], ["internet", "Accès Internet", "globe"], ["backup", "Sauvegardes", "database"], ["update", "Mise à jour", "download"]];
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
        const render = { users: renderUsersTab, access: renderAccessTab, repo: renderRepoTab, internet: renderInternetTab, backup: renderBackupTab, update: renderUpdateTab }[k];
        render(box, o).catch((e) => { box.innerHTML = `<div class="msg err">${esc(e.message)}</div>`; });
      };
      for (const b of $$(".tabs button", card)) b.onclick = () => show(b.dataset.tab);
      const ub = $('.tabs [data-tab="update"]', card);
      if (ub && updateInfo && updateInfo.check && updateInfo.check.available) ub.classList.add("has-badge");
      show(tab, opts);
    },
  });
}

/* ---- Sauvegardes ---- */
const dlBackup = (name) => {
  const a = document.createElement("a");
  a.href = `/api/admin/backups/download?name=${encodeURIComponent(name)}`;
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
};
async function renderBackupTab(box) {
  const d = await api("GET", "/api/admin/backups");
  if (!tabAlive(box, "backup")) return;
  const when = (ts) => new Date(ts).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
  const last = d.list[0];
  box.innerHTML = `
    <p class="muted-sm">Une sauvegarde contient tout ce qui n'est pas dans le dépôt GitHub : comptes, droits d'accès,
      commentaires, « qui a écrit quoi », réglages${d.mode === "local" ? "" : ""} et, en dépôt local, les documents eux-mêmes
      avec leur historique. <strong>Elle contient aussi le jeton GitHub et les empreintes des mots de passe : range-la en lieu sûr.</strong></p>
    <div class="card"><span class="tdot ${last && Date.now() - last.date < 26 * 3600 * 1000 ? "t-ok" : "t-busy"}"></span>
      <div style="flex:1;min-width:0"><div class="t">${last ? `Dernière sauvegarde : ${esc(when(last.date))}` : "Aucune sauvegarde pour l'instant"}</div>
      <div class="s">${d.list.length} sauvegarde${d.list.length > 1 ? "s" : ""} gardée${d.list.length > 1 ? "s" : ""} sur le serveur (${esc(d.dir)})</div></div>
      <button class="btn btn-primary" data-act="now" ${d.running ? "disabled" : ""}>${svg("download")}Sauvegarder et télécharger</button></div>
    ${d.lastError ? `<div class="msg err">Dernier échec : ${esc(d.lastError)}</div>` : ""}
    <label class="check-row"><input type="checkbox" data-act="auto" ${d.auto ? "checked" : ""}>
      <span>Sauvegarde automatique chaque jour, en gardant les
      <input class="input input-sm" type="number" min="1" max="90" data-act="keep" value="${esc(d.keep)}"> dernières</span></label>
    <div class="note">Pour ne rien perdre si le serveur lui-même disparaît, télécharge de temps en temps une sauvegarde
      ailleurs (ou sauvegarde le conteneur avec Proxmox). <strong>Restaurer</strong> : arrêter Easydoc, puis
      <code>tar -xzf easydoc-….tar.gz -C ${esc(d.dir.replace(/[\\/]backups$/, ""))}</code> et relancer Easydoc.</div>
    <div class="msg"></div>
    <ul class="backup-list">${d.list.map((b) => `<li><span>${esc(b.name)}</span><span class="muted-sm">${esc(when(b.date))} · ${fmtSize(b.size)}</span>
      <button class="icon-btn sm" data-dl="${esc(b.name)}" title="Télécharger">${svg("download")}</button>
      <button class="icon-btn sm" data-del="${esc(b.name)}" title="Supprimer">${svg("trash")}</button></li>`).join("")}</ul>`;
  $('[data-act="now"]', box).onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.innerHTML = `${svg("refresh")}Sauvegarde en cours…`;
    try {
      const r = await api("POST", "/api/admin/backups");
      dlBackup(r.name);
      toast(`Sauvegarde créée : ${r.files} fichiers, ${fmtSize(r.bytes)}.`);
    } catch (err) { toast(err.message, { error: true }); }
    if (tabAlive(box, "backup")) renderBackupTab(box);
  };
  const saveSettings = async () => {
    const keep = Number($('[data-act="keep"]', box).value);
    try { await api("PUT", "/api/admin/backups", { auto: $('[data-act="auto"]', box).checked, keep }); toast("Réglage enregistré."); }
    catch (err) { setMsg(box, err.message, "err"); }
    if (tabAlive(box, "backup")) renderBackupTab(box);
  };
  $('[data-act="auto"]', box).onchange = saveSettings;
  $('[data-act="keep"]', box).onchange = saveSettings;
  for (const b of $$("[data-dl]", box)) b.onclick = () => dlBackup(b.dataset.dl);
  for (const b of $$("[data-del]", box)) b.onclick = async () => {
    if (!confirm(`Supprimer la sauvegarde ${b.dataset.del} ?`)) return;
    await api("DELETE", `/api/admin/backups?name=${encodeURIComponent(b.dataset.del)}`).catch((err) => toast(err.message, { error: true }));
    renderBackupTab(box);
  };
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
    ${d.last && !d.last.ok && !d.last.pending && d.last.error ? `<div class="msg err">${esc(d.last.error)} (${esc(when(d.last.at))})</div>` : ""}
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
/* ---- Renommer / déplacer un document ou un dossier ---- */
const ROOT_LABEL = "(racine du dépôt)";
/** Fenêtre « Renommer ou déplacer » pour un document (ou fichier) ou un dossier de la liste. */
function openMoveDialog(target) {
  const p = target || currentPath();
  if (!p) return;
  const isFolder = !files.includes(p) && files.some((f) => f.startsWith(p + "/"));
  if (!isFolder && !canWrite(p)) return toast("Tu n'as pas le droit de modifier ce fichier.", { error: true });
  const ext = isFolder ? "" : (fileName(p).match(/\.[^.]+$/) || [""])[0];
  const name = isFolder ? fileName(p) : fileName(p).slice(0, fileName(p).length - ext.length);
  const parent = dirName(p);
  // dossiers possibles : tous, sauf le dossier déplacé lui-même et ce qu'il contient
  const folders = allFolders().filter((f) => !isFolder || (f !== p && !f.startsWith(p + "/")));
  const opt = (v, label) => `<option value="${esc(v)}"${v === parent ? " selected" : ""}>${esc(label)}</option>`;
  openModal({
    title: isFolder ? "Renommer ou déplacer le dossier" : "Renommer ou déplacer",
    subtitle: `<strong>${esc(p)}</strong>${isFolder ? ` · ${files.filter((f) => f.startsWith(p + "/")).length} fichier(s)` : ""}`,
    body: `<div class="msg"></div>
      <label class="field"><span>Nom</span>
        <span class="mv-name"><input class="input" id="mvName" value="${esc(name)}" autocomplete="off" spellcheck="false">${ext ? `<span class="mv-ext">${esc(ext)}</span>` : ""}</span></label>
      <label class="field"><span>Dossier</span>
        <select class="input" id="mvDir">${opt("", ROOT_LABEL)}${folders.map((f) => opt(f, f)).join("")}<option value="__new">Nouveau dossier…</option></select></label>
      <label class="field" id="mvNewWrap" hidden><span>Nouveau dossier (ex. <code>projets/2026</code>)</span>
        <input class="input" id="mvNew" autocomplete="off" spellcheck="false"></label>
      <p class="muted-sm">${isFolder ? "Tous les fichiers du dossier le suivent." : "Les commentaires, les auteurs et les droits d'accès suivent le document."}
        Les participants qui l'ont ouvert passent automatiquement au nouveau nom.</p>`,
    foot: '<button class="btn" data-act="cancel">Annuler</button><button class="btn btn-primary" data-act="ok">Renommer / déplacer</button>',
    onMount(card) {
      const nameEl = $("#mvName", card), dirEl = $("#mvDir", card), newEl = $("#mvNew", card);
      dirEl.onchange = () => { $("#mvNewWrap", card).hidden = dirEl.value !== "__new"; if (dirEl.value === "__new") newEl.focus(); };
      $('[data-act="cancel"]', card).onclick = closeModal;
      const go = async () => {
        const n = cleanName(nameEl.value.trim());
        if (!n) return setMsg(card, "Donne un nom.", "err");
        const dir = dirEl.value === "__new" ? newEl.value.trim().replace(/^\/+|\/+$/g, "") : dirEl.value;
        if (dirEl.value === "__new" && !dir) return setMsg(card, "Indique le nom du nouveau dossier.", "err");
        const to = (dir ? dir + "/" : "") + n + ext;
        const btn = $('[data-act="ok"]', card);
        btn.disabled = true; btn.textContent = "Déplacement…";
        try {
          const d = await api("POST", "/api/move", { from: p, to });
          closeModal();
          if (!d.moved) return;
          await refreshTree();
          // document ou dossier affiché : on suit (les autres participants suivent aussi, prévenus par le serveur)
          const cur = currentPath();
          if (cur === p) openFile(d.path);
          else if (cur && cur.startsWith(p + "/")) openFile(d.path + cur.slice(p.length));
          if (isFolder && closed.has(p)) { closed.delete(p); closed.add(d.path); localStorage.setItem("ed-closed", JSON.stringify([...closed])); }
          toast(`${isFolder ? "Dossier" : fileName(p) === fileName(d.path) ? "Déplacé" : "Renommé"} : ${d.path}`);
        } catch (e) { setMsg(card, e.message, "err"); btn.disabled = false; btn.textContent = "Renommer / déplacer"; }
      };
      $('[data-act="ok"]', card).onclick = go;
      for (const el of [nameEl, newEl]) el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } });
      setTimeout(() => { nameEl.focus(); nameEl.select(); }, 40);
    },
  });
}
$("#btnMove").onclick = () => openMoveDialog();
// clic sur le titre du document (comme dans Google Docs)
$("#crumbs").addEventListener("click", (e) => { if (e.target.closest(".cur") && S && canWrite(S.path)) openMoveDialog(); });
// liste des documents : clic droit sur une ligne
$("#tree").addEventListener("contextmenu", (e) => {
  const row = e.target.closest && e.target.closest(".node");
  if (!row) return;
  e.preventDefault();
  openMoveDialog(row.dataset.path || row.dataset.dir);
});


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

/* ---- Menu « ⋯ » : actions secondaires de la barre d'outils quand la place manque ---- */
const MORE_LABELS = {
  btnCopyLink: "Copier le lien", btnToc: "Plan du document", btnAuthors: "Qui a écrit quoi",
  btnHistory: "Historique", btnExport: "Exporter / imprimer", btnDuplicate: "Dupliquer", btnMove: "Renommer / déplacer", btnAccess: "Droits d'accès", btnSync: "Récupérer les modifications", btnDelete: "Supprimer le document",
};
let moreMenu = null;
function closeMoreMenu() {
  if (!moreMenu) return;
  moreMenu.remove(); moreMenu = null;
  $("#btnMore").setAttribute("aria-expanded", "false");
  document.removeEventListener("pointerdown", onMoreOutside, true);
}
function onMoreOutside(e) { if (moreMenu && !moreMenu.contains(e.target) && !e.target.closest("#btnMore")) closeMoreMenu(); }
function openMoreMenu() {
  // les boutons repliés dans le menu, dans leur état actuel (cachés, désactivés, activés)
  const items = $$(".topbar .tb-more-item").filter((b) => !b.hidden && b.style.display !== "none");
  if (!items.length) return;
  moreMenu = document.createElement("div");
  moreMenu.className = "tb-menu";
  moreMenu.setAttribute("role", "menu");
  moreMenu.innerHTML = items.map((b) => {
    const on = b.getAttribute("aria-pressed") === "true" || b.classList.contains("on");
    return `<button role="menuitem" data-for="${b.id}"${b.disabled ? " disabled" : ""}${b.id === "btnDelete" ? ' class="danger"' : ""}>${b.querySelector("svg").outerHTML}<span>${esc(MORE_LABELS[b.id] || b.title)}</span>${on ? svg("check", "tick") : ""}</button>`;
  }).join("");
  document.body.appendChild(moreMenu);
  const r = $("#btnMore").getBoundingClientRect();
  moreMenu.style.top = r.bottom + 6 + "px";
  moreMenu.style.right = Math.max(8, innerWidth - r.right) + "px";
  $("#btnMore").setAttribute("aria-expanded", "true");
  for (const it of $$("button", moreMenu)) it.onclick = () => {
    const b = $("#" + it.dataset.for);
    closeMoreMenu();
    $("#btnMore").focus(); // la fenêtre éventuellement ouverte rendra le focus à « ⋯ »
    if (b && !b.disabled) b.click();
  };
  document.addEventListener("pointerdown", onMoreOutside, true);
  const first = $("button:not([disabled])", moreMenu);
  if (first) first.focus();
}
$("#btnMore").onclick = () => (moreMenu ? closeMoreMenu() : openMoreMenu());
window.addEventListener("keydown", (e) => {
  if (!moreMenu) return;
  if (e.key === "Escape") { closeMoreMenu(); $("#btnMore").focus(); }
  else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const list = $$("button:not([disabled])", moreMenu);
    const k = list.indexOf(document.activeElement);
    const next = list[(k + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length];
    if (next) next.focus();
  }
});
window.addEventListener("resize", closeMoreMenu);
$("#scrim").onclick = () => $("#app").classList.remove("nav-open");
$("#search").addEventListener("input", renderTree);
$("#skipToDoc").addEventListener("click", (e) => {
  e.preventDefault();
  if (S && S.loaded) ED.focus(); else { const r = $("#tree .node"); if (r) r.focus(); }
});
$("#search").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") {
    // d'abord les résultats dans le contenu, puis la liste des documents
    const r = (!srBox.hidden && $(".sr", srBox)) || $('#tree .node[tabindex="0"]') || $("#tree .node");
    if (r) { e.preventDefault(); r.focus(); }
  }
  if (e.key === "Enter") { const first = $("#tree .node.file"); if (first) first.click(); }
  if (e.key === "Escape") { e.target.value = ""; renderTree(); e.target.blur(); }
});
window.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); saveNow(true); }
  if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); $("#search").focus(); $("#search").select(); }
  if (mod && e.key.toLowerCase() === "l") { e.preventDefault(); copyLink(); }
  if (mod && e.altKey && e.key.toLowerCase() === "m") { e.preventDefault(); startDraft(); }
  if (e.key === "F2" && !e.defaultPrevented && !(e.target.closest && e.target.closest("#tree, .modal")) && currentPath() && canWrite(currentPath())) { e.preventDefault(); openMoveDialog(); }
  // Ctrl+F hors de l'éditeur : recherche dans le document ouvert (celle du navigateur ne voit que l'écran)
  if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f" && !e.defaultPrevented && S && S.loaded && !moreMenu
    && !(e.target.closest && e.target.closest("input, textarea, select, .modal"))) { e.preventDefault(); ED.openSearch(); }
  const typing = e.target.closest && e.target.closest("input, textarea, select, [contenteditable]");
  if (e.key === "?" && !typing) { e.preventDefault(); showShortcuts(); }
});
// Fermer l'onglet alors que des modifications ne sont pas arrivées au serveur : le navigateur demande confirmation
window.addEventListener("beforeunload", (e) => {
  const s = S;
  if (!s || !s.loaded || ED.readOnly) return;
  const unsent = s.offline ? s.dirty || s.saving : (s.reconnecting || !s.connected) && ED.text !== (s.reconnectBase ?? s.confirmedText);
  if (unsent) { e.preventDefault(); e.returnValue = ""; }
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
  // sans document demandé : la page d'accueil (favoris, récents) ; à la toute première visite, le README
  const firstVisit = !loadList("recent").length && !loadList("fav").length;
  const target = (wanted && files.includes(wanted) && wanted) || (firstVisit && files.includes("README.md") && "README.md");
  if (target) openFile(target); else showEmpty();
  loadNotifications();
  updateButtons();
})();
