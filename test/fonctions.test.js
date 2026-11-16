// Fonctions de travail en équipe : recherche, liens après déplacement, relecteurs, mentions,
// notifications, page d'accueil, modèles, aperçu d'une ancienne version.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { startServer, waitFor, readRepo } = require("./helpers");

test("travail en équipe", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const { admin, member } = srv;

  await t.test("recherche : sans accents ni majuscules, regroupée par document", async () => {
    await member.post("/api/create", { path: "notes/Été.md", content: "# Été\n\nL'ÉTÉ arrive.\nUn été chaud.\n" });
    await member.post("/api/create", { path: "notes/Autre.md", content: "# Autre\n\nRien à voir.\n" });
    const r = await member.get("/api/search?q=" + encodeURIComponent("ete"));
    assert.equal(r.status, 200);
    const g = r.json.results.find((x) => x.path === "notes/Été.md");
    assert.ok(g, JSON.stringify(r.json.results));
    assert.equal(g.byName, true);
    assert.equal(g.count, 3);
    assert.equal(g.matches[1].match, "ÉTÉ");
    assert.ok(!r.json.results.some((x) => x.path === "notes/Autre.md"));
  });

  await t.test("modèle : le contenu de départ remplace {{titre}}", async () => {
    const r = await member.post("/api/create", { path: "notes/Réunion du lundi", content: "# {{titre}}\n\n**Date :** {{date}}\n" });
    assert.equal(r.status, 200);
    assert.match(readRepo(srv, "notes/Réunion du lundi.md"), /^# Réunion du lundi\n\n\*\*Date :\*\* \d/);
  });

  await t.test("liens : renommer ou déplacer met à jour les liens qui y mènent (et ceux du document déplacé)", async () => {
    await member.post("/api/create", { path: "guides/Installer.md", content: "# Installer\n\nRetour au [sommaire](../Sommaire.md).\n" });
    await member.post("/api/create", { path: "Sommaire.md", content: "# Sommaire\n\n- [Installer](guides/Installer.md#etapes)\n- [Site](https://exemple.fr/guides/Installer.md)\n" });
    const r = await member.post("/api/move", { from: "guides/Installer.md", to: "archives/2026/Installation.md" });
    assert.equal(r.status, 200, r.text);
    assert.ok(await waitFor(() => readRepo(srv, "Sommaire.md").includes("archives/2026/Installation.md#etapes")), readRepo(srv, "Sommaire.md"));
    assert.ok(readRepo(srv, "Sommaire.md").includes("https://exemple.fr/guides/Installer.md"), "lien externe intact");
    assert.ok(await waitFor(() => readRepo(srv, "archives/2026/Installation.md").includes("](../../Sommaire.md)")));
  });

  await t.test("relecteurs : « lecture et commentaires » permet de commenter, pas de modifier", async () => {
    await admin.post("/api/create", { path: "relu/Texte.md", content: "# Texte\n\nPassage à relire.\n" });
    assert.equal((await admin.put("/api/admin/access", { path: "relu", entries: { "*": "comment" } })).status, 200);
    const at = readRepo(srv, "relu/Texte.md").indexOf("Passage");
    const c = await member.post("/api/comments", { path: "relu/Texte.md", text: "Une remarque", quote: "Passage", start: at });
    assert.equal(c.status, 200, c.text);
    assert.equal((await member.upload("relu/Texte.md", Buffer.from("piraté"), true)).status, 403);
    assert.equal((await member.post("/api/save", { path: "relu/Texte.md", content: "piraté", base: "" })).status, 403);
    const files = await member.get("/api/files");
    assert.equal(files.json.files.find((f) => f.path === "relu/Texte.md").access, "comment");
  });

  await t.test("mentions et réponses : notifications de la personne concernée seulement", async () => {
    await admin.post("/api/create", { path: "equipe/Plan.md", content: "# Plan\n\nObjectif du trimestre.\n" });
    const at = readRepo(srv, "equipe/Plan.md").indexOf("Objectif");
    const c = await admin.post("/api/comments", { path: "equipe/Plan.md", text: "@membre-test tu peux relire ?", quote: "Objectif", start: at });
    assert.equal(c.status, 200);
    let n = await member.get("/api/notifications");
    assert.equal(n.json.unread, 1);
    assert.equal(n.json.notifications[0].kind, "mention");
    assert.equal(n.json.notifications[0].cid, c.json.comment.id);
    assert.equal((await admin.get("/api/notifications")).json.unread, 0, "pas de notification pour soi-même");
    // réponse : l'auteur de la discussion est prévenu
    await member.post("/api/comments/reply", { path: "equipe/Plan.md", id: c.json.comment.id, text: "Oui, c'est fait." });
    const na = await admin.get("/api/notifications");
    assert.equal(na.json.unread, 1);
    assert.equal(na.json.notifications[0].kind, "reply");
    // lu
    assert.equal((await member.post("/api/notifications/read", {})).status, 200);
    n = await member.get("/api/notifications");
    assert.equal(n.json.unread, 0);
    // document masqué : pas de notification
    await admin.put("/api/admin/access", { path: "secret", entries: { "*": "none" } });
    await admin.post("/api/create", { path: "secret/Note.md", content: "# Note\n\nConfidentiel.\n" });
    const at2 = readRepo(srv, "secret/Note.md").indexOf("Confidentiel");
    await admin.post("/api/comments", { path: "secret/Note.md", text: "@membre-test regarde", quote: "Confidentiel", start: at2 });
    assert.equal((await member.get("/api/notifications")).json.unread, 0);
  });

  await t.test("accueil : documents modifiés récemment, selon les droits", async () => {
    const r = await member.get("/api/recent");
    assert.equal(r.status, 200);
    const paths = r.json.recent.map((x) => x.path);
    assert.ok(paths.includes("equipe/Plan.md"));
    assert.ok(!paths.includes("secret/Note.md"), "document masqué absent");
    assert.ok(!paths.includes("guides/Installer.md"), "ancien nom absent");
  });

  await t.test("historique : texte complet d'une ancienne version", async () => {
    const c = await member.open("notes/Autre.md");
    c.text.insert(c.text.length, "Ajout.\n");
    await waitFor(() => readRepo(srv, "notes/Autre.md").includes("Ajout."));
    c.close();
    const shas = execFileSync("git", ["-C", srv.repoDir, "log", "--format=%H", "--", "notes/Autre.md"]).toString().trim().split("\n");
    const old = await member.get(`/api/history/content?path=${encodeURIComponent("notes/Autre.md")}&sha=${shas[shas.length - 1]}`);
    assert.equal(old.status, 200);
    assert.equal(old.json.content, "# Autre\n\nRien à voir.\n");
    assert.equal((await member.get(`/api/history/content?path=${encodeURIComponent("secret/Note.md")}&sha=${shas[0]}`)).status, 404);
  });
});

test("liens : réécriture (fonction pure)", () => {
  const { rewrite } = require("../src/links");
  const exists = new Set(["a/x.md", "a/y.md", "img/p.png", "a/z (v2).md"]);
  const moved = new Map([["a/x.md", "b/c/x.md"]]);
  assert.equal(rewrite("[X](x.md) [Y](y.md) [W](https://w.fr/x.md) [Z](zz.md)", "a/y.md", "a/y.md", moved, exists),
    "[X](../b/c/x.md) [Y](y.md) [W](https://w.fr/x.md) [Z](zz.md)");
  assert.equal(rewrite("[Y](y.md) ![P](/img/p.png) [V](z%20%28v2%29.md) [ancre](#t)", "a/x.md", "b/c/x.md", moved, exists),
    "[Y](../../a/y.md) ![P](/img/p.png) [V](../../a/z%20%28v2%29.md) [ancre](#t)");
});

test("Markdown → HTML : rien de ce qui est écrit dans un document ne devient du code", () => {
  const r = require("esbuild").buildSync({ entryPoints: [path.join(__dirname, "..", "client", "markdown-html.js")], bundle: true, format: "cjs", write: false, platform: "node" });
  const m = { exports: {} };
  new Function("module", "exports", "require", r.outputFiles[0].text)(m, m.exports, require);
  const html = m.exports.markdownToHtml("# T\n\n<script>alert(1)</script>\n\n**g** [l](a.md) <img src=x onerror=alert(1)>\n\n| A |\n| - |\n| 1 |\n");
  assert.ok(!/<script|<img src=x/i.test(html), html);
  assert.match(html, /<h1 id="t">T<\/h1>/);
  assert.match(html, /<strong>g<\/strong> <a href="a.md">l<\/a>/);
  assert.match(html, /<table>[\s\S]*<th>A<\/th>[\s\S]*<td>1<\/td>/);
  assert.ok(fs.existsSync(path.join(__dirname, "..", "public", "vendor", "libs.js")));
});
