// Mini app backend. Every request: POST { initData, action, ...args }; the Telegram user is taken from initData,
// and only people in as_people (the owner) get in.
import { db } from "../_shared/common.ts";
import { openReminders, type Reminder, scheduleNext } from "../_shared/reminders.ts";
import { telegramUser, tg } from "../_shared/telegram.ts";
import { fromKyiv, kyiv, parseWhen } from "../_shared/time.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

class Fail extends Error {}
const must = (ok: unknown, msg: string) => {
  if (!ok) throw new Fail(msg);
};

const HOUR = 3600_000;

async function overview(tgId: number) {
  const now = new Date();
  const p = kyiv(now);
  const monthStart = fromKyiv(p.y, p.m, 1, 0, 0).toISOString();
  const open = await openReminders(tgId);
  const { data: closed } = await db.from("as_reminders").select("id,text,due_at,repeat,status,closed_at").eq("tg_id", tgId)
    .in("status", ["done", "missed"]).gte("closed_at", new Date(now.getTime() - 14 * 24 * HOUR).toISOString())
    .order("closed_at", { ascending: false }).limit(40);
  const { data: month } = await db.from("as_reminders").select("status").eq("tg_id", tgId).gte("closed_at", monthStart);
  const { data: memory } = await db.from("as_memory").select("topic,fact,updated_at").order("topic");
  const { data: me } = await db.from("as_people").select("name").eq("tg_id", tgId).maybeSingle();
  return {
    name: me?.name ?? "",
    now: now.toISOString(),
    open,
    closed: closed ?? [],
    month: {
      done: (month ?? []).filter((r) => r.status === "done").length,
      missed: (month ?? []).filter((r) => r.status === "missed").length,
    },
    memory: memory ?? [],
  };
}

async function reminder(tgId: number, id: number): Promise<Reminder> {
  const { data } = await db.from("as_reminders").select("*").eq("id", id).eq("tg_id", tgId).maybeSingle();
  must(data, "Нагадування не знайдено");
  return data as Reminder;
}

// The reminder's message in the chat loses its buttons once it is handled here.
async function dropButtons(r: Reminder) {
  if (r.msg_id) await tg("editMessageReplyMarkup", { chat_id: r.tg_id, message_id: r.msg_id, reply_markup: { inline_keyboard: [] } });
}

// deno-lint-ignore no-explicit-any
async function handle(tgId: number, b: any) {
  switch (b.action) {
    case "overview":
      return await overview(tgId);

    case "add": {
      const text = String(b.text ?? "").trim();
      must(text, "Напишіть, про що нагадати");
      const time = String(b.time ?? "");
      must(/^\d{1,2}:\d{2}$/.test(time), "Вкажіть час");
      const repeat = String(b.repeat ?? "");
      let when;
      if (repeat) when = parseWhen(`${repeat} ${time}`);
      else {
        const m = String(b.date ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
        must(m, "Вкажіть дату");
        when = parseWhen(`${m![3]}.${m![2]}.${m![1]} ${time}`);
        must(when && when.due.getTime() > Date.now() - 60_000, "Цей час уже минув");
      }
      must(when, "Не зрозумів повтор");
      await db.from("as_reminders").insert({ tg_id: tgId, text, due_at: when!.due.toISOString(), repeat: when!.repeat });
      return await overview(tgId);
    }

    case "done":
    case "cancel": {
      const r = await reminder(tgId, Number(b.id));
      must(["pending", "sent", "missed"].includes(r.status), "Це нагадування вже закрите");
      await db.from("as_reminders").update({ status: b.action === "done" ? "done" : "cancelled", closed_at: new Date().toISOString() }).eq("id", r.id);
      await dropButtons(r);
      if (b.action === "done") await scheduleNext(r);
      return await overview(tgId);
    }

    case "snooze": {
      const r = await reminder(tgId, Number(b.id));
      must(["pending", "sent"].includes(r.status), "Це нагадування вже закрите");
      const due = b.to === "tomorrow"
        ? (() => {
          const t = kyiv(new Date(Date.now() + 24 * HOUR));
          const o = kyiv(new Date(r.due_at));
          return fromKyiv(t.y, t.m, t.d, o.h, o.mi);
        })()
        : new Date(Date.now() + HOUR);
      await db.from("as_reminders").update({ status: "pending", due_at: due.toISOString(), nags: 0 }).eq("id", r.id);
      await dropButtons(r);
      return await overview(tgId);
    }

    case "memory_save": {
      const topic = String(b.topic ?? "").trim().slice(0, 120);
      const fact = String(b.fact ?? "").trim();
      must(topic && fact, "Потрібні тема і факт");
      if (b.old && b.old !== topic) await db.from("as_memory").delete().eq("topic", String(b.old));
      await db.from("as_memory").upsert({ topic, fact, updated_at: new Date().toISOString() });
      return await overview(tgId);
    }

    case "memory_delete":
      await db.from("as_memory").delete().eq("topic", String(b.topic ?? ""));
      return await overview(tgId);
  }
  throw new Fail("Невідома дія");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const b = await req.json();
    const user = await telegramUser(String(b.initData ?? ""));
    if (!user) return json({ error: "Відкрийте апку через свого бота в Телеграмі." }, 401);
    const { data: person } = await db.from("as_people").select("tg_id").eq("tg_id", user.id).maybeSingle();
    if (!person) return json({ error: "Спершу натисніть /start у боті." }, 403);
    return json(await handle(user.id, b));
  } catch (e) {
    if (e instanceof Fail) return json({ error: e.message }, 400);
    console.error(e);
    return json({ error: "Помилка сервера. Спробуйте ще раз." }, 500);
  }
});
