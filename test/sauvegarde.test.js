// Sauvegardes : l'archive se relit avec un « tar » standard et suffit à remonter une instance complète.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { startServer, waitFor, readRepo } = require("./helpers");

test("sauvegarde", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const { admin, member } = srv;

  // des données à sauvegarder : un document, un commentaire, une règle d'accès, un fichier exclu
  await member.post("/api/create", { path: "notes/À garder.md" });
  const c = await member.open("notes/À garder.md");
  c.text.insert(c.text.length, "Texte important.\n");
  await waitFor(() => readRepo(srv, "notes/À garder.md").includes("Texte important."));
  const at = readRepo(srv, "notes/À garder.md").indexOf("Texte important");
  await member.post("/api/comments", { path: "notes/À garder.md", text: "Commentaire à garder", quote: "Texte important", start: at });
  c.close();
  await admin.put("/api/admin/access", { path: "Privé", entries: { "*": "none" } });
  fs.mkdirSync(path.join(srv.dataDir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(srv.dataDir, "bin", "cloudflared"), "programme retéléchargeable");

  await t.test("réservé aux administrateurs", async () => {
    assert.equal((await member.get("/api/admin/backups")).status, 403);
    assert.equal((await member.post("/api/admin/backups")).status, 403);
  });

  let archive;
  await t.test("créer, lister, télécharger", async () => {
    const r = await admin.post("/api/admin/backups");
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.name, /^easydoc-\d{4}-\d{2}-\d{2}-\d{4}(-\d+)?\.tar\.gz$/);
    const list = await admin.get("/api/admin/backups");
    assert.ok(list.json.list.some((b) => b.name === r.json.name));
    const dl = await fetch(`${srv.base}/api/admin/backups/download?name=${encodeURIComponent(r.json.name)}`, { headers: { Cookie: admin.cookie } });
    assert.equal(dl.status, 200);
    const buf = Buffer.from(await dl.arrayBuffer());
    assert.equal(buf[0], 0x1f); assert.equal(buf[1], 0x8b); // gzip
    archive = path.join(os.tmpdir(), `easydoc-test-archive-${Date.now()}.tar.gz`);
    fs.writeFileSync(archive, buf);
    assert.equal((await admin.get("/api/admin/backups/download?name=..%2Fusers.json")).status, 404, "pas d'accès hors des sauvegardes");
  });

  await t.test("l'archive se relit avec tar et contient ce qu'il faut (sans le superflu)", async () => {
    const names = execFileSync("tar", ["-tzf", archive], { cwd: path.dirname(archive) }).toString().split(/\r?\n/).filter(Boolean);
    for (const n of ["users.json", "access.json", "comments.json", "localrepo/.git/HEAD"]) assert.ok(names.includes(n), `${n} présent`);
    assert.ok(names.some((n) => n.startsWith("localrepo/notes/")), "documents du dépôt local présents");
    assert.ok(!names.some((n) => n.startsWith("bin/") || n.startsWith("backups/")), "programme et anciennes sauvegardes exclus");
  });

  await t.test("restauration : une nouvelle instance repart avec comptes, documents, commentaires et droits", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "easydoc-test-restaure-"));
    execFileSync("tar", ["-xzf", path.basename(archive), "-C", dir], { cwd: path.dirname(archive) });
    const copy = await startServer({}, { dataDir: dir, password: srv.password });
    try {
      const doc = await copy.member.get(`/api/raw?path=${encodeURIComponent("notes/À garder.md")}`);
      assert.equal(doc.status, 200);
      assert.ok(doc.text.includes("Texte important."));
      const cm = await copy.member.get(`/api/comments?path=${encodeURIComponent("notes/À garder.md")}`);
      assert.equal(cm.json.comments[0].text, "Commentaire à garder");
      const rules = await copy.admin.get("/api/admin/access");
      assert.ok(JSON.stringify(rules.json).includes("Privé"), "règle d'accès restaurée");
      const log = execFileSync("git", ["-C", path.join(dir, "localrepo"), "log", "--oneline"]).toString();
      assert.ok(log.split("\n").filter(Boolean).length >= 2, "historique git restauré");
    } finally { await copy.stop(); fs.rmSync(archive, { force: true }); }
  });

  await t.test("réglages : nombre de sauvegardes gardées", async () => {
    for (let i = 0; i < 3; i++) await admin.post("/api/admin/backups");
    const r = await admin.put("/api/admin/backups", { auto: false, keep: 2 });
    assert.equal(r.status, 200);
    assert.equal(r.json.list.length, 2, "les plus anciennes sont supprimées");
    assert.equal(r.json.auto, false);
  });
});
