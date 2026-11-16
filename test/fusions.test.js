// Fusions des modifications externes avec une saisie pas encore enregistrée (enregistrement
// automatique désactivé pour ce serveur : la saisie reste « en cours » pendant tout le test).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { startServer, waitFor, sleep, externalCommit, readRepo } = require("./helpers");

test("fusions", async (t) => {
  const srv = await startServer({ AUTOSAVE_MS: "600000", POLL_MS: "600000" });
  t.after(() => srv.stop());
  const { member } = srv;

  await t.test("deux modifications externes successives n'effacent pas la saisie en cours", async () => {
    const p = "notes/deux-fusions.md";
    await member.post("/api/create", { path: p });
    externalCommit(srv, p, "# deux-fusions\n\nPara un.\n\nPara deux.\n\nPara trois.\n", "base");
    const c = await member.open(p);
    await member.post("/api/sync");
    await waitFor(() => c.text.toString().includes("Para trois."));
    // saisie locale (pas encore enregistrée)
    const i = c.text.toString().indexOf("Para un.") + "Para un.".length;
    c.text.insert(i, " TEXTE LOCAL");
    await sleep(300);
    // un agent modifie deux fois le fichier ; chaque version est fusionnée dans le document ouvert
    externalCommit(srv, p, "# deux-fusions\n\nPara un.\n\nPara deux.\n\nPara trois. Agent 1.\n", "agent 1");
    await member.post("/api/sync");
    await waitFor(() => c.text.toString().includes("Agent 1."));
    externalCommit(srv, p, "# deux-fusions\n\nPara un.\n\nPara deux. Agent 2.\n\nPara trois. Agent 1.\n", "agent 2");
    await member.post("/api/sync");
    await waitFor(() => c.text.toString().includes("Agent 2."));
    const txt = c.text.toString();
    assert.ok(txt.includes("Para un. TEXTE LOCAL"), "saisie en cours conservée : " + JSON.stringify(txt));
    assert.ok(txt.includes("Agent 1.") && txt.includes("Agent 2."), "les deux versions de l'agent intégrées : " + JSON.stringify(txt));
    c.close();
  });

  await t.test("supprimer un document efface aussi son secours (il ne réapparaît pas)", async () => {
    if (process.getuid && process.getuid() === 0) { t.skip("root écrit malgré les droits du fichier"); return; }
    const p = "notes/a-supprimer.md";
    await member.post("/api/create", { path: p });
    const full = path.join(srv.repoDir, p);
    const c = await member.open(p);
    fs.chmodSync(full, 0o444);
    c.text.insert(c.text.length, "Texte jamais enregistré.\n");
    await sleep(100);
    c.close(); // échec d'enregistrement à la fermeture : secours
    const recov = path.join(srv.dataDir, "recovery");
    assert.ok(await waitFor(() => fs.existsSync(recov) && fs.readdirSync(recov).length > 0, { timeout: 8000 }), "secours créé");
    fs.chmodSync(full, 0o644);
    const d = await member.del(`/api/file?path=${encodeURIComponent(p)}`);
    assert.equal(d.status, 200);
    assert.equal(fs.readdirSync(recov).length, 0, "secours effacé avec le document");
    await sleep(1500);
    assert.ok(!fs.existsSync(full), "le document n'est pas recréé");
  });

  await t.test("enregistrement après fusion : la saisie et la version externe sont enregistrées", async () => {
    const p = "notes/apres-fusion.md";
    await member.post("/api/create", { path: p });
    const c = await member.open(p);
    c.text.insert(c.text.length, "Ma ligne.\n");
    await sleep(200);
    externalCommit(srv, p, readRepo(srv, p) + "Ligne de l'agent.\n", "agent");
    const r = await member.post("/api/save", { path: p }); // Ctrl+S : version externe pas encore détectée
    assert.equal(r.status, 200);
    const disk = readRepo(srv, p);
    assert.ok(disk.includes("Ma ligne.") && disk.includes("Ligne de l'agent."), JSON.stringify(disk));
    c.close();
  });
});
