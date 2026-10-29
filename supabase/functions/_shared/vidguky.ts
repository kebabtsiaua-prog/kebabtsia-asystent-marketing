// What the «Відгуки» bot knows, for the assistant and its app: it lives in the same database. Read only; nothing here
// writes to the «Відгуки» tables. A missing table or column just leaves that part empty, so a change there cannot break the assistant.
import { db, type Location } from "./common.ts";

const DAY = 24 * 3600_000;
const dateOnly = (d: Date) => d.toISOString().slice(0, 10);
const mean = (xs: number[]) => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length * 10) / 10 : null;
const show = (x: number | null) => x == null ? "—" : x.toFixed(1);

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

// deno-lint-ignore no-explicit-any
async function rows(label: string, query: () => any): Promise<any[] | null> {
  try {
    return await all(query);
  } catch (e) {
    console.error("vidguky", label, e);
    return null;
  }
}

export type Point = {
  id: number;
  name: string;
  city: string;
  admins: string[]; // location admins who signed up in «Відгуки»
  complaintsWeek: number;
  complaintsOpen: number;
  appWeek: number;
  appAvgWeek: number | null;
  google: number | null;
  googleChange: number | null; // over the last 30 days
};

export type Vidguky = {
  points: Point[];
  complaints: { week: number; month: number; open: number; openList: { day: string; point: string; channel: string; text: string }[] } | null;
  app: { week: number; avgWeek: number | null; lowWeek: number; avgMonth: number | null } | null;
  google: { avg: number | null } | null;
  lowReviews: { point: string; rating: number; text: string }[];
};

export async function vidgukyData(locs: Location[]): Promise<Vidguky> {
  const now = Date.now();
  const week = dateOnly(new Date(now - 7 * DAY));
  const month = dateOnly(new Date(now - 30 * DAY));
  const points = new Map<number, Point>(locs.map((l) => [l.id, {
    id: l.id, name: l.name, city: l.city, admins: [], complaintsWeek: 0, complaintsOpen: 0, appWeek: 0, appAvgWeek: null, google: null, googleChange: null,
  }]));
  const where = (id: number) => points.get(id)?.name ?? `точка ${id}`;

  const [users, links, complaints, ratings, daily, reviews] = await Promise.all([
    rows("users", () => db.from("users").select("tg_id,name,role,location_id,active").eq("active", true).order("tg_id")),
    rows("user_locations", () => db.from("user_locations").select("tg_id,location_id").order("tg_id")),
    rows("complaints", () =>
      db.from("complaints").select("location_id,channel,happened_on,text,result").gte("happened_on", month).order("happened_on", { ascending: false })
    ),
    rows("app_ratings", () => db.from("app_ratings").select("location_id,rated_on,rating").gte("rated_on", month).order("id")),
    rows("google_daily", () => db.from("google_daily").select("location_id,day,rating").gte("day", month).order("day").order("location_id")),
    rows("google_reviews", () =>
      db.from("google_reviews").select("location_id,rating,text,published_at").gte("published_at", new Date(now - 7 * DAY).toISOString())
        .lte("rating", 3).order("published_at", { ascending: false }).limit(5)
    ),
  ]);

  if (users) {
    const names = new Map(users.filter((u) => u.role === "loc_admin").map((u) => [u.tg_id, u.name]));
    const seen = new Set<string>();
    const add = (tg: number, loc: number) => {
      const n = names.get(tg);
      const p = points.get(loc);
      if (n && p && !seen.has(`${tg}:${loc}`)) seen.add(`${tg}:${loc}`) && p.admins.push(n);
    };
    for (const l of links ?? []) add(l.tg_id, l.location_id);
    for (const u of users) if (u.location_id) add(u.tg_id, u.location_id);
  }

  let complaintsOut: Vidguky["complaints"] = null;
  if (complaints) {
    const open = complaints.filter((r) => !r.result);
    for (const r of complaints) {
      const p = points.get(r.location_id);
      if (!p) continue;
      if (r.happened_on >= week) p.complaintsWeek++;
      if (!r.result) p.complaintsOpen++;
    }
    complaintsOut = {
      week: complaints.filter((r) => r.happened_on >= week).length,
      month: complaints.length,
      open: open.length,
      openList: open.slice(0, 5).map((r) => ({ day: r.happened_on, point: where(r.location_id), channel: r.channel, text: String(r.text).slice(0, 160) })),
    };
  }

  let appOut: Vidguky["app"] = null;
  if (ratings) {
    const lastWeek = ratings.filter((r) => r.rated_on >= week);
    const byLoc = new Map<number, number[]>();
    for (const r of lastWeek) byLoc.set(r.location_id, [...(byLoc.get(r.location_id) ?? []), r.rating]);
    for (const [id, xs] of byLoc) {
      const p = points.get(id);
      if (p) [p.appWeek, p.appAvgWeek] = [xs.length, mean(xs)];
    }
    appOut = {
      week: lastWeek.length,
      avgWeek: mean(lastWeek.map((r) => r.rating)),
      lowWeek: lastWeek.filter((r) => r.rating <= 3).length,
      avgMonth: mean(ratings.map((r) => r.rating)),
    };
  }

  let googleOut: Vidguky["google"] = null;
  if (daily) {
    const first = new Map<number, number>();
    for (const r of daily) {
      if (r.rating == null) continue;
      const v = Number(r.rating);
      if (!first.has(r.location_id)) first.set(r.location_id, v);
      const p = points.get(r.location_id);
      if (p) [p.google, p.googleChange] = [v, Math.round((v - first.get(r.location_id)!) * 10) / 10];
    }
    googleOut = { avg: mean([...points.values()].map((p) => p.google).filter((x): x is number => x != null)) };
  }

  return {
    points: [...points.values()],
    complaints: complaintsOut,
    app: appOut,
    google: googleOut,
    lowReviews: (reviews ?? []).map((r) => ({ point: where(r.location_id), rating: r.rating, text: String(r.text ?? "").slice(0, 160) })),
  };
}

// The same, as lines for the bot's system prompt.
export async function vidgukySummary(locs: Location[]): Promise<string> {
  const v = await vidgukyData(locs);
  const lines = [`Точок у мережі (активних): ${v.points.length}. Хто за них відповідає (адміністратори з «Відгуків»):`];
  for (const p of v.points) lines.push(`- ${p.name}: ${p.admins.join(", ") || "немає адміністратора"}`);
  if (v.complaints) {
    const top = [...v.points].filter((p) => p.complaintsWeek).sort((a, b) => b.complaintsWeek - a.complaintsWeek).slice(0, 5)
      .map((p) => `${p.name} ${p.complaintsWeek}`).join(", ");
    lines.push(`Скарги: за 7 днів ${v.complaints.week}, за 30 днів ${v.complaints.month}, без рішення ${v.complaints.open}.${top ? ` Найбільше за тиждень: ${top}.` : ""}`);
    for (const c of v.complaints.openList) lines.push(`- без рішення ${c.day}, ${c.point} (${c.channel}): ${c.text}`);
  }
  if (v.app) {
    lines.push(`Оцінки замовлень в апці: за 7 днів ${v.app.week}, середня ${show(v.app.avgWeek)}, з них 1–3 зірки ${v.app.lowWeek}; за 30 днів середня ${show(v.app.avgMonth)}.`);
  }
  if (v.google?.avg != null) {
    const rated = v.points.filter((p) => p.google != null);
    const lowest = [...rated].sort((a, b) => a.google! - b.google!).slice(0, 3).map((p) => `${p.name} ${p.google}`);
    const moved = rated.filter((p) => Math.abs(p.googleChange ?? 0) >= 0.1).sort((a, b) => a.googleChange! - b.googleChange!)
      .map((p) => `${p.name} ${p.google} (${p.googleChange! > 0 ? "+" : ""}${p.googleChange!.toFixed(1)})`);
    lines.push(`Google: середній рейтинг мережі ${show(v.google.avg)}. Найнижчі: ${lowest.join(", ")}.${moved.length ? ` Зміни за 30 днів: ${moved.join(", ")}.` : " За 30 днів без змін."}`);
  }
  for (const r of v.lowReviews) lines.push(`- Google ${r.rating}★ ${r.point}: ${r.text}`);
  return lines.join("\n");
}
