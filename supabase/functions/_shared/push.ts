// «Пуш RFM»: the push plan, the reminders that keep coming until a push is marked sent, and the return check
// that compares the list a push went to with a later export.
import { db } from "./common.ts";
import { getValues, serviceAccount, setValues } from "./sheets.ts";
import { fromKyiv, kyiv } from "./time.ts";

export type Push = {
  num: number; due_at: string; segment: string; why: string; source: string; places: string; title: string; body: string;
  news: string; bonus: string; measure: string; check_on: string | null; check_what: string; status: string;
  sent_count: number | null; sent_at: string | null; nags: number; msg_id: number | null; notes?: string;
};
export type Nag = { at: Date; kind: "eve" | "soon" | "late" | "morning" };

const MIN = 60_000;

// When the bot reminds about one push: the evening before at 18:00, an hour before, 30 minutes after,
// then every 2 hours until 20:00, then at 9:00 for three more mornings.
export function nagTimes(due: Date): Nag[] {
  const d = kyiv(due);
  const out: Nag[] = [];
  const eve = fromKyiv(d.y, d.m, d.d - 1, 18, 0);
  if (eve.getTime() < due.getTime() - 3 * 60 * MIN) out.push({ at: eve, kind: "eve" });
  out.push({ at: new Date(due.getTime() - 60 * MIN), kind: "soon" });
  const evening = fromKyiv(d.y, d.m, d.d, 20, 0).getTime();
  for (let t = due.getTime() + 30 * MIN; t <= evening; t += 120 * MIN) out.push({ at: new Date(t), kind: "late" });
  for (let i = 1; i <= 3; i++) out.push({ at: fromKyiv(d.y, d.m, d.d + i, 9, 0), kind: "morning" });
  return out;
}

// The newest reminder that is due and not sent yet; older missed ones are skipped, so a late tick sends only one.
export function dueNag(p: Push, now: number): { index: number; nag: Nag } | null {
  const times = nagTimes(new Date(p.due_at));
  let index = -1;
  times.forEach((n, i) => { if (n.at.getTime() <= now) index = i; });
  if (index < 0 || index < p.nags) return null;
  return { index, nag: times[index] };
}

export async function pushList(): Promise<Push[]> {
  const { data } = await db.from("as_push").select("*").order("num");
  return (data ?? []) as Push[];
}

export async function markSent(num: number, count: number | null) {
  const patch: Record<string, unknown> = { status: "sent", updated_at: new Date().toISOString() };
  const { data } = await db.from("as_push").select("sent_at").eq("num", num).maybeSingle();
  if (!data?.sent_at) patch.sent_at = new Date().toISOString();
  if (count != null) patch.sent_count = count;
  patch.dirty = true;
  await db.from("as_push").update(patch).eq("num", num);
  const { data: p } = await db.from("as_push").select("title,sent_count").eq("num", num).maybeSingle();
  const k = kyiv(new Date()), dd = `${String(k.d).padStart(2, "0")}.${String(k.m).padStart(2, "0")}`;
  await db.from("as_trello_queue").insert({ action: "add", card: dd, item: `Пуш №${num} надіслано${p?.sent_count != null ? `, отримали ${p.sent_count}` : ""}: ${p?.title ?? ""}` });
  await syncNow();
}

export async function movePush(num: number, due: Date) {
  await db.from("as_push").update({ due_at: due.toISOString(), status: "plan", nags: passed(due.toISOString(), Date.now()), dirty: true, updated_at: new Date().toISOString() }).eq("num", num);
  await syncNow();
}

// The same time the next day.
export function nextDay(dueIso: string): Date {
  const p = kyiv(new Date(dueIso));
  return fromKyiv(p.y, p.m, p.d + 1, p.h, p.mi);
}

type Row = { i: string; g: string; c: number | null; l: string | null };

// Who of the people a push went to bought again: in the later export they have more checks or a purchase after the push.
export async function compare(num: number) {
  const { data: push } = await db.from("as_push").select("sent_at,due_at").eq("num", num).maybeSingle();
  const { data: files } = await db.from("as_push_files").select("kind,rows,created_at").eq("push_num", num).order("created_at");
  const base = (files ?? []).find((f) => f.kind === "sent");
  const later = (files ?? []).filter((f) => f.kind === "check").pop();
  if (!push || !base || !later) return null;
  const since = (push.sent_at ?? push.due_at).slice(0, 10);
  const after = new Map((later.rows as Row[]).map((r) => [r.i, r]));
  const groups: Record<string, { n: number; back: number }> = {};
  let back = 0;
  for (const r of base.rows as Row[]) {
    const g = (groups[r.g || "—"] ??= { n: 0, back: 0 });
    g.n++;
    const a = after.get(r.i);
    const came = !!a && ((a.c != null && r.c != null && a.c > r.c) || (!!a.l && a.l >= since && (!r.l || a.l > r.l)));
    if (came) { back++; g.back++; }
  }
  const n = (base.rows as Row[]).length;
  return { n, back, pct: n ? Math.round(back * 1000 / n) / 10 : 0, groups };
}

// ---------- The push plan sheet ----------
// as_kv «push_sheet» = { id, tab } (kept in the database, not in this public repo). Header in row 4, pushes from row 5.
// Columns: A № · B Дата · C День · D Час · E Сегмент · F Звідки список · G Заклади · H Заголовок · I Текст · J Новина ·
// K Бонус · L Що міряємо · O Надіслано · S Статус · T Нотатки.

type SheetCfg = { id: string; tab: string };
async function sheetCfg(): Promise<SheetCfg | null> {
  const { data } = await db.from("as_kv").select("value").eq("key", "push_sheet").maybeSingle();
  const v = data?.value as SheetCfg | undefined;
  return v?.id && serviceAccount() ? { id: v.id, tab: v.tab || "Контент-план" } : null;
}
// Without a Google key on the server Claude copies the sheet (rows from row 5, columns A–T) into as_kv «push_sheet_rows»
// at every Trello sync and writes the app's changes (rows with dirty = true) back itself.
async function copiedRows(): Promise<string[][] | null> {
  const { data } = await db.from("as_kv").select("value").eq("key", "push_sheet_rows").maybeSingle();
  const v = data?.value as { rows?: string[][]; done?: boolean } | undefined;
  if (!v?.rows || v.done) return null;
  await db.from("as_kv").update({ value: { ...v, done: true } }).eq("key", "push_sheet_rows");
  return v.rows;
}
const DAYS_SHORT = ["нд", "пн", "вт", "ср", "чт", "пт", "сб"];
const STATUS_IN: [RegExp, string][] = [[/^надісл/i, "sent"], [/^пропущ/i, "skipped"], [/^скасов|^об.?єднан/i, "cancelled"]];

// «2.11» + «18:40–19:00» → the Kyiv moment, in the year that puts it nearest to today.
function sheetDate(d: string, t: string, now: Date): Date | null {
  const m = d.match(/(\d{1,2})\.(\d{1,2})/), h = t.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const n = kyiv(now);
  let y = n.y;
  if (+m[2] - n.m > 6) y--;
  if (n.m - +m[2] > 6) y++;
  return fromKyiv(y, +m[2], +m[1], h ? +h[1] : 12, h ? +h[2] : 0);
}
function checkOf(measure: string, due: Date): string | null {
  const p = kyiv(due);
  if (!/перевір|звірк|сходинк/i.test(measure)) return null;
  for (const m of measure.matchAll(/(\d{2})\.(\d{2})/g)) {
    const y = +m[2] < p.m - 6 ? p.y + 1 : p.y;
    const iso = `${y}-${m[2]}-${m[1]}`;
    if (iso >= `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`) return iso;
  }
  return null;
}
const passed = (dueIso: string, now: number) => nagTimes(new Date(dueIso)).filter((n) => n.at.getTime() <= now).length;

// The sheet → the database. A push the app already marked sent stays sent and the sheet gets that status back.
export async function pullSheet(): Promise<Record<string, unknown>> {
  const cfg = await sheetCfg();
  if (cfg) await pushDirty(cfg);
  const rows = cfg ? await getValues(cfg.id, `${cfg.tab}!A5:T400`) : await copiedRows();
  if (!rows) return { ok: false, reason: "sheet not connected, no new copy" };
  const now = new Date();
  const { data: have } = await db.from("as_push").select("num,due_at,status,sent_count,nags");
  const byNum = new Map((have ?? []).map((r) => [r.num, r]));
  const out: Record<string, unknown>[] = [];
  rows.forEach((r, i) => {
    const num = parseInt(r[0] ?? "", 10);
    if (!num) return;
    const due = sheetDate(r[1] ?? "", r[3] ?? "", now);
    if (!due) return;
    const old = byNum.get(num);
    const sheetStatus = STATUS_IN.find(([re]) => re.test(r[18] ?? ""))?.[1] ?? "plan";
    const status = old?.status === "sent" ? "sent" : sheetStatus;
    const count = parseInt(String(r[14] ?? "").replace(/\D/g, ""), 10);
    const dueIso = due.toISOString();
    const row: Record<string, unknown> = {
      num, sheet_row: i + 5, segment: r[4] ?? "", source: (r[5] ?? "").replace(/;\s*/g, "\n"), places: r[6] ?? "", title: r[7] ?? "", body: r[8] ?? "",
      news: r[9] ?? "", bonus: r[10] ?? "", measure: r[11] ?? "", notes: r[19] ?? "", check_on: checkOf(r[11] ?? "", due), check_what: r[11] ?? "",
      status, updated_at: now.toISOString(),
    };
    // Every row carries the same columns, or the batch upsert would write nulls.
    const keepDue = old && status === "sent" && sheetStatus !== "sent";
    row.due_at = keepDue ? old.due_at : dueIso;
    row.sent_count = !isNaN(count) ? count : old?.sent_count ?? null;
    row.nags = !old || (!keepDue && new Date(old.due_at).getTime() !== due.getTime()) ? passed(dueIso, now.getTime()) : old.nags;
    row.dirty = !!(old?.status === "sent" && sheetStatus !== "sent");
    out.push(row);
  });
  if (out.length) await db.from("as_push").upsert(out);
  if (cfg) await pushDirty(cfg);
  return { ok: true, rows: out.length };
}

// The database → the sheet, for what the app changed: sent with a count, or a new date and time.
async function pushDirty(cfg: SheetCfg) {
  const { data } = await db.from("as_push").select("num,sheet_row,status,sent_count,due_at").eq("dirty", true).not("sheet_row", "is", null);
  if (!data?.length) return;
  const writes: { range: string; values: unknown[][] }[] = [];
  for (const p of data) {
    const k = kyiv(new Date(p.due_at)), two = (n: number) => String(n).padStart(2, "0");
    writes.push({ range: `${cfg.tab}!B${p.sheet_row}:D${p.sheet_row}`, values: [[`${two(k.d)}.${two(k.m)}`, DAYS_SHORT[k.wd], `${two(k.h)}:${two(k.mi)}`]] });
    if (p.status === "sent") {
      writes.push({ range: `${cfg.tab}!S${p.sheet_row}`, values: [["Надіслано"]] });
      if (p.sent_count != null) writes.push({ range: `${cfg.tab}!O${p.sheet_row}`, values: [[p.sent_count]] });
    }
  }
  await setValues(cfg.id, writes);
  await db.from("as_push").update({ dirty: false }).in("num", data.map((p) => p.num));
}

// After a change in the app or the bot: tell the sheet now; if Google fails, the next pull retries.
export async function syncNow() {
  const cfg = await sheetCfg();
  if (!cfg) return;
  try {
    await pushDirty(cfg);
  } catch (e) {
    console.error("push sheet", e);
  }
}
