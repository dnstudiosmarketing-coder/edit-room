// A stand-in for the parts of Google the Drive upload uses, for tests on one machine: the sign-in's token
// exchange, Drive's file and permission calls, and resumable uploads, which a browser sends straight to it.
// Uploads behave the way Google's do: the address Google hands out answers the browser only if it was asked
// for with that browser page's origin, every piece says where it starts, and "308 Resume Incomplete" with a
// Range header says how much has arrived. It can also cut a connection part way through a piece.
import http from "node:http";
import crypto from "node:crypto";

const FOLDER = "application/vnd.google-apps.folder";
const b64u = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

export async function startGoogle(opts = {}) {
  const g = {
    clientId: opts.clientId || "test-client.apps.googleusercontent.com",
    clientSecret: opts.clientSecret || "test-client-secret",
    email: opts.email || "studio@example.com",
    codes: new Map(),          // code -> { redirect, scope }
    refresh: new Map(),        // refresh token -> { valid }
    access: new Map(),         // access token -> expires (ms)
    files: new Map(),          // id -> file
    sessions: new Map(),       // upload id -> { meta, size, mime, origin, bytes: Buffer[], received, file }
    perms: [],
    revoked: [],
    log: [],
    cut: 0,                    // cut the connection on the next N pieces that carry data, part way through,
    cutSkip: 0,                // after letting this many pieces through first
    pieceDelay: 0,             // wait this long before answering each piece, as a slow line would
    bytesIn: new Map(),        // upload id -> bytes received in whole pieces, to show nothing was sent twice
    grantScope: "https://www.googleapis.com/auth/drive.file openid https://www.googleapis.com/auth/userinfo.email",
  };
  g.folder = (name, extra) => {
    const id = "fld" + crypto.randomBytes(9).toString("base64url");
    g.files.set(id, Object.assign({ id, name, mimeType: FOLDER, trashed: false, canAddChildren: true, parents: [] }, extra || {}));
    return id;
  };
  g.code = (redirect, scope) => { const c = "code-" + crypto.randomBytes(8).toString("hex"); g.codes.set(c, { redirect, scope: scope || g.grantScope }); return c; };
  g.expireAccess = () => { for (const k of g.access.keys()) g.access.set(k, 0); };
  g.revokeAll = () => { for (const v of g.refresh.values()) v.valid = false; };

  const authed = (req) => { const t = /^Bearer (.+)$/.exec(req.headers.authorization || ""); return !!t && (g.access.get(t[1]) || 0) > Date.now(); };
  const send = (res, status, body, headers) => { res.writeHead(status, Object.assign({ "Content-Type": "application/json" }, headers || {})); res.end(body == null ? "" : typeof body === "string" ? body : JSON.stringify(body)); };
  const read = (req) => new Promise((resolve, reject) => { const parts = []; req.on("data", (c) => parts.push(c)); req.on("end", () => resolve(Buffer.concat(parts))); req.on("error", reject); req.on("aborted", () => reject(new Error("aborted"))); });
  const corsFor = (sess, req) => (sess && req.headers.origin && sess.origin === req.headers.origin
    ? { "Access-Control-Allow-Origin": sess.origin, "Access-Control-Expose-Headers": "Range, X-GUploader-UploadID", Vary: "Origin" } : {});
  const fileJson = (f) => ({ kind: "drive#file", id: f.id, name: f.name, mimeType: f.mimeType, size: f.size == null ? undefined : String(f.size), parents: f.parents,
    trashed: f.trashed, appProperties: f.appProperties, capabilities: { canAddChildren: f.mimeType === FOLDER ? f.canAddChildren : false } });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    g.log.push(req.method + " " + url.pathname + (url.searchParams.has("upload_id") ? " (upload)" : ""));
    try {
      // ---- the token exchange
      if (req.method === "POST" && url.pathname === "/token") {
        const f = new URLSearchParams((await read(req)).toString());
        if (f.get("client_id") !== g.clientId || f.get("client_secret") !== g.clientSecret) return send(res, 401, { error: "invalid_client" });
        const issue = (scope) => { const at = "at-" + crypto.randomBytes(12).toString("hex"); g.access.set(at, Date.now() + 3600e3); return { access_token: at, expires_in: 3599, token_type: "Bearer", scope }; };
        if (f.get("grant_type") === "authorization_code") {
          const c = g.codes.get(f.get("code"));
          g.codes.delete(f.get("code"));
          if (!c || c.redirect !== f.get("redirect_uri")) return send(res, 400, { error: "invalid_grant", error_description: "Bad code or redirect" });
          const rt = "rt-" + crypto.randomBytes(16).toString("hex");
          g.refresh.set(rt, { valid: true });
          const idt = b64u({ alg: "RS256", typ: "JWT" }) + "." + b64u({ iss: "https://accounts.google.com", email: g.email, email_verified: true, aud: g.clientId }) + ".sig";
          return send(res, 200, Object.assign(issue(c.scope), { refresh_token: rt, id_token: idt }));
        }
        if (f.get("grant_type") === "refresh_token") {
          const r = g.refresh.get(f.get("refresh_token"));
          if (!r || !r.valid) return send(res, 400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
          return send(res, 200, issue(g.grantScope));
        }
        return send(res, 400, { error: "unsupported_grant_type" });
      }
      if (req.method === "POST" && url.pathname === "/revoke") {
        const t = new URLSearchParams((await read(req)).toString()).get("token");
        g.revoked.push(t);
        if (g.refresh.has(t)) g.refresh.get(t).valid = false;
        return send(res, 200, {});
      }
      // ---- resumable uploads: the browser talks to these directly
      if (url.pathname === "/upload/drive/v3/files" && url.searchParams.has("upload_id")) {
        const sess = g.sessions.get(url.searchParams.get("upload_id"));
        const cors = corsFor(sess, req);
        if (req.method === "OPTIONS") {
          return send(res, 200, null, Object.assign(cors.Vary ? { "Access-Control-Allow-Methods": "PUT, POST", "Access-Control-Allow-Headers": "content-range, content-type", "Access-Control-Max-Age": "3600" } : {}, cors));
        }
        if (req.method !== "PUT") return send(res, 405, { error: "method" }, cors);
        if (!sess) { await read(req); return send(res, 404, { error: { code: 404, message: "Not found" } }, cors); }
        const range = req.headers["content-range"] || "";
        const ask = /^bytes \*\/(\d+)$/.exec(range), piece = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
        const hasNow = () => (sess.received ? { Range: "bytes=0-" + (sess.received - 1) } : {});
        if (ask) {
          await read(req);
          if (sess.file) return send(res, 200, fileJson(sess.file), cors);
          return send(res, 308, null, Object.assign(hasNow(), cors));
        }
        if (!piece || Number(piece[3]) !== sess.size) { await read(req); return send(res, 400, { error: { code: 400, message: "Bad Content-Range" } }, cors); }
        const from = Number(piece[1]), to = Number(piece[2]);
        if (g.cut > 0 && g.cutSkip > 0) g.cutSkip--;
        else if (g.cut > 0) {    // the line drops part way through this piece; Google keeps nothing of a piece cut short
          g.cut--;
          let seen = 0;
          req.on("data", (c) => { seen += c.length; if (seen > (to - from + 1) / 3) req.socket.destroy(); });
          return;
        }
        let data;
        try { data = await read(req); } catch (e) { return; }          // the browser went away part way through
        if (g.pieceDelay) await new Promise((r) => setTimeout(r, g.pieceDelay));
        if (from !== sess.received) return send(res, 308, null, Object.assign(hasNow(), cors));     // not where it left off: say how much it has
        if (data.length !== to - from + 1) return send(res, 400, { error: { code: 400, message: "Length does not match" } }, cors);
        sess.bytes.push(data);
        sess.received += data.length;
        const sidNow = url.searchParams.get("upload_id");
        g.bytesIn.set(sidNow, (g.bytesIn.get(sidNow) || 0) + data.length);
        if (sess.received < sess.size) return send(res, 308, null, Object.assign(hasNow(), cors));
        const id = "file" + crypto.randomBytes(9).toString("base64url");
        const all = Buffer.concat(sess.bytes);
        sess.file = { id, name: sess.meta.name, mimeType: sess.mime, size: all.length, parents: sess.meta.parents, appProperties: sess.meta.appProperties || {},
          trashed: false, sha256: crypto.createHash("sha256").update(all).digest("hex") };
        g.files.set(id, sess.file);
        return send(res, 200, fileJson(sess.file), cors);
      }
      if (req.method === "POST" && url.pathname === "/upload/drive/v3/files" && url.searchParams.get("uploadType") === "resumable") {
        if (!authed(req)) { await read(req); return send(res, 401, { error: { code: 401, message: "Invalid Credentials" } }); }
        const meta = JSON.parse((await read(req)).toString() || "{}");
        const parent = g.files.get((meta.parents || [])[0]);
        if (!parent || parent.mimeType !== FOLDER || parent.trashed) return send(res, 404, { error: { code: 404, message: "File not found: " + (meta.parents || [])[0] } });
        const sid = "up" + crypto.randomBytes(12).toString("base64url");
        g.sessions.set(sid, { meta, size: Number(req.headers["x-upload-content-length"]), mime: req.headers["x-upload-content-type"], origin: req.headers.origin || null, bytes: [], received: 0, file: null });
        return send(res, 200, null, { Location: g.url + "/upload/drive/v3/files?uploadType=resumable&upload_id=" + sid });
      }
      // ---- Drive's file calls, for the function
      const m = /^\/drive\/v3\/files\/([^/]+)(\/permissions)?$/.exec(url.pathname);
      if (m) {
        if (!authed(req)) { await read(req); return send(res, 401, { error: { code: 401, message: "Invalid Credentials" } }); }
        const f = g.files.get(decodeURIComponent(m[1]));
        if (!f) { await read(req); return send(res, 404, { error: { code: 404, message: "File not found" } }); }
        if (m[2] && req.method === "POST") { const p = JSON.parse((await read(req)).toString() || "{}"); g.perms.push(Object.assign({ file: f.id }, p)); return send(res, 200, { kind: "drive#permission", id: "anyoneWithLink", type: p.type, role: p.role }); }
        if (req.method === "GET") return send(res, 200, fileJson(f));
      }
      await read(req);
      return send(res, 404, { error: "no such route" });
    } catch (e) {
      try { send(res, 500, { error: String(e && e.message) }); } catch (x) { /* gone */ }
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  g.url = "http://127.0.0.1:" + server.address().port;
  g.close = () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(r); });
  return g;
}
