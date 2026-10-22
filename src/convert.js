/**
 * convert.js — aperçu et conversion des fichiers Word (.docx) et PDF.
 *
 *  - Word → HTML (aperçu) ou Markdown (version modifiable ; les images sont extraites).
 *  - PDF  → Markdown (texte de chaque page ; la mise en page n'est pas conservée).
 * Les bibliothèques sont chargées à la première utilisation.
 */
"use strict";

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

async function readImage(image) {
  if (typeof image.readAsBuffer === "function") return image.readAsBuffer();
  return image.read();
}

async function docxToHtml(buf) {
  const mammoth = require("mammoth");
  const r = await mammoth.convertToHtml({ buffer: buf });
  return r.value;
}

/** onImage(nomFichier, données) doit renvoyer l'adresse (relative) à utiliser dans le Markdown. */
async function docxToMarkdown(buf, onImage) {
  const mammoth = require("mammoth");
  let n = 0;
  const r = await mammoth.convertToHtml({ buffer: buf }, {
    convertImage: mammoth.images.imgElement(async (image) => {
      n++;
      const name = `image-${n}.${IMAGE_EXT[image.contentType] || "bin"}`;
      return { src: await onImage(name, await readImage(image)) };
    }),
  });
  const md = turndown().turndown(prepareTables(r.value))
    .replace(/^(\s*)([-*]|\d+\.)\s{2,}/gm, "$1$2 ") // « -   élément » → « - élément »
    .replace(/\n{3,}/g, "\n\n").trim();
  return { markdown: md + "\n", images: n };
}

async function pdfToMarkdown(buf, title) {
  const { getDocumentProxy, extractText } = await import("unpdf");
  let pdf;
  try { pdf = await getDocumentProxy(new Uint8Array(buf), { verbosity: 0 }); }
  catch (_e) { throw new Error("Ce fichier PDF est illisible ou endommagé."); }
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = (Array.isArray(text) ? text : [text])
    .map((t) => String(t || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim())
    .filter(Boolean);
  if (!pages.length) throw new Error("Ce PDF ne contient pas de texte exploitable (document scanné ?).");
  return `# ${title}\n\n${pages.join("\n\n---\n\n")}\n`;
}

module.exports = { docxToHtml, docxToMarkdown, pdfToMarkdown };
