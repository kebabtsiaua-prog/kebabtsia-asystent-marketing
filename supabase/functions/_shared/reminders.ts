// Reminders shared by the bot and the mini app.
import { db, esc } from "./common.ts";
import { fmt, nextTime, parseRepeat } from "./time.ts";

export type Reminder = { id: number; tg_id: number; text: string; due_at: string; repeat: string | null; status: string; nags: number; msg_id: number | null };

export async function openReminders(tgId: number): Promise<Reminder[]> {
  const { data } = await db.from("as_reminders").select("*").eq("tg_id", tgId).in("status", ["pending", "sent"]).order("due_at").limit(50);
  return (data ?? []) as Reminder[];
}

export function reminderLine(r: Reminder): string {
  return `${r.status === "sent" ? "✱" : "○"} ${fmt(new Date(r.due_at))} ${esc(r.text)}${r.repeat ? ` <i>(${esc(r.repeat)})</i>` : ""}`;
}

// A done, missed or cancelled repeat puts the next one in the plan.
export async function scheduleNext(r: Reminder) {
  const rule = r.repeat && parseRepeat(r.repeat);
  const due = rule && nextTime(rule, new Date(Math.max(Date.now(), new Date(r.due_at).getTime())));
  if (due) await db.from("as_reminders").insert({ tg_id: r.tg_id, text: r.text, due_at: due.toISOString(), repeat: r.repeat });
}
