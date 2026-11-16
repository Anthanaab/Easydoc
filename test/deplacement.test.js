// Renommer / déplacer des documents et des dossiers.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { startServer, waitFor, readRepo } = require("./helpers");

test("renommer / déplacer", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const { admin, member } = srv;
  const exists = (p) => fs.existsSync(path.join(srv.repoDir, p));

  await t.test("renommer un document ouvert : le texte, les commentaires et les participants suivent", async () => {
    await member.post("/api/create", { path: "notes/Ancien nom.md" });
    const c = await member.open("notes/Ancien nom.md");
    c.text.insert(c.text.length, "Un passage commenté.\n");
    await waitFor(() => readRepo(srv, "notes/Ancien nom.md").includes("Un passage commenté."));
    const full = readRepo(srv, "notes/Ancien nom.md");
    const at = full.indexOf("passage commenté");
    const cm = await member.post("/api/comments", { path: "notes/Ancien nom.md", text: "À revoir", quote: "passage commenté", start: at });
    assert.equal(cm.status, 200);
    c.text.insert(c.text.length, "Frappe juste avant le renommage.\n"); // pas encore enregistrée
    const r = await member.post("/api/move", { from: "notes/Ancien nom.md", to: "notes/Nouveau nom" });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.path, "notes/Nouveau nom.md", "extension gardée");
    assert.ok(!exists("notes/Ancien nom.md") && exists("notes/Nouveau nom.md"));
    const moved = readRepo(srv, "notes/Nouveau nom.md");
    assert.ok(moved.includes("Un passage commenté.") && moved.includes("Frappe juste avant le renommage."), JSON.stringify(moved));
    assert.equal(await waitFor(() => c.doc.getMap("meta").get("movedTo")), "notes/Nouveau nom.md", "les participants sont prévenus");
    const list = await member.get(`/api/comments?path=${encodeURIComponent("notes/Nouveau nom.md")}`);
    assert.equal(list.json.comments.length, 1, "le commentaire suit le document");
    const log = execFileSync("git", ["-C", srv.repoDir, "log", "-1", "--format=%s"]).toString();
    assert.match(log, /renommage/);
    c.close();
  });

  await t.test("renommer un dossier masqué : il reste masqué", async () => {
    await admin.post("/api/create", { path: "Secret/plan.md" });
    await admin.post("/api/create", { path: "Secret/sous/budget.md" });
    await admin.put("/api/admin/access", { path: "Secret", entries: { "*": "none" } });
    const r = await admin.post("/api/move", { from: "Secret", to: "Confidentiel" });
    assert.equal(r.status, 200, r.text);
    assert.ok(exists("Confidentiel/plan.md") && exists("Confidentiel/sous/budget.md") && !exists("Secret"));
    const raw = await member.get(`/api/raw?path=${encodeURIComponent("Confidentiel/plan.md")}`);
    assert.ok(raw.status >= 400, `le membre ne voit toujours pas le fichier (${raw.status})`);
    assert.ok(!/confidentiel/i.test((await member.get("/api/files")).text), "absent de la liste du membre");
  });

  await t.test("déplacer un document dans un autre dossier : ses images suivent", async () => {
    await member.post("/api/create", { path: "Rapport.md" });
    await member.upload("Rapport - images/schema.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const r = await member.post("/api/move", { from: "Rapport.md", to: "archives/Rapport.md" });
    assert.equal(r.status, 200, r.text);
    assert.ok(exists("archives/Rapport.md") && exists("archives/Rapport - images/schema.png"), "images déplacées avec le document");
    assert.ok(!exists("Rapport - images"));
  });

  await t.test("refus : nom déjà pris, dossier dans lui-même, extension changée, pas le droit", async () => {
    await member.post("/api/create", { path: "a.md" });
    await member.post("/api/create", { path: "b.md" });
    assert.equal((await member.post("/api/move", { from: "a.md", to: "b.md" })).status, 409);
    assert.equal((await member.post("/api/move", { from: "a.md", to: "a.pdf" })).status, 400);
    await member.post("/api/create", { path: "dossier/x.md" });
    assert.equal((await member.post("/api/move", { from: "dossier", to: "dossier/sous" })).status, 400);
    await admin.put("/api/admin/access", { path: "lecture", entries: { "*": "read" } });
    await admin.post("/api/create", { path: "lecture/doc.md" });
    assert.equal((await member.post("/api/move", { from: "lecture/doc.md", to: "doc.md" })).status, 403);
    assert.equal((await member.post("/api/move", { from: "a.md", to: "lecture/a.md" })).status, 403);
    assert.ok(exists("a.md") && exists("lecture/doc.md"), "rien n'a bougé");
  });
});
