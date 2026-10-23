/**
 * tunnel.js — tunnel Cloudflare intégré (accès depuis Internet, en HTTPS, sans ouvrir de port).
 *
 * L'administrateur colle le jeton du tunnel (Cloudflare Zero Trust → Networks → Tunnels) dans
 * l'interface ; Easydoc lance `cloudflared tunnel run` et le relance s'il s'arrête.
 *  - Jeton : data/tunnel.json (chmod 600), jamais renvoyé au navigateur, transmis à cloudflared par
 *    variable d'environnement (invisible dans la liste des processus).
 *  - cloudflared : celui du système s'il est installé, sinon téléchargé depuis les publications
 *    officielles GitHub de Cloudflare dans data/bin/, avec vérification de l'empreinte SHA-256.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");
const { writeJsonSecure } = require("./auth");

const RELEASE_API = "https://api.github.com/repos/cloudflare/cloudflared/releases/latest";
const ARCH = { x64: "amd64", arm64: "arm64", arm: "arm" };

/** Extrait le jeton d'un collage (jeton seul, ou commande « cloudflared … --token eyJ… »). */
function parseToken(input) {
  const raw = String(input || "").trim();
  const m = raw.match(/eyJ[A-Za-z0-9+/=_-]{40,}/);
  if (!m) throw new Error("Jeton de tunnel introuvable : colle le jeton (il commence par « eyJ ») ou la commande d'installation affichée par Cloudflare.");
  let info;
  try {
    const json = Buffer.from(m[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    info = JSON.parse(json);
  } catch (_e) { throw new Error("Jeton de tunnel illisible : vérifie qu'il a été copié en entier."); }
  if (!info || typeof info.a !== "string" || typeof info.t !== "string" || typeof info.s !== "string") {
    throw new Error("Ce n'est pas un jeton de tunnel Cloudflare valide.");
  }
  return { token: m[0], tunnelId: info.t, accountTag: info.a };
}

const sanitize = (line, token) => {
  let s = String(line).replace(/eyJ[A-Za-z0-9+/=_-]{40,}/g, "‹jeton›");
  if (token) s = s.split(token).join("‹jeton›");
  return s.slice(0, 400);
};

function findInPath(bin) {
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const f = path.join(dir, bin);
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch (_e) {}
  }
  return null;
}

class TunnelManager {
  constructor({ dataDir, port, onChange }) {
    this.file = path.join(dataDir, "tunnel.json");
    this.binDir = path.join(dataDir, "bin");
    this.port = port;
    this.onChange = onChange || (() => {});
    this.cfg = { token: "", enabled: false, tunnelId: "" };
    try { Object.assign(this.cfg, JSON.parse(fs.readFileSync(this.file, "utf8"))); } catch (_e) {}
    this.child = null;
    this.stopping = false;
    this.retryTimer = null;
    this.retries = 0;
    this.state = { status: "off", connections: new Set(), hostnames: [], services: [], lastError: "", logs: [], version: "", binary: "", since: 0 };
  }

  get enabled() { return !!(this.cfg.enabled && this.cfg.token); }
  /** Noms publics connus (pour accepter l'origine des requêtes qui passent par le tunnel). */
  get hostnames() { return this.state.hostnames; }

  save() { writeJsonSecure(this.file, this.cfg); }

  log(line) {
    const clean = sanitize(line, this.cfg.token);
    if (!clean.trim()) return;
    this.state.logs.push(clean);
    if (this.state.logs.length > 80) this.state.logs.splice(0, this.state.logs.length - 80);
  }

  setStatus(status, err) {
    this.state.status = status;
    if (err !== undefined) this.state.lastError = err ? sanitize(err, this.cfg.token) : "";
    if (status === "connected") this.retries = 0;
    this.onChange(this.publicState());
  }

  publicState() {
    const expected = `http://localhost:${this.port}`;
    const services = this.state.services;
    const wrongService = services.length > 0 && !services.some((s) => {
      try { const u = new URL(s); return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname) && String(u.port || (u.protocol === "https:" ? 443 : 80)) === String(this.port); }
      catch (_e) { return false; }
    });
    return {
      hasToken: !!this.cfg.token, enabled: this.enabled, tunnelId: this.cfg.tunnelId || "",
      status: this.state.status, connections: this.state.connections.size,
      hostnames: this.state.hostnames, services, expectedService: expected, wrongService,
      lastError: this.state.lastError, logs: this.state.logs.slice(-25), version: this.state.version,
      binary: this.state.binary, since: this.state.since,
    };
  }

  // ---- cloudflared -----------------------------------------------------------------------------
  async binaryPath() {
    const sys = findInPath("cloudflared");
    if (sys) { this.state.binary = "système"; return sys; }
    const local = path.join(this.binDir, "cloudflared");
    try { fs.accessSync(local, fs.constants.X_OK); this.state.binary = "téléchargé"; return local; } catch (_e) {}
    await this.download(local);
    this.state.binary = "téléchargé";
    return local;
  }

  async download(dest) {
    const arch = ARCH[process.arch];
    if (process.platform !== "linux" || !arch) throw new Error(`cloudflared n'est pas disponible pour ce système (${process.platform}/${process.arch}) : installe-le manuellement.`);
    const name = `cloudflared-linux-${arch}`;
    this.setStatus("installing", "");
    this.log(`Téléchargement de ${name} depuis les publications officielles de Cloudflare…`);
    const rel = await fetchJson(RELEASE_API);
    const asset = (rel.assets || []).find((a) => a.name === name);
    if (!asset) throw new Error(`Fichier ${name} introuvable dans la dernière publication de cloudflared.`);
    let expected = String(asset.digest || "").replace(/^sha256:/, "");
    if (!/^[0-9a-f]{64}$/.test(expected)) {
      const m = String(rel.body || "").match(new RegExp(`${name}:\\s*([0-9a-f]{64})`));
      expected = m ? m[1] : "";
    }
    if (!expected) throw new Error("Empreinte de cloudflared introuvable : téléchargement annulé par sécurité.");
    const r = await fetch(asset.browser_download_url, { redirect: "follow" });
    if (!r.ok) throw new Error(`Téléchargement de cloudflared impossible (HTTP ${r.status}).`);
    const buf = Buffer.from(await r.arrayBuffer());
    const got = crypto.createHash("sha256").update(buf).digest("hex");
    if (got !== expected) throw new Error("Empreinte de cloudflared incorrecte : fichier rejeté.");
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buf, { mode: 0o755 });
    fs.renameSync(tmp, dest);
    this.log(`cloudflared ${rel.tag_name} installé (empreinte SHA-256 vérifiée).`);
  }

  // ---- cycle de vie ----------------------------------------------------------------------------
  /** Enregistre la configuration et démarre / arrête le tunnel en conséquence. */
  async configure({ token, enabled }) {
    if (token !== undefined && token !== null && String(token).trim()) {
      const p = parseToken(token);
      if (p.token !== this.cfg.token && this.child) await this.stop();
      this.cfg.token = p.token;
      this.cfg.tunnelId = p.tunnelId;
      this.state.hostnames = []; this.state.services = [];
    }
    if (enabled !== undefined) this.cfg.enabled = !!enabled;
    if (this.cfg.enabled && !this.cfg.token) throw new Error("Indique d'abord le jeton du tunnel.");
    this.save();
    if (this.enabled) await this.start(true); else await this.stop();
    return this.publicState();
  }

  async forget() {
    await this.stop();
    this.cfg = { token: "", enabled: false, tunnelId: "" };
    this.state.hostnames = []; this.state.services = []; this.state.logs = [];
    this.save();
    this.setStatus("off", "");
    return this.publicState();
  }

  async start(restart = false) {
    if (!this.enabled) return;
    if (this.child && !restart) return;
    if (this.child) await this.stop(true);
    clearTimeout(this.retryTimer);
    this.stopping = false;
    let bin;
    try { bin = await this.binaryPath(); }
    catch (e) { this.log(e.message); this.setStatus("error", e.message); this.scheduleRetry(); return; }
    if (!this.state.version) {
      this.state.version = await new Promise((res) => execFile(bin, ["--version"], { timeout: 10000 }, (_e, out) => res((String(out || "").match(/version (\S+)/) || [])[1] || "")));
    }
    this.state.connections.clear();
    this.setStatus("starting", "");
    this.log("Démarrage du tunnel…");
    const child = spawn(bin, ["tunnel", "--no-autoupdate", "run"], {
      env: { ...process.env, TUNNEL_TOKEN: this.cfg.token }, stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.state.since = Date.now();
    let buf = "";
    const onData = (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { this.parse(buf.slice(0, i)); buf = buf.slice(i + 1); }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (e) => { this.log(e.message); this.setStatus("error", e.message); });
    child.on("exit", (code, sig) => {
      if (this.child === child) this.child = null;
      this.state.connections.clear();
      if (this.stopping || !this.enabled) { this.setStatus("off"); return; }
      const msg = this.state.lastError || `cloudflared s'est arrêté (${sig || `code ${code}`}).`;
      this.log(`cloudflared s'est arrêté (${sig || `code ${code}`}).`);
      this.setStatus("error", msg);
      this.scheduleRetry();
    });
  }

  scheduleRetry() {
    clearTimeout(this.retryTimer);
    if (!this.enabled || this.stopping) return;
    const delay = Math.min(60000, 5000 * 2 ** Math.min(this.retries++, 4));
    this.retryTimer = setTimeout(() => this.start().catch(() => {}), delay);
    if (this.retryTimer.unref) this.retryTimer.unref();
  }

  stop(keepState = false) {
    clearTimeout(this.retryTimer);
    this.stopping = true;
    const child = this.child;
    if (!child) { if (!keepState) this.setStatus("off", ""); return Promise.resolve(); }
    return new Promise((res) => {
      const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch (_e) {} }, 5000);
      child.once("exit", () => { clearTimeout(t); res(); });
      try { child.kill("SIGTERM"); } catch (_e) { clearTimeout(t); res(); }
    }).then(() => { this.child = null; if (!keepState) this.setStatus("off", ""); });
  }

  /** Lecture des journaux de cloudflared : connexions, configuration publiée, erreurs. */
  parse(line) {
    if (!line.trim()) return;
    this.log(line);
    let m;
    if ((m = line.match(/Registered tunnel connection connIndex=(\d+)/))) {
      this.state.connections.add(m[1]);
      this.setStatus("connected", "");
      return;
    }
    if ((m = line.match(/(?:Unregistered tunnel connection|Connection terminated|Lost connection).*?connIndex=(\d+)/))) {
      this.state.connections.delete(m[1]);
      if (!this.state.connections.size && this.state.status === "connected") this.setStatus("starting");
      return;
    }
    if ((m = line.match(/Updated to new configuration config="(.*)" version=/))) {
      try {
        const conf = JSON.parse(m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
        const ingress = Array.isArray(conf.ingress) ? conf.ingress : [];
        this.state.hostnames = ingress.map((r) => r.hostname).filter(Boolean);
        this.state.services = ingress.filter((r) => r.hostname).map((r) => r.service).filter(Boolean);
        this.onChange(this.publicState());
      } catch (_e) {}
      return;
    }
    if (/receive buffer size|ICMP proxy|Cannot determine default origin certificate|update check/i.test(line)) return; // avertissements sans conséquence
    if (/\bERR\b|error="|failed to|Unauthorized|not valid|invalid/i.test(line) && !/Retrying connection/i.test(line)) {
      const e = (line.match(/error="([^"]+)"/) || [])[1] || line.replace(/^\S+\s+ERR\s+/, "");
      this.state.lastError = sanitize(friendly(e), this.cfg.token);
      if (!this.state.connections.size) this.state.status = "error"; // cloudflared réessaie de lui-même
      this.onChange(this.publicState());
    }
  }
}

function friendly(e) {
  if (/Failed to get tunnel|tunnel not found/i.test(e)) return "Cloudflare ne trouve pas ce tunnel : il a peut-être été supprimé. Crée un tunnel dans le tableau de bord Cloudflare et copie son jeton.";
  if (/token is not valid|Invalid tunnel secret|Unauthorized/i.test(e)) return "Cloudflare refuse ce jeton (tunnel supprimé ou jeton régénéré) : copie le jeton actuel depuis le tableau de bord Cloudflare.";
  if (/no such host|dial tcp|i\/o timeout|network is unreachable/i.test(e)) return `Cloudflare injoignable depuis ce serveur : ${e}`;
  return e;
}

function fetchJson(url) {
  return fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "easydoc" } }).then(async (r) => {
    if (!r.ok) throw new Error(`Publications de cloudflared inaccessibles (HTTP ${r.status}).`);
    return r.json();
  });
}

module.exports = { TunnelManager, parseToken, sanitize };
