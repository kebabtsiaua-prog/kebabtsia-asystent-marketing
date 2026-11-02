// Mini app backend. Every request: POST { initData, action, ...args }; the Telegram user is taken from initData,
// and only people in as_people (the owner) get in.
import { activeLocations, db } from "../_shared/common.ts";
import { compare, markSent, movePush, pushList } from "../_shared/push.ts";
import { openReminders, type Reminder, scheduleNext } from "../_shared/reminders.ts";
import { sendDocument, telegramUser, tg } from "../_shared/telegram.ts";
import { fromKyiv, kyiv, parseWhen } from "../_shared/time.ts";
import { vidgukyData } from "../_shared/vidguky.ts";

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
  const { data: tasks } = await db.from("as_kv").select("value,updated_at").eq("key", "tasks").maybeSingle();
  const { data: trello } = await db.from("as_kv").select("value,updated_at").eq("key", "trello").maybeSingle();
  const { data: pushStats } = await db.from("as_kv").select("value").eq("key", "push_stats").maybeSingle();
  const { data: files } = await db.from("as_push_files").select("id,push_num,kind,file_name,n,created_at").order("created_at", { ascending: false }).limit(60);
  const { data: reports } = await db.from("as_outbox").select("id,file_name,caption,send_after,sent_at").eq("tg_id", tgId)
    .order("send_after", { ascending: false }).limit(8);
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
    tasks: tasks ? { text: tasks.value as string, updated_at: tasks.updated_at } : null,
    trello: trello ? { ...(trello.value as object), updated_at: trello.updated_at } : null,
    reports: reports ?? [],
    push: { list: await pushList(), files: files ?? [], stats: pushStats?.value ?? null },
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

    // The «Огляд» tab: «Відгуки» by location. Loaded separately, so the plan opens fast.
    case "vidguky":
      return await vidgukyData(await activeLocations());

    case "add": {
      const text = String(b.text ?? "").trim();
      must(text, "Напиши, про що нагадати");
      const time = String(b.time ?? "");
      must(/^\d{1,2}:\d{2}$/.test(time), "Вкажи час");
      const repeat = String(b.repeat ?? "");
      let when;
      if (repeat) when = parseWhen(`${repeat} ${time}`);
      else {
        const m = String(b.date ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
        must(m, "Вкажи дату");
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

    // A weekly PDF again, straight into the chat.
    case "report_send": {
      const { data: f } = await db.from("as_outbox").select("file_name,file_b64,caption").eq("id", Number(b.id)).eq("tg_id", tgId).maybeSingle();
      must(f?.file_b64, "Звіт не знайдено");
      const bytes = Uint8Array.from(atob(f!.file_b64), (c) => c.charCodeAt(0));
      must(await sendDocument(tgId, f!.file_name, bytes, f!.caption), "Telegram не прийняв файл, спробуй ще раз");
      return await overview(tgId);
    }

    // «Пуш RFM»: marked sent (with how many got it), moved, or a list file kept for the return check.
    case "push_sent": {
      const count = b.count === "" || b.count == null ? null : Number(String(b.count).replace(/\s/g, ""));
      must(count == null || (Number.isInteger(count) && count >= 0), "Кількість має бути цілим числом");
      await markSent(Number(b.num), count);
      return await overview(tgId);
    }
    case "push_move": {
      const m = String(b.date ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/), t = String(b.time ?? "").match(/^(\d{1,2}):(\d{2})$/);
      must(m && t, "Вкажи дату і час");
      const due = fromKyiv(+m![1], +m![2], +m![3], +t![1], +t![2]);
      must(due.getTime() > Date.now() - 60_000, "Цей час уже минув");
      await movePush(Number(b.num), due);
      return await overview(tgId);
    }
    case "push_file": {
      const rows = Array.isArray(b.rows) ? b.rows : [];
      must(rows.length, "У файлі не знайшов жодного клієнта");
      must(rows.length <= 60000, "Файл завеликий");
      const clean = rows.map((r: Record<string, unknown>) => ({
        i: String(r.i ?? "").slice(0, 64), g: String(r.g ?? "").slice(0, 8),
        c: r.c == null || r.c === "" ? null : Number(r.c), l: /^\d{4}-\d{2}-\d{2}$/.test(String(r.l ?? "")) ? String(r.l) : null,
      })).filter((r: { i: string }) => r.i);
      must(clean.length, "У файлі не знайшов колонки з клієнтом");
      await db.from("as_push_files").insert({
        push_num: b.num ? Number(b.num) : null, kind: b.kind === "check" ? "check" : "sent",
        file_name: String(b.name ?? "файл").slice(0, 120), rows: clean, n: clean.length,
      });
      return await overview(tgId);
    }
    case "push_file_delete":
      await db.from("as_push_files").delete().eq("id", Number(b.id));
      return await overview(tgId);
    case "push_compare": {
      const r = await compare(Number(b.num));
      must(r, "Потрібні два файли: список, на який пішов пуш, і пізніший експорт");
      return r;
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
    if (!user) return json({ error: "Відкрий апку через свого бота в Телеграмі." }, 401);
    const { data: person } = await db.from("as_people").select("tg_id").eq("tg_id", user.id).maybeSingle();
    if (!person) return json({ error: "Спершу натисни /start у боті." }, 403);
    return json(await handle(user.id, b));
  } catch (e) {
    if (e instanceof Fail) return json({ error: e.message }, 400);
    console.error(e);
    return json({ error: "Помилка сервера. Спробуй ще раз." }, 500);
  }
});
