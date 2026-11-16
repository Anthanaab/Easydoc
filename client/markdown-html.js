// Markdown → HTML, à partir de l'analyseur Markdown (GFM) déjà utilisé par l'éditeur : impression,
// export en page web, aperçu d'une ancienne version, tableaux de l'éditeur.
// Le HTML brut écrit dans un document n'est jamais repris tel quel (il est affiché comme du texte) ;
// le résultat passe en plus par DOMPurify avant d'être inséré dans une page.
import { parser as baseParser, GFM } from "@lezer/markdown";

const parser = baseParser.configure([GFM]);
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
const MARKS = new Set(["EmphasisMark", "CodeMark", "LinkMark", "StrikethroughMark", "QuoteMark", "ListMark", "HeaderMark", "TaskMarker", "TableDelimiter", "CodeInfo"]);

/**
 * opts.url(adresse, "link" | "image") : adresse finale d'un lien ou d'une image (liens relatifs du dépôt…).
 * opts.slug(texte) : identifiant des titres (ancres du plan).
 */
export function markdownToHtml(src, opts = {}) {
  const url = opts.url || ((u) => u);
  const tree = parser.parse(src);
  const text = (a, b) => src.slice(a, b);

  // contenu en ligne d'un nœud, entre `from` et `to` : texte échappé + éléments reconnus
  function inline(node, from = node.from, to = node.to) {
    let html = "", pos = from;
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.to <= from || c.from >= to) continue;
      if (c.from > pos) html += esc(text(pos, c.from));
      html += inlineNode(c);
      pos = Math.max(pos, c.to);
    }
    if (pos < to) html += esc(text(pos, to));
    return html;
  }
  const child = (node, name) => { for (let c = node.firstChild; c; c = c.nextSibling) if (c.name === name) return c; return null; };
  const children = (node, name) => { const out = []; for (let c = node.firstChild; c; c = c.nextSibling) if (!name || c.name === name) out.push(c); return out; };

  function linkParts(node) {
    const marks = children(node, "LinkMark");
    const u = child(node, "URL");
    const title = child(node, "LinkTitle");
    const labelFrom = marks[0] ? marks[0].to : node.from;
    const labelTo = marks[1] ? marks[1].from : node.to;
    return { labelFrom, labelTo, href: u ? text(u.from, u.to).replace(/^<|>$/g, "") : "", title: title ? text(title.from + 1, title.to - 1) : "" };
  }

  function inlineNode(c) {
    if (MARKS.has(c.name)) return "";
    switch (c.name) {
      case "Emphasis": return `<em>${inline(c)}</em>`;
      case "StrongEmphasis": return `<strong>${inline(c)}</strong>`;
      case "Strikethrough": return `<del>${inline(c)}</del>`;
      case "InlineCode": return `<code>${inline(c)}</code>`;
      case "Escape": return esc(text(c.from + 1, c.to));
      case "Entity": return /^&(#\d+|#x[0-9a-f]+|[a-z]+);$/i.test(text(c.from, c.to)) ? text(c.from, c.to) : esc(text(c.from, c.to));
      case "HardBreak": return "<br>";
      case "URL": case "Autolink": {
        const raw = text(c.from, c.to).replace(/^<|>$/g, "");
        return `<a href="${esc(url(raw, "link"))}">${esc(raw)}</a>`;
      }
      case "Link": {
        const p = linkParts(c);
        if (!p.href) return inline(c);
        return `<a href="${esc(url(p.href, "link"))}"${p.title ? ` title="${esc(p.title)}"` : ""}>${inline(c, p.labelFrom, p.labelTo)}</a>`;
      }
      case "Image": {
        const p = linkParts(c);
        return `<img src="${esc(url(p.href, "image"))}" alt="${esc(text(p.labelFrom, p.labelTo))}"${p.title ? ` title="${esc(p.title)}"` : ""}>`;
      }
      default: return inline(c);
    }
  }

  const slugs = new Map();
  function slug(s) {
    const base = (opts.slug ? opts.slug(s) : s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "")) || "titre";
    const n = slugs.get(base) || 0;
    slugs.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  }

  function cells(row, tag, aligns) {
    return children(row, "TableCell").map((cell, i) => `<${tag}${aligns[i] ? ` style="text-align:${aligns[i]}"` : ""}>${inline(cell).trim()}</${tag}>`).join("");
  }

  function block(node) {
    const name = node.name;
    let m;
    if ((m = /^(?:ATX|Setext)Heading(\d)$/.exec(name))) {
      const inner = inline(node).trim();
      return `<h${m[1]} id="${esc(slug(text(node.from, node.to).replace(/^#+\s*|\s*#*\s*$|\n[=-]+\s*$/g, "")))}">${inner}</h${m[1]}>\n`;
    }
    switch (name) {
      case "Document": return children(node).map(block).join("");
      case "Paragraph": return `<p>${inline(node).trim()}</p>\n`;
      case "Blockquote": return `<blockquote>\n${children(node).filter((c) => c.name !== "QuoteMark").map(block).join("")}</blockquote>\n`;
      case "BulletList": return `<ul>\n${children(node, "ListItem").map(block).join("")}</ul>\n`;
      case "OrderedList": {
        const first = child(node, "ListItem"), mark = first && child(first, "ListMark");
        const start = mark ? parseInt(text(mark.from, mark.to), 10) : 1;
        return `<ol${start > 1 ? ` start="${start}"` : ""}>\n${children(node, "ListItem").map(block).join("")}</ol>\n`;
      }
      case "ListItem": {
        const parts = children(node).filter((c) => c.name !== "ListMark");
        const task = parts.length && parts[0].name === "Task";
        return `<li${task ? ' class="task"' : ""}>${parts.map(block).join("").replace(/^<p>([\s\S]*?)<\/p>\n$/, "$1")}</li>\n`;
      }
      case "Task": {
        const mk = child(node, "TaskMarker");
        const checked = mk && /x/i.test(text(mk.from, mk.to));
        return `<input type="checkbox" disabled${checked ? " checked" : ""}> ${inline(node).trim()}`;
      }
      case "FencedCode": {
        const info = child(node, "CodeInfo");
        const code = children(node, "CodeText").map((c) => text(c.from, c.to)).join("\n");
        return `<pre><code${info ? ` class="language-${esc(text(info.from, info.to).trim())}"` : ""}>${esc(code)}</code></pre>\n`;
      }
      case "CodeBlock": return `<pre><code>${esc(text(node.from, node.to).replace(/^( {4}|\t)/gm, ""))}</code></pre>\n`;
      case "HorizontalRule": return "<hr>\n";
      case "Table": {
        const delim = child(node, "TableDelimiter");
        const aligns = delim ? text(delim.from, delim.to).split("|").map((s) => s.trim()).filter(Boolean)
          .map((s) => (/^:-+:$/.test(s) ? "center" : /-:$/.test(s) ? "right" : /^:-/.test(s) ? "left" : "")) : [];
        const head = child(node, "TableHeader");
        const rows = children(node, "TableRow");
        return `<table>\n${head ? `<thead><tr>${cells(head, "th", aligns)}</tr></thead>\n` : ""}<tbody>\n${rows.map((r) => `<tr>${cells(r, "td", aligns)}</tr>\n`).join("")}</tbody>\n</table>\n`;
      }
      case "HTMLBlock": case "CommentBlock": case "ProcessingInstructionBlock":
        return `<p>${esc(text(node.from, node.to))}</p>\n`;
      case "LinkReference": return "";
      default: return `<p>${inline(node).trim()}</p>\n`;
    }
  }
  return block(tree.topNode);
}

/** Lignes de chaque tableau du texte : [{ from, to, html }] (rendu des tableaux dans l'éditeur). */
export function tablesIn(src, from = 0, to = src.length) {
  const out = [];
  parser.parse(src).iterate({
    from, to,
    enter(n) {
      if (n.name === "Table") { out.push({ from: n.from, to: n.to, html: markdownToHtml(src.slice(n.from, n.to)) }); return false; }
      return undefined;
    },
  });
  return out;
}
