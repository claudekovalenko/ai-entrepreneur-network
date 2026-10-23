// Web Push: VAPID signing (RFC 8292) and payload encryption (RFC 8291, aes128gcm),
// implemented with WebCrypto so no keys need to be configured. The server's VAPID
// key pair is generated on first use and stored in D1.

const enc = new TextEncoder();

export const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function fromB64url(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
}

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
};

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

// Returns { publicKey (base64url, for browsers), privateJwk } and creates it once.
export async function getVapidKeys(db) {
  let row = await db.prepare("SELECT value FROM settings WHERE key = 'vapid'").first();
  if (!row) {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const value = JSON.stringify({
      publicKey: b64url(await crypto.subtle.exportKey('raw', pair.publicKey)),
      privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
    });
    await db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('vapid', ?)").bind(value).run();
    row = await db.prepare("SELECT value FROM settings WHERE key = 'vapid'").first();
  }
  return JSON.parse(row.value);
}

async function vapidHeader(endpoint, vapid, subject) {
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  })));
  const key = await crypto.subtle.importKey('jwk', vapid.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${vapid.publicKey}`;
}

// Encrypts a payload for one browser subscription (RFC 8291).
export async function encryptPayload(payload, p256dh, auth) {
  const uaPublic = fromB64url(p256dh);
  const authSecret = fromB64url(auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // A single record: the payload followed by the 0x02 "last record" delimiter.
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce },
    aesKey, concat(enc.encode(payload), new Uint8Array([2]))));
  const recordSize = new Uint8Array([0, 0, 16, 0]); // 4096
  return concat(salt, recordSize, new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

// Sends a notification to every device the given members have turned notifications on for.
// payload: { title, body, url, tag }
export async function sendPush(env, userIds, payload) {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (!ids.length) return;
  const db = env.DB;
  const { results: subs } = await db.prepare('SELECT * FROM push_subscriptions WHERE user_id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(ids)).all();
  if (!subs.length) return;
  const vapid = await getVapidKeys(db);
  // Push services want a contact for the sender; use the first admin's email.
  const admin = await db.prepare("SELECT email FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").first();
  const subject = env.PUSH_CONTACT || `mailto:${admin?.email ?? 'admin@example.com'}`;
  const body = JSON.stringify(payload);
  await Promise.allSettled(subs.map(async (sub) => {
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: await vapidHeader(sub.endpoint, vapid, subject),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '86400',
        Urgency: 'high',
      },
      body: await encryptPayload(body, sub.p256dh, sub.auth),
    });
    // The browser unsubscribed or the app was removed: forget this device.
    if (res.status === 404 || res.status === 410) {
      await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(sub.endpoint).run();
    }
  }));
}
