// Tests de perte de données : chaque scénario est rejoué contre un serveur isolé.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { startServer, waitFor, sleep, externalCommit, readRepo } = require("./helpers");

test("perte de données", async (t) => {
  const srv = await startServer({ AUTOSAVE_MS: "400", POLL_MS: "600000" }); // pas de détection automatique : cas le plus dur
  t.after(() => srv.stop());
  const { admin, member } = srv;

  await t.test("une modification externe pas encore détectée n'est pas écrasée par l'enregistrement", async () => {
    const p = "notes/externe.md";
    await member.post("/api/create", { path: p });
    const c = await member.open(p);
    c.text.insert(c.text.length, "Ligne tapée dans Easydoc.\n");
    externalCommit(srv, p, readRepo(srv, p) + "Ligne ajoutée par l'agent.\n", "agent");
    const ok = await waitFor(() => { const d = readRepo(srv, p); return d.includes("Ligne tapée dans Easydoc.") && d.includes("Ligne ajoutée par l'agent.") && d; });
    assert.ok(ok, JSON.stringify(readRepo(srv, p)));
    assert.ok(c.text.toString().includes("Ligne ajoutée par l'agent."), "le document ouvert reçoit la modification externe");
    c.close();
  });

  await t.test("l'enregistrement échoue quand le dernier participant part : secours, puis enregistrement", async () => {
    if (process.getuid && process.getuid() === 0) { t.skip("root écrit malgré les droits du fichier"); return; }
    const p = "notes/secours.md";
    await member.post("/api/create", { path: p });
    const full = path.join(srv.repoDir, p);
    const c = await member.open(p);
    fs.chmodSync(full, 0o444); // écriture impossible
    c.text.insert(c.text.length, "Texte à ne pas perdre.\n");
    await sleep(100);
    c.close(); // dernier participant parti : le serveur tente d'enregistrer, échoue
    const recov = path.join(srv.dataDir, "recovery");
    assert.ok(await waitFor(() => fs.existsSync(recov) && fs.readdirSync(recov).length > 0, { timeout: 8000 }), "secours gardé sur le disque");
    const c2 = await member.open(p);
    assert.ok(c2.text.toString().includes("Texte à ne pas perdre."), "rouvert : le texte non enregistré est là");
    fs.chmodSync(full, 0o644);
    assert.ok(await waitFor(() => readRepo(srv, p).includes("Texte à ne pas perdre.")), "enregistré une fois l'écriture possible");
    assert.ok(await waitFor(() => fs.readdirSync(recov).length === 0), "secours effacé après l'enregistrement");
    c2.close();
  });

  await t.test("enregistrement hors ligne : fusionné avec la version des autres, conflit refusé", async () => {
    const p = "notes/hors-ligne.md";
    await member.post("/api/create", { path: p });
    const base = readRepo(srv, p) + "un\ndeux\ntrois\nquatre\ncinq\n";
    externalCommit(srv, p, base, "base");
    externalCommit(srv, p, base.replace("cinq", "CINQ (autre)"), "autre");
    const r = await member.post("/api/save", { path: p, base, content: base.replace("un", "UN (hors ligne)") });
    assert.equal(r.status, 200);
    assert.ok(readRepo(srv, p).includes("UN (hors ligne)") && readRepo(srv, p).includes("CINQ (autre)"), readRepo(srv, p));
    const r2 = await member.post("/api/save", { path: p, base, content: base.replace("cinq", "CINQ (moi)") });
    assert.equal(r2.status, 409);
    assert.ok(!readRepo(srv, p).includes("CINQ (moi)"));
  });

  await t.test("restaurer une ancienne version d'une image : octets identiques", async () => {
    const p = "notes/image.png";
    const v1 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28]);
    await admin.upload(p, v1);
    await admin.upload(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), true);
    const shas = execFileSync("git", ["-C", srv.repoDir, "log", "--format=%H", "--", p]).toString().trim().split("\n");
    const r = await admin.post("/api/restore", { path: p, sha: shas[shas.length - 1] });
    assert.equal(r.status, 200);
    assert.equal(Buffer.compare(fs.readFileSync(path.join(srv.repoDir, p)), v1), 0);
  });

  await t.test("restaurer un document ouvert ne duplique pas son texte", async () => {
    const p = "notes/restauration.md";
    await member.post("/api/create", { path: p });
    externalCommit(srv, p, "# restauration\n\nversion 1\n", "v1");
    const c = await member.open(p);
    await member.post("/api/sync");
    await waitFor(() => c.text.toString().includes("version 1"));
    c.text.insert(c.text.length, "version 2\n");
    await waitFor(() => readRepo(srv, p).includes("version 2"));
    const shas = execFileSync("git", ["-C", srv.repoDir, "log", "--format=%H", "--", p]).toString().trim().split("\n");
    const v1sha = shas.find((s) => execFileSync("git", ["-C", srv.repoDir, "show", `${s}:${p}`]).toString() === "# restauration\n\nversion 1\n");
    assert.equal((await member.post("/api/restore", { path: p, sha: v1sha })).status, 200);
    externalCommit(srv, p, "# restauration\n\nversion 1\nversion agent\n", "agent après restauration");
    await member.post("/api/sync");
    const final = await waitFor(() => { const s = c.text.toString(); return s.includes("version agent") && s; });
    assert.equal(final, "# restauration\n\nversion 1\nversion agent\n");
    c.close();
  });
});
