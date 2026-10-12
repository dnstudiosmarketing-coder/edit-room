// DN Studios: the phone notification sender (Supabase Edge Function "dn-push").
// The database nudges this function when notifications are waiting; see sender.js for what it does.
import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";
import { handle } from "./sender.js";

// SUPABASE_DB_URL is provided to every edge function by Supabase.
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 2, prepare: false, idle_timeout: 20, connect_timeout: 10 });

Deno.serve(async (req: Request) => {
  try {
    return await handle(req, sql);
  } catch (e) {
    console.error("dn-push failed:", e instanceof Error ? e.message : e);
    return new Response(JSON.stringify({ error: "failed" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
