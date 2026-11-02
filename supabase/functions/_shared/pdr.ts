// «ПДР»: the owner's personal study plan for the driving theory exam. The plan itself lives only in as_kv 'pdr'
// (never in this public repo); the app ticks steps, keeps the exam and mistake logs, the bot reminds when to study.
import { db } from "./common.ts";
import { fromKyiv, kyiv, kyivDay } from "./time.ts";

export type Step = "book" | "tests" | "night";
export const STEPS: [Step, string][] = [["book", "Книга"], ["tests", "Тести теми"], ["night", "Дорогою / перед сном"]];
export type Day = { d: string; stage: number; plan: string; book?: boolean; tests?: boolean; night?: boolean };
export type Exam = { id: number; date: string; errors: number; minutes: number | null };
export type Mistake = { id: number; date: string; topic: string; why: string; rep: boolean[] };
export type Pdr = {
  title: string;
  exam_from: string; // the wished exam dates
  exam_to: string;
  times: { weekday: string; weekend: string; night: string; late: string };
  stages: { n: number; name: string; from: string; to: string }[];
  rules: string[];
  days: Day[];
  exams: Exam[];
  mistakes: Mistake[];
  checklist: { t: string; done: boolean }[];
  sent?: Record<string, string[]>; // day -> reminders already sent («main», «late», «night»)
};
export const REPEAT_DAYS = [1, 3, 7];

export async function getPdr(): Promise<{ pdr: Pdr | null; updated_at: string | null }> {
  const { data } = await db.from("as_kv").select("value,updated_at").eq("key", "pdr").maybeSingle();
  return { pdr: (data?.value as Pdr) ?? null, updated_at: data?.updated_at ?? null };
}
export async function savePdr(p: Pdr) {
  await db.from("as_kv").upsert({ key: "pdr", value: p, updated_at: new Date().toISOString() });
}

const addDays = (day: string, n: number) => new Date(Date.parse(day + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
// Mistakes whose 1-, 3- or 7-day repeat falls on `day` or earlier and is not ticked yet.
export function repeatsDue(p: Pdr, day: string): { m: Mistake; i: number }[] {
  const out: { m: Mistake; i: number }[] = [];
  for (const m of p.mistakes ?? []) {
    const i = REPEAT_DAYS.findIndex((n, k) => !m.rep?.[k] && addDays(m.date, n) <= day);
    if (i >= 0) out.push({ m, i });
  }
  return out;
}
// The readiness rule from the plan: 8 of the last 10 practice exams with at most one mistake.
export function readiness(p: Pdr) {
  const last = (p.exams ?? []).slice(-10);
  return { ok: last.filter((e) => e.errors <= 1).length, of: last.length };
}

// ---------- Changes from the app (and the bot's buttons) ----------
export function tickStep(p: Pdr, day: string, step: Step, on: boolean): boolean {
  const d = p.days.find((x) => x.d === day);
  if (!d || !STEPS.some(([s]) => s === step)) return false;
  d[step] = on;
  return true;
}

// ---------- Reminders, called from the bot's tick every minute ----------
const at = (day: string, hm: string) => {
  const [y, m, d] = day.split("-").map(Number), [h, mi] = hm.split(":").map(Number);
  return fromKyiv(y, m, d, h, mi).getTime();
};
export type PdrNote = { kind: "main" | "late" | "night"; day: Day; text: string; buttons: Step[] };
// What is due now and not sent yet today. A reminder is skipped when its steps are already ticked.
export function pdrDue(p: Pdr, now: number): PdrNote[] {
  const today = kyivDay(new Date(now));
  const day = p.days.find((x) => x.d === today);
  if (!day) return [];
  const sent = p.sent?.[today] ?? [];
  const weekend = [0, 6].includes(kyiv(new Date(now)).wd);
  const start = weekend ? p.times.weekend : p.times.weekday;
  const n = p.days.indexOf(day) + 1;
  const stage = p.stages.find((s) => s.n === day.stage);
  const reps = repeatsDue(p, today);
  const repLine = reps.length ? `\n\nПовтор помилок: ${reps.map(({ m, i }) => `${m.topic} (${REPEAT_DAYS[i]} д)`).join("; ")}` : "";
  const out: PdrNote[] = [];
  const main = !day.book || !day.tests;
  if (main && !sent.includes("main") && now >= at(today, start) && now < at(today, p.times.night)) {
    out.push({ kind: "main", day, buttons: ["book", "tests"], text: `<b>Час вчити ПДР</b> · день ${n} з ${p.days.length}${stage ? ` · етап ${stage.n}, ${stage.name}` : ""}\n\n${day.plan}${repLine}` });
  } else if (main && sent.includes("main") && !sent.includes("late") && now >= at(today, p.times.late) && now < at(today, p.times.night)) {
    out.push({ kind: "late", day, buttons: ["book", "tests"], text: `<b>ПДР ще не позначено</b>\n${day.plan}\n\nЗроби хоча б тести теми, 20 хвилин.` });
  }
  if (!day.night && !sent.includes("night") && now >= at(today, p.times.night) && now < at(today, "23:59")) {
    out.push({ kind: "night", day, buttons: ["night"], text: `<b>Перед сном, 10–15 хвилин</b>\nGreen Way: «Робота над помилками», потім «20 випадкових». Сон закріплює саме помилки.${repLine}` });
  }
  return out;
}
export function markSentNote(p: Pdr, day: string, kind: string) {
  p.sent = Object.fromEntries(Object.entries(p.sent ?? {}).filter(([k]) => k >= addDays(day, -7)));
  p.sent[day] = [...(p.sent[day] ?? []), kind];
}
