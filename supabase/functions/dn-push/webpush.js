// Web Push for the DN Studios sender: the message encryption every browser expects (RFC 8291, "aes128gcm")
// and the sender's signature (RFC 8292, "VAPID"). Uses only the standard Web Crypto API, so it runs the same
// in Supabase's edge runtime and in Node, where the checks run.
const enc = new TextEncoder();
const subtle = globalThis.crypto.subtle;

export function b64u(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function unb64u(text) {
  const s = String(text).replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const bin = atob(s + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
async function hkdf(salt, ikm, info, length) {
  const key = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

// A new signing key pair: the public key as phones need it (65 bytes, uncompressed point) and the private one.
export async function makeKeys() {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await subtle.exportKey("jwk", pair.privateKey);
  const pub = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  return { publicKey: b64u(pub), privateKey: jwk.d };
}

async function signingKey(publicKey, privateKey) {
  const pub = unb64u(publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("bad public key");
  const jwk = { kty: "EC", crv: "P-256", x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), d: privateKey, ext: true };
  return subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

// The Authorization header for one push service: a short-lived token signed with the sender's key.
export async function vapidHeader(endpoint, keys, subject, nowSeconds) {
  const u = new URL(endpoint);
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(enc.encode(JSON.stringify({ aud: u.protocol + "//" + u.host, exp: Math.floor(nowSeconds ?? Date.now() / 1000) + 12 * 3600, sub: subject })));
  const key = await signingKey(keys.publicKey, keys.privateKey);
  const sig = new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(head + "." + body)));
  return "vapid t=" + head + "." + body + "." + b64u(sig) + ", k=" + keys.publicKey;
}

// Encrypts a message for one phone, which only that phone can read.
export async function encryptFor(sub, payload) {
  const uaPublic = unb64u(sub.p256dh), authSecret = unb64u(sub.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error("bad subscription keys");
  const mine = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await subtle.exportKey("raw", mine.publicKey));
  const theirs = await subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: theirs }, mine.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const data = typeof payload === "string" ? enc.encode(payload) : payload;
  if (data.length > 3800) throw new Error("message too long");
  const aes = await subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aes, concat(data, new Uint8Array([2]))));
  const head = new Uint8Array(21);
  head.set(salt, 0);
  new DataView(head.buffer).setUint32(16, 4096);
  head[20] = asPublic.length;
  return concat(head, asPublic, sealed);
}

// Sends one message to one phone. Returns the push service's answer; 404 or 410 means the phone is gone.
export async function sendPush(sub, payload, keys, subject, opts = {}) {
  const body = await encryptFor(sub, payload);
  const res = await (opts.fetch || fetch)(sub.endpoint, {
    method: "POST",
    headers: {
      TTL: String(opts.ttl ?? 86400),
      Urgency: opts.urgency || "high",
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      Authorization: await vapidHeader(sub.endpoint, keys, subject),
      ...(opts.topic ? { Topic: opts.topic } : {}),
    },
    body,
  });
  let text = "";
  try { text = (await res.text()).slice(0, 200); } catch (e) { /* no body */ }
  return { status: res.status, text };
}
