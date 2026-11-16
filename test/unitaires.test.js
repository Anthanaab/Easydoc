// Tests unitaires : fonctions pures, sans serveur.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { locate, shiftPos } = require("../src/comments");
const { merge3, diffOps } = require("../src/authorship");
const { safeFilePath, safeDocPath } = require("../src/paths");

test("commentaires : le passage suit les insertions et suppressions", () => {
  // insertion avant le passage : il se décale
  assert.equal(shiftPos(10, [{ insert: "abc" }], true), 13);
  assert.equal(shiftPos(15, [{ insert: "abc" }], false), 18);
  // insertion exactement au début : hors du passage (le début avance)
  assert.equal(shiftPos(10, [{ retain: 10 }, { insert: "X" }], true), 11);
  // insertion exactement à la fin : hors du passage (la fin ne bouge pas)
  assert.equal(shiftPos(15, [{ retain: 15 }, { insert: "X" }], false), 15);
  // suppression qui chevauche le début
  assert.equal(shiftPos(10, [{ retain: 8 }, { delete: 5 }], true), 8);
  assert.equal(shiftPos(15, [{ retain: 8 }, { delete: 5 }], false), 10);
});

test("commentaires : le passage est retrouvé par son texte et son contexte", () => {
  const t = "aa chaque document bb chaque document cc";
  assert.deepEqual(locate(t, { quote: "chaque document", start: 3 }), [3, 18]);
  assert.deepEqual(locate(t, { quote: "chaque document", start: 0, prefix: "bb ", suffix: " cc" }), [22, 37]);
  assert.deepEqual(locate("Intro. " + t, { quote: "chaque document", start: 3, prefix: "aa ", suffix: " bb" }), [10, 25]);
  assert.equal(locate(t, { quote: "absent", start: 0 }), null);
});

test("fusion à trois voies : lignes différentes fusionnées, mêmes lignes en conflit", () => {
  const base = "l1\nl2\nl3\nl4\nl5\nl6\nl7\n";
  assert.equal(merge3(base, base.replace("l2", "moi"), base.replace("l6", "autre")), "l1\nmoi\nl3\nl4\nl5\nautre\nl7\n");
  assert.equal(merge3(base, base.replace("l2", "moi"), base.replace("l2", "autre")), null);
  assert.equal(merge3(base, "intro\n" + base, base + "fin\n"), "intro\n" + base + "fin\n");
  assert.equal(merge3(base, base, "autre"), "autre");
  // lignes voisines (j'ajoute une phrase à la ligne 3, l'autre modifie la ligne 2) : fusionnées
  assert.equal(merge3(base, base.replace("l3", "l3 et ma phrase"), base.replace("l2", "L2 (autre)")), "l1\nL2 (autre)\nl3 et ma phrase\nl4\nl5\nl6\nl7\n");
  // insertion sans repère près d'une ligne modifiée par l'autre : conflit plutôt qu'un mauvais endroit
  assert.equal(merge3("a\nb\n", "a\nnouveau\nb\n", "A\nb\n"), null);
  // fichier en fins de ligne Windows : fusion possible, fins de ligne conservées
  const crlf = base.replace(/\n/g, "\r\n");
  assert.equal(merge3(crlf, crlf.replace("l2", "moi"), crlf.replace("l6", "autre")), "l1\r\nmoi\r\nl3\r\nl4\r\nl5\r\nautre\r\nl7\r\n");
});

test("comparaison de textes : limitée dans le temps sur deux très longs textes", () => {
  const a = Array.from({ length: 12000 }, (_, i) => "ligne a " + i).join("\n");
  const b = Array.from({ length: 12000 }, (_, i) => "autre b " + i * 7).join("\n");
  const t0 = Date.now();
  const ops = diffOps(a, b);
  assert.ok(Date.now() - t0 < 5000, "ne doit pas bloquer le serveur");
  // les opérations reconstruisent bien le nouveau texte
  let out = "", i = 0;
  for (const o of ops) { if (o.op === "eq") { out += a.slice(i, i + o.len); i += o.len; } else if (o.op === "del") i += o.len; else out += o.text; }
  assert.equal(out, b);
});

test("fusion à trois voies : limitée dans le temps (deux textes très différents = conflit)", () => {
  const base = Array.from({ length: 30000 }, (_, i) => "ligne a " + i).join("\n");
  const mine = Array.from({ length: 30000 }, (_, i) => "autre b " + i * 7).join("\n");
  const t0 = Date.now();
  assert.equal(merge3(base, mine, base + "\nfin"), null);
  assert.ok(Date.now() - t0 < 6000, `ne doit pas bloquer le serveur (${Date.now() - t0} ms)`);
});

test("conversion : un fichier illisible échoue proprement (dans un fil séparé)", async () => {
  const convert = require("../src/convert");
  await assert.rejects(convert.pdfToMarkdown(Buffer.from("ceci n'est pas un PDF"), "x"), /illisible|endommagé/);
  await assert.rejects(convert.docxToMarkdown(Buffer.from("ceci n'est pas un Word"), "x - images"), /./);
});

test("temps réel : seules les modifications du texte sont acceptées", () => {
  const { textOnly } = require("../src/wsguard");
  const Y = require("yjs");
  const server = new Y.Doc();
  server.transact(() => { server.getText("content").insert(0, "Bonjour"); server.getMap("meta").set("loaded", true); });
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
  const diff = (fn) => { const sv = Y.encodeStateVector(client); fn(); return Y.encodeStateAsUpdate(client, sv); };
  // frappe ordinaire, suppression, frappe en plusieurs morceaux dépendants
  const typed = diff(() => { const t = client.getText("content"); t.insert(7, " à"); t.insert(9, " tous"); t.delete(0, 1); });
  assert.equal(textOnly(server, typed, "content"), true);
  Y.applyUpdate(server, typed);
  // valeur remplacée, valeur effacée, nouvelle clé, nouveau type
  assert.equal(textOnly(server, diff(() => client.getMap("meta").set("loaded", false)), "content"), false);
  const c2 = new Y.Doc(); Y.applyUpdate(c2, Y.encodeStateAsUpdate(server));
  const sv2 = Y.encodeStateVector(c2); c2.getMap("meta").delete("loaded");
  assert.equal(textOnly(server, Y.encodeStateAsUpdate(c2, sv2), "content"), false);
  const c3 = new Y.Doc(); Y.applyUpdate(c3, Y.encodeStateAsUpdate(server));
  const sv3 = Y.encodeStateVector(c3); c3.getMap("autre").set("x", 1);
  assert.equal(textOnly(server, Y.encodeStateAsUpdate(c3, sv3), "content"), false);
  const c4 = new Y.Doc(); Y.applyUpdate(c4, Y.encodeStateAsUpdate(server));
  const sv4 = Y.encodeStateVector(c4); c4.getText("content").insertEmbed(0, { image: "x" });
  assert.equal(textOnly(server, Y.encodeStateAsUpdate(c4, sv4), "content"), false);
});

test("mise à jour : une version qui ne démarre pas est remplacée par la précédente", () => {
  const fs = require("fs"), os = require("os"), path = require("path");
  const { execFileSync } = require("child_process");
  const { bootGuard, RESTART_CODE } = require("../src/updater");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "easydoc-test-maj-"));
  const app = path.join(dir, "app"), data = path.join(dir, "data");
  fs.mkdirSync(app); fs.mkdirSync(data);
  const git = (...a) => execFileSync("git", ["-C", app, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...a]).toString().trim();
  git("init", "-q");
  fs.writeFileSync(path.join(app, "version.txt"), "ancienne"); git("add", "."); git("commit", "-qm", "v1");
  const prevSha = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(app, "version.txt"), "nouvelle"); git("commit", "-qam", "v2");
  fs.mkdirSync(path.join(app, "node_modules.prev")); fs.writeFileSync(path.join(app, "node_modules.prev", "ancienne-lib"), "x");
  fs.mkdirSync(path.join(app, "node_modules")); fs.writeFileSync(path.join(app, "node_modules", "nouvelle-lib"), "x");
  const marker = path.join(data, "update-state.json");
  fs.writeFileSync(marker, JSON.stringify({ pending: true, prevSha, fromVersion: "1", toVersion: "2" }));
  const exit = process.exit;
  const codes = [];
  process.exit = (c) => { codes.push(c); };
  try {
    bootGuard({ appDir: app, dataDir: data });
    bootGuard({ appDir: app, dataDir: data });
    assert.equal(fs.readFileSync(path.join(app, "version.txt"), "utf8"), "nouvelle", "deux essais avant d'abandonner");
    bootGuard({ appDir: app, dataDir: data });
  } finally { process.exit = exit; }
  assert.deepEqual(codes, [RESTART_CODE]);
  assert.equal(fs.readFileSync(path.join(app, "version.txt"), "utf8"), "ancienne");
  assert.ok(fs.existsSync(path.join(app, "node_modules", "ancienne-lib")), "anciennes bibliothèques remises");
  const m = JSON.parse(fs.readFileSync(marker, "utf8"));
  assert.equal(m.pending, false); assert.equal(m.rolledBack, true); assert.match(m.error, /retour automatique/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("tunnel : l'arrêt n'attend pas un cloudflared qui n'a jamais pu démarrer", async () => {
  const { TunnelManager } = require("../src/tunnel");
  const os = require("os");
  const tm = new TunnelManager({ dataDir: require("fs").mkdtempSync(require("path").join(os.tmpdir(), "easydoc-test-tunnel-")), port: 1 });
  const child = require("child_process").spawn("easydoc-programme-inexistant", []);
  child.on("error", () => {});
  tm.child = child;
  const t0 = Date.now();
  await tm.stop();
  assert.ok(Date.now() - t0 < 2000);
});

test("feuille de style : pas de sélecteur orphelin ni d'accolade manquante", () => {
  // un sélecteur laissé seul sur sa ligne avale la règle suivante (bug de la 0.12.0 : .area n'était plus en flex)
  const lines = require("fs").readFileSync(require("path").join(__dirname, "..", "public", "style.css"), "utf8").split("\n");
  let depth = 0, inComment = false;
  lines.forEach((l, i) => {
    const t = l.trim();
    if (t.startsWith("/*")) inComment = !t.includes("*/");
    else if (inComment) { if (t.includes("*/")) inComment = false; }
    else if (depth === 0 && t && !/[{};,]$/.test(t) && !t.includes("{")) assert.fail(`ligne ${i + 1} : sélecteur sans règle « ${t} »`);
    depth += (l.match(/\{/g) || []).length - (l.match(/\}/g) || []).length;
    assert.ok(depth >= 0, `ligne ${i + 1} : accolade fermante en trop`);
  });
  assert.equal(depth, 0, "accolade ouvrante non refermée");
});

test("déplacement sur GitHub : un seul commit qui réutilise les contenus existants", async () => {
  const { RepoService } = require("../src/repo");
  const repo = new RepoService({ githubRepo: "moi/docs", githubBranch: "main", githubToken: "x" });
  repo.mode = "github";
  const calls = [];
  const rec = (name, data) => async (args) => { calls.push([name, args]); return { data }; };
  repo.octokit = { rest: { git: {
    getRef: rec("getRef", { object: { sha: "c0" } }),
    getCommit: rec("getCommit", { tree: { sha: "t0" } }),
    getTree: rec("getTree", { tree: [
      { path: "notes/a.md", type: "blob", mode: "100644", sha: "blobA" },
      { path: "notes/b.png", type: "blob", mode: "100644", sha: "blobB" },
    ] }),
    createTree: rec("createTree", { sha: "t1" }),
    createCommit: rec("createCommit", { sha: "c1" }),
    updateRef: rec("updateRef", {}),
  } } };
  const r = await repo.move([["notes/a.md", "archives/a.md"], ["notes/b.png", "archives/b.png"]], "Easydoc : déplacement");
  assert.equal(r.commit, "c1");
  const tree = calls.find((c) => c[0] === "createTree")[1];
  assert.equal(tree.base_tree, "t0");
  assert.deepEqual(tree.tree, [
    { path: "archives/a.md", mode: "100644", type: "blob", sha: "blobA" }, { path: "notes/a.md", mode: "100644", type: "blob", sha: null },
    { path: "archives/b.png", mode: "100644", type: "blob", sha: "blobB" }, { path: "notes/b.png", mode: "100644", type: "blob", sha: null },
  ]);
  assert.deepEqual(calls.find((c) => c[0] === "createCommit")[1].parents, ["c0"]);
  assert.deepEqual(calls.find((c) => c[0] === "updateRef")[1], { owner: "moi", repo: "docs", ref: "heads/main", sha: "c1" });
  // destination déjà prise : rien n'est envoyé
  calls.length = 0;
  await assert.rejects(repo.move([["notes/a.md", "notes/b.png"]], "x"), /existe|porte déjà/);
  assert.ok(!calls.some((c) => c[0] === "createCommit"));
});

test("chemins : noms dangereux refusés, noms ordinaires acceptés", () => {
  for (const bad of ["../x.md", "a/../../x.md", "C:/Windows/win.ini", ".git/config", "a/.env", "Interne./a.md", "Interne /a.md", "INTERN~1/a.md", "PROGRA~2.MD", "-A", "notes/-x.md", "a\0b.md"]) {
    assert.equal(safeFilePath(bad), null, bad);
  }
  // un chemin « absolu » reste à l'intérieur du dépôt
  assert.equal(safeFilePath("/etc/passwd"), "etc/passwd");
  for (const ok of ["notes/a.md", "Notes de réunion/compte rendu (v2).md", "images/capture 2026-11-16 12h23m52.png", "Budget~2024.md", "rapport~v2.md", "Compte rendu de l’équipe.md"]) {
    assert.equal(safeFilePath(ok), ok);
  }
  assert.equal(safeDocPath("notes/image.png"), null);
  assert.equal(safeDocPath("notes/a.md"), "notes/a.md");
});
