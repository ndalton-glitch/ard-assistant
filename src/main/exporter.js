// Export a draft (HTML from the editor) to Word or PDF.
const fs = require('fs');
const { BrowserWindow } = require('electron');
const D = require('docx');

// Minimal HTML tokenizer: good enough for the editor's output (headings, paragraphs, lists, tables, bold/italic/underline).
function parseHTML(html) {
  const root = { tag: 'root', children: [] };
  const stack = [root];
  const re = /<\/?([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g;
  const voidTags = new Set(['br', 'hr', 'img', 'meta', 'input']);
  let m;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1];
    if (m[3] !== undefined) { top.children.push({ text: decode(m[3]) }); continue; }
    const tag = m[1].toLowerCase();
    if (m[0].startsWith('</')) {
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === tag) { stack.length = i; break; }
      continue;
    }
    const node = { tag, children: [] };
    top.children.push(node);
    if (!voidTags.has(tag) && !m[0].endsWith('/>')) stack.push(node);
  }
  return root;
}
function decode(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

function runs(node, fmt = {}) {
  const out = [];
  for (const c of node.children || []) {
    if (c.text !== undefined) {
      const t = c.text.replace(/\s+/g, ' ');
      if (t) out.push(new D.TextRun({ text: t, bold: fmt.b, italics: fmt.i, underline: fmt.u ? {} : undefined, highlight: /\[(NEEDS INPUT|VERIFY)/.test(t) ? 'yellow' : undefined }));
    } else if (c.tag === 'br') out.push(new D.TextRun({ break: 1 }));
    else {
      const f = { ...fmt };
      if (c.tag === 'b' || c.tag === 'strong') f.b = true;
      if (c.tag === 'i' || c.tag === 'em') f.i = true;
      if (c.tag === 'u') f.u = true;
      out.push(...runs(c, f));
    }
  }
  return out;
}

let olInstance = 0;
function blocks(node, out = [], list = null, level = 0) {
  for (const c of node.children || []) {
    if (c.text !== undefined) { if (c.text.trim()) out.push(new D.Paragraph({ children: runs({ children: [c] }) })); continue; }
    switch (c.tag) {
      case 'h1': out.push(new D.Paragraph({ heading: D.HeadingLevel.TITLE, children: runs(c) })); break;
      case 'h2': out.push(new D.Paragraph({ heading: D.HeadingLevel.HEADING_1, children: runs(c) })); break;
      case 'h3': out.push(new D.Paragraph({ heading: D.HeadingLevel.HEADING_2, children: runs(c) })); break;
      case 'h4': case 'h5': case 'h6': out.push(new D.Paragraph({ heading: D.HeadingLevel.HEADING_3, children: runs(c) })); break;
      case 'p': case 'div': {
        const hasBlock = (c.children || []).some(k => ['p', 'div', 'ul', 'ol', 'table', 'h1', 'h2', 'h3'].includes(k.tag));
        if (hasBlock) blocks(c, out, list, level); else out.push(new D.Paragraph({ children: runs(c) }));
        break;
      }
      case 'ul': case 'ol': if (c.tag === 'ol' && !list) olInstance++; blocks(c, out, c.tag, list ? level + 1 : 0); break;
      case 'li': {
        const inline = { children: (c.children || []).filter(k => !['ul', 'ol'].includes(k.tag)) };
        const p = list === 'ol'
          ? new D.Paragraph({ numbering: { reference: 'num', level: Math.min(level, 2), instance: olInstance }, children: runs(inline) })
          : new D.Paragraph({ bullet: { level: Math.min(level, 2) }, children: runs(inline) });
        out.push(p);
        for (const k of c.children || []) if (k.tag === 'ul' || k.tag === 'ol') blocks({ children: [k] }, out, list, level);
        break;
      }
      case 'table': out.push(table(c)); out.push(new D.Paragraph('')); break;
      case 'hr': out.push(new D.Paragraph({ border: { bottom: { style: D.BorderStyle.SINGLE, size: 6, color: '999999' } } })); break;
      default: blocks(c, out, list, level);
    }
  }
  return out;
}

function table(node) {
  const rows = [];
  const walk = n => { for (const c of n.children || []) { if (c.tag === 'tr') rows.push(c); else if (c.tag) walk(c); } };
  walk(node);
  const width = Math.max(1, ...rows.map(r => (r.children || []).filter(c => c.tag === 'td' || c.tag === 'th').length));
  return new D.Table({
    width: { size: 100, type: D.WidthType.PERCENTAGE },
    rows: rows.map(r => {
      const cells = (r.children || []).filter(c => c.tag === 'td' || c.tag === 'th');
      while (cells.length < width) cells.push({ tag: 'td', children: [] });
      return new D.TableRow({ children: cells.map(cell => new D.TableCell({
        shading: cell.tag === 'th' ? { fill: 'E8EEF4', type: D.ShadingType.CLEAR, color: 'auto' } : undefined,
        children: [new D.Paragraph({ children: runs(cell, { b: cell.tag === 'th' }) })],
      })) });
    }),
  });
}

async function toDocx(html, file) {
  const doc = new D.Document({
    styles: { default: { document: { run: { font: 'Calibri', size: 22 }, paragraph: { spacing: { after: 100 } } } } },
    numbering: { config: [{ reference: 'num', levels: [0, 1, 2].map(l => ({ level: l, format: D.LevelFormat.DECIMAL, text: `%${l + 1}.`, alignment: D.AlignmentType.START, style: { paragraph: { indent: { left: 720 * (l + 1), hanging: 360 } } } })) }] },
    sections: [{ properties: { page: { margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } } }, children: blocks(parseHTML(html)) }],
  });
  fs.writeFileSync(file, await D.Packer.toBuffer(doc));
}

function printableHTML(html, title) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title || 'ARD Summary'}</title><style>
  body{font-family:Calibri,"Segoe UI",Arial,sans-serif;font-size:11pt;color:#111;line-height:1.4;margin:0}
  h1{font-size:18pt;margin:0 0 8pt}h2{font-size:13pt;margin:14pt 0 4pt;border-bottom:1px solid #bbb;padding-bottom:2pt}h3{font-size:11.5pt;margin:10pt 0 3pt}
  table{border-collapse:collapse;width:100%;margin:6pt 0}td,th{border:1px solid #999;padding:3pt 5pt;text-align:left;vertical-align:top}th{background:#e8eef4}
  mark,.ph{background:#fff59d}
  </style></head><body>${html.replace(/\[(NEEDS INPUT|VERIFY)([^\]]*)\]/g, '<mark>[$1$2]</mark>')}</body></html>`;
}

async function toPdf(html, file, title) {
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false } });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(printableHTML(html, title)));
    const buf = await win.webContents.printToPDF({ pageSize: 'Letter', margins: { marginType: 'default' }, printBackground: true });
    fs.writeFileSync(file, buf);
  } finally { win.destroy(); }
}

module.exports = { toDocx, toPdf, printableHTML };
