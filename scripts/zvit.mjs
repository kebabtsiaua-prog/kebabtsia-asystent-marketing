// Weekly work report as a PDF: node scripts/zvit.mjs report.json out.pdf
// report.json holds the week as data (period, author, days, done groups, open tasks, plan); the reports
// themselves stay out of the repo, it is public. Needs Playwright with Chromium.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const { chromium } = createRequire(import.meta.url)("playwright");

const e = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const CSS = `

@page{size:A4;margin:14mm 15mm 12mm}
:root{--ink:#1f1d1a;--muted:#6f6a61;--line:#e4e0d8;--accent:#c8411f;--soft:#f6efe9;--ok:#2f7d3a}
*{box-sizing:border-box}
body{margin:0;color:var(--ink);font:10pt/1.5 Manrope,Inter,"DejaVu Sans",sans-serif}
h1,h2,.num{font-family:Unbounded,"Inter Display",Inter,sans-serif}
.top{display:flex;justify-content:space-between;align-items:flex-end;gap:12mm;border-bottom:2px solid var(--accent);padding-bottom:5mm}
.eyebrow{font-size:8pt;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);font-weight:700}
h1{font-size:20pt;line-height:1.15;margin:2mm 0 0;font-weight:600}
.who{text-align:right;font-size:9pt;color:var(--muted);white-space:nowrap}
.who b{color:var(--ink);font-size:10pt}
.summary{margin:6mm 0 0;font-size:10.5pt;max-width:165mm}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:4mm;margin:5mm 0}
.kpi{background:var(--soft);border-radius:3mm;padding:4mm}
.kpi .num{font-size:18pt;font-weight:600;font-variant-numeric:tabular-nums}
.kpi span{display:block;font-size:8.5pt;color:var(--muted)}
.kpi.main .num{color:var(--accent)}
h2{font-size:12pt;font-weight:600;margin:6mm 0 3mm;display:flex;justify-content:space-between;align-items:baseline}
h2 small{font-family:Manrope,Inter,sans-serif;font-size:8.5pt;color:var(--muted);font-weight:500}
.days{display:grid;grid-template-columns:repeat(var(--n),1fr);gap:4mm}
.day{font-size:8.5pt;color:var(--muted)}
.day b{display:block;color:var(--ink);font-size:9.5pt}
.bar{height:2.4mm;background:var(--line);border-radius:2mm;margin:1.5mm 0;overflow:hidden}
.bar i{display:block;height:100%;background:var(--accent)}
.groups{columns:2;column-gap:8mm}
.group{break-inside:avoid;margin:0 0 5mm}
.group h3{font-size:9.5pt;margin:0 0 1.5mm;display:flex;justify-content:space-between;border-bottom:1px solid var(--line);padding-bottom:1mm}
.group h3 span{color:var(--ok);font-variant-numeric:tabular-nums}
ul{margin:0;padding-left:4mm}
li{margin:0 0 1mm}
table{width:100%;border-collapse:collapse;font-size:9pt}
th{text-align:left;white-space:nowrap;font-size:7.5pt;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:600;border-bottom:1px solid var(--ink);padding:1.5mm 2mm}
td{border-bottom:1px solid var(--line);padding:2mm;vertical-align:top}
td.area{font-weight:700;white-space:nowrap}
td.since{white-space:nowrap;font-variant-numeric:tabular-nums;color:var(--muted)}
tr{break-inside:avoid}
.note{background:var(--soft);border-radius:3mm;padding:3mm 4mm;font-size:9pt;margin-top:3mm}
.plan li{margin-bottom:1.5mm}
.foot{margin-top:4mm;font-size:8pt;color:var(--muted);border-top:1px solid var(--line);padding-top:2mm}
h2{break-after:avoid}
`;

function build(r) {
  const total = r.days.reduce((a, d) => a + d.total, 0);
  const done = r.days.reduce((a, d) => a + d.done, 0);
  const pct = total ? Math.round(done * 100 / total) : 0;
  const days = r.days.map((d) => `<div class="day"><b>${e(d.label)}</b>` + (d.total
    ? `<div class="bar"><i style="width:${Math.round(d.done * 100 / d.total)}%"></i></div>${d.done} з ${d.total}`
    : `<div class="bar"></div>${e(d.note ?? "немає картки")}`) + "</div>").join("");
  const groups = r.groups.map((g) => `<div class="group"><h3>${e(g.title)}<span>${g.n ?? g.items.length}</span></h3><ul>` +
    g.items.map((i) => `<li>${e(i)}</li>`).join("") + "</ul></div>").join("");
  const rows = r.open.map((o) => `<tr><td class="area">${e(o.area)}</td><td>${e(o.task)}</td><td class="since">${e(o.since)}</td></tr>`).join("");
  const plan = r.plan.map((p) => `<li>${e(p)}</li>`).join("");
  const note = r.note ? `<div class="note">${e(r.note)}</div>` : "";
  return `<!doctype html><html lang="uk"><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Manrope:400,500,700|Unbounded:500,600&display=swap">
<style>${CSS}</style></head><body>
<div class="top"><div><div class="eyebrow">Звіт про виконану роботу · маркетинг</div><h1>${e(r.period)}</h1></div>
<div class="who"><b>${e(r.author)}</b><br>${e(r.role)}<br>Кебабця</div></div>
<p class="summary">${e(r.summary)}</p>
<div class="kpis"><div class="kpi main"><div class="num">${done}</div><span>задач закрито</span></div>
<div class="kpi"><div class="num">${total}</div><span>задач було в плані</span></div>
<div class="kpi"><div class="num">${pct}%</div><span>виконання плану</span></div>
<div class="kpi"><div class="num">${total - done}</div><span>переходять на наступний тиждень</span></div></div>
<div class="days" style="--n:${r.days.length}">${days}</div>
<h2>Що зроблено <small>за напрямами</small></h2><div class="groups">${groups}</div>
<div class="page2"><h2>Що не закрито <small>переходить на ${e(r.next)}</small></h2>
<table><thead><tr><th>Напрям</th><th>Задача</th><th>Відкрита з</th></tr></thead><tbody>${rows}</tbody></table>${note}
<h2>План на ${e(r.next)}</h2><ul class="plan">${plan}</ul>
<div class="foot">Джерело: дошка Trello «Мої задачі Кебабця», щоденні картки. Звіт склав асистент, перевірив ${e(r.author)}.</div></div>
</body></html>`;
}

// Renders one report to a PDF file. Used by the command line below and by scripts/zvity-server.mjs.
export async function render(r, out) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(build(r), { waitUntil: "networkidle" });
  await page.pdf({ path: out, format: "A4", printBackground: true, preferCSSPageSize: true });
  await browser.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [src, out] = process.argv.slice(2);
  await render(JSON.parse(readFileSync(src, "utf8")), out);
}
