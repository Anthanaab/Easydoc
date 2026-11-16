// Outils communs aux tests : un serveur Easydoc isolé (dossier de données temporaire, dépôt
// local, port libre), deux comptes (administrateur et membre), requêtes HTTP et temps réel.
// Rien n'est lu ni écrit dans les données de l'instance réelle.
"use strict";
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const Y = require("yjs");
const { WebsocketProvider } = require("y-websocket");
const WS = require("ws");

const ROOT = path.join(__dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
    s.on("error", rej);
  });
}

/** Attend qu'une condition devienne vraie (plutôt qu'un délai fixe) ; retourne sa dernière valeur. */
async function waitFor(fn, { timeout = 15000, every = 100 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    let v;
    try { v = await fn(); } catch (_e) { v = false; }
    if (v || Date.now() > end) return v;
    await sleep(every);
  }
}

/** Session HTTP d'un compte : get/post/put/del/upload → { status, type, text, json }, et open() en temps réel. */
function session(srv, cookie) {
  const call = async (method, url, body, headers = {}) => {
    const raw = Buffer.isBuffer(body);
    const r = await fetch(srv.base + url, {
      method,
      headers: { Origin: srv.base, Cookie: cookie, ...(body !== undefined && !raw ? { "Content-Type": "application/json" } : {}), ...headers },
      body: raw ? body : body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_e) {}
    return { status: r.status, type: r.headers.get("content-type") || "", text, json };
  };
  return {
    cookie,
    get: (u, h) => call("GET", u, undefined, h),
    post: (u, b, h) => call("POST", u, b, h),
    put: (u, b) => call("PUT", u, b),
    del: (u) => call("DELETE", u),
    upload: (p, buf, replace) => call("POST", `/api/upload?path=${encodeURIComponent(p)}${replace ? "&replace=1" : ""}`, buf),
    /** Ouvre un document en temps réel : { doc, text (Y.Text), provider, close() }. */
    async open(docPath) {
      class CookieWS extends WS { constructor(url, p) { super(url, p, { headers: { Cookie: cookie, Origin: srv.base } }); } }
      const doc = new Y.Doc();
      const provider = new WebsocketProvider(srv.base.replace("http", "ws"), docPath.split("/").map(encodeURIComponent).join("/"), doc,
        { WebSocketPolyfill: CookieWS, disableBc: true });
      await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error("connexion temps réel impossible : " + docPath)), 10000);
        provider.on("sync", (ok) => { if (ok) { clearTimeout(t); res(); } });
      });
      await waitFor(() => doc.getMap("meta").get("loaded"), { timeout: 5000 });
      const conn = { doc, text: doc.getText("content"), provider, close() { provider.destroy(); doc.destroy(); srv.conns.delete(conn); } };
      srv.conns.add(conn); // fermée par srv.stop() même si un test échoue avant de la fermer
      return conn;
    },
  };
}

/**
 * Démarre un serveur Easydoc isolé (env : AUTOSAVE_MS, POLL_MS…).
 * Retourne { base, repoDir, dataDir, admin, member, login(), stop(), log }.
 */
async function startServer(env = {}, opts = {}) {
  // opts.dataDir + opts.password : démarrer sur des données existantes (restauration d'une sauvegarde)
  const dataDir = opts.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), "easydoc-test-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), DATA_DIR: dataDir, ENV_FILE: path.join(dataDir, ".env"),
      GITHUB_TOKEN: "", GITHUB_REPO: "", AUTOSAVE_MS: "400", POLL_MS: "600000", TRUST_PROXY: "0", ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  const up = await waitFor(async () => (await fetch(base + "/api/health")).ok, { timeout: 20000 });
  if (!up) { child.kill(); throw new Error("Le serveur de test n'a pas démarré :\n" + log); }

  const password = opts.password || crypto.randomBytes(12).toString("base64url");
  const srv = {
    base, port, dataDir, repoDir: path.join(dataDir, "localrepo"), password,
    conns: new Set(), // connexions temps réel ouvertes par les tests
    get log() { return log; },
    async login(username) {
      const r = await fetch(base + "/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json", Origin: base },
        body: JSON.stringify({ username, password }),
      });
      if (!r.ok) throw new Error(`connexion de ${username} impossible (${r.status})`);
      return session(srv, (r.headers.get("set-cookie") || "").split(";")[0]);
    },
    async stop() {
      for (const c of [...srv.conns]) { try { c.close(); } catch (_e) {} } // sinon elles se reconnectent sans fin
      if (child.exitCode === null) {
        child.kill();
        await new Promise((r) => child.once("exit", r));
      }
      // Windows : un fichier peut rester verrouillé un instant après l'arrêt (git, antivirus…) ;
      // un dossier temporaire oublié n'est pas un échec du test
      try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); }
      catch (e) { console.warn(`[test] dossier temporaire non supprimé (${e.code || e.message}) : ${dataDir}`); }
    },
  };
  if (opts.dataDir) { // comptes déjà présents
    srv.admin = await srv.login("admin-test");
    srv.member = await srv.login("membre-test");
    return srv;
  }
  const setup = await fetch(base + "/api/auth/setup", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ username: "admin-test", displayName: "Admin Test", password, password2: password }),
  });
  if (!setup.ok) throw new Error("création du compte administrateur impossible : " + (await setup.text()));
  srv.admin = session(srv, (setup.headers.get("set-cookie") || "").split(";")[0]);
  const m = await srv.admin.post("/api/admin/users", { username: "membre-test", displayName: "Membre Test", password, role: "member" });
  if (m.status !== 200) throw new Error("création du compte membre impossible : " + m.text);
  srv.member = await srv.login("membre-test");
  return srv;
}

/** Commit fait « hors d'Easydoc » dans le dépôt local (comme un agent IA ou un git push). */
function externalCommit(srv, rel, content, message = "modification externe") {
  const full = path.join(srv.repoDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  const git = (...a) => execFileSync("git", ["-C", srv.repoDir, "-c", "user.name=Agent", "-c", "user.email=agent@test", "-c", "core.autocrlf=false", ...a]);
  git("add", "--", rel);
  git("commit", "-q", "-m", message, "--", rel);
}
const readRepo = (srv, rel) => fs.readFileSync(path.join(srv.repoDir, rel), "utf8");

module.exports = { startServer, waitFor, sleep, externalCommit, readRepo, Y, WS };
