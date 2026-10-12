// The DN Studios notification sender. The database calls it when notifications are waiting (and a timer
// checks every minute). It takes them a batch at a time, encrypts each one for each of the person's
// phones, hands them to the phones' push services, and reports back what happened. Nothing else can start
// it: each call must carry the secret that lives only in the database.
import { makeKeys, sendPush } from "./webpush.js";

const DEFAULT_CONTACT = "https://dnstudiosmarketing-coder.github.io/edit-room/";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const ids = (list) => JSON.stringify(list);       // sent as text, so the driver doesn't encode it a second time

export async function handle(req, sql, opts = {}) {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const [{ ok }] = await sql`select app.push_secret_ok(${req.headers.get("x-push-secret")}) as ok`;
  if (!ok) return json({ error: "no" }, 401);
  const keys = await loadKeys(sql);
  return json(Object.assign({ keys: true }, await deliver(sql, keys, opts)));
}

// The sender's signing keys, made on its first run and kept in the database from then on.
export async function loadKeys(sql) {
  let [k] = await sql`select * from app.push_keys()`;
  if (!k || !k.public_key) {
    const made = await makeKeys();
    await sql`select app.push_keys_set(${made.publicKey}, ${made.privateKey})`;
    [k] = await sql`select * from app.push_keys()`;
  }
  return { publicKey: k.public_key, privateKey: k.private_key, contact: k.contact || DEFAULT_CONTACT };
}

const tagOf = (r) => r.kind + (r.project ? ":" + r.project : "");

export async function deliver(sql, keys, opts = {}) {
  const tally = { notices: 0, sent: 0, gone: 0, failed: 0 };
  const stop = Date.now() + (opts.budgetMs ?? 25000);
  for (let round = 0; round < 10 && Date.now() < stop; round++) {
    const rows = await sql`select * from app.push_claim(${opts.batch ?? 100})`;
    if (!rows.length) break;
    const byNotice = new Map();
    for (const r of rows) { const list = byNotice.get(r.notice) || []; list.push(r); byNotice.set(r.notice, list); }
    await Promise.all(Array.from(byNotice.values()).map(async (list) => {
      const first = list[0];
      const payload = JSON.stringify({ title: first.title, body: first.body, tag: tagOf(first), url: "./" });
      const ok = [], gone = [];
      let failed = 0, note = null;
      await Promise.all(list.filter((r) => r.sub).map(async (r) => {
        try {
          const res = await sendPush({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }, payload, keys, keys.contact,
            { fetch: opts.fetch, urgency: first.kind === "picture" ? "normal" : "high" });
          if (res.status >= 200 && res.status < 300) ok.push(r.sub);
          else if (res.status === 404 || res.status === 410) gone.push(r.sub);
          else { failed++; note = "push service said " + res.status + (res.text ? " " + res.text : ""); }
        } catch (e) {
          failed++; note = String((e && e.message) || e).slice(0, 150);
        }
      }));
      await sql`select app.push_report(${first.notice}::uuid,
        array(select jsonb_array_elements_text((${ids(ok)}::text)::jsonb))::uuid[],
        array(select jsonb_array_elements_text((${ids(gone)}::text)::jsonb))::uuid[], ${failed}::int, ${note}::text)`;
      tally.notices++; tally.sent += ok.length; tally.gone += gone.length; tally.failed += failed;
    }));
  }
  return tally;
}
