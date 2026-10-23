/**
 * updater.js — mise à jour d'Easydoc depuis l'interface.
 *
 * Fonctionne quand le code est un clone git (installation Proxmox / LXC) et que le service
 * Easydoc peut y écrire. Étapes : récupération → application → dépendances (si elles ont changé)
 * → essai de la nouvelle version sur un port et des données temporaires → redémarrage.
 * Si une étape échoue avant le redémarrage, l'ancienne version est remise en place.
 * Le redémarrage se fait en quittant avec le code 75 : systemd (Restart=on-failure) relance le service.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const { spawn, execFile } = require("child_process");

const RESTART_CODE = 75;

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 20 * 1024 * 1024, timeout: opts.timeout || 120000, cwd: opts.cwd, env: opts.env || process.env }, (err, stdout, stderr) => {
      if (err) { err.message = `${cmd} ${args[0]} : ${String(stderr || err.message).trim().split("\n").slice(-4).join(" ").slice(0, 400)}`; return reject(err); }
      resolve(String(stdout));
    });
  });
}
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); s.on("error", rej); });
const majorOf = (v) => Number(String(v || "").replace(/^v/, "").split(".")[0]) || 0;
/** Version minimale de Node demandée par un champ engines (« >=22 », « ^22.1 »…). */
const minNode = (eng) => { const m = String(eng || "").match(/(\d+)/); return m ? Number(m[1]) : 0; };

/** L'URL d'une origine git, avec le jeton d'Easydoc quand il en existe (dépôt privé). */
function authUrl(url, token) {
  if (!token || !String(url).startsWith("https://github.com/")) return String(url || "");
  try {
    const u = new URL(url);
    if (u.username) return String(url); // déjà des identifiants
    u.username = "oauth2";
    u.password = token;
    return u.toString();
  } catch (_e) { return String(url || ""); }
}

class Updater {
  constructor({ appDir, dataDir, currentVersion, beforeRestart, onEvent, tokenProvider, gitBin, fetchHook }) {
    this.appDir = appDir;
    this.dataDir = dataDir;
    this.tokenProvider = tokenProvider || (() => "");
    this.currentVersion = currentVersion;
    this.beforeRestart = beforeRestart || (async () => {});
    this.onEvent = onEvent || (() => {});
    const gb = gitBin || "git";
    this.git = (args, opts = {}) => run(gb, ["-C", this.appDir, ...args], opts);
    this._gitBin = gb;
    this.fetchHook = fetchHook || null;
    this.check = null;     // dernier résultat de vérification
    this.job = null;       // mise à jour en cours / terminée
    this.markerFile = path.join(dataDir, "update-state.json");
    this.last = null;      // dernière mise à jour réussie (après redémarrage)
    try {
      const m = JSON.parse(fs.readFileSync(this.markerFile, "utf8"));
      if (m && m.pending) {
        m.pending = false;
        m.ok = m.toVersion === currentVersion;
        fs.writeFileSync(this.markerFile, JSON.stringify(m));
      }
      this.last = m;
    } catch (_e) {}
  }

  /** Mise à jour possible ici ? { ok, reasons[], managed } */
  availability() {
    const reasons = [];
    const isContainer = fs.existsSync("/.dockerenv") || fs.existsSync("/run/systemd/container");
    if (!fs.existsSync(path.join(this.appDir, ".git"))) {
      reasons.push(isContainer
        ? "Easydoc tourne dans un conteneur sans clone git : avec Docker, reconstruis l'image (docker compose build --pull puis docker compose up -d) ; sinon réinstalle-le avec le script Proxmox."
        : "Le code d'Easydoc n'est pas un clone git : réinstalle-le avec le script Proxmox, ou mets-le à jour à la main.");
    } else {
      for (const p of [this.appDir, path.join(this.appDir, ".git"), path.join(this.appDir, "node_modules")]) {
        try { fs.accessSync(p, fs.constants.W_OK); }
        catch (_e) { reasons.push(`Le service Easydoc ne peut pas écrire dans ${p} : lance une fois « bash easydoc-lxc.sh update » sur Proxmox (il remet les bons droits).`); break; }
      }
    }
    const managed = !!process.env.INVOCATION_ID || process.env.EASYDOC_SELF_UPDATE === "1";
    return { ok: reasons.length === 0, reasons, managed };
  }

  async branch() { return (await this.git(["rev-parse", "--abbrev-ref", "HEAD"])).trim(); }

  /** Interroge le dépôt d'Easydoc : nouvelle version disponible ? */
  async checkNow() {
    const av = this.availability();
    if (!av.ok) { this.check = { at: Date.now(), error: av.reasons[0] }; return this.check; }
    try {
      const branch = await this.branch();
      if (branch === "HEAD") throw new Error("Le code d'Easydoc n'est sur aucune branche (version figée) : mise à jour depuis l'interface impossible.");
      // le dépôt du code peut être privé : on lui donne le jeton d'Easydoc pour ce téléchargement.
      await this.fetchAuth(branch);
      const local = (await this.git(["rev-parse", "HEAD"])).trim();
      const remote = (await this.git(["rev-parse", `origin/${branch}`])).trim();
      const behind = Number((await this.git(["rev-list", "--count", `HEAD..origin/${branch}`])).trim()) || 0;
      const ahead = Number((await this.git(["rev-list", "--count", `origin/${branch}..HEAD`])).trim()) || 0;
      const log = behind ? await this.git(["log", "-n30", "--format=%H%x1f%s%x1f%aI", `HEAD..origin/${branch}`]) : "";
      const changes = log.split("\n").filter(Boolean).map((l) => { const [sha, title, date] = l.split("\x1f"); return { sha: sha.slice(0, 7), title, date }; });
      let pkg = {};
      try { pkg = JSON.parse(await this.git(["show", `origin/${branch}:package.json`])); } catch (_e) {}
      const need = minNode(pkg.engines && pkg.engines.node);
      const nodeOk = !need || majorOf(process.versions.node) >= need;
      const dirty = (await this.git(["status", "--porcelain", "--untracked-files=no"])).trim();
      this.check = {
        at: Date.now(), branch, local: local.slice(0, 7), remote: remote.slice(0, 7), behind, ahead, changes,
        currentVersion: this.currentVersion, latestVersion: pkg.version || "", available: behind > 0 && local !== remote,
        nodeOk, nodeNeeded: need, nodeCurrent: process.versions.node,
        blocked: !nodeOk ? `Cette version demande Node.js ${need} (installé : ${process.versions.node}) : lance une fois « bash easydoc-lxc.sh update » sur Proxmox, qui met Node.js à niveau.`
          : dirty ? "Des fichiers d'Easydoc ont été modifiés à la main sur le serveur : mise à jour depuis l'interface impossible (elle les écraserait)."
          : ahead > 0 && behind === 0 ? "" : "",
      };
    } catch (e) {
      this.check = { at: Date.now(), error: `Vérification impossible : ${e.message}` };
    }
    return this.check;
  }

  status() {
    return { availability: this.availability(), check: this.check, job: this.job, last: this.last, currentVersion: this.currentVersion };
  }

  /** Lance la mise à jour (en arrière-plan). */
  start() {
    if (this.job && this.job.running) throw new Error("Une mise à jour est déjà en cours.");
    const av = this.availability();
    if (!av.ok) throw new Error(av.reasons[0]);
    const job = this.job = {
      running: true, ok: false, error: "", startedAt: Date.now(), from: this.currentVersion, to: "",
      steps: [
        { id: "fetch", label: "Récupération de la nouvelle version", status: "todo" },
        { id: "apply", label: "Installation du code", status: "todo" },
        { id: "deps", label: "Bibliothèques", status: "todo" },
        { id: "verify", label: "Essai de la nouvelle version", status: "todo" },
        { id: "restart", label: "Redémarrage", status: "todo" },
      ],
      log: [],
    };
    this.execute(job).catch(() => {});
    return job;
  }

  async execute(job) {
    const step = (id, status, detail) => {
      const s = job.steps.find((x) => x.id === id);
      s.status = status; if (detail) s.detail = detail;
      this.onEvent({ type: "progress", job });
    };
    let prev = null, depsChanged = false, applied = false;
    try {
      step("fetch", "doing");
      const c = await this.checkNow();
      if (c.error) throw new Error(c.error);
      if (c.blocked) throw new Error(c.blocked);
      if (!c.available) { step("fetch", "done", "déjà à jour"); job.steps.slice(1).forEach((s) => { s.status = "skip"; }); job.running = false; job.ok = true; job.upToDate = true; this.onEvent({ type: "done", job }); return; }
      prev = (await this.git(["rev-parse", "HEAD"])).trim();
      const target = `origin/${c.branch}`;
      job.to = c.latestVersion || c.remote;
      step("fetch", "done", `${c.behind} modification${c.behind > 1 ? "s" : ""}`);

      step("apply", "doing");
      const changed = (await this.git(["diff", "--name-only", prev, target])).split("\n").filter(Boolean);
      depsChanged = await this.depsDiffer(prev, target);
      await this.git(["reset", "--hard", "--quiet", target]);
      applied = true;
      step("apply", "done", `${changed.length} fichier${changed.length > 1 ? "s" : ""}`);

      if (depsChanged) {
        step("deps", "doing");
        await this.npmCi();
        step("deps", "done");
      } else step("deps", "skip", "inchangées");

      step("verify", "doing");
      await this.smokeTest(job.to);
      step("verify", "done");

      step("restart", "doing");
      fs.writeFileSync(this.markerFile, JSON.stringify({ pending: true, fromVersion: job.from, toVersion: job.to, at: Date.now(), from: prev.slice(0, 7), to: (await this.git(["rev-parse", "--short", "HEAD"])).trim() }));
      job.ok = true;
      this.onEvent({ type: "restarting", job });
      const av = this.availability();
      if (!av.managed) {
        step("restart", "manual", "Easydoc ne tourne pas comme service : redémarre-le toi-même pour utiliser la nouvelle version.");
        job.running = false;
        this.onEvent({ type: "done", job });
        return;
      }
      await new Promise((r) => setTimeout(r, 800)); // laisse partir la réponse et la notification
      await this.beforeRestart();
      process.exit(RESTART_CODE);
    } catch (e) {
      job.error = e.message;
      const cur = job.steps.find((s) => s.status === "doing");
      if (cur) cur.status = "error";
      if (applied && prev) {
        try {
          await this.git(["reset", "--hard", "--quiet", prev]);
          if (depsChanged) await this.npmCi();
          job.rolledBack = true;
        } catch (e2) { job.error += ` — retour à la version précédente impossible : ${e2.message}`; }
      }
      job.running = false;
      this.onEvent({ type: "done", job });
    }
  }

  async fetchAuth(branch) {
    if (typeof this.fetchHook === "function") return this.fetchHook(branch); // tests
    const origin = (await this.git(["remote", "get-url", "origin"])).trim();
    const token = this.tokenProvider();
    const args = ["-C", this.appDir, "fetch", "--quiet", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`];
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    if (token && /^https:\/\//.test(origin)) {
      // dépôt du code privé : le jeton n'est fourni que pour ce téléchargement, par un
      // « credential.helper » jetable (aucune URL ni identifiant n'est écrit dans le dépôt).
      const helper = path.join(this.dataDir, ".git-credential-easydoc");
      fs.mkdirSync(this.dataDir, { recursive: true });
      const runArgs = ["-C", this.appDir, "-c", `credential.helper=${helper}`, "fetch", "--quiet", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`];
      const helperBody = `#!/bin/sh\n[ "$1" = "get" ] && printf 'username=oauth2\\npassword=%s\\n' "$EASYDOC_GIT_TOKEN"\n`;
      try {
        fs.writeFileSync(helper, helperBody, { mode: 0o700 });
        await run(this._gitBin, runArgs, { timeout: 90000, env: { ...env, GIT_TERMINAL_PROMPT: "0", EASYDOC_GIT_TOKEN: token, GITHUB_TOKEN: token } });
      } finally { try { fs.unlinkSync(helper); } catch (_e) {} }
      return;
    }
    await this.git(["fetch", "--quiet", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`], { timeout: 90000 });
  }

  /** Les bibliothèques diffèrent-elles entre deux versions ? (le numéro de version seul ne compte pas) */
  async depsDiffer(a, b) {
    const read = async (rev, file) => { try { return JSON.parse(await this.git(["show", `${rev}:${file}`])); } catch (_e) { return null; } };
    const sig = async (rev) => {
      const pkg = (await read(rev, "package.json")) || {};
      const lock = (await read(rev, "package-lock.json")) || {};
      const pk = { ...(lock.packages || {}) };
      delete pk[""];
      return JSON.stringify([pkg.dependencies || {}, pkg.optionalDependencies || {}, pk]);
    };
    if ((await sig(a)) !== (await sig(b))) return true;
    return !fs.existsSync(path.join(this.appDir, "node_modules"));
  }

  npmCi() {
    const cache = path.join(this.dataDir, ".npm-cache");
    return run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], {
      cwd: this.appDir, timeout: 10 * 60 * 1000, env: { ...process.env, npm_config_cache: cache, npm_config_update_notifier: "false" },
    });
  }

  /** Démarre la nouvelle version à côté (port libre, données vides) et attend qu'elle réponde. */
  async smokeTest(expectedVersion) {
    const port = await freePort();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "easydoc-check-"));
    const child = spawn(process.execPath, ["server.js"], {
      cwd: this.appDir, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PORT: String(port), DATA_DIR: tmp, LOCAL_REPO_DIR: path.join(tmp, "repo"), ENV_FILE: path.join(tmp, "none.env"),
        GITHUB_TOKEN: "", GITHUB_REPO: "", TRUST_PROXY: "", INVOCATION_ID: "", EASYDOC_SELF_UPDATE: "" },
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
    let exited = null;
    child.on("exit", (code) => { exited = code; });
    try {
      const deadline = Date.now() + 40000;
      while (Date.now() < deadline) {
        if (exited !== null) throw new Error(`la nouvelle version ne démarre pas : ${out.trim().split("\n").slice(-3).join(" ").slice(0, 400)}`);
        try {
          const r = await fetch(`http://127.0.0.1:${port}/api/health`);
          if (r.ok) {
            const d = await r.json();
            if (expectedVersion && d.version && !/^[0-9a-f]{7}$/.test(expectedVersion) && d.version !== expectedVersion) throw new Error(`version inattendue (${d.version})`);
            return;
          }
        } catch (e) { if (/version inattendue/.test(e.message)) throw e; }
        await new Promise((r) => setTimeout(r, 400));
      }
      throw new Error("la nouvelle version ne répond pas (délai dépassé).");
    } finally {
      try { child.kill("SIGKILL"); } catch (_e) {}
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

module.exports = { Updater, RESTART_CODE };
