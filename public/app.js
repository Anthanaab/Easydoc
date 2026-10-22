// Easydoc — client (temps réel Yjs ↔ éditeur, synchro GitHub, aperçu Markdown).
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { Marked } from "marked";
import DOMPurify from "dompurify";

const marked = new Marked();
marked.setOptions({ breaks: true, gfm: true });

const $ = (s) => document.querySelector(s);
const ta = $("#editor-ta");
const caretLayer = $("#caret-layer");
// Erreurs JS visibles (utile pour diagnostiquer à distance)
window.addEventListener("error", (ev) => { try { toast("Erreur : " + (ev.message || "inconnue"), true); } catch (_e) {} });
const toast = (msg, err = false) => {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", err);
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 2600);
};

// --- Identité (persistée dans le navigateur) ---
function myName() {
  let n = localStorage.getItem("gv-name");
  if (!n) { n = prompt("Comment veux-tu t'appeler ici ?", "Joueur"); localStorage.setItem("gv-name", n || "Joueur"); }
  return n || "Joueur";
}
function colorFor(n) {
  let h = 0; for (const c of n) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 70% 60%)`;
}
const ME = { name: myName(), color: colorFor(myName()) };

let ydoc = null, provider = null, currentPath = null, previewVisible = false, files = [];
let undoManager = null;
const wsUrl = `ws${location.protocol === "https:" ? "s" : ""}://${location.host}/`;

// ----- Arborescence -----
async function refreshTree() {
  try {
    const r = await fetch("/api/files");
    const { files: list } = await r.json();
    files = list.filter((f) => String(f.path).toLowerCase().endsWith(".md"));
    renderTree();
  } catch (e) { toast("Impossible de lire le dépôt: " + e.message, true); }
}
function renderTree() {
  const tree = $("#tree");
  tree.innerHTML = "";
  const groups = {};
  for (const f of files) {
    const parts = f.path.split("/");
    const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : "/";
    (groups[dir] = groups[dir] || []).push(f);
  }
  for (const dir of Object.keys(groups).sort()) {
    const d = document.createElement("div");
    d.className = "folder";
    d.textContent = dir === "/" ? "📄 Racine" : `📁 ${dir}`;
    tree.appendChild(d);
    groups[dir].sort((a, b) => a.path.localeCompare(b.path)).forEach((f) => {
      const el = document.createElement("div");
      el.className = "file" + (f.path === currentPath ? " active" : "");
      const dot = document.createElement("span");
      dot.className = "dot"; dot.style.background = colorFor(f.path);
      el.appendChild(dot);
      const name = document.createElement("span");
      name.textContent = f.path.split("/").pop();
      el.appendChild(name); el.title = f.path;
      el.onclick = () => openFile(f.path);
      tree.appendChild(el);
    });
  }
}

// ----- Synchronisation temps réel Yjs ↔ textarea -----
let ignoreYtext = false;

// Applique le texte local (textarea) dans le Y.Text avec un diff précis,
// pour ne pas écraser les insertions simultanées des autres clients.
function applyLocalValue(newValue) {
  if (!ydoc) return;
  const ytext = ydoc.getText("content");
  const cur = ytext.toString();
  if (newValue === cur) return;
  let start = 0;
  const max = Math.min(cur.length, newValue.length);
  while (start < max && cur[start] === newValue[start]) start++;
  let eCur = cur.length, eNew = newValue.length;
  while (eCur > start && eNew > start && cur[eCur - 1] === newValue[eNew - 1]) { eCur--; eNew--; }
  ignoreYtext = true;
  ytext.doc.transact(() => {
    ytext.delete(start, eCur - start);
    ytext.insert(start, newValue.slice(start, eNew));
  });
  ignoreYtext = false;
}

function bindYtext() {
  const ytext = ydoc.getText("content");
  undoManager = new Y.UndoManager(ytext);
  ytext.observe(() => {
    if (ignoreYtext) return;
    const val = ytext.toString();
    if (ta.value !== val) ta.value = val; // une édition distante a modifié le doc
  });
}
ta.addEventListener("input", () => applyLocalValue(ta.value));
ta.addEventListener("keydown", (e) => {
  if (!undoManager || !ydoc) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) undoManager.redo(); else undoManager.undo();
  }
  if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y")) { e.preventDefault(); undoManager.redo(); }
});

// ----- Présence + curseurs distants -----
const CHAR_W = measureWidth();
function measureWidth() {
  try {
    const c = document.createElement("canvas").getContext("2d");
    c.font = '14px ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace';
    return c.measureText("M").width;
  } catch (e) { return 8.4; }
}
function posFromIndex(index) {
  const text = ta.value.slice(0, index);
  const nl = text.lastIndexOf("\n");
  return { line: text.split("\n").length - 1, col: index - (nl + 1) };
}
function renderRemote() {
  const nodes = [];
  if (provider) {
    provider.awareness.getStates().forEach((state, id) => {
      if (id === ydoc.clientID) return;
      const user = state.user, cursor = state.cursor;
      if (!user || !user.name) return;
      if (cursor && cursor.anchor && ydoc) {
        try {
          const rp = Y.createRelativePositionFromJSON(JSON.parse(cursor.anchor));
          const abs = Y.createAbsolutePositionFromRelativePosition(rp, ydoc);
          const index = abs ? abs.index : 0;
          const { line, col } = posFromIndex(index);
          const el = document.createElement("div");
          el.className = "rcaret";
          el.style.left = `${20 + col * CHAR_W}px`;
          el.style.top = `${14 + line * 22.4}px`;
          el.style.background = user.color || "#f78166";
          el.dataset.name = user.name;
          nodes.push(el);
        } catch (_e) {}
      }
    });
  }
  caretLayer.innerHTML = "";
  nodes.forEach((n) => caretLayer.appendChild(n));
  const u = $("#users");
  const names = [];
  if (provider) provider.awareness.getStates().forEach((s) => {
    if (s.user && s.user.name) names.push(`<span style="color:${s.user.color || "#fff"}">●</span>${s.user.name}`);
  });
  u.innerHTML = names.join(" ");
}

// ----- Aperçu Markdown -----
function renderPreview(md) {
  const p = $("#preview");
  try { p.innerHTML = DOMPurify.sanitize(marked.parse(md)); }
  catch (e) { p.textContent = md; }
}
let previewT = null;
function schedulePreview() {
  clearTimeout(previewT);
  previewT = setTimeout(() => { if (previewVisible && ydoc) renderPreview(ydoc.getText("content").toJSON()); }, 250);
}

// ----- Sauvegarde / publication -----
let autosaveT = null;
function scheduleAutosave() {
  if (!currentPath) return;
  clearTimeout(autosaveT);
  autosaveT = setTimeout(() => saveDoc(false), 1500);
}
function saveDoc(manual) {
  if (!ydoc || !currentPath) return;
  const content = ydoc.getText("content").toJSON();
  $("#btnSave").textContent = "💾 …";
  fetch("/api/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: currentPath, content, author: ME.name }),
  }).then((r) => r.json()).then((d) => {
    $("#btnSave").textContent = "💾 Publier";
    if (d.ok) { if (manual) toast("Doc publié sur le dépôt ✅"); }
    else toast("Échec publication: " + (d.error || "?"), true);
  }).catch(() => { $("#btnSave").textContent = "💾 Publier"; toast("Échec réseau", true); });
}

// ----- Ouverture d'un document -----
function closeDoc() {
  if (provider) { try { provider.destroy(); } catch (_e) {} provider = null; }
  if (ydoc) { try { ydoc.destroy(); } catch (_e) {} ydoc = null; }
  undoManager = null;
  ta.value = "";
  caretLayer.innerHTML = "";
}
async function openFile(path) {
  closeDoc();
  currentPath = path;
  renderTree();
  previewVisible = false;
  $("#preview").classList.add("hidden");
  $("#conn").textContent = "⏳ synchronisation…";

  ydoc = new Y.Doc();
  provider = new WebsocketProvider(wsUrl, path, ydoc, { connect: true });
  provider.on("status", (e) => {
    const c = $("#conn");
    c.textContent = e.status === "connected" ? "🟢 temps réel actif" : "⚪ hors ligne";
    c.classList.toggle("on", e.status === "connected");
  });
  provider.awareness.setLocalStateField("user", ME);

  bindYtext();
  ydoc.on("update", () => { scheduleAutosave(); schedulePreview(); renderRemote(); });
  provider.awareness.on("change", renderRemote);

  // publie la position du curseur local pour les autres clients
  const publishCursor = () => {
    if (!ydoc || !provider || document.activeElement !== ta) return;
    try {
      const rp = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ydoc.getText("content"), ta.selectionStart));
      provider.awareness.setLocalStateField("cursor", { anchor: JSON.stringify(rp), head: JSON.stringify(rp) });
    } catch (_e) {}
  };
  ta.addEventListener("input", publishCursor);
  ta.addEventListener("select", publishCursor);
  ta.addEventListener("keyup", publishCursor);
  ta.addEventListener("click", publishCursor);
  renderRemote();

  // Repli : si le temps réel (WebSocket) ne connecte pas — reverse proxy sans relais
  // WS, NAT, pare-feu… — le document s'ouvre quand même via HTTP (l'éditeur et la
  // publication restent utilisables ; la synchro live reprend si le WS s'établit).
  setTimeout(async () => {
    try {
      if (!ydoc || currentPath !== path) return;
      if (provider.wsconnected) return; // temps réel OK, rien à faire
      const ytext = ydoc.getText("content");
      if (ytext.length > 0) return;
      const r = await fetch("/api/file?path=" + encodeURIComponent(path));
      const d = await r.json();
      if (d.exists && !provider.wsconnected && ydoc.getText("content").length === 0) {
        ydoc.transact(() => ydoc.getText("content").insert(0, d.content));
        $("#conn").textContent = "⚪ temps réel indisponible — doc ouvert via HTTP (éditable + publiable)";
      }
    } catch (_e) {}
  }, 1200);
}

// ----- Wire-up -----
$("#btnPull").onclick = () => {
  if (!provider) return toast("Ouvre un document d'abord");
  fetch("/api/pull", { method: "POST" }).then((r) => r.json()).then((d) => {
    toast(d.ok ? `Dépôt synchronisé (${d.reloaded} docs rechargés).` : "Sync: " + (d.error || "erreur"), !d.ok);
  }).catch((e) => toast("Sync: " + e.message, true));
};
$("#btnSave").onclick = () => { if (ydoc) { applyLocalValue(ta.value); saveDoc(true); } else toast("Ouvre un document d'abord"); };
$("#btnPreview").onclick = () => {
  previewVisible = !previewVisible;
  $("#preview").classList.toggle("hidden", !previewVisible);
  if (previewVisible && ydoc) renderPreview(ydoc.getText("content").toJSON());
};
$("#btnNew").onclick = () => $("#newbox").classList.toggle("hidden");
$("#btnNewGo").onclick = async () => {
  const p = $("#newpath").value.trim();
  if (!p) return;
  const r = await fetch("/api/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: p }) });
  const d = await r.json();
  if (d.ok) { $("#newbox").classList.add("hidden"); $("#newpath").value = ""; await refreshTree(); openFile(d.path); }
  else toast(d.error || "création impossible", true);
};
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    if (!ydoc) return;
    applyLocalValue(ta.value);
    saveDoc(true);
  }
});

// ----- Fenêtre de réglages : connecter / changer de dépôt -----------------------------
const modal = $("#settingsModal");
const setInfo = $("#setInfo");
function setInfoMsg(msg, ok) {
  setInfo.textContent = msg;
  setInfo.className = "set-info " + (ok ? "ok" : "err");
}
function ghModeSelected() {
  const gh = document.querySelector('input[name="setmode"]:checked').value === "github";
  $("#ghFields").classList.toggle("hidden", !gh);
  $("#localFields").classList.toggle("hidden", gh);
}
async function loadSettingsForm() {
  try {
    const s = await (await fetch("/api/settings")).json();
    document.querySelector('input[name="setmode"][value="' + (s.mode === "github" ? "github" : "local") + '"]').checked = true;
    $("#setRepo").value = s.repo || "";
    $("#setBranch").value = s.branch || "";
    $("#setCurrent").innerHTML =
      s.mode === "github"
        ? `Connecté à <b>${esc(s.repo)}</b> (branche ${esc(s.branch)}, jeton ${s.hasToken ? "présent" : "absent"})`
        : "Mode <b>local</b> — aucun dépôt GitHub connecté.";
    ghModeSelected();
  } catch (e) { setInfoMsg("Impossible de lire les réglages: " + e.message, false); }
}
function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }

$("#btnSettings").onclick = () => { modal.classList.remove("hidden"); setInfoMsg("", true); loadSettingsForm(); };
$("#btnCloseSettings").onclick = () => modal.classList.add("hidden");
modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.add("hidden"); });
document.querySelectorAll('input[name="setmode"]').forEach((r) => r.addEventListener("change", ghModeSelected));

$("#btnTest").onclick = async () => {
  setInfoMsg("Test en cours…", true);
  const r = await fetch("/api/settings/test", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ githubToken: $("#setToken").value || null, githubRepo: $("#setRepo").value }),
  });
  const d = await r.json();
  if (d.ok) {
    let extra = d.repo ? ` → <b>${esc(d.repo.full_name)}</b>${d.repo.private ? " (privé)" : " (public)"}, branche par défaut : ${esc(d.repo.default_branch)}` : "";
    setInfoMsg(`✅ Jeton valide pour <b>${esc(d.user)}</b>${extra}`, true);
  } else setInfoMsg("✗ " + (d.error || "échec"), false);
};
$("#btnSaveSettings").onclick = async () => {
  setInfoMsg("Connexion…", true);
  const r = await fetch("/api/settings", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: "github",
      githubToken: $("#setToken").value || null,
      githubRepo: $("#setRepo").value,
      githubBranch: $("#setBranch").value || null,
    }),
  });
  const d = await r.json();
  if (d.ok) { setInfoMsg(`✅ Connecté à ${esc(d.repo)} (${esc(d.user)}) — reconnexion…`, true); setTimeout(() => location.reload(), 900); }
  else setInfoMsg("✗ " + (d.error || "échec"), false);
};
$("#btnLocalSave").onclick = async () => {
  setInfoMsg("Bascule en mode local…", true);
  const r = await fetch("/api/settings", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "local" }),
  });
  const d = await r.json();
  if (d.ok) { setInfoMsg("✅ Mode local — reconnexion…", true); setTimeout(() => location.reload(), 900); }
  else setInfoMsg("✗ " + (d.error || "échec"), false);
};

// Recharge automatiquement si le dépôt connecté change (bascule faite ailleurs/par un autre onglet)
let knownVersion = null;
setInterval(async () => {
  try {
    const c = await (await fetch("/api/config")).json();
    if (knownVersion === null) { knownVersion = c.version; return; }
    if (c.version !== knownVersion) { knownVersion = c.version; location.reload(); }
  } catch (_e) {}
}, 4000);

document.title = `Easydoc · ${ME.name}`;

// ----- Démarrage -----
(async () => {
  try {
    const cfg = await (await fetch("/api/config")).json();
    $("#mode").textContent = cfg.mode === "github" ? `GitHub ${cfg.repo}` : "dépôt local";
  } catch (_e) {}
  await refreshTree();
  const first = files.find((f) => f.path.includes("notes-claude")) || files[0];
  if (first) openFile(first.path);
  else toast("Le dépôt est vide — clique sur + pour créer un doc.", true);
})();