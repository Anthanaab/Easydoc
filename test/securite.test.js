// Tests de sécurité : chaque attaque est rejouée contre un serveur isolé.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { startServer, waitFor, WS } = require("./helpers");

test("sécurité", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const { admin, member } = srv;

  await t.test("droits : un dossier masqué reste masqué, quel que soit le nom employé", async () => {
    assert.equal((await admin.post("/api/create", { path: "Interne/secret.md" })).status, 200);
    assert.equal((await admin.put("/api/admin/access", { path: "Interne", entries: { "*": "none" } })).status, 200);
    for (const v of ["Interne/secret.md", "INTERNE/secret.md", "interne/SECRET.md", "Interne./secret.md", "Interne /secret.md"]) {
      const r = await member.get(`/api/raw?path=${encodeURIComponent(v)}`);
      assert.ok(r.status >= 400 && !r.text.includes("# secret"), `${v} → ${r.status}`);
    }
    const list = await member.get("/api/files");
    assert.ok(!/interne/i.test(list.text), "absent de la liste des fichiers");
    const own = await admin.get("/api/raw?path=interne/secret.md");
    assert.equal(own.status, 200, "l'administrateur y accède toujours");
  });

  await t.test("droits : connexion temps réel refusée sur un document masqué", async () => {
    const code = await new Promise((res) => {
      const ws = new WS(`${srv.base.replace("http", "ws")}/interne/secret.md`, { headers: { Cookie: member.cookie, Origin: srv.base } });
      ws.on("close", (c) => res(c));
      ws.on("error", () => {});
      setTimeout(() => res(null), 3000);
    });
    assert.ok(code === 4003 || code === 1008, `code ${code}`);
  });

  await t.test("fichiers importés : un .js n'est jamais servi comme script", async () => {
    const up = await member.upload("notes/piege.js", Buffer.from("alert(1)"));
    assert.equal(up.status, 200);
    const r = await member.get(`/api/raw?path=${encodeURIComponent(up.json.path)}`);
    assert.match(r.type, /application\/octet-stream/);
  });

  await t.test("noms : un nom commençant par « - » est refusé (option git)", async () => {
    assert.equal((await member.upload("notes/-A", Buffer.from("x"))).status, 400);
  });

  await t.test("liens : un lien placé dans le dépôt ne mène pas hors du dépôt", async () => {
    const link = path.join(srv.repoDir, "notes", "lien-donnees");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    try { fs.symlinkSync(srv.dataDir, link, "junction"); } catch (e) { t.skip("lien impossible à créer ici : " + e.message); return; }
    const leak = await member.get(`/api/raw?path=${encodeURIComponent("notes/lien-donnees/users.json")}`);
    assert.ok(leak.status >= 400 && !leak.text.includes("membre-test"), `lecture : ${leak.status}`);
    const write = await member.upload("notes/lien-donnees/pirate.txt", Buffer.from("x"), true);
    assert.ok(write.status >= 400 && !fs.existsSync(path.join(srv.dataDir, "pirate.txt")), `écriture : ${write.status}`);
  });

  await t.test("liens : un lien vers un fichier inexistant hors du dépôt ne permet pas de le créer", async () => {
    const outside = path.join(srv.dataDir, "cree-hors-depot.txt");
    const link = path.join(srv.repoDir, "notes", "lien-casse.md");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    try { fs.symlinkSync(outside, link, "file"); } catch (e) { t.skip("lien impossible à créer ici : " + e.message); return; }
    const w = await member.upload("notes/lien-casse.md", Buffer.from("piratage"), true);
    assert.ok(w.status >= 400, `écriture : ${w.status}`);
    assert.ok(!fs.existsSync(outside), "aucun fichier créé hors du dépôt");
    fs.unlinkSync(link);
  });

  await t.test("origine : une requête d'un autre site est refusée, même avec X-Forwarded-Host", async () => {
    const r = await member.post("/api/sync", undefined, { Origin: "http://evil.example", "X-Forwarded-Host": "evil.example" });
    assert.equal(r.status, 403);
  });

  await t.test("déconnexion : la connexion temps réel de la session est coupée", async () => {
    const s = await srv.login("membre-test");
    const ws = await new Promise((res, rej) => {
      const w = new WS(`${srv.base.replace("http", "ws")}/README.md`, { headers: { Cookie: s.cookie, Origin: srv.base } });
      w.on("open", () => res(w)); w.on("error", rej);
    });
    let code = null;
    ws.on("close", (c) => { code = c; });
    await s.post("/api/auth/logout");
    assert.equal(await waitFor(() => code, { timeout: 5000 }), 4001);
  });

  await t.test("CSP : le script de thème de la page est autorisé par son empreinte", async () => {
    const r = await fetch(srv.base + "/");
    const csp = r.headers.get("content-security-policy") || "";
    const script = (await r.text()).match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\r\n?/g, "\n");
    assert.ok(csp.includes(crypto.createHash("sha256").update(script).digest("base64")));
  });
});
