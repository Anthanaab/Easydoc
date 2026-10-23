#!/usr/bin/env node
/**
 * cli.js — administration d'Easydoc en ligne de commande (à lancer sur le serveur).
 *
 *   node cli.js users                     liste des comptes
 *   node cli.js reset-password <login>    nouveau mot de passe (affiché), sessions fermées
 *   node cli.js create-admin <login>      crée un administrateur (mot de passe affiché)
 *
 * Le service n'a pas besoin d'être redémarré : il relit les comptes automatiquement.
 */
"use strict";

const path = require("path");
require("dotenv").config({ path: process.env.ENV_FILE || path.join(__dirname, ".env") });
const auth = require("./src/auth");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const users = new auth.UserStore(path.join(DATA_DIR, "users.json"));

function usage(code = 1) {
  console.log(`Utilisation :
  node cli.js users                     liste des comptes
  node cli.js reset-password <login>    définit un nouveau mot de passe et l'affiche
  node cli.js create-admin <login>      crée un compte administrateur`);
  process.exit(code);
}

(async () => {
  const [cmd, login] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") usage(cmd ? 0 : 1);

  if (cmd === "users") {
    const list = users.all();
    if (!list.length) { console.log("Aucun compte : le premier visiteur de l'interface créera le compte administrateur."); return; }
    for (const u of list) {
      console.log(`${u.username.padEnd(20)} ${(u.role === "admin" ? "administrateur" : "membre").padEnd(15)} ${u.disabled ? "désactivé  " : "actif      "} ${u.displayName}${u.groups && u.groups.length ? `  [${u.groups.join(", ")}]` : ""}`);
    }
    return;
  }

  if (cmd === "reset-password") {
    if (!login) usage();
    const u = users.byUsername(login);
    if (!u) { console.error(`Compte « ${login} » introuvable. Comptes existants : ${users.all().map((x) => x.username).join(", ") || "aucun"}`); process.exit(2); }
    const password = auth.generatePassword();
    await users.update(u.id, { password, disabled: false });
    console.log(`Nouveau mot de passe pour ${u.username} : ${password}`);
    console.log("Ses sessions ouvertes sont fermées. Il pourra le changer depuis « Mon compte ».");
    return;
  }

  if (cmd === "create-admin") {
    if (!login) usage();
    const password = auth.generatePassword();
    const u = await users.create({ username: login, displayName: login, password, role: "admin" });
    console.log(`Administrateur ${u.username} créé. Mot de passe : ${password}`);
    return;
  }

  usage();
})().catch((e) => { console.error("Erreur :", e.message); process.exit(1); });
