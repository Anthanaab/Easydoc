// Éditeur d'Easydoc : CodeMirror 6 branché sur le Y.Text partagé (y-codemirror.next).
//
// Le document reste du Markdown (le fichier du dépôt, le texte partagé, les auteurs et les
// commentaires n'ont pas changé) ; l'affichage est « mis en forme » à la manière d'Obsidian :
// titres en grand, gras en gras, listes à puces, cases à cocher, liens, images… Les symboles
// Markdown (**, #, [](…)) ne réapparaissent que sur la ligne où se trouve le curseur.
//
// L'application fournit ses données par des « crochets » (hooks) :
//   marks(from, to)   → passages à surligner : [{ from, to, cls, attrs }] (auteurs, commentaires)
//   onUpdate(update, local) → après chaque changement (texte, sélection, focus)
//   resolveImage(src) → adresse d'une image du dépôt ;  openLink(href) → ouverture d'un lien
import { EditorState, EditorSelection, StateEffect, Compartment, Prec } from "@codemirror/state";
import { EditorView, ViewPlugin, Decoration, WidgetType, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { syntaxTree, syntaxHighlighting, HighlightStyle, LanguageSupport } from "@codemirror/language";
import { markdownLanguage, markdownKeymap } from "@codemirror/lang-markdown";
import { tags } from "@lezer/highlight";
import { yCollab, yUndoManagerKeymap, ySyncAnnotation } from "y-codemirror.next";

/** Redessine les surlignages fournis par l'application (auteurs, commentaires). */
const refreshEffect = StateEffect.define();

/* ---- Surlignages de l'application ---------------------------------------------------------- */
function appMarks(hooks) {
  return ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = this.build(view); }
    update(u) {
      if (u.docChanged || u.viewportChanged || u.transactions.some((t) => t.effects.some((e) => e.is(refreshEffect)))) {
        this.decorations = this.build(u.view);
      }
    }
    build(view) {
      const len = view.state.doc.length;
      const out = [];
      for (const { from, to } of view.visibleRanges) {
        for (const m of hooks.marks(from, to) || []) {
          const a = Math.max(0, m.from), b = Math.min(len, m.to);
          if (b > a) out.push(Decoration.mark({ class: m.cls, attributes: m.attrs || {} }).range(a, b));
        }
      }
      return Decoration.set(out, true);
    }
  }, { decorations: (v) => v.decorations });
}

/* ---- Affichage mis en forme (Markdown « vivant ») -------------------------------------------- */
class BulletWidget extends WidgetType {
  eq() { return true; }
  toDOM() { const s = document.createElement("span"); s.className = "cm-bullet"; s.textContent = "•"; return s; }
}
class CheckboxWidget extends WidgetType {
  constructor(checked, pos) { super(); this.checked = checked; this.pos = pos; }
  eq(o) { return o.checked === this.checked && o.pos === this.pos; }
  toDOM(view) {
    const box = document.createElement("input");
    box.type = "checkbox"; box.className = "cm-task"; box.checked = this.checked;
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("click", (e) => {
      e.preventDefault();
      if (view.state.readOnly) return;
      view.dispatch({ changes: { from: this.pos + 1, to: this.pos + 2, insert: this.checked ? " " : "x" }, userEvent: "input.task" });
    });
    return box;
  }
  ignoreEvent() { return true; }
}
class ImageWidget extends WidgetType {
  constructor(src, alt) { super(); this.src = src; this.alt = alt; }
  eq(o) { return o.src === this.src && o.alt === this.alt; }
  toDOM() {
    const img = document.createElement("img");
    img.className = "cm-img"; img.src = this.src; img.alt = this.alt; img.loading = "lazy";
    return img;
  }
}
class RuleWidget extends WidgetType {
  eq() { return true; }
  toDOM() { const s = document.createElement("span"); s.className = "cm-rule"; return s; }
}

function livePreview(hooks) {
  const hide = Decoration.replace({});
  const line = (cls) => Decoration.line({ class: cls });
  const mark = (cls, attrs) => Decoration.mark({ class: cls, attributes: attrs });

  function build(view) {
    const { state } = view;
    const doc = state.doc;
    // lignes « actives » : celles de la sélection, quand on écrit (symboles visibles)
    const active = new Set();
    if (view.hasFocus && !state.readOnly) {
      for (const r of state.selection.ranges) {
        for (let l = doc.lineAt(r.from).number, e = doc.lineAt(r.to).number; l <= e; l++) active.add(l);
      }
    }
    const isActive = (from, to) => {
      for (let l = doc.lineAt(from).number, e = doc.lineAt(to).number; l <= e; l++) if (active.has(l)) return true;
      return false;
    };
    const out = [];
    const lineDeco = (pos, cls) => out.push(line(cls).range(doc.lineAt(pos).from));
    const linesDeco = (from, to, cls) => {
      for (let l = doc.lineAt(from).number, e = doc.lineAt(to).number; l <= e; l++) out.push(line(cls).range(doc.line(l).from));
    };
    const hideRange = (a, b) => { if (b > a) out.push(hide.range(a, b)); };
    /** Masque un symbole et les espaces qui le suivent (« # », « > », « - »). */
    const hideWithSpace = (a, b) => {
      let e = b;
      while (e < doc.length && e < b + 4 && doc.sliceString(e, e + 1) === " ") e++;
      hideRange(a, e);
    };

    for (const { from, to } of view.visibleRanges) {
      syntaxTree(state).iterate({
        from, to,
        enter(n) {
          const name = n.name;
          const act = isActive(n.from, n.to);
          if (/^ATXHeading(\d)$/.test(name)) {
            lineDeco(n.from, `cm-h cm-h${name.slice(-1)}`);
            const hm = n.node.getChild("HeaderMark");
            if (hm && !act) hideWithSpace(hm.from, hm.to);
            return;
          }
          if (/^SetextHeading(\d)$/.test(name)) {
            linesDeco(n.from, n.to, `cm-h cm-h${name.slice(-1)}`);
            const hm = n.node.getChild("HeaderMark");
            if (hm) lineDeco(hm.from, "cm-setext");
            return;
          }
          switch (name) {
            case "StrongEmphasis": out.push(mark("cm-strong").range(n.from, n.to)); break;
            case "Emphasis": out.push(mark("cm-em").range(n.from, n.to)); break;
            case "Strikethrough": out.push(mark("cm-strike").range(n.from, n.to)); break;
            case "EmphasisMark": case "StrikethroughMark":
              if (!act) hideRange(n.from, n.to); else out.push(mark("cm-md-mark").range(n.from, n.to));
              break;
            case "InlineCode": {
              out.push(mark("cm-icode").range(n.from, n.to));
              if (!act) for (const cm of n.node.getChildren("CodeMark")) hideRange(cm.from, cm.to);
              return false;
            }
            case "Link": {
              const marks = n.node.getChildren("LinkMark");
              const url = n.node.getChild("URL");
              const href = url ? doc.sliceString(url.from, url.to) : "";
              if (marks.length >= 2) {
                const textFrom = marks[0].to, textTo = marks[1].from;
                if (textTo > textFrom) out.push(mark("cm-link", { "data-href": href }).range(textFrom, textTo));
                if (!act) { hideRange(n.from, textFrom); hideRange(textTo, n.to); }
                else out.push(mark("cm-md-mark").range(textTo, n.to));
              }
              return false;
            }
            case "Autolink": case "URL": {
              if (name === "URL" && n.node.parent && /Link|Image/.test(n.node.parent.name)) return false;
              const t = doc.sliceString(n.from, n.to).replace(/^<|>$/g, "");
              out.push(mark("cm-link", { "data-href": t }).range(n.from, n.to));
              return false;
            }
            case "Image": {
              const url = n.node.getChild("URL");
              const marks = n.node.getChildren("LinkMark");
              const alt = marks.length >= 2 ? doc.sliceString(marks[0].to, marks[1].from) : "";
              if (url && !act) {
                out.push(Decoration.replace({ widget: new ImageWidget(hooks.resolveImage(doc.sliceString(url.from, url.to)), alt) }).range(n.from, n.to));
              } else out.push(mark("cm-md-mark").range(n.from, n.to));
              return false;
            }
            case "Blockquote": linesDeco(n.from, n.to, "cm-quote"); break;
            case "QuoteMark": if (!isActive(n.from, n.from)) hideWithSpace(n.from, n.to); break;
            case "ListItem": {
              // retrait suspendu : un élément long revient à la ligne sous son texte, pas sous la puce
              const ln = doc.lineAt(n.from);
              if (n.from - ln.from <= 1) lineDeco(n.from, "cm-li");
              break;
            }
            case "ListMark": {
              const list = n.node.parent && n.node.parent.parent;
              const task = n.node.parent && n.node.parent.getChild("Task");
              if (list && list.name === "BulletList" && !isActive(n.from, n.from)) {
                if (task) hideWithSpace(n.from, n.to);
                else out.push(Decoration.replace({ widget: new BulletWidget() }).range(n.from, n.to));
              } else out.push(mark("cm-listmark").range(n.from, n.to));
              break;
            }
            case "TaskMarker": {
              const checked = /x/i.test(doc.sliceString(n.from, n.to));
              if (!isActive(n.from, n.from)) out.push(Decoration.replace({ widget: new CheckboxWidget(checked, n.from) }).range(n.from, n.to));
              if (checked) out.push(mark("cm-done").range(n.to, doc.lineAt(n.from).to));
              break;
            }
            case "FencedCode": case "CodeBlock": {
              linesDeco(n.from, n.to, "cm-codeblock");
              lineDeco(n.from, "cm-codeblock-first");
              lineDeco(n.to, "cm-codeblock-last");
              for (const cm of n.node.getChildren("CodeMark")) out.push(mark("cm-md-mark").range(cm.from, cm.to));
              return false;
            }
            case "HorizontalRule":
              if (!act) out.push(Decoration.replace({ widget: new RuleWidget() }).range(n.from, n.to));
              else out.push(mark("cm-md-mark").range(n.from, n.to));
              break;
            case "Table": linesDeco(n.from, n.to, "cm-table"); return false;
            case "HTMLBlock": case "HTMLTag": case "Comment": out.push(mark("cm-html").range(n.from, n.to)); break;
          }
          return undefined;
        },
      });
    }
    return Decoration.set(out, true);
  }

  return ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = build(view); }
    update(u) {
      if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged
        || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = build(u.view);
    }
  }, { decorations: (v) => v.decorations });
}

/* Couleurs du code et des éléments Markdown (le reste est dans style.css) */
const mdHighlight = HighlightStyle.define([
  { tag: tags.processingInstruction, class: "cm-md-mark" },
  { tag: tags.meta, class: "cm-md-mark" },
  { tag: tags.monospace, class: "cm-mono" },
  { tag: tags.url, class: "cm-url" },
]);

/* ---- Commandes de mise en forme ------------------------------------------------------------ */
/** Entoure la sélection (ou le mot) d'un symbole, ou le retire s'il y est déjà. */
function toggleWrap(view, m) {
  const { state } = view;
  if (state.readOnly) return false;
  const ml = m.length;
  const tr = state.changeByRange((r) => {
    const text = state.sliceDoc(r.from, r.to);
    if (state.sliceDoc(r.from - ml, r.from) === m && state.sliceDoc(r.to, r.to + ml) === m) {
      return { changes: [{ from: r.from - ml, to: r.from }, { from: r.to, to: r.to + ml }], range: EditorSelection.range(r.from - ml, r.to - ml) };
    }
    if (text.length >= 2 * ml && text.startsWith(m) && text.endsWith(m)) {
      return { changes: { from: r.from, to: r.to, insert: text.slice(ml, -ml) }, range: EditorSelection.range(r.from, r.to - 2 * ml) };
    }
    if (r.empty) {
      const w = state.wordAt(r.head);
      if (w) return { changes: [{ from: w.from, insert: m }, { from: w.to, insert: m }], range: EditorSelection.cursor(r.head + ml) };
      return { changes: { from: r.from, insert: m + m }, range: EditorSelection.cursor(r.from + ml) };
    }
    // les espaces en bordure restent en dehors (« **mot** » et non « **mot **»)
    const lead = text.length - text.trimStart().length, trail = text.length - text.trimEnd().length;
    const a = r.from + lead, b = r.to - trail;
    return { changes: [{ from: a, insert: m }, { from: b, insert: m }], range: EditorSelection.range(a + ml, b + ml) };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input.format" }));
  view.focus();
  return true;
}

const BLOCK_RE = /^(\s*)(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)?/;
function kindOfPrefix(p) {
  if (!p) return "";
  if (p[0] === "#") return "h" + p.trim().length;
  if (p[0] === ">") return "quote";
  if (/\[[ xX]\]/.test(p)) return "task";
  if (/^[-*+]/.test(p)) return "ul";
  return "ol";
}
/** Type de bloc des lignes sélectionnées (titre, liste, citation…) ; le même type l'annule. */
function setBlock(view, kind) {
  const { state } = view;
  if (state.readOnly) return false;
  const lines = [];
  for (const r of state.selection.ranges) {
    for (let l = state.doc.lineAt(r.from).number, e = state.doc.lineAt(r.to).number; l <= e; l++) {
      if (!lines.includes(l)) lines.push(l);
    }
  }
  const info = lines.map((n) => {
    const ln = state.doc.line(n);
    const m = BLOCK_RE.exec(ln.text);
    return { ln, indent: m[1], prefix: m[2] || "", kind: kindOfPrefix(m[2] || "") };
  });
  const content = info.filter((x) => x.ln.text.trim() || info.length === 1);
  const off = content.length && content.every((x) => x.kind === kind);
  let num = 1;
  const changes = content.map((x) => {
    let p = "";
    if (!off) {
      if (/^h\d$/.test(kind)) p = "#".repeat(+kind[1]) + " ";
      else if (kind === "quote") p = "> ";
      else if (kind === "ul") p = "- ";
      else if (kind === "task") p = "- [ ] ";
      else if (kind === "ol") p = `${num++}. `;
    }
    const from = x.ln.from + x.indent.length;
    return { from, to: from + x.prefix.length, insert: p };
  });
  view.dispatch({ changes, scrollIntoView: true, userEvent: "input.format" });
  view.focus();
  return true;
}
function insertLink(view) {
  const { state } = view;
  if (state.readOnly) return false;
  const r = state.selection.main;
  const text = state.sliceDoc(r.from, r.to) || "lien";
  const insert = `[${text}](https://)`;
  const urlFrom = r.from + text.length + 3;
  view.dispatch({ changes: { from: r.from, to: r.to, insert }, selection: EditorSelection.range(urlFrom, urlFrom + 8), scrollIntoView: true, userEvent: "input.format" });
  view.focus();
  return true;
}
function codeFormat(view) {
  const { state } = view;
  const r = state.selection.main;
  if (state.doc.lineAt(r.from).number !== state.doc.lineAt(r.to).number) {
    const a = state.doc.lineAt(r.from).from, b = state.doc.lineAt(r.to).to;
    view.dispatch({ changes: [{ from: a, insert: "```\n" }, { from: b, insert: "\n```" }], userEvent: "input.format" });
    view.focus();
    return true;
  }
  return toggleWrap(view, "`");
}
export const FORMATS = {
  bold: (v) => toggleWrap(v, "**"), italic: (v) => toggleWrap(v, "*"), strike: (v) => toggleWrap(v, "~~"), code: codeFormat,
  h1: (v) => setBlock(v, "h1"), h2: (v) => setBlock(v, "h2"), h3: (v) => setBlock(v, "h3"),
  ul: (v) => setBlock(v, "ul"), ol: (v) => setBlock(v, "ol"), task: (v) => setBlock(v, "task"), quote: (v) => setBlock(v, "quote"),
  link: insertLink,
};
const formatKeymap = [
  { key: "Mod-b", run: FORMATS.bold }, { key: "Mod-i", run: FORMATS.italic },
  { key: "Mod-Shift-x", run: FORMATS.strike }, { key: "Mod-e", run: FORMATS.code },
  { key: "Mod-Alt-1", run: FORMATS.h1 }, { key: "Mod-Alt-2", run: FORMATS.h2 }, { key: "Mod-Alt-3", run: FORMATS.h3 },
  { key: "Mod-Shift-7", run: FORMATS.ol }, { key: "Mod-Shift-8", run: FORMATS.ul }, { key: "Mod-Shift-9", run: FORMATS.task },
];

/* ---- L'éditeur ------------------------------------------------------------------------------ */
export function createEditor(parent, hooks) {
  const readOnlyComp = new Compartment();
  const placeholderComp = new Compartment();
  let mode = { kind: "markdown", collab: false };

  function extensions({ kind, ytext, awareness, undoManager, readOnly, placeholder }) {
    const md = kind === "markdown";
    const collab = !!ytext;
    return [
      readOnlyComp.of(EditorState.readOnly.of(!!readOnly)),
      placeholderComp.of(cmPlaceholder(placeholder || "")),
      EditorView.lineWrapping,
      Prec.high(keymap.of([...(md ? formatKeymap : []), ...(md ? markdownKeymap : [])])),
      keymap.of([...(collab ? yUndoManagerKeymap : historyKeymap), indentWithTab, ...defaultKeymap]),
      collab ? yCollab(ytext, awareness, { undoManager }) : history(),
      md ? [new LanguageSupport(markdownLanguage), livePreview(hooks), syntaxHighlighting(mdHighlight)] : [],
      appMarks(hooks),
      EditorView.editorAttributes.of({ class: md ? "cm-md" : "cm-plain" }),
      EditorView.contentAttributes.of({ spellcheck: "true", autocorrect: "on", autocapitalize: "sentences", "aria-label": "Contenu du document" }),
      EditorView.updateListener.of((u) => {
        const local = u.transactions.some((t) => t.docChanged && !t.annotation(ySyncAnnotation));
        hooks.onUpdate(u, local);
      }),
      EditorView.domEventHandlers({
        mousedown(e, view) {
          const a = e.target.closest && e.target.closest(".cm-link");
          if (a && (e.ctrlKey || e.metaKey || view.state.readOnly)) {
            e.preventDefault();
            hooks.openLink(a.dataset.href || a.textContent);
            return true;
          }
          return false;
        },
      }),
    ];
  }

  const view = new EditorView({ parent, state: EditorState.create({ doc: "", extensions: extensions({ kind: "markdown", readOnly: true }) }) });

  return {
    view,
    /** Nouveau document : texte de départ et, s'il y en a un, texte partagé en temps réel. */
    open(opts) {
      mode = { kind: opts.kind, collab: !!opts.ytext };
      view.setState(EditorState.create({ doc: opts.text || "", extensions: extensions(opts) }));
    },
    get text() { return view.state.doc.toString(); },
    /** Remplace le texte par une modification minimale (reprise après coupure, mode hors ligne). */
    setText(value) {
      const cur = view.state.doc.toString();
      if (cur === value) return;
      let a = 0;
      const max = Math.min(cur.length, value.length);
      while (a < max && cur.charCodeAt(a) === value.charCodeAt(a)) a++;
      let e1 = cur.length, e2 = value.length;
      while (e1 > a && e2 > a && cur.charCodeAt(e1 - 1) === value.charCodeAt(e2 - 1)) { e1--; e2--; }
      view.dispatch({ changes: { from: a, to: e1, insert: value.slice(a, e2) } });
    },
    get readOnly() { return view.state.readOnly; },
    setReadOnly(ro) { if (view.state.readOnly !== !!ro) view.dispatch({ effects: readOnlyComp.reconfigure(EditorState.readOnly.of(!!ro)) }); },
    setPlaceholder(t) { view.dispatch({ effects: placeholderComp.reconfigure(cmPlaceholder(t || "")) }); },
    get selection() { return view.state.selection.main; },
    setSelection(a, b = a, scroll = true) {
      const len = view.state.doc.length;
      view.dispatch({ selection: EditorSelection.range(Math.min(a, len), Math.min(b, len)), scrollIntoView: scroll });
    },
    get hasFocus() { return view.hasFocus; },
    focus() { view.focus(); },
    /** Redessine les surlignages de l'application (auteurs, commentaires). */
    refresh() { view.dispatch({ effects: refreshEffect.of(null) }); },
    /** Haut d'une position du texte, en coordonnées de la fenêtre (même hors de la zone affichée). */
    topAt(pos) {
      const p = Math.max(0, Math.min(pos, view.state.doc.length));
      const c = view.coordsAtPos(p, 1);
      if (c) return c.top;
      return view.documentTop + view.lineBlockAt(p).top;
    },
    lineAt(pos) { return view.state.doc.lineAt(pos); },
    format(name) { const f = FORMATS[name]; return f ? f(view) : false; },
    get mode() { return mode; },
  };
}
