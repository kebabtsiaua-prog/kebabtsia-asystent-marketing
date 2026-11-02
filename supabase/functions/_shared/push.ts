// «Пуш RFM»: the push plan, the reminders that keep coming until a push is marked sent, and the return check
// that compares the list a push went to with a later export.
import { db } from "./common.ts";
import { fromKyiv, kyiv } from "./time.ts";

export type Push = {
  num: number; due_at: string; segment: string; why: string; source: string; places: string; title: string; body: string;
  news: string; bonus: string; measure: string; check_on: string | null; check_what: string; status: string;
  sent_count: number | null; sent_at: string | null; nags: number; msg_id: number | null;
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
  await db.from("as_push").update(patch).eq("num", num);
}

export async function movePush(num: number, due: Date) {
  await db.from("as_push").update({ due_at: due.toISOString(), status: "plan", nags: 0, updated_at: new Date().toISOString() }).eq("num", num);
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
