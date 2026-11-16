/**
 * convert.js — aperçu et conversion des fichiers Word (.docx) et PDF.
 *
 *  - Word → HTML (aperçu) ou Markdown (version modifiable ; les images sont extraites).
 *  - PDF  → Markdown (texte de chaque page ; la mise en page n'est pas conservée).
 *
 * Chaque conversion tourne dans un fil d'exécution séparé (worker), avec une mémoire et une durée
 * limitées : un fichier piégé (archive qui se décompresse en centaines de Mo, PDF sans fin) fait
 * échouer sa conversion, jamais le serveur ni les documents en cours d'édition.
 */
"use strict";
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");

const LIMITS = { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 48, stackSizeMb: 4 };
const TIMEOUT_MS = 60000;
const MAX_PARALLEL = 2;
const MAX_IMAGES = 300;
const MAX_PDF_PAGES = 1000;

// ---- Travail effectué dans le fil séparé -------------------------------------------------------
let td = null;
function turndown() {
  if (td) return td;
  const TurndownService = require("turndown");
  const { gfm } = require("turndown-plugin-gfm");
  td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "*" });
  td.use(gfm);
  return td;
}

/** Prépare les tableaux Word pour le Markdown : 1re ligne en en-tête, cellules sans paragraphes. */
function prepareTables(html) {
  html = html.replace(/<(td|th)([^>]*)>([\s\S]*?)<\/\1>/g, (m, tag, attrs, inner) =>
    `<${tag}${attrs}>${inner.replace(/<\/p>\s*<p[^>]*>/g, " ").replace(/<\/?p[^>]*>/g, "")}</${tag}>`);
  return html.replace(/<table([^>]*)>(\s*(?:<tbody>)?\s*)<tr([^>]*)>([\s\S]*?)<\/tr>/g, (m, a, mid, ra, row) =>
    `<table${a}>${mid}<tr${ra}>${row.replace(/<td(\s[^>]*)?>/g, "<th>").replace(/<\/td>/g, "</th>")}</tr>`);
}

const IMAGE_EXT = {
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
  "image/svg+xml": "svg", "image/bmp": "bmp", "image/tiff": "tif", "image/x-emf": "emf", "image/x-wmf": "wmf",
};
const encSeg = (s) => encodeURIComponent(s).replace(/\(/g, "%28").replace(/\)/g, "%29");

async function readImage(image) {
  if (typeof image.readAsBuffer === "function") return image.readAsBuffer();
  return image.read();
}

const tasks = {
  async docxHtml(buf) {
    const mammoth = require("mammoth");
    return (await mammoth.convertToHtml({ buffer: buf })).value;
  },
  /** Les images sont renvoyées à part ; `imgDir` : dossier (relatif) où elles seront rangées. */
  async docxMarkdown(buf, { imgDir }) {
    const mammoth = require("mammoth");
    const images = [];
    const r = await mammoth.convertToHtml({ buffer: buf }, {
      convertImage: mammoth.images.imgElement(async (image) => {
        if (images.length >= MAX_IMAGES) return { src: "" };
        const name = `image-${images.length + 1}.${IMAGE_EXT[image.contentType] || "bin"}`;
        images.push({ name, data: Buffer.from(await readImage(image)) });
        return { src: `${encSeg(imgDir)}/${encSeg(name)}` };
      }),
    });
    const md = turndown().turndown(prepareTables(r.value))
      .replace(/^(\s*)([-*]|\d+\.)\s{2,}/gm, "$1$2 ") // « -   élément » → « - élément »
      .replace(/\n{3,}/g, "\n\n").trim();
    return { markdown: md + "\n", images };
  },
  async pdfMarkdown(buf, { title }) {
    const { getDocumentProxy, extractText } = await import("unpdf");
    let pdf;
    try { pdf = await getDocumentProxy(new Uint8Array(buf), { verbosity: 0 }); }
    catch (_e) { throw new Error("Ce fichier PDF est illisible ou endommagé."); }
    if (pdf.numPages > MAX_PDF_PAGES) throw new Error(`Ce PDF compte plus de ${MAX_PDF_PAGES} pages : conversion impossible.`);
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = (Array.isArray(text) ? text : [text])
      // espaces en fin de ligne retirés ligne par ligne (une expression régulière serait quadratique
      // sur une page faite d'une très longue suite d'espaces)
      .map((t) => String(t || "").split("\n").map((l) => l.trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n").trim())
      .filter(Boolean);
    if (!pages.length) throw new Error("Ce PDF ne contient pas de texte exploitable (document scanné ?).");
    return { markdown: `# ${title}\n\n${pages.join("\n\n---\n\n")}\n` };
  },
};

if (!isMainThread && workerData && workerData.easydocConvert) {
  const { task, buf, opts } = workerData.easydocConvert;
  tasks[task](Buffer.from(buf), opts || {})
    .then((value) => parentPort.postMessage({ ok: true, value }))
    .catch((e) => parentPort.postMessage({ ok: false, error: String((e && e.message) || e) }));
}

// ---- Côté serveur : lancement isolé, au plus MAX_PARALLEL à la fois -----------------------------
let running = 0;
const queue = [];
function slot() {
  if (running < MAX_PARALLEL) { running++; return Promise.resolve(); }
  return new Promise((r) => queue.push(r));
}
function release() { const next = queue.shift(); if (next) next(); else running--; }

async function isolated(task, buf, opts) {
  await slot();
  try {
    return await new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); w.terminate().catch(() => {}); fn(v); };
      const w = new Worker(__filename, { workerData: { easydocConvert: { task, buf, opts } }, resourceLimits: LIMITS });
      const timer = setTimeout(() => finish(reject, new Error("Ce fichier est trop long à convertir (plus d'une minute).")), TIMEOUT_MS);
      w.once("message", (m) => (m && m.ok ? finish(resolve, m.value) : finish(reject, new Error((m && m.error) || "Conversion impossible."))));
      w.once("error", (e) => finish(reject, new Error(e && e.code === "ERR_WORKER_OUT_OF_MEMORY"
        ? "Ce fichier est trop volumineux une fois décompressé : conversion impossible."
        : `Conversion impossible : ${(e && e.message) || e}`)));
      w.once("exit", () => finish(reject, new Error("Conversion interrompue.")));
    });
  } finally { release(); }
}

const docxToHtml = (buf) => isolated("docxHtml", buf);
/** → { markdown, images: [{ name, data }] } ; `imgDir` : nom du dossier des images (relatif au document). */
const docxToMarkdown = (buf, imgDir) => isolated("docxMarkdown", buf, { imgDir })
  .then((r) => ({ markdown: r.markdown, images: r.images.map((i) => ({ name: i.name, data: Buffer.from(i.data) })) }));
const pdfToMarkdown = (buf, title) => isolated("pdfMarkdown", buf, { title }).then((r) => r.markdown);

module.exports = { docxToHtml, docxToMarkdown, pdfToMarkdown };
