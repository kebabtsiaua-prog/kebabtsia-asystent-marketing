// Telegram calls for the assistant bot (its own token, ASYSTENT_BOT_TOKEN).
export function token(): string {
  return Deno.env.get("ASYSTENT_BOT_TOKEN")?.trim() ?? "";
}

export async function tg(method: string, body: Record<string, unknown>) {
  const res = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) console.error("telegram", method, json.description);
  return json;
}

// HTML first; if Telegram rejects the tags the model wrote, the same text goes without them.
export async function send(chat: number, text: string, keyboard?: unknown[][]) {
  const markup = keyboard?.length ? { reply_markup: { inline_keyboard: keyboard } } : {};
  let out = await tg("sendMessage", { chat_id: chat, text: text.slice(0, 4000), parse_mode: "HTML", ...markup });
  if (!out.ok) out = await tg("sendMessage", { chat_id: chat, text: text.replace(/<[^>]+>/g, "").slice(0, 4000), ...markup });
  return out.result?.message_id as number | undefined;
}

export async function webhookSecret(): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode("kebabtsia-asystent"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(token())));
  return Array.from(sig, (x) => x.toString(16).padStart(2, "0")).join("").slice(0, 48);
}

export async function tgFile(fileId: string): Promise<{ bytes: Uint8Array; path: string }> {
  const info = await tg("getFile", { file_id: fileId });
  const path: string = info.result.file_path;
  const res = await fetch(`https://api.telegram.org/file/bot${token()}/${path}`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), path };
}

// Checks Mini App initData (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app).
export async function telegramUser(initData: string): Promise<{ id: number; first_name?: string } | null> {
  if (!initData || !token()) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const hmac = async (key: Uint8Array, data: string) => {
    const k = await crypto.subtle.importKey("raw", key as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
  };
  const secret = await hmac(new TextEncoder().encode("WebAppData"), token());
  const hex = Array.from(await hmac(secret, check), (x) => x.toString(16).padStart(2, "0")).join("");
  if (hex !== hash) return null;
  if (Date.now() / 1000 - Number(params.get("auth_date") ?? 0) > 7 * 24 * 3600) return null;
  try {
    return JSON.parse(params.get("user") ?? "null");
  } catch {
    return null;
  }
}
