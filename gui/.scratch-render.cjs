const { renderToStaticMarkup } = require('react-dom/server');
const { createElement } = require('react');
const { Trash2, Clock, Database } = require('lucide-react');
const fs = require('fs');
const mk = (I, size) => renderToStaticMarkup(createElement(I, { size, strokeWidth: 1.75 }));
const html = `<html data-theme="dark"><link rel="stylesheet" href="app.css"><body style="background:var(--surface);padding:10px;width:400px">
<div class="mem-row"><span class="mem-rowline"><Database ... placeholder></span></div>
<div class="mem-row" style="display:flex;align-items:center;gap:8px">
<span style="color:var(--fg-secondary)">${mk(Database,14)}</span><span style="font:14px sans-serif;color:var(--fg-secondary)">text</span>
<span class="mem-date" style="font:14px sans-serif;color:var(--fg-tertiary)">${mk(Clock,14)}2026-11-09</span>
<button class="sx-changes-act mem-del" style="opacity:1">${mk(Trash2,18)}</button>
<button class="sx-changes-act mem-del arm" style="opacity:1">${mk(Trash2,18)}</button>
</div></body></html>`;
fs.writeFileSync('.scratch/x.html', html.replaceAll(' ... placeholder','').replaceAll('<svg ','<svg class="lucide" '));
