// Google Sheets through the service account the «Відгуки» bot already has on this server (secret GOOGLE_SERVICE_ACCOUNT).
// A sheet works once it is shared with that account's email as editor.
const b64url = (b: Uint8Array | string) =>
  btoa(typeof b === "string" ? unescape(encodeURIComponent(b)) : String.fromCharCode(...b)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

export function serviceAccount(): { client_email: string; private_key: string } | null {
  try {
    const a = JSON.parse(Deno.env.get("GOOGLE_SERVICE_ACCOUNT") ?? "");
    return a.client_email && a.private_key ? a : null;
  } catch {
    return null;
  }
}

let cached: { token: string; until: number } | null = null;
async function token(): Promise<string> {
  if (cached && cached.until > Date.now()) return cached.token;
  const a = serviceAccount();
  if (!a) throw new Error("no GOOGLE_SERVICE_ACCOUNT");
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({ iss: a.client_email, scope: "https://www.googleapis.com/auth/spreadsheets", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const der = Uint8Array.from(atob(a.private_key.replace(/-----[^-]+-----|\s/g, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${claim}`)));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${b64url(sig)}` }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`Google token: ${j.error ?? r.status}`);
  cached = { token: j.access_token, until: Date.now() + 50 * 60_000 };
  return j.access_token;
}

export async function getValues(sheet: string, range: string): Promise<string[][]> {
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheet}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE`, {
    headers: { authorization: `Bearer ${await token()}` },
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Sheets ${r.status}: ${j.error?.status ?? ""}`);
  return j.values ?? [];
}

export async function setValues(sheet: string, data: { range: string; values: unknown[][] }[]) {
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheet}/values:batchUpdate`, {
    method: "POST",
    headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json" },
    body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
  });
  if (!r.ok) throw new Error(`Sheets ${r.status}: ${(await r.json()).error?.status ?? ""}`);
}
