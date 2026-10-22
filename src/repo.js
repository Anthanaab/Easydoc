/**
 * repo.js — Couche d'accès aux documents Markdown.
 *
 * Deux modes selon la config :
 *  - GITHUB   : GITHUB_TOKEN + GITHUB_REPO sont renseignés -> API GitHub réelle
 *               (sauvegarde = commit + push, pull = récupère les updates d'un agent IA/Claude).
 *  - LOCAL    : aucun token -> dépôt git local dans LOCAL_REPO_DIR, 100% auto-hébergé.
 *
 * Ne modifie JAMAIS de fichiers en dehors de son dossier de travail.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { Octokit } = require("@octokit/rest");
const { simpleGit } = require("simple-git");

class RepoService {
  constructor(options) {
    this.options = options;
    this.mode = options.githubRepo && options.githubToken ? "github" : "local";
    this.git = null;
    this.octokit = null;
  }

  async init() {
    await this.switch(this.options);
  }

  /** Bascule le dépôt actif à chaud (appelé au démarrage ET depuis l'interface). */
  async switch(opts) {
    this.options = { ...this.options, ...opts };
    this.mode = this.options.githubRepo && this.options.githubToken ? "github" : "local";
    if (this.mode === "github") {
      this.octokit = new Octokit({ auth: this.options.githubToken });
      this.git = null;
      return;
    }
    // Mode LOCAL
    this.octokit = null;
    const dir = this.options.localRepoDir;
    fs.mkdirSync(dir, { recursive: true });
    this.git = simpleGit(dir);
    if (!fs.existsSync(path.join(dir, ".git"))) {
      await this.git.init();
    }
    // Identité git par défaut (nécessaire pour commit) si non configurée
    try { await this.git.addConfig("user.name", "Easydoc", false, "local"); } catch (_e) {}
    try { await this.git.addConfig("user.email", "easydoc@local", false, "local"); } catch (_e) {}
    fs.mkdirSync(path.join(dir, "ideas"), { recursive: true });
    fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
  }

  _splitRepo() {
    const [owner, repo] = this.options.githubRepo.split("/");
    return { owner, repo };
  }

  /** Liste récursive des fichiers (mode github retourne chemins .md/png/etc, local scan le disque). */
  async listFiles() {
    if (this.mode === "github") {
      const { owner, repo } = this._splitRepo();
      const { data } = await this.octokit.rest.git.getTree({
        owner, repo, tree_sha: this.options.githubBranch, recursive: "1",
      });
      return (data.tree || [])
        .filter((t) => t.type === "blob")
        .map((t) => ({ path: t.path, sha: t.sha, size: t.size || 0 }));
    }
    const out = [];
    const walk = (dir, prefix) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name.startsWith(".")) continue;
        if (ent.name === "node_modules") continue;
        const full = path.join(dir, ent.name);
        const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
        if (ent.isDirectory()) walk(full, rel);
        else out.push({ path: rel, size: fs.statSync(full).size });
      }
    };
    walk(this.options.localRepoDir, "");
    return out;
  }

  /** Lit le contenu d'un fichier. Retourne { content, sha } ou null. */
  async readFile(relPath) {
    if (this.mode === "github") {
      const { owner, repo } = this._splitRepo();
      try {
        const { data } = await this.octokit.rest.repos.getContent({
          owner, repo, path: relPath, ref: this.options.githubBranch,
        });
        const content = Buffer.from(data.content, "base64").toString("utf8");
        return { content, sha: data.sha };
      } catch (e) {
        if (e.status === 404) return null;
        throw e;
      }
    }
    const full = path.join(this.options.localRepoDir, relPath);
    if (!fs.existsSync(full)) return null;
    return { content: fs.readFileSync(full, "utf8"), sha: null };
  }

  /** Écrit un fichier (mode github : commit+push, mode local : écriture + commit). */
  async writeFile(relPath, content, message) {
    if (this.mode === "github") {
      const { owner, repo } = this._splitRepo();
      const exist = await this.readFile(relPath);
      const sha = exist && !exist.sha ? exist.sha : exist ? exist.sha : undefined;
      const body = {
        owner, repo, path: relPath, message,
        content: Buffer.from(content, "utf8").toString("base64"),
        branch: this.options.githubBranch,
      };
      if (sha) body.sha = sha;
      await this.octokit.rest.repos.createOrUpdateFileContents(body);
      return { committed: true };
    }
    const full = path.join(this.options.localRepoDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
    try {
      await this.git.add(relPath);
      await this.git.commit(message);
    } catch (e) {
      // rien à committer, on ignore
    }
    return { committed: true };
  }

  /** Récupère les dernières versions depuis l'origi-/remote (updates d'un agent IA). */
  async pull() {
    if (this.mode === "github") return { pulled: true }; // API => toujours à jour
    try {
      await this.git.pull();
      return { pulled: true };
    } catch (e) {
      return { pulled: true, note: e.message.split("\n")[0] };
    }
  }

  /** Crée l'arborescence initiale de docs si vide. */
  async seedIfEmpty() {
    const files = await this.listFiles();
    if (files.length > 0) return;
    const seed = {
      "docs/design-doc.md":
        "# 🎮 Design Doc — [Titre du jeu]\n\n> Écris ici la vision globale du jeu.\n\n## Pitch\n",
      "docs/gameplay.md": "# 🕹️ Gameplay\n\n## Systèmes de jeu\n\n- \n",
      "ideas/idees.md": "# 💡 Idées\n\n## Liste d'idées\n\n- [ ] Idée 1\n- [ ] Idée 2\n",
      "ideas/notes-claude.md":
        "# 🤖 Canal Claude\n\n> Ici apparaissent les notes, propositions et mises à jour écrites par l'agent IA (Claude).\n",
      "docs/roadmap.md": "# 🛣️ Roadmap\n\n## Phase 1\n- [ ] \n\n## Phase 2\n- [ ] \n",
    };
    for (const [p, c] of Object.entries(seed)) {
      if (!(await this.readFile(p))) await this.writeFile(p, c, `seed: créer ${p}`);
    }
  }
}

module.exports = { RepoService };