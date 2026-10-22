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
const { setupWSConnection, setPersistence } = require("y-websocket/bin/utils");
const { RepoService } = require("./src/repo");

require("dotenv").config({ path: path.join(__dirname, ".env") });

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, "public");
const LOCAL_DIR = process.env.LOCAL_REPO_DIR || path.join(__dirname, "data", "localrepo");
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";

const repo = new RepoService({ githubToken: GITHUB_TOKEN, githubRepo: GITHUB_REPO, githubBranch: GITHUB_BRANCH, localRepoDir: LOCAL_DIR });

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
  res.json({ mode: repo.mode, repo: GITHUB_REPO || "(local)", user: GITHUB_TOKEN.slice(0, 6) || null }));

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
  const mode = repo.mode === "github" ? `GitHub:${GITHUB_REPO}` : `local:${LOCAL_DIR}`;
  server.listen(PORT, () => {
    console.log(`🎮 Easydoc démarré sur http://localhost:${PORT} (mode ${mode})`);
  });
}

main().catch((e) => { console.error("Erreur au démarrage:", e); process.exit(1); });