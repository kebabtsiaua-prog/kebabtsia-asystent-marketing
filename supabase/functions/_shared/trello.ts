// The Trello board «Мої задачі Кебабця» as Claude copies it into as_kv «trello» at 8:00, 14:00 and 18:00 (Kyiv).
// The bot has no Trello access of its own; this snapshot is all it and the app see.
export type TrelloItem = { name: string; done?: boolean; since?: string; card?: string };
export type Trello = {
  board_url: string;
  week: { label: string; total: number; done: number; days: { date: string; label: string; total: number; done: number }[] };
  today: { date: string; card: string; items: TrelloItem[] } | null;
  tails: TrelloItem[]; // open items from earlier day cards of this and last week, oldest first
  main: TrelloItem[]; // open items on the ГОЛОВНЕ cards for this month
};

export function trelloSummary(t: Trello | null, at: string): string {
  if (!t) return "Trello: ще не підтягнуто.";
  const lines = [`Trello, дошка «Мої задачі Кебабця» (${at}). Тиждень ${t.week.label}: закрито ${t.week.done} з ${t.week.total}.`];
  if (t.today) lines.push(`Сьогодні (картка ${t.today.card}): ${t.today.items.map((i) => `${i.done ? "✓" : "○"} ${i.name}`).join("; ") || "порожньо"}.`);
  if (t.tails.length) lines.push(`Хвости (${t.tails.length}): ${t.tails.map((i) => `${i.name} (з ${i.since})`).join("; ")}.`);
  if (t.main.length) lines.push(`Головне на місяць: ${t.main.map((i) => i.name).join("; ")}.`);
  return lines.join("\n");
}
