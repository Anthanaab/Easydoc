/**
 * server.js — Easydoc
 * Serveur Express + temps réel (Yjs via WebSocket) + synchronisation GitHub/local.
 */
"use strict";

const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const Y = require("yjs");
const { Octokit } = require("@octokit/rest");
const { setupWSConnection, setPersistence, docs: ywsDocs } = require("y-websocket/bin/utils");
const { RepoService } = require("./src/repo");
const { SettingsStore } = require("./src/settings");

require("dotenv").config({ path: path.join(__dirname, ".env") });

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, "public");
const LOCAL_DIR = process.env.LOCAL_REPO_DIR || path.join(__dirname, "data", "localrepo");
const ENV_GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const ENV_GITHUB_REPO = process.env.GITHUB_REPO || "";
const ENV_GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";

// Configuration persistée (connectée depuis l'interface). Dès que le fichier de config
// existe, il prime sur les variables d'environnement.
const settingsStore = new SettingsStore(path.join(__dirname, "data", "config.json"));
settingsStore.load();
const saved = settingsStore.exists();
const GH_TOKEN = saved ? settingsStore.get().githubToken : ENV_GITHUB_TOKEN;
const GH_REPO = saved ? settingsStore.get().githubRepo : ENV_GITHUB_REPO;
const GH_BRANCH = saved ? settingsStore.get().githubBranch : ENV_GITHUB_BRANCH;

const repo = new RepoService({ githubToken: GH_TOKEN, githubRepo: GH_REPO, githubBranch: GH_BRANCH, localRepoDir: LOCAL_DIR });

// ---- Stock : un Y.Doc vivant par document (source du temps réel). ----
const liveDocs = new Map(); // docName -> { ydoc, loaded }
const TEXT_FIELD = "content";

async function ensureDoc(docName) {
  let entry = liveDocs.get(docName);
  if (entry) return entry;
  const ydoc = new Y.Doc();
  entry = { ydoc, loaded: false };
  liveDocs.set(docName, entry);
  // Charger le contenu actuel (GitHub/local) dans le Y.Text avant le premier sync client.
  try {
    const existing = await repo.readFile(docName);
    if (existing) {
      ydoc.transact(() => {
        const t = ydoc.getText(TEXT_FIELD);
        t.insert(0, existing.content);
      });
    }
  } catch (e) {
    console.error(`[load] échec lecture ${docName}:`, e.message);
  }
  entry.loaded = true;
  return entry;
}

// Persistance Yjs -> raccord aux Y.Doc de notre stock.
setPersistence({
  bindState: async (docName, ydoc) => {
    // Ne charge que si le doc est vierge (sinon on écraserait une session en cours).
    const text = ydoc.getText(TEXT_FIELD);
    if (text.length > 0) return;
    try {
      const clean = String(docName).replace(/^\/+/, "");
      const existing = await repo.readFile(clean);
      if (existing && text.length === 0) {
        ydoc.transact(() => text.insert(0, existing.content));
      }
    } catch (e) { console.error(`[bind] «${docName}»`, e.message); }
  },
  writeState: async (_docName, _ydoc) => {},
});

// ---- HTTP + API ----
const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.static(PUBLIC));

app.get("/api/health", (_req, res) => res.json({ ok: true, mode: repo.mode }));
app.get("/api/config", (_req, res) =>
  res.json({
    mode: repo.mode,
    repo: repo.mode === "github" ? repo.options.githubRepo : "(local)",
    branch: repo.mode === "github" ? repo.options.githubBranch : null,
    user: repo.mode === "github" ? String(repo.options.githubToken).slice(0, 6) || null : null,
    version: settingsStore.get().version,
  }));

// ---- Réglages : connecter / changer de dépôt depuis l'interface ------------------------
function clearLiveDocs() {
  for (const [, entry] of liveDocs) { try { entry.ydoc.destroy(); } catch (_e) {} }
  liveDocs.clear();
  for (const [, holder] of ywsDocs) { try { (holder.doc || holder).destroy(); } catch (_e) {} }
  ywsDocs.clear();
}

async function testGithub(token, repoName) {
  const octokit = new Octokit({ auth: token });
  const me = await octokit.rest.users.getAuthenticated();
  let repoInfo = null;
  if (repoName) {
    const [owner, name] = repoName.split("/");
    try {
      const r = await octokit.rest.repos.get({ owner, repo: name });
      repoInfo = { full_name: r.data.full_name, default_branch: r.data.default_branch, private: r.data.private };
    } catch (e) {
      if (e.status === 404) throw new Error(`Dépôt « ${repoName} » introuvable pour ce jeton.`);
      throw e;
    }
  }
  return { login: me.data.login, repoInfo };
}

app.get("/api/settings", (_req, res) => {
  res.json({
    mode: repo.mode,
    repo: repo.mode === "github" ? repo.options.githubRepo : null,
    branch: repo.mode === "github" ? repo.options.githubBranch : null,
    hasToken: !!repo.options.githubToken,
    version: settingsStore.get().version,
  });
});

// Teste la connexion sans rien modifier (ne renvoie jamais le jeton).
app.post("/api/settings/test", async (req, res) => {
  const token = String(req.body.githubToken || repo.options.githubToken || "").trim();
  const repoName = String(req.body.githubRepo || "").trim().replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, "");
  if (!token) return res.status(400).json({ ok: false, error: "Jeton GitHub requis." });
  if (repoName && !/^[\w.-]+\/[\w.-]+$/.test(repoName)) {
    return res.status(400).json({ ok: false, error: "Format du dépôt attendu : proprietaire/repo" });
  }
  try {
    const r = await testGithub(token, repoName);
    res.json({ ok: true, user: r.login, repo: r.repoInfo });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Enregistre la connexion (ou le mode local) et bascule le dépôt à chaud.
app.post("/api/settings", async (req, res) => {
  try {
    const mode = String(req.body.mode || repo.mode);
    if (mode === "local") {
      settingsStore.save({ githubToken: "", githubRepo: "", githubBranch: "" });
      await repo.switch({ githubToken: "", githubRepo: "", githubBranch: "" });
      await repo.seedIfEmpty();
      clearLiveDocs();
      return res.json({ ok: true, mode: "local", version: settingsStore.get().version });
    }
    let repoName = String(req.body.githubRepo || repo.options.githubRepo || "").trim()
      .replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(repoName)) {
      return res.status(400).json({ ok: false, error: "Format attendu : proprietaire/repo" });
    }
    let token = String(req.body.githubToken || "").trim() || repo.options.githubToken || "";
    if (!token) return res.status(400).json({ ok: false, error: "Jeton GitHub requis." });
    const t = await testGithub(token, repoName); // valide jeton + dépôt
    let branch = String(req.body.githubBranch || "").trim() || (t.repoInfo && t.repoInfo.default_branch) || "main";
    settingsStore.save({ githubToken: token, githubRepo: repoName, githubBranch: branch });
    await repo.switch({ githubToken: token, githubRepo: repoName, githubBranch: branch });
    if (repo.mode === "github") await repo.seedIfEmpty();
    clearLiveDocs();
    res.json({ ok: true, mode: "github", repo: repoName, branch, user: t.login, version: settingsStore.get().version });
  } catch (e) {
    console.error("[settings] enregistrement :", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Arborescence
app.get("/api/files", async (_req, res) => {
  try {
    const files = await repo.listFiles();
    res.json({ files });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Contenu d'un fichier (pour l'assertion initiale coté client)
app.get("/api/file", async (req, res) => {
  const p = String(req.query.path || "").replace(/^\/+/, "");
  if (!p) return res.status(400).json({ error: "path requis" });
  try {
    const existing = await repo.readFile(p);
    res.json({ path: p, content: existing ? existing.content : "", exists: !!existing });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Sauvegarde : enregistre le texte et commit+push
app.post("/api/save", async (req, res) => {
  const p = String(req.body.path || "").replace(/^\/+/, "");
  const content = String(req.body.content || "");
  const author = String(req.body.author || "inconnu");
  if (!p) return res.status(400).json({ error: "path requis" });
  try {
    // met à jour le Y.Doc vivant pour que tous voient la même version
    const entry = await ensureDoc(p);
    entry.ydoc.transact(() => {
      const t = entry.ydoc.getText(TEXT_FIELD);
      const cur = t.toJSON();
      if (cur !== content) {
        t.delete(0, t.length);
        t.insert(0, content);
      }
    });
    const res_ = await repo.writeFile(p, content, `Easydoc: ${author}`);
    res.json({ ok: true, committed: res_.committed });
  } catch (e) {
    console.error(`[save] ${p}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// Pull : récupère les derniers états (incl. updates d'un agent IA) et les injecte en temps réel
app.post("/api/pull", async (req, res) => {
  try {
    await repo.pull();
    const files = await repo.listFiles();
    // recharge chaque doc vivant
    for (const f of files) {
      if (!String(f.path).toLowerCase().endsWith(".md")) continue;
      if (!liveDocs.has(f.path)) continue;
      try {
        const existing = await repo.readFile(f.path);
        if (existing) {
          const entry = liveDocs.get(f.path);
          entry.ydoc.transact(() => {
            const t = entry.ydoc.getText(TEXT_FIELD);
            if (t.toJSON() !== existing.content) {
              t.delete(0, t.length);
              t.insert(0, existing.content);
            }
          });
        }
      } catch (e) { console.error(`[pull] ${f.path}: ${e.message}`); }
    }
    res.json({ ok: true, reloaded: files.filter((f) => String(f.path).endsWith(".md")).length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Création d'un nouveau document ---
app.post("/api/create", async (req, res) => {
  const p = String(req.body.path || "").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  if (!p) return res.status(400).json({ error: "path requis" });
  if (!p.toLowerCase().endsWith(".md")) return res.status(400).json({ error: "seuls des .md pour l'instant" });
  try {
    const exist = await repo.readFile(p);
    if (exist) return res.status(409).json({ error: "existe déjà" });
    await repo.writeFile(p, "", `Easydoc: créer ${p}`);
    res.json({ ok: true, path: p });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- HTTP server + WebSocket (temps réel Yjs) ----
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (conn, req) => {
  // y-websocket passe le nom du document dans le chemin de l'URL : /docs/mon-ficher.md
  const docName = decodeURIComponent((req.url || "").split("?")[0].replace(/^\/+/, ""));
  setupWSConnection(conn, req, { gc: true, docName });
});

async function main() {
  await repo.init();
  await repo.seedIfEmpty();
  const mode = repo.mode === "github" ? `GitHub:${repo.options.githubRepo} (branche ${repo.options.githubBranch})` : `local:${LOCAL_DIR}`;
  server.listen(PORT, () => {
    console.log(`🎮 Easydoc démarré sur http://localhost:${PORT} (mode ${mode})`);
  });
}

main().catch((e) => { console.error("Erreur au démarrage:", e); process.exit(1); });