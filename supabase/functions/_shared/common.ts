// Database client and small helpers shared by the bot (`asystent`) and the mini app server (`api`).
import { createClient } from "npm:@supabase/supabase-js@2.117.3";

// New Supabase projects give functions `sb_secret_…` keys in SUPABASE_SECRET_KEYS; older ones only the legacy service_role JWT.
function serverKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    const key = keys.default ?? Object.values(keys)[0];
    if (typeof key === "string" && key) return key;
  } catch (e) {
    console.error("SUPABASE_SECRET_KEYS", e);
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}

export const db = createClient(Deno.env.get("SUPABASE_URL")!, serverKey(), { auth: { persistSession: false } });

export type Location = { id: number; name: string; city: string; aliases: string[]; active: boolean };

export async function activeLocations(): Promise<Location[]> {
  const { data } = await db.from("locations").select("id,name,city,aliases,active").eq("active", true).order("name");
  return (data ?? []) as Location[];
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
