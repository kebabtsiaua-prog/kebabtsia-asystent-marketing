// What the «Відгуки» bot knows, for the assistant: it lives in the same database. Read only; nothing here writes
// to the «Відгуки» tables. Any missing table or column just drops that line, so a change there cannot break the assistant.
import { db, type Location } from "./common.ts";

const DAY = 24 * 3600_000;
const dateOnly = (d: Date) => d.toISOString().slice(0, 10);
const avg = (xs: number[]) => xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : "—";

// Supabase returns at most 1000 rows per request; a month of app ratings can be more.
// deno-lint-ignore no-explicit-any
async function all(query: () => any): Promise<any[]> {
  const rows = [];
  for (let from = 0; from < 20000; from += 1000) {
    const { data, error } = await query().range(from, from + 999);
    if (error) throw error;
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return rows;
}

async function part(label: string, f: () => Promise<string[]>): Promise<string[]> {
  try {
    return await f();
  } catch (e) {
    console.error("vidguky", label, e);
    return [];
  }
}

export async function vidgukySummary(locs: Location[]): Promise<string> {
  const name = new Map(locs.map((l) => [l.id, l.name]));
  const where = (id: number) => name.get(id) ?? `точка ${id}`;
  const now = Date.now();
  const week = dateOnly(new Date(now - 7 * DAY));
  const month = dateOnly(new Date(now - 30 * DAY));
  const lines: string[] = [`Точок у мережі (активних): ${locs.length}.`];

  lines.push(...await part("complaints", async () => {
    const rows = await all(() =>
      db.from("complaints").select("location_id,channel,happened_on,text,result").gte("happened_on", month).order("happened_on", { ascending: false })
    );
    const lastWeek = rows.filter((r) => r.happened_on >= week);
    const open = rows.filter((r) => !r.result);
    const byLoc = new Map<number, number>();
    for (const r of lastWeek) byLoc.set(r.location_id, (byLoc.get(r.location_id) ?? 0) + 1);
    const top = [...byLoc].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, n]) => `${where(id)} ${n}`).join(", ");
    return [
      `Скарги: за 7 днів ${lastWeek.length}, за 30 днів ${rows.length}, без рішення ${open.length}.${top ? ` Найбільше за тиждень: ${top}.` : ""}`,
      ...open.slice(0, 5).map((r) => `- без рішення ${r.happened_on}, ${where(r.location_id)} (${r.channel}): ${String(r.text).slice(0, 140)}`),
    ];
  }));

  lines.push(...await part("app_ratings", async () => {
    const rows = await all(() => db.from("app_ratings").select("location_id,rated_on,rating").gte("rated_on", month).order("id"));
    const lastWeek = rows.filter((r) => r.rated_on >= week);
    const low = lastWeek.filter((r) => r.rating <= 3);
    return [`Оцінки замовлень в апці: за 7 днів ${lastWeek.length}, середня ${avg(lastWeek.map((r) => r.rating))}, з них 1–3 зірки ${low.length}; за 30 днів середня ${avg(rows.map((r) => r.rating))}.`];
  }));

  lines.push(...await part("google", async () => {
    const data = await all(() => db.from("google_daily").select("location_id,day,rating,count").gte("day", month).order("day").order("location_id"));
    const first = new Map<number, number>();
    const last = new Map<number, { rating: number; count: number }>();
    for (const r of data) {
      if (r.rating == null) continue;
      if (!first.has(r.location_id)) first.set(r.location_id, Number(r.rating));
      last.set(r.location_id, { rating: Number(r.rating), count: r.count ?? 0 });
    }
    if (!last.size) return [];
    const ratings = [...last.values()].map((v) => v.rating);
    const moved = [...last].map(([id, v]) => ({ id, d: v.rating - (first.get(id) ?? v.rating), v }))
      .filter((x) => Math.abs(x.d) >= 0.1).sort((a, b) => a.d - b.d)
      .map((x) => `${where(x.id)} ${x.v.rating} (${x.d > 0 ? "+" : ""}${x.d.toFixed(1)})`);
    const lowest = [...last].sort((a, b) => a[1].rating - b[1].rating).slice(0, 3).map(([id, v]) => `${where(id)} ${v.rating}`);
    return [
      `Google: середній рейтинг мережі ${avg(ratings)}. Найнижчі: ${lowest.join(", ")}.${moved.length ? ` Зміни за 30 днів: ${moved.join(", ")}.` : " За 30 днів без змін."}`,
    ];
  }));

  lines.push(...await part("google_reviews", async () => {
    const { data, error } = await db.from("google_reviews").select("location_id,rating,text,published_at")
      .gte("published_at", new Date(now - 7 * DAY).toISOString()).lte("rating", 3).order("published_at", { ascending: false }).limit(5);
    if (error) throw error;
    return (data ?? []).map((r) => `- Google ${r.rating}★ ${where(r.location_id)}: ${String(r.text ?? "").slice(0, 140)}`);
  }));

  return lines.join("\n");
}
