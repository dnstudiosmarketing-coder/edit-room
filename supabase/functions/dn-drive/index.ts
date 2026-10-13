// DN Studios: uploads to Google Drive (Supabase Edge Function "dn-drive"); see drive.js for what it does.
// Deployed with JWT checks off: it is called from the app's pages and by Google, and checks the app's own
// logins itself.
import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";
import { handle, settings } from "./drive.js";

// SUPABASE_DB_URL and SUPABASE_URL are provided to every edge function by Supabase; the GOOGLE_* settings
// are this project's secrets.
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 3, prepare: false, idle_timeout: 20, connect_timeout: 10 });
const cfg = settings((name: string) => Deno.env.get(name));

Deno.serve(async (req: Request) => {
  try {
    return await handle(req, sql, cfg);
  } catch (e) {
    console.error("dn-drive failed:", e instanceof Error ? e.message : e);
    return new Response(JSON.stringify({ error: "failed" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
