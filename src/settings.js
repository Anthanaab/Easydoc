/**
 * settings.js — configuration persistante de la plateforme (dépôt GitHub connecté).
 *
 * Fichier : <app>/data/config.json (chmod 600, jamais versionné — voir .gitignore).
 * Les variables d'environnement servent de valeurs initiales tant que ce fichier
 * n'existe pas ; dès la première sauvegarde depuis l'interface, la config fichier
 * fait foi (l'utilisateur peut connecter/ changer de dépôt sans redémarrer).
 */
"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULTS = { githubToken: "", githubRepo: "", githubBranch: "", version: 0 };

class SettingsStore {
  constructor(file) {
    this.file = file;
    this.data = { ...DEFAULTS };
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
        this.data = { ...DEFAULTS, ...raw };
      }
    } catch (e) {
      console.error("[settings] lecture impossible:", e.message);
    }
    this.data.version = Number(this.data.version || 0);
    return this.data;
  }

  exists() {
    return fs.existsSync(this.file);
  }

  /** Enregistre et incrémente la version (sert de signal de reconnexion côté client). */
  save(partial) {
    this.data = { ...this.data, ...partial };
    this.data.version = (Number(this.data.version || 0) + 1) % 1_000_000;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data, null, 2));
    fs.renameSync(`${this.file}.tmp`, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch (_e) {}
    return this.data;
  }

  get() {
    return this.data;
  }
}

module.exports = { SettingsStore, DEFAULTS };