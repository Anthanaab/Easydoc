// Sauvegarde des données d'Easydoc (comptes, droits, commentaires, auteurs, secours, réglages et,
// en dépôt local, les documents avec leur historique git) dans une archive .tar.gz standard :
// n'importe quel « tar » sait la relire (tar -xzf archive.tar.gz -C <dossier de données>).
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// Ce qui est sauvegardé, relatif au dossier de données. Le reste (programme cloudflared, caches,
// sauvegardes précédentes, essais de mise à jour) se retélécharge ou se recrée tout seul.
const ENTRIES = ["config.json", "users.json", "sessions.json", "access.json", "comments.json", "tunnel.json", "authorship", "recovery"];
const MANIFEST = "easydoc-sauvegarde.json";

/* ---- Écriture d'une archive tar (format ustar + en-têtes PAX pour les noms longs ou accentués) ---- */
function octal(n, len) { return n.toString(8).padStart(len - 1, "0") + "\0"; }
function header(name, size, mtime, type = "0") {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write(octal(type === "5" ? 0o755 : 0o644, 8), 100, 8, "ascii");
  h.write(octal(0, 8), 108, 8, "ascii");
  h.write(octal(0, 8), 116, 8, "ascii");
  h.write(octal(size, 12), 124, 12, "ascii");
  h.write(octal(Math.floor(mtime / 1000), 12), 136, 12, "ascii");
  h.fill(" ", 148, 156); // somme de contrôle : calculée avec ce champ rempli d'espaces
  h.write(type, 156, 1, "ascii");
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + " ", 148, 8, "ascii");
  return h;
}
const pad = (n) => Buffer.alloc((512 - (n % 512)) % 512);
/** Enregistrement PAX « path=… » : nom exact, sans limite de longueur, en UTF-8. */
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
  return Buffer.from(`${len}${body}`, "utf8");
}
function* tarEntry(name, data, mtime) {
  const simple = /^[\x20-\x7e]*$/.test(name) && name.length <= 100;
  if (!simple) {
    const pax = paxRecord("path", name);
    yield header("PaxHeader/" + name.replace(/[^\x20-\x7e]/g, "_").slice(-80), pax.length, mtime, "x");
    yield pax;
    yield pad(pax.length);
  }
  yield header(simple ? name : name.replace(/[^\x20-\x7e]/g, "_").slice(-100), data.length, mtime);
  yield data;
  yield pad(data.length);
}

/** Fichiers à sauvegarder : [{ name (dans l'archive), full (sur le disque) }]. Les liens sont ignorés. */
function collect(dataDir, localRepoDir) {
  const out = [];
  const walk = (full, name) => {
    let st;
    try { st = fs.lstatSync(full); } catch (_e) { return; }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) { for (const e of fs.readdirSync(full).sort()) walk(path.join(full, e), `${name}/${e}`); }
    else if (st.isFile()) out.push({ name, full, mtime: st.mtimeMs, size: st.size });
  };
  for (const e of ENTRIES) walk(path.join(dataDir, e), e);
  if (localRepoDir && fs.existsSync(localRepoDir)) walk(localRepoDir, "localrepo");
  return out;
}

/** Écrit l'archive .tar.gz dans le fichier `dest` (écriture atomique). Retourne { files, bytes }. */
async function createBackup({ dataDir, localRepoDir, dest, meta = {} }) {
  const items = collect(dataDir, localRepoDir);
  const manifest = Buffer.from(JSON.stringify({ ...meta, date: new Date().toISOString(), files: items.length,
    restaurer: "Arrêter Easydoc, puis : tar -xzf <cette archive> -C <dossier de données> ; rendre les fichiers à l'utilisateur du service (Proxmox : chown -R easydoc:easydoc /opt/easydoc/data) ; relancer Easydoc." }, null, 2));
  const tmp = dest + ".partiel";
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const gz = zlib.createGzip({ level: 6 });
  const out = fs.createWriteStream(tmp, { mode: 0o600 });
  const done = new Promise((res, rej) => { out.on("finish", res); out.on("error", rej); gz.on("error", rej); });
  gz.pipe(out);
  const write = (b) => (gz.write(b) ? null : new Promise((r) => gz.once("drain", r)));
  for (const b of tarEntry(MANIFEST, manifest, Date.now())) await write(b);
  for (const it of items) {
    let data;
    try { data = fs.readFileSync(it.full); } catch (_e) { continue; } // supprimé entre-temps
    for (const b of tarEntry(it.name, data, it.mtime)) await write(b);
  }
  await write(Buffer.alloc(1024)); // fin d'archive : deux blocs vides
  gz.end();
  await done;
  fs.renameSync(tmp, dest);
  return { files: items.length, bytes: fs.statSync(dest).size };
}

/* ---- Sauvegardes automatiques (une par jour, les N dernières gardées) ---- */
const NAME_RE = /^easydoc-\d{4}-\d{2}-\d{2}-\d{4}(-\d+)?\.tar\.gz$/;
class BackupManager {
  constructor({ dataDir, localRepoDir, meta, beforeBackup }) {
    this.dataDir = dataDir;
    this.localRepoDir = localRepoDir;
    this.meta = meta || (() => ({}));
    this.beforeBackup = beforeBackup || (async () => {});
    this.dir = path.join(dataDir, "backups");
    this.file = path.join(dataDir, "backup.json");
    this.settings = { auto: true, keep: 7 };
    try { Object.assign(this.settings, JSON.parse(fs.readFileSync(this.file, "utf8"))); } catch (_e) {}
    this.running = null;
    this.lastError = "";
  }
  save(s) {
    if (typeof s.auto === "boolean") this.settings.auto = s.auto;
    if (Number.isInteger(s.keep) && s.keep >= 1 && s.keep <= 90) this.settings.keep = s.keep;
    fs.writeFileSync(this.file, JSON.stringify(this.settings, null, 2), { mode: 0o600 });
    this.prune();
  }
  list() {
    let names = [];
    try { names = fs.readdirSync(this.dir).filter((n) => NAME_RE.test(n)); } catch (_e) {}
    return names.map((name) => { const st = fs.statSync(path.join(this.dir, name)); return { name, size: st.size, date: st.mtimeMs }; })
      .sort((a, b) => b.date - a.date || b.name.localeCompare(a.name, "en", { numeric: true }));
  }
  pathOf(name) { return NAME_RE.test(String(name)) ? path.join(this.dir, name) : null; }
  remove(name) { const p = this.pathOf(name); if (p && fs.existsSync(p)) { fs.unlinkSync(p); return true; } return false; }
  prune() { for (const b of this.list().slice(this.settings.keep)) this.remove(b.name); }
  /** Crée une sauvegarde maintenant (une seule à la fois). */
  create(reason = "manuelle") {
    if (this.running) return this.running;
    this.running = (async () => {
      const d = new Date();
      const p2 = (n) => String(n).padStart(2, "0");
      const base = `easydoc-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
      let name = `${base}.tar.gz`;
      for (let i = 2; fs.existsSync(path.join(this.dir, name)); i++) name = `${base}-${i}.tar.gz`; // plusieurs dans la même minute
      try {
        await this.beforeBackup(); // documents ouverts enregistrés, fichiers en attente écrits
        const r = await createBackup({ dataDir: this.dataDir, localRepoDir: this.localRepoDir, dest: path.join(this.dir, name), meta: { ...this.meta(), motif: reason } });
        this.lastError = "";
        this.prune();
        console.log(`[sauvegarde] ${name} : ${r.files} fichiers, ${Math.round(r.bytes / 1024)} Ko`);
        return { name, ...r };
      } catch (e) {
        this.lastError = e.message;
        console.error(`[sauvegarde] échec : ${e.message}`);
        throw e;
      } finally { this.running = null; }
    })();
    return this.running;
  }
  /** Sauvegarde automatique si la dernière date de plus de 24 h (vérifié toutes les heures). */
  start() {
    const tick = () => {
      if (!this.settings.auto) return;
      const last = this.list()[0];
      if (!last || Date.now() - last.date > 24 * 3600 * 1000) this.create("automatique").catch(() => {});
    };
    setTimeout(tick, 60 * 1000).unref();
    setInterval(tick, 3600 * 1000).unref();
  }
}

module.exports = { createBackup, BackupManager, ENTRIES, MANIFEST };
