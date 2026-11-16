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

test("chemins : noms dangereux refusés, noms ordinaires acceptés", () => {
  for (const bad of ["../x.md", "a/../../x.md", "C:/Windows/win.ini", ".git/config", "a/.env", "Interne./a.md", "Interne /a.md", "INTERN~1/a.md", "PROGRA~2.MD", "-A", "notes/-x.md", "a\0b.md"]) {
    assert.equal(safeFilePath(bad), null, bad);
  }
  // un chemin « absolu » reste à l'intérieur du dépôt
  assert.equal(safeFilePath("/etc/passwd"), "etc/passwd");
  for (const ok of ["notes/a.md", "Notes de réunion/compte rendu (v2).md", "images/capture 2026-11-16 12h23m52.png", "Budget~2024.md", "rapport~v2.md"]) {
    assert.equal(safeFilePath(ok), ok);
  }
  assert.equal(safeDocPath("notes/image.png"), null);
  assert.equal(safeDocPath("notes/a.md"), "notes/a.md");
});
