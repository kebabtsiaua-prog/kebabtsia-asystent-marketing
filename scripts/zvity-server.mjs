// Turns queued weekly reports into PDFs for the bot. Claude puts the report as data into as_outbox.report
// (Sunday evening); this script, run by GitHub Actions, renders every row that has no file yet and stores the PDF
// as base64 in as_outbox.file_b64. The bot sends it at send_after. Prints only ids and sizes: the repo is public.
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "./zvit.mjs";

const ref = process.env.PROJECT_REF, token = process.env.SUPABASE_ACCESS_TOKEN;
async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`SQL ${res.status}`);
  return await res.json();
}

const rows = await sql("select id, report from as_outbox where file_b64 is null and report is not null order by id");
console.log(`to render: ${rows.length}`);
for (const { id, report } of rows) {
  const out = join(tmpdir(), `zvit-${id}.pdf`);
  await render(typeof report === "string" ? JSON.parse(report) : report, out);
  const b64 = readFileSync(out).toString("base64");
  rmSync(out);
  await sql(`update as_outbox set file_b64 = '${b64}' where id = ${Number(id)} and file_b64 is null`);
  console.log(`#${id}: ${Math.round(b64.length * 0.75 / 1024)} KB`);
}
