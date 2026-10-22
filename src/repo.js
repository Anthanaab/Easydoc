/**
 * repo.js — accès aux fichiers du dépôt.
 *
 * Deux modes :
 *  - github : jeton + dépôt renseignés → API GitHub (chaque enregistrement = un commit).
 *  - local  : dépôt git local dans localRepoDir, 100 % auto-hébergé.
 *
 * Les chemins reçus ici sont déjà validés par safeFilePath() (voir paths.js).
 * Le contenu écrit peut être du texte (documents) ou un Buffer (PDF, Word, images…).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { Octokit } = require("@octokit/rest");
const { simpleGit } = require("simple-git");
const { isHidden } = require("./paths");

const toBuf = (c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c), "utf8"));

class RepoService {
  constructor(options) {
    this.options = { ...options };
    this.mode = "local";
    this.git = null;
    this.octokit = null;
  }

  async init() {
    await this.switch(this.options);
  }

  /** Bascule le dépôt actif à chaud (démarrage ET réglages de l'interface). */
  async switch(opts) {
    this.options = { ...this.options, ...opts };
    this.mode = this.options.githubRepo && this.options.githubToken ? "github" : "local";
    if (this.mode === "github") {
      this.octokit = new Octokit({ auth: this.options.githubToken });
      this.git = null;
      return;
    }
    this.octokit = null;
    const dir = this.options.localRepoDir;
    fs.mkdirSync(dir, { recursive: true });
    this.git = simpleGit(dir);
    if (!fs.existsSync(path.join(dir, ".git"))) await this.git.init();
    try { await this.git.addConfig("user.name", "Easydoc", false, "local"); } catch (_e) {}
    try { await this.git.addConfig("user.email", "easydoc@local", false, "local"); } catch (_e) {}
  }

  _split() {
    const [owner, repo] = this.options.githubRepo.split("/");
    return { owner, repo };
  }

  _local(rel) {
    const root = path.resolve(this.options.localRepoDir);
    const full = path.resolve(root, rel);
    if (full !== root && !full.startsWith(root + path.sep)) throw new Error("chemin refusé");
    return full;
  }

  /** SHA du dernier commit de la branche (sert à détecter les modifications externes). */
  async headSha() {
    if (this.mode !== "github") return null;
    const { owner, repo } = this._split();
    try {
      const { data } = await this.octokit.rest.repos.getBranch({ owner, repo, branch: this.options.githubBranch });
      return data.commit.sha;
    } catch (e) {
      if (e.status === 404 || e.status === 409) return null; // dépôt vide
      throw e;
    }
  }

  /** Liste de tous les fichiers (hors fichiers et dossiers cachés). */
  async listFiles() {
    if (this.mode === "github") {
      const { owner, repo } = this._split();
      try {
        const { data } = await this.octokit.rest.git.getTree({
          owner, repo, tree_sha: this.options.githubBranch, recursive: "1",
        });
        return (data.tree || [])
          .filter((t) => t.type === "blob" && !isHidden(t.path))
          .map((t) => ({ path: t.path, size: t.size || 0 }));
      } catch (e) {
        if (e.status === 404 || e.status === 409) return []; // dépôt vide / branche absente
        throw e;
      }
    }
    const out = [];
    const walk = (dir, prefix) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name.startsWith(".") || ent.name === "node_modules") continue;
        const full = path.join(dir, ent.name);
        const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
        if (ent.isDirectory()) walk(full, rel);
        else if (ent.isFile()) out.push({ path: rel, size: fs.statSync(full).size });
      }
    };
    walk(this.options.localRepoDir, "");
    return out;
  }

  /** Lit un fichier brut. Retourne { buf, sha } ou null. */
  async readRaw(rel) {
    if (this.mode === "github") {
      const { owner, repo } = this._split();
      try {
        const { data } = await this.octokit.rest.repos.getContent({
          owner, repo, path: rel, ref: this.options.githubBranch,
          headers: { "If-None-Match": "" }, // pas de cache HTTP : on veut la dernière version
        });
        if (Array.isArray(data) || data.type !== "file") return null;
        let buf;
        if (data.encoding === "base64" && data.content) buf = Buffer.from(data.content, "base64");
        else if (!data.size) buf = Buffer.alloc(0);
        else {
          // fichiers > 1 Mo : contenu via l'API blobs
          const blob = await this.octokit.rest.git.getBlob({ owner, repo, file_sha: data.sha });
          buf = Buffer.from(blob.data.content, "base64");
        }
        return { buf, sha: data.sha };
      } catch (e) {
        if (e.status === 404 || e.status === 409) return null;
        throw e;
      }
    }
    const full = this._local(rel);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
    return { buf: fs.readFileSync(full), sha: null };
  }

  /** Lit un document texte. Retourne { content, sha } ou null. */
  async readFile(rel) {
    const r = await this.readRaw(rel);
    return r ? { content: r.buf.toString("utf8"), sha: r.sha } : null;
  }

  /** Écrit un fichier (github : commit ; local : écriture + commit). Ne fait rien si inchangé. */
  async writeFile(rel, content, message) {
    const buf = toBuf(content);
    if (this.mode === "github") {
      const { owner, repo } = this._split();
      for (let attempt = 0; attempt < 3; attempt++) {
        const exist = await this.readRaw(rel);
        if (exist && exist.buf.equals(buf)) return { committed: false };
        const body = {
          owner, repo, path: rel, message, branch: this.options.githubBranch,
          content: buf.toString("base64"),
        };
        if (exist) body.sha = exist.sha;
        try {
          const { data } = await this.octokit.rest.repos.createOrUpdateFileContents(body);
          return { committed: true, commit: data.commit && data.commit.sha };
        } catch (e) {
          if ((e.status === 409 || e.status === 422) && attempt < 2) continue; // sha périmé : on relit
          throw e;
        }
      }
    }
    const full = this._local(rel);
    if (fs.existsSync(full) && fs.readFileSync(full).equals(buf)) return { committed: false };
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, buf);
    try {
      await this.git.add(rel);
      await this.git.commit(message);
    } catch (e) {
      console.error("[git] commit :", e.message.split("\n")[0]);
    }
    return { committed: true };
  }

  /** Supprime un fichier. */
  async deleteFile(rel, message) {
    if (this.mode === "github") {
      const { owner, repo } = this._split();
      const exist = await this.readRaw(rel);
      if (!exist) return { deleted: false };
      await this.octokit.rest.repos.deleteFile({
        owner, repo, path: rel, message, sha: exist.sha, branch: this.options.githubBranch,
      });
      return { deleted: true };
    }
    const full = this._local(rel);
    if (!fs.existsSync(full)) return { deleted: false };
    fs.unlinkSync(full);
    // supprime les dossiers devenus vides
    let dir = path.dirname(full);
    const root = path.resolve(this.options.localRepoDir);
    while (dir !== root && dir.startsWith(root) && fs.readdirSync(dir).length === 0) { fs.rmdirSync(dir); dir = path.dirname(dir); }
    try {
      await this.git.rm(rel);
      await this.git.commit(message);
    } catch (e) {
      console.error("[git] suppression :", e.message.split("\n")[0]);
    }
    return { deleted: true };
  }

  /** Crée quelques documents de départ si le dépôt est vide. */
  async seedIfEmpty() {
    const files = await this.listFiles();
    if (files.length > 0) return false;
    const seed = {
      "README.md":
        "# Bienvenue\n\nCet espace est partagé : chaque document est un fichier du dépôt,\n" +
        "édité à plusieurs en temps réel et enregistré automatiquement (un commit par enregistrement).\n\n" +
        "## Pour commencer\n\n- Crée un document avec le bouton **Nouveau document**\n" +
        "- Importe des PDF, des fichiers Word ou des images (bouton d'import ou glisser-déposer)\n" +
        "- Organise-les en dossiers : `notes/idees.md`, `specs/v1.md`…\n" +
        "- Un agent IA (Claude…) peut travailler sur le même dépôt : ses commits apparaissent ici automatiquement.\n",
      "CLAUDE.md":
        "# Consignes pour l'agent IA\n\n" +
        "Ce dépôt est un espace de documentation collaboratif édité par des humains via Easydoc.\n\n" +
        "- Lis les documents existants avant de proposer quoi que ce soit.\n" +
        "- Écris tes propositions et comptes rendus dans `notes/agent.md` (ajoute en bas, date chaque entrée).\n" +
        "- Ne réécris pas un document entier sans qu'on te le demande : modifie les sections concernées.\n" +
        "- Fais des commits courts et explicites.\n",
      "notes/agent.md": "# Notes de l'agent\n\n> Propositions, questions et comptes rendus de l'agent IA.\n",
    };
    for (const [p, c] of Object.entries(seed)) {
      await this.writeFile(p, c, `Easydoc : création de ${p}`);
    }
    return true;
  }
}

module.exports = { RepoService };
