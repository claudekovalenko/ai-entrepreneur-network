import { ensureSchema } from './schema.js';
import { hashPassword, randomToken, verifyPassword } from './password.js';
import { FREQUENCIES, isValidTimeZone, upcomingOccurrences } from './schedule.js';
import { getVapidKeys, sendPush } from './push.js';

export { Hub } from './hub.js';

const COOKIE = 'aen_session';
const SESSION_MAX_AGE = 60 * 60 * 24 * 60;
const REACTIONS = ['🙏', '🔥', '❤️', '🙌', '💡', '😂'];
const PROJECT_STATUSES = ['looking', 'in-progress', 'launched', 'paused'];
const SUGGESTION_STATUSES = ['open', 'planned', 'done', 'not-now'];
const PLAYBOOK_KINDS = ['case', 'blueprint'];
const REVENUE_RANGES = ['', 'pre-revenue', 'under-1k', '1k-5k', '5k-10k', '10k-plus'];
const MAX_MESSAGE = 4000;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- small helpers ----------

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function str(value, { max = 200, required = false, field = 'value' } = {}) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (required && !s) throw new HttpError(400, `${field} is required`);
  if (s.length > max) throw new HttpError(400, `${field} must be ${max} characters or fewer`);
  return s;
}

function intParam(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, 'Not found');
  return n;
}

const all = async (stmt) => (await stmt.all()).results;

function sessionCookie(token, maxAge = SESSION_MAX_AGE) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

// ---------- serializers ----------

const publicUser = (u) => u && ({
  id: u.id, name: u.name, headline: u.headline, bio: u.bio,
  skills: u.skills, ministry: u.ministry, role: u.role, createdAt: u.created_at,
});
const privateUser = (u) => ({ ...publicUser(u), email: u.email });

async function serializeMessages(db, rows) {
  if (!rows.length) return [];
  const reactions = await all(db.prepare(
    'SELECT message_id, emoji, user_id FROM reactions WHERE message_id IN (SELECT value FROM json_each(?)) ORDER BY rowid',
  ).bind(JSON.stringify(rows.map((m) => m.id))));
  const byMessage = new Map();
  for (const r of reactions) {
    if (!byMessage.has(r.message_id)) byMessage.set(r.message_id, new Map());
    const grouped = byMessage.get(r.message_id);
    if (!grouped.has(r.emoji)) grouped.set(r.emoji, []);
    grouped.get(r.emoji).push(r.user_id);
  }
  return rows.map((m) => ({
    id: m.id,
    room: m.channel_id ? `c:${m.channel_id}` : `d:${m.conversation_id}`,
    userId: m.user_id,
    body: m.body,
    createdAt: m.created_at,
    editedAt: m.edited_at,
    reactions: [...(byMessage.get(m.id) || [])].map(([emoji, userIds]) => ({ emoji, userIds })),
  }));
}

async function loadMessage(db, id) {
  const row = await db.prepare('SELECT * FROM messages WHERE id = ?').bind(id).first();
  return (await serializeMessages(db, [row]))[0];
}

function serializeConversation(c, userId) {
  return {
    id: c.id, room: `d:${c.id}`,
    otherUserId: c.user_a === userId ? c.user_b : c.user_a,
    lastMessageAt: c.last_at ?? c.created_at,
    unread: c.unread ?? 0,
  };
}

const UNREAD = (column, prefix, idExpr) => `(SELECT COUNT(*) FROM messages m
  WHERE m.${column} = ${idExpr} AND m.user_id != ?1
    AND m.id > COALESCE((SELECT last_read_id FROM reads r WHERE r.user_id = ?1 AND r.room = '${prefix}' || ${idExpr}), 0))`;

const CHANNELS_SQL = `SELECT c.id, c.name, c.description, ${UNREAD('channel_id', 'c:', 'c.id')} AS unread
  FROM channels c ORDER BY c.id`;
const CONVERSATIONS_SQL = `SELECT cv.*, (SELECT MAX(created_at) FROM messages WHERE conversation_id = cv.id) AS last_at,
  ${UNREAD('conversation_id', 'd:', 'cv.id')} AS unread
  FROM conversations cv WHERE (cv.user_a = ?1 OR cv.user_b = ?1)`;

const serializeChannel = (c) => ({ id: c.id, room: `c:${c.id}`, name: c.name, description: c.description, unread: c.unread ?? 0 });

async function serializeProjects(db, projects, { detail = false } = {}) {
  if (!projects.length) return [];
  const ids = JSON.stringify(projects.map((p) => p.id));
  const [helpers, counts, comments] = await db.batch([
    db.prepare(`SELECT project_id, user_id, note, created_at FROM project_helpers
      WHERE project_id IN (SELECT value FROM json_each(?)) ORDER BY created_at`).bind(ids),
    db.prepare(`SELECT project_id, COUNT(*) AS n FROM project_comments
      WHERE project_id IN (SELECT value FROM json_each(?)) GROUP BY project_id`).bind(ids),
    db.prepare(`SELECT * FROM project_comments WHERE ? AND project_id IN (SELECT value FROM json_each(?)) ORDER BY id`)
      .bind(detail ? 1 : 0, ids),
  ]);
  const countFor = new Map(counts.results.map((r) => [r.project_id, r.n]));
  return projects.map((p) => {
    const out = {
      id: p.id, userId: p.user_id, title: p.title, description: p.description,
      helpNeeded: p.help_needed, tags: p.tags, status: p.status,
      createdAt: p.created_at, updatedAt: p.updated_at,
      helpers: helpers.results.filter((h) => h.project_id === p.id)
        .map((h) => ({ userId: h.user_id, note: h.note, createdAt: h.created_at })),
      commentCount: countFor.get(p.id) ?? 0,
    };
    if (detail) {
      out.comments = comments.results.filter((c) => c.project_id === p.id)
        .map((c) => ({ id: c.id, userId: c.user_id, body: c.body, createdAt: c.created_at }));
    }
    return out;
  });
}

async function serializeCalls(db, calls) {
  if (!calls.length) return [];
  const rsvps = await all(db.prepare('SELECT call_id, occurrence, user_id FROM call_rsvps WHERE call_id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(calls.map((c) => c.id))));
  return calls.map((c) => ({
    id: c.id, title: c.title, description: c.description, frequency: c.frequency,
    startDate: c.start_date, startTime: c.start_time, timezone: c.timezone,
    durationMin: c.duration_min, link: c.link,
    occurrences: upcomingOccurrences(c).map((o) => ({
      ...o,
      rsvps: rsvps.filter((r) => r.call_id === c.id && r.occurrence === o.occurrence).map((r) => r.user_id),
    })),
  }));
}

function projectFields(body, existing = {}) {
  const status = body.status ?? existing.status ?? 'looking';
  if (!PROJECT_STATUSES.includes(status)) throw new HttpError(400, 'Unknown project status');
  return {
    title: str(body.title ?? existing.title, { max: 120, required: true, field: 'Title' }),
    description: str(body.description ?? existing.description, { max: 4000, field: 'Description' }),
    help_needed: str(body.helpNeeded ?? existing.help_needed, { max: 2000, field: 'Help needed' }),
    tags: str(body.tags ?? existing.tags, { max: 200, field: 'Tags' }),
    status,
  };
}

function callFields(body, existing = {}) {
  const frequency = body.frequency ?? existing.frequency ?? 'weekly';
  if (!FREQUENCIES.includes(frequency)) throw new HttpError(400, 'Frequency must be weekly, biweekly, or once');
  const startDate = body.startDate ?? existing.start_date;
  const startTime = body.startTime ?? existing.start_time;
  const timezone = body.timezone ?? existing.timezone ?? 'UTC';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate ?? '')) throw new HttpError(400, 'Start date is required');
  if (!/^\d{2}:\d{2}$/.test(startTime ?? '')) throw new HttpError(400, 'Start time is required');
  if (!isValidTimeZone(timezone)) throw new HttpError(400, 'Unknown timezone');
  const duration = Number(body.durationMin ?? existing.duration_min ?? 60);
  if (!Number.isInteger(duration) || duration < 5 || duration > 600) {
    throw new HttpError(400, 'Duration must be between 5 and 600 minutes');
  }
  const link = str(body.link ?? existing.link, { max: 500, field: 'Meeting link' });
  if (link && !/^https?:\/\//i.test(link)) throw new HttpError(400, 'Meeting link must start with http:// or https://');
  return {
    title: str(body.title ?? existing.title, { max: 120, required: true, field: 'Title' }),
    description: str(body.description ?? existing.description, { max: 2000, field: 'Description' }),
    frequency, start_date: startDate, start_time: startTime, timezone, duration_min: duration, link,
  };
}

// ---------- routes ----------

const routes = [];
function on(method, pattern, handler, { auth = true, admin = false } = {}) {
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`);
  routes.push({ method, re, handler, auth, admin });
}

on('GET', '/api/config', async ({ db, env }) => ({
  googleEnabled: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  // True only before anyone has signed up, so the first person can create the admin account.
  setupNeeded: !(await db.prepare('SELECT 1 FROM users LIMIT 1').first()),
  reactions: REACTIONS,
}), { auth: false });

// ----- invite-only membership -----

const INVITE_DAYS = 14;
const INVALID_INVITE = 'This invite link is not valid. It may have expired or already been used. Ask the person who invited you for a new one.';

// Reserves a single-use invite so the same link can't be used twice, even at the same moment.
const claimInvite = (db, token) => (token ? db.prepare(`UPDATE invites SET used_at = ${NOW}
  WHERE token = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ${NOW} RETURNING *`)
  .bind(String(token)).first() : null);

// Creates a member. Everyone except the very first person (the admin) needs a valid invite.
async function createMember(db, { email, name, passwordHash }, inviteToken) {
  const { n } = await db.prepare('SELECT COUNT(*) AS n FROM users').first();
  const invite = n === 0 ? null : await claimInvite(db, inviteToken);
  if (n > 0 && !invite) throw new HttpError(403, INVALID_INVITE);
  try {
    const user = await db.prepare('INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?) RETURNING *')
      .bind(email, passwordHash, name, n === 0 ? 'admin' : 'member').first();
    if (invite) await db.prepare('UPDATE invites SET used_by = ? WHERE token = ?').bind(user.id, invite.token).run();
    return user;
  } catch (err) {
    if (invite) await db.prepare('UPDATE invites SET used_at = NULL WHERE token = ? AND used_by IS NULL').bind(invite.token).run();
    throw err;
  }
}

const inviteStatus = (i) => (i.used_by || i.used_at ? 'joined' : i.revoked_at ? 'cancelled' : i.expires_at <= new Date().toISOString() ? 'expired' : 'pending');
const serializeInvite = (i) => ({
  token: i.token, name: i.name, email: i.email, note: i.note, createdBy: i.created_by, createdAt: i.created_at,
  expiresAt: i.expires_at, usedBy: i.used_by, usedAt: i.used_at, status: inviteStatus(i),
});

// Public: lets the invite page greet the person before they sign up.
on('GET', '/api/invites/:token', async ({ db, params }) => {
  const i = await db.prepare('SELECT * FROM invites WHERE token = ?').bind(params.token).first();
  if (!i || inviteStatus(i) !== 'pending') throw new HttpError(404, INVALID_INVITE);
  return { invite: { name: i.name, email: i.email, expiresAt: i.expires_at } };
}, { auth: false });

on('GET', '/api/invites', async ({ db }) => ({
  invites: (await all(db.prepare('SELECT * FROM invites ORDER BY created_at DESC LIMIT 200'))).map(serializeInvite),
}), { admin: true });

on('POST', '/api/invites', async ({ db, user, body }) => {
  const name = str(body.name, { max: 80, required: true, field: 'Name' });
  const email = str(body.email, { max: 200, required: true, field: 'Email' }).toLowerCase();
  const note = str(body.note, { max: 300, field: 'Note' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Enter a valid email');
  if (await db.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first()) {
    throw new HttpError(409, 'That person is already a member');
  }
  const token = randomToken().slice(0, 32);
  const expires = new Date(Date.now() + INVITE_DAYS * 86_400_000).toISOString();
  const row = await db.prepare('INSERT INTO invites (token, name, email, note, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *')
    .bind(token, name, email, note, user.id, expires).first();
  return { invite: serializeInvite(row) };
}, { admin: true });

on('DELETE', '/api/invites/:token', async ({ db, params }) => {
  const { meta } = await db.prepare(`UPDATE invites SET revoked_at = ${NOW} WHERE token = ? AND used_at IS NULL AND revoked_at IS NULL`)
    .bind(params.token).run();
  if (!meta.changes) throw new HttpError(404, 'That invite is no longer pending');
  return { ok: true };
}, { admin: true });

on('POST', '/api/auth/register', async ({ db, body, emit, setCookie }) => {
  const email = str(body.email, { max: 200, required: true, field: 'Email' }).toLowerCase();
  const name = str(body.name, { max: 80, required: true, field: 'Name' });
  const password = typeof body.password === 'string' ? body.password : '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Enter a valid email');
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (await db.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first()) {
    throw new HttpError(409, 'An account with that email already exists');
  }
  const user = await createMember(db, { email, name, passwordHash: await hashPassword(password) }, body.inviteToken);
  setCookie(await startSession(db, user.id));
  emit('user:updated', publicUser(user));
  return { user: privateUser(user) };
}, { auth: false });

on('POST', '/api/auth/login', async ({ db, body, setCookie }) => {
  const email = str(body.email, { max: 200 }).toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  const user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    throw new HttpError(401, 'Email or password is incorrect');
  }
  setCookie(await startSession(db, user.id));
  return { user: privateUser(user) };
}, { auth: false });

on('POST', '/api/auth/logout', async ({ db, request, setCookie }) => {
  const token = parseCookies(request.headers.get('Cookie') ?? '')[COOKIE];
  if (token) await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
  setCookie(sessionCookie('', 0));
  return { ok: true };
}, { auth: false });

// ----- Google sign-in (OAuth 2.0 authorization code flow) -----

const OAUTH_COOKIE = 'aen_oauth';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

const redirect = (location) => new Response(null, { status: 302, headers: { Location: location } });
const googleCallbackUrl = (url) => `${url.origin}/api/auth/google/callback`;

function requireGoogle(env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new HttpError(404, 'Google sign-in is not set up');
}

function decodeJwtPayload(jwt) {
  const part = String(jwt).split('.')[1] ?? '';
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
}

// Starts sign-in: remembers a random state (and any invite code) in a short-lived cookie.
on('GET', '/api/auth/google/start', ({ env, url, setCookie }) => {
  requireGoogle(env);
  const state = randomToken();
  const invite = url.searchParams.get('invite') ?? '';
  setCookie(`${OAUTH_COOKIE}=${state}.${encodeURIComponent(invite)}; Path=/api/auth/google; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: googleCallbackUrl(url),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  return redirect(`${GOOGLE_AUTH_URL}?${params}`);
}, { auth: false });

on('GET', '/api/auth/google/callback', async ({ db, env, url, request, setCookie, emit }) => {
  requireGoogle(env);
  setCookie(`${OAUTH_COOKIE}=; Path=/api/auth/google; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  const fail = (reason) => redirect(`/?auth_error=${reason}`);
  const [state, invite = ''] = (parseCookies(request.headers.get('Cookie') ?? '')[OAUTH_COOKIE] ?? '').split('.');
  const code = url.searchParams.get('code');
  if (!state || state !== url.searchParams.get('state') || !code) return fail('google');

  // The ID token comes straight from Google over TLS in exchange for our secret,
  // so its claims can be trusted without re-checking the signature.
  const tokenRes = await fetch(env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: googleCallbackUrl(url),
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) return fail('google');
  let claims;
  try {
    claims = decodeJwtPayload((await tokenRes.json()).id_token);
  } catch {
    return fail('google');
  }
  if (claims.aud !== env.GOOGLE_CLIENT_ID || !claims.sub || !claims.email || claims.email_verified === false) {
    return fail('google');
  }
  const email = String(claims.email).toLowerCase();

  let user = await db.prepare(`SELECT u.* FROM oauth_accounts o JOIN users u ON u.id = o.user_id
    WHERE o.provider = 'google' AND o.subject = ?`).bind(claims.sub).first();
  if (!user) {
    // Google has verified the email, so an existing member with it is the same person.
    user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
    if (!user) {
      const name = str(claims.name || email.split('@')[0], { max: 80 }) || 'New member';
      try {
        user = await createMember(db, { email, name, passwordHash: '' }, decodeURIComponent(invite));
      } catch (err) {
        if (err instanceof HttpError) return fail(invite ? 'invite' : 'not-member');
        throw err;
      }
      emit('user:updated', publicUser(user));
    }
    await db.prepare("INSERT OR IGNORE INTO oauth_accounts (provider, subject, user_id) VALUES ('google', ?, ?)")
      .bind(claims.sub, user.id).run();
  }
  setCookie(await startSession(db, user.id));
  return redirect('/');
}, { auth: false });

async function startSession(db, userId) {
  const token = randomToken();
  await db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').bind(token, userId).run();
  return sessionCookie(token);
}

// ----- profile & members -----

on('GET', '/api/me', ({ user }) => ({ user: privateUser(user) }));

on('PATCH', '/api/me', async ({ db, user: me, body, emit }) => {
  const name = str(body.name ?? me.name, { max: 80, required: true, field: 'Name' });
  const headline = str(body.headline ?? me.headline, { max: 120, field: 'Headline' });
  const bio = str(body.bio ?? me.bio, { max: 1000, field: 'Bio' });
  const skills = str(body.skills ?? me.skills, { max: 300, field: 'Skills' });
  const ministry = str(body.ministry ?? me.ministry, { max: 300, field: 'Ministry' });
  const user = await db.prepare('UPDATE users SET name = ?, headline = ?, bio = ?, skills = ?, ministry = ? WHERE id = ? RETURNING *')
    .bind(name, headline, bio, skills, ministry, me.id).first();
  emit('user:updated', publicUser(user));
  return { user: privateUser(user) };
});

on('DELETE', '/api/users/:id', async ({ db, env, user: me, params, emit }) => {
  const id = intParam(params.id);
  if (id === me.id) throw new HttpError(400, 'You cannot remove yourself');
  const { meta } = await db.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  if (!meta.changes) throw new HttpError(404, 'Member not found');
  await hub(env).disconnectUser(id);
  emit('user:removed', { id });
  return { ok: true };
}, { admin: true });

on('PATCH', '/api/users/:id/role', async ({ db, user: me, params, body, emit }) => {
  const id = intParam(params.id);
  const role = body.role === 'admin' ? 'admin' : 'member';
  if (id === me.id && role !== 'admin') throw new HttpError(400, 'You cannot remove your own admin role');
  const user = await db.prepare('UPDATE users SET role = ? WHERE id = ? RETURNING *').bind(role, id).first();
  if (!user) throw new HttpError(404, 'Member not found');
  emit('user:updated', publicUser(user));
  return { user: publicUser(user) };
}, { admin: true });

// ----- rooms: channels & direct messages -----

// Resolves 'c:1' / 'd:2' to a room the user may access.
async function resolveRoom(db, room, user) {
  const match = /^([cd]):(\d+)$/.exec(String(room));
  if (!match) throw new HttpError(404, 'Conversation not found');
  const id = Number(match[2]);
  if (match[1] === 'c') {
    if (!(await db.prepare('SELECT 1 FROM channels WHERE id = ?').bind(id).first())) {
      throw new HttpError(404, 'Channel not found');
    }
    return { kind: 'channel', id, room: `c:${id}`, column: 'channel_id', audience: null };
  }
  const convo = await db.prepare('SELECT * FROM conversations WHERE id = ?').bind(id).first();
  if (!convo || (convo.user_a !== user.id && convo.user_b !== user.id)) {
    throw new HttpError(404, 'Conversation not found');
  }
  return { kind: 'dm', id, room: `d:${id}`, column: 'conversation_id', convo, audience: [convo.user_a, convo.user_b] };
}

const markRead = (db, userId, room, lastReadId) => db.prepare(`INSERT INTO reads (user_id, room, last_read_id) VALUES (?, ?, ?)
  ON CONFLICT (user_id, room) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`)
  .bind(userId, room, lastReadId);

on('GET', '/api/bootstrap', async ({ db, env, user }) => {
  const [users, channels, conversations] = await db.batch([
    db.prepare('SELECT * FROM users ORDER BY name COLLATE NOCASE'),
    db.prepare(CHANNELS_SQL).bind(user.id),
    db.prepare(CONVERSATIONS_SQL).bind(user.id),
  ]);
  const online = await hub(env).onlineUserIds();
  return {
    user: privateUser(user),
    users: users.results.map(publicUser),
    channels: channels.results.map(serializeChannel),
    conversations: conversations.results.map((c) => serializeConversation(c, user.id))
      .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt)),
    online,
    reactions: REACTIONS,
  };
});

on('POST', '/api/channels', async ({ db, user, body, emit }) => {
  const name = str(body.name, { max: 40, required: true, field: 'Channel name' })
    .toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!name) throw new HttpError(400, 'Channel name must contain letters or numbers');
  const description = str(body.description, { max: 200, field: 'Description' });
  if (await db.prepare('SELECT 1 FROM channels WHERE name = ?').bind(name).first()) {
    throw new HttpError(409, 'A channel with that name already exists');
  }
  const row = await db.prepare('INSERT INTO channels (name, description, created_by) VALUES (?, ?, ?) RETURNING *')
    .bind(name, description, user.id).first();
  const channel = serializeChannel(row);
  emit('channel:new', channel);
  return { channel };
}, { admin: true });

on('DELETE', '/api/channels/:id', async ({ db, params, emit }) => {
  const id = intParam(params.id);
  const { n } = await db.prepare('SELECT COUNT(*) AS n FROM channels').first();
  if (n <= 1) throw new HttpError(400, 'The network needs at least one channel');
  const { meta } = await db.prepare('DELETE FROM channels WHERE id = ?').bind(id).run();
  if (!meta.changes) throw new HttpError(404, 'Channel not found');
  emit('channel:deleted', { room: `c:${id}` });
  return { ok: true };
}, { admin: true });

on('POST', '/api/conversations', async ({ db, user, body }) => {
  const otherId = Number(body.userId);
  if (otherId === user.id) throw new HttpError(400, 'You cannot message yourself');
  if (!(await db.prepare('SELECT 1 FROM users WHERE id = ?').bind(otherId).first())) {
    throw new HttpError(404, 'Member not found');
  }
  const [a, b] = [user.id, otherId].sort((x, y) => x - y);
  await db.prepare('INSERT OR IGNORE INTO conversations (user_a, user_b) VALUES (?, ?)').bind(a, b).run();
  const convo = await db.prepare(`${CONVERSATIONS_SQL} AND cv.user_a = ?2 AND cv.user_b = ?3`).bind(user.id, a, b).first();
  return { conversation: serializeConversation(convo, user.id) };
});

on('GET', '/api/rooms/:room/messages', async ({ db, user, params, url }) => {
  const target = await resolveRoom(db, params.room, user);
  const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
  const rows = await all(db.prepare(`SELECT * FROM messages WHERE ${target.column} = ? AND id < ? ORDER BY id DESC LIMIT 50`)
    .bind(target.id, before));
  return { messages: await serializeMessages(db, rows.reverse()), hasMore: rows.length === 50 };
});

// ----- push notifications -----

on('GET', '/api/push/key', async ({ db }) => ({ publicKey: (await getVapidKeys(db)).publicKey }));

on('POST', '/api/push/subscribe', async ({ db, env, user, body }) => {
  const endpoint = str(body.endpoint, { max: 1000, required: true, field: 'Endpoint' });
  const p256dh = str(body.keys?.p256dh, { max: 200, required: true, field: 'Key' });
  const auth = str(body.keys?.auth, { max: 100, required: true, field: 'Key' });
  const allowed = endpoint.startsWith('https://') || (env.ALLOW_HTTP_PUSH && endpoint.startsWith('http://'));
  if (!allowed) throw new HttpError(400, 'Unsupported push endpoint');
  await db.prepare(`INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth) VALUES (?, ?, ?, ?)
    ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`)
    .bind(endpoint, user.id, p256dh, auth).run();
  return { ok: true };
});

on('POST', '/api/push/unsubscribe', async ({ db, user, body }) => {
  await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').bind(String(body.endpoint ?? ''), user.id).run();
  return { ok: true };
});

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Members @mentioned in a channel message (by first or full name), or everyone for an admin's @everyone.
async function mentionedUserIds(db, text, sender) {
  if (!text.includes('@')) return [];
  const users = await all(db.prepare('SELECT id, name FROM users WHERE id != ?').bind(sender.id));
  if (sender.role === 'admin' && /(^|\s)@(everyone|channel)\b/i.test(text)) return users.map((u) => u.id);
  return users.filter((u) => {
    const names = [u.name, u.name.split(/\s+/)[0]].map((n) => escapeRegex(n.trim())).filter(Boolean);
    return names.some((n) => new RegExp(`(^|[^\\w])@${n}(?![\\w])`, 'i').test(text));
  }).map((u) => u.id);
}

// Notifies the people a new message is for, skipping anyone looking at the app right now.
async function notifyMessage(env, db, target, message, sender) {
  const recipients = target.kind === 'dm'
    ? target.audience.filter((id) => id !== sender.id)
    : await mentionedUserIds(db, message.body, sender);
  if (!recipients.length) return;
  const active = new Set(await hub(env).activeUserIds());
  const away = recipients.filter((id) => !active.has(id));
  if (!away.length) return;
  const channel = target.kind === 'channel'
    ? (await db.prepare('SELECT name FROM channels WHERE id = ?').bind(target.id).first())?.name
    : null;
  await sendPush(env, away, {
    title: channel ? `${sender.name} in #${channel}` : sender.name,
    body: message.body.length > 180 ? `${message.body.slice(0, 180)}…` : message.body,
    url: `/#/${target.room.replace(':', '/')}`,
    tag: target.room,
  });
}

on('POST', '/api/rooms/:room/messages', async ({ db, env, user, params, body, emit, waitUntil }) => {
  const target = await resolveRoom(db, params.room, user);
  const text = str(body.body, { max: MAX_MESSAGE, required: true, field: 'Message' });
  const row = await db.prepare(`INSERT INTO messages (${target.column}, user_id, body) VALUES (?, ?, ?) RETURNING *`)
    .bind(target.id, user.id, text).first();
  await markRead(db, user.id, target.room, row.id).run();
  const [message] = await serializeMessages(db, [row]);
  if (target.kind === 'dm') {
    // Make sure the recipient learns about a brand-new conversation.
    for (const uid of target.audience) {
      emit('conversation:upsert', serializeConversation({ ...target.convo, last_at: row.created_at }, uid), [uid]);
    }
  }
  emit('message:new', message, target.audience);
  waitUntil(notifyMessage(env, db, target, message, user));
  return { message };
});

async function loadOwnMessage(db, user, params) {
  const m = await db.prepare('SELECT * FROM messages WHERE id = ?').bind(intParam(params.id)).first();
  if (!m) throw new HttpError(404, 'Message not found');
  const target = await resolveRoom(db, m.channel_id ? `c:${m.channel_id}` : `d:${m.conversation_id}`, user);
  return { m, target, isOwner: m.user_id === user.id };
}

on('PATCH', '/api/messages/:id', async ({ db, user, params, body, emit }) => {
  const { m, target, isOwner } = await loadOwnMessage(db, user, params);
  if (!isOwner) throw new HttpError(403, 'You can only edit your own messages');
  const text = str(body.body, { max: MAX_MESSAGE, required: true, field: 'Message' });
  await db.prepare(`UPDATE messages SET body = ?, edited_at = ${NOW} WHERE id = ?`).bind(text, m.id).run();
  const message = await loadMessage(db, m.id);
  emit('message:update', message, target.audience);
  return { message };
});

on('DELETE', '/api/messages/:id', async ({ db, user, params, emit }) => {
  const { m, target, isOwner } = await loadOwnMessage(db, user, params);
  if (!isOwner && !(user.role === 'admin' && target.kind === 'channel')) {
    throw new HttpError(403, 'You can only delete your own messages');
  }
  await db.prepare('DELETE FROM messages WHERE id = ?').bind(m.id).run();
  emit('message:delete', { id: m.id, room: target.room }, target.audience);
  return { ok: true };
});

on('POST', '/api/messages/:id/reactions', async ({ db, user, params, body, emit }) => {
  const { m, target } = await loadOwnMessage(db, user, params);
  const emoji = body.emoji;
  if (!REACTIONS.includes(emoji)) throw new HttpError(400, 'Unsupported reaction');
  const { meta } = await db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
    .bind(m.id, user.id, emoji).run();
  if (!meta.changes) {
    await db.prepare('INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').bind(m.id, user.id, emoji).run();
  }
  const message = await loadMessage(db, m.id);
  emit('message:update', message, target.audience);
  return { message };
});

on('POST', '/api/rooms/:room/read', async ({ db, user, params, body }) => {
  const target = await resolveRoom(db, params.room, user);
  await markRead(db, user.id, target.room, Number(body.lastReadId) || 0).run();
  return { ok: true };
});

// ----- projects -----

async function loadProject(db, params) {
  const p = await db.prepare('SELECT * FROM projects WHERE id = ?').bind(intParam(params.id)).first();
  if (!p) throw new HttpError(404, 'Project not found');
  return p;
}

// Broadcasts the project's latest state and returns its detailed view.
async function projectChanged(db, id, emit) {
  const p = await db.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first();
  if (!p) {
    emit('project:changed', { id, deleted: true });
    return null;
  }
  const [detail] = await serializeProjects(db, [p], { detail: true });
  const { comments, ...summary } = detail;
  emit('project:changed', summary);
  return detail;
}

on('GET', '/api/projects', async ({ db }) => ({
  projects: await serializeProjects(db, await all(db.prepare('SELECT * FROM projects ORDER BY updated_at DESC'))),
  statuses: PROJECT_STATUSES,
}));

on('POST', '/api/projects', async ({ db, user, body, emit }) => {
  const f = projectFields(body);
  const row = await db.prepare(`INSERT INTO projects (user_id, title, description, help_needed, tags, status)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING id`).bind(user.id, f.title, f.description, f.help_needed, f.tags, f.status).first();
  return { project: await projectChanged(db, row.id, emit) };
});

on('GET', '/api/projects/:id', async ({ db, params }) => {
  const [project] = await serializeProjects(db, [await loadProject(db, params)], { detail: true });
  return { project };
});

on('PATCH', '/api/projects/:id', async ({ db, user, params, body, emit }) => {
  const p = await loadProject(db, params);
  if (p.user_id !== user.id) throw new HttpError(403, 'Only the project owner can edit it');
  const f = projectFields(body, p);
  await db.prepare(`UPDATE projects SET title = ?, description = ?, help_needed = ?, tags = ?, status = ?,
    updated_at = ${NOW} WHERE id = ?`).bind(f.title, f.description, f.help_needed, f.tags, f.status, p.id).run();
  return { project: await projectChanged(db, p.id, emit) };
});

on('DELETE', '/api/projects/:id', async ({ db, user, params, emit }) => {
  const p = await loadProject(db, params);
  if (p.user_id !== user.id && user.role !== 'admin') throw new HttpError(403, 'Only the project owner can delete it');
  await db.prepare('DELETE FROM projects WHERE id = ?').bind(p.id).run();
  await projectChanged(db, p.id, emit);
  return { ok: true };
});

on('POST', '/api/projects/:id/helpers', async ({ db, user, params, body, emit }) => {
  const p = await loadProject(db, params);
  if (p.user_id === user.id) throw new HttpError(400, 'This is your project');
  const note = str(body.note, { max: 500, field: 'Note' });
  await db.prepare(`INSERT INTO project_helpers (project_id, user_id, note) VALUES (?, ?, ?)
    ON CONFLICT (project_id, user_id) DO UPDATE SET note = excluded.note`).bind(p.id, user.id, note).run();
  return { project: await projectChanged(db, p.id, emit) };
});

on('DELETE', '/api/projects/:id/helpers', async ({ db, user, params, emit }) => {
  const p = await loadProject(db, params);
  await db.prepare('DELETE FROM project_helpers WHERE project_id = ? AND user_id = ?').bind(p.id, user.id).run();
  return { project: await projectChanged(db, p.id, emit) };
});

on('POST', '/api/projects/:id/comments', async ({ db, user, params, body, emit }) => {
  const p = await loadProject(db, params);
  const text = str(body.body, { max: 2000, required: true, field: 'Comment' });
  await db.prepare('INSERT INTO project_comments (project_id, user_id, body) VALUES (?, ?, ?)').bind(p.id, user.id, text).run();
  return { project: await projectChanged(db, p.id, emit) };
});

// ----- suggestions -----

async function serializeSuggestions(db, rows, userId, { detail = false } = {}) {
  if (!rows.length) return [];
  const ids = JSON.stringify(rows.map((r) => r.id));
  const [votes, counts, comments] = await db.batch([
    db.prepare('SELECT suggestion_id, user_id FROM suggestion_votes WHERE suggestion_id IN (SELECT value FROM json_each(?))').bind(ids),
    db.prepare(`SELECT suggestion_id, COUNT(*) AS n FROM suggestion_comments
      WHERE suggestion_id IN (SELECT value FROM json_each(?)) GROUP BY suggestion_id`).bind(ids),
    db.prepare(`SELECT * FROM suggestion_comments WHERE ? AND suggestion_id IN (SELECT value FROM json_each(?)) ORDER BY id`)
      .bind(detail ? 1 : 0, ids),
  ]);
  const countFor = new Map(counts.results.map((r) => [r.suggestion_id, r.n]));
  return rows.map((s) => {
    const voters = votes.results.filter((v) => v.suggestion_id === s.id).map((v) => v.user_id);
    const out = {
      id: s.id, userId: s.user_id, title: s.title, details: s.details, status: s.status, createdAt: s.created_at,
      votes: voters.length, voters, commentCount: countFor.get(s.id) ?? 0,
    };
    if (userId != null) out.voted = voters.includes(userId);
    if (detail) {
      out.comments = comments.results.filter((c) => c.suggestion_id === s.id)
        .map((c) => ({ id: c.id, userId: c.user_id, body: c.body, createdAt: c.created_at }));
    }
    return out;
  });
}

async function loadSuggestion(db, params) {
  const s = await db.prepare('SELECT * FROM suggestions WHERE id = ?').bind(intParam(params.id)).first();
  if (!s) throw new HttpError(404, 'Suggestion not found');
  return s;
}

// Broadcasts the suggestion's latest state and returns its detailed view for the caller.
async function suggestionChanged(db, id, user, emit) {
  const row = await db.prepare('SELECT * FROM suggestions WHERE id = ?').bind(id).first();
  if (!row) {
    emit('suggestion:changed', { id, deleted: true });
    return null;
  }
  const [detail] = await serializeSuggestions(db, [row], user.id, { detail: true });
  const { comments, voted, ...summary } = detail;
  emit('suggestion:changed', summary);
  return detail;
}

on('GET', '/api/suggestions', async ({ db, user }) => ({
  suggestions: await serializeSuggestions(db, await all(db.prepare('SELECT * FROM suggestions ORDER BY id DESC')), user.id),
  statuses: SUGGESTION_STATUSES,
}));

on('POST', '/api/suggestions', async ({ db, user, body, emit }) => {
  const title = str(body.title, { max: 140, required: true, field: 'Suggestion' });
  const details = str(body.details, { max: 2000, field: 'Details' });
  const row = await db.prepare('INSERT INTO suggestions (user_id, title, details) VALUES (?, ?, ?) RETURNING id')
    .bind(user.id, title, details).first();
  // Suggesters back their own idea.
  await db.prepare('INSERT INTO suggestion_votes (suggestion_id, user_id) VALUES (?, ?)').bind(row.id, user.id).run();
  return { suggestion: await suggestionChanged(db, row.id, user, emit) };
});

on('GET', '/api/suggestions/:id', async ({ db, user, params }) => {
  const [suggestion] = await serializeSuggestions(db, [await loadSuggestion(db, params)], user.id, { detail: true });
  return { suggestion };
});

on('PATCH', '/api/suggestions/:id', async ({ db, user, params, body, emit }) => {
  const s = await loadSuggestion(db, params);
  const isOwner = s.user_id === user.id;
  const isAdmin = user.role === 'admin';
  if (!isOwner && !isAdmin) throw new HttpError(403, 'Only the person who suggested this can edit it');
  const title = isOwner ? str(body.title ?? s.title, { max: 140, required: true, field: 'Suggestion' }) : s.title;
  const details = isOwner ? str(body.details ?? s.details, { max: 2000, field: 'Details' }) : s.details;
  let status = s.status;
  if (body.status !== undefined && body.status !== s.status) {
    if (!isAdmin) throw new HttpError(403, 'Only admins can change the status');
    if (!SUGGESTION_STATUSES.includes(body.status)) throw new HttpError(400, 'Unknown status');
    status = body.status;
  }
  await db.prepare('UPDATE suggestions SET title = ?, details = ?, status = ? WHERE id = ?').bind(title, details, status, s.id).run();
  return { suggestion: await suggestionChanged(db, s.id, user, emit) };
});

on('DELETE', '/api/suggestions/:id', async ({ db, user, params, emit }) => {
  const s = await loadSuggestion(db, params);
  if (s.user_id !== user.id && user.role !== 'admin') throw new HttpError(403, 'Only the person who suggested this can delete it');
  await db.prepare('DELETE FROM suggestions WHERE id = ?').bind(s.id).run();
  await suggestionChanged(db, s.id, user, emit);
  return { ok: true };
});

on('POST', '/api/suggestions/:id/vote', async ({ db, user, params, body, emit }) => {
  const s = await loadSuggestion(db, params);
  const stmt = body.vote === false
    ? 'DELETE FROM suggestion_votes WHERE suggestion_id = ? AND user_id = ?'
    : 'INSERT OR IGNORE INTO suggestion_votes (suggestion_id, user_id) VALUES (?, ?)';
  await db.prepare(stmt).bind(s.id, user.id).run();
  return { suggestion: await suggestionChanged(db, s.id, user, emit) };
});

on('POST', '/api/suggestions/:id/comments', async ({ db, user, params, body, emit }) => {
  const s = await loadSuggestion(db, params);
  const text = str(body.body, { max: 2000, required: true, field: 'Comment' });
  await db.prepare('INSERT INTO suggestion_comments (suggestion_id, user_id, body) VALUES (?, ?, ?)').bind(s.id, user.id, text).run();
  return { suggestion: await suggestionChanged(db, s.id, user, emit) };
});

// ----- what's working: case studies & blueprints -----

async function serializePlaybooks(db, rows, userId, { detail = false } = {}) {
  if (!rows.length) return [];
  const ids = JSON.stringify(rows.map((r) => r.id));
  const [votes, counts, comments] = await db.batch([
    db.prepare('SELECT playbook_id, user_id FROM playbook_votes WHERE playbook_id IN (SELECT value FROM json_each(?))').bind(ids),
    db.prepare(`SELECT playbook_id, COUNT(*) AS n FROM playbook_comments
      WHERE playbook_id IN (SELECT value FROM json_each(?)) GROUP BY playbook_id`).bind(ids),
    db.prepare(`SELECT * FROM playbook_comments WHERE ? AND playbook_id IN (SELECT value FROM json_each(?)) ORDER BY id`)
      .bind(detail ? 1 : 0, ids),
  ]);
  const countFor = new Map(counts.results.map((r) => [r.playbook_id, r.n]));
  return rows.map((p) => {
    const voters = votes.results.filter((v) => v.playbook_id === p.id).map((v) => v.user_id);
    const out = {
      id: p.id, userId: p.user_id, kind: p.kind, title: p.title, summary: p.summary,
      customer: p.customer, offer: p.offer, acquisition: p.acquisition, tools: p.tools,
      revenue: p.revenue, hoursPerWeek: p.hours_per_week, timeFreed: p.time_freed, steps: p.steps,
      createdAt: p.created_at, updatedAt: p.updated_at,
      votes: voters.length, voters, commentCount: countFor.get(p.id) ?? 0,
    };
    if (userId != null) out.voted = voters.includes(userId);
    if (detail) {
      out.comments = comments.results.filter((c) => c.playbook_id === p.id)
        .map((c) => ({ id: c.id, userId: c.user_id, body: c.body, createdAt: c.created_at }));
    }
    return out;
  });
}

function playbookFields(body, existing = {}) {
  const kind = body.kind ?? existing.kind ?? 'case';
  if (!PLAYBOOK_KINDS.includes(kind)) throw new HttpError(400, 'Unknown type');
  const revenue = body.revenue ?? existing.revenue ?? '';
  if (!REVENUE_RANGES.includes(revenue)) throw new HttpError(400, 'Unknown revenue range');
  const rawHours = body.hoursPerWeek ?? existing.hours_per_week;
  let hours = null;
  if (rawHours !== null && rawHours !== undefined && rawHours !== '') {
    hours = Number(rawHours);
    if (!Number.isInteger(hours) || hours < 0 || hours > 100) throw new HttpError(400, 'Hours per week must be a whole number from 0 to 100');
  }
  const text = (key, col, max, field) => str(body[key] ?? existing[col], { max, field });
  return {
    kind,
    title: str(body.title ?? existing.title, { max: 120, required: true, field: 'Title' }),
    summary: text('summary', 'summary', 2000, 'Summary'),
    customer: text('customer', 'customer', 300, 'Customer'),
    offer: text('offer', 'offer', 500, 'Offer'),
    acquisition: text('acquisition', 'acquisition', 500, 'How customers find you'),
    tools: text('tools', 'tools', 300, 'Tools'),
    revenue,
    hours_per_week: hours,
    time_freed: text('timeFreed', 'time_freed', 500, 'Time given back'),
    steps: text('steps', 'steps', 4000, 'Steps'),
  };
}

async function loadPlaybook(db, params) {
  const p = await db.prepare('SELECT * FROM playbooks WHERE id = ?').bind(intParam(params.id)).first();
  if (!p) throw new HttpError(404, 'Not found');
  return p;
}

async function playbookChanged(db, id, user, emit) {
  const row = await db.prepare('SELECT * FROM playbooks WHERE id = ?').bind(id).first();
  if (!row) {
    emit('playbook:changed', { id, deleted: true });
    return null;
  }
  const [detail] = await serializePlaybooks(db, [row], user.id, { detail: true });
  const { comments, voted, ...summary } = detail;
  emit('playbook:changed', summary);
  return detail;
}

on('GET', '/api/playbooks', async ({ db, user }) => ({
  playbooks: await serializePlaybooks(db, await all(db.prepare('SELECT * FROM playbooks ORDER BY updated_at DESC')), user.id),
}));

on('POST', '/api/playbooks', async ({ db, user, body, emit }) => {
  const f = playbookFields(body);
  const row = await db.prepare(`INSERT INTO playbooks (user_id, kind, title, summary, customer, offer, acquisition, tools,
    revenue, hours_per_week, time_freed, steps) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(user.id, f.kind, f.title, f.summary, f.customer, f.offer, f.acquisition, f.tools, f.revenue, f.hours_per_week, f.time_freed, f.steps)
    .first();
  return { playbook: await playbookChanged(db, row.id, user, emit) };
});

on('GET', '/api/playbooks/:id', async ({ db, user, params }) => {
  const [playbook] = await serializePlaybooks(db, [await loadPlaybook(db, params)], user.id, { detail: true });
  return { playbook };
});

on('PATCH', '/api/playbooks/:id', async ({ db, user, params, body, emit }) => {
  const p = await loadPlaybook(db, params);
  if (p.user_id !== user.id) throw new HttpError(403, 'Only the person who shared this can edit it');
  const f = playbookFields(body, p);
  await db.prepare(`UPDATE playbooks SET kind = ?, title = ?, summary = ?, customer = ?, offer = ?, acquisition = ?, tools = ?,
    revenue = ?, hours_per_week = ?, time_freed = ?, steps = ?, updated_at = ${NOW} WHERE id = ?`)
    .bind(f.kind, f.title, f.summary, f.customer, f.offer, f.acquisition, f.tools, f.revenue, f.hours_per_week, f.time_freed, f.steps, p.id)
    .run();
  return { playbook: await playbookChanged(db, p.id, user, emit) };
});

on('DELETE', '/api/playbooks/:id', async ({ db, user, params, emit }) => {
  const p = await loadPlaybook(db, params);
  if (p.user_id !== user.id && user.role !== 'admin') throw new HttpError(403, 'Only the person who shared this can delete it');
  await db.prepare('DELETE FROM playbooks WHERE id = ?').bind(p.id).run();
  await playbookChanged(db, p.id, user, emit);
  return { ok: true };
});

on('POST', '/api/playbooks/:id/vote', async ({ db, user, params, body, emit }) => {
  const p = await loadPlaybook(db, params);
  const stmt = body.vote === false
    ? 'DELETE FROM playbook_votes WHERE playbook_id = ? AND user_id = ?'
    : 'INSERT OR IGNORE INTO playbook_votes (playbook_id, user_id) VALUES (?, ?)';
  await db.prepare(stmt).bind(p.id, user.id).run();
  return { playbook: await playbookChanged(db, p.id, user, emit) };
});

on('POST', '/api/playbooks/:id/comments', async ({ db, user, params, body, emit }) => {
  const p = await loadPlaybook(db, params);
  const text = str(body.body, { max: 2000, required: true, field: 'Comment' });
  await db.prepare('INSERT INTO playbook_comments (playbook_id, user_id, body) VALUES (?, ?, ?)').bind(p.id, user.id, text).run();
  return { playbook: await playbookChanged(db, p.id, user, emit) };
});

// ----- calls -----

async function loadCall(db, params) {
  const c = await db.prepare('SELECT * FROM calls WHERE id = ?').bind(intParam(params.id)).first();
  if (!c) throw new HttpError(404, 'Call not found');
  return c;
}

async function callView(db, id) {
  const row = await db.prepare('SELECT * FROM calls WHERE id = ?').bind(id).first();
  return (await serializeCalls(db, [row]))[0];
}

on('GET', '/api/calls', async ({ db }) => {
  const calls = (await serializeCalls(db, await all(db.prepare('SELECT * FROM calls'))))
    .filter((c) => c.occurrences.length)
    .sort((a, b) => a.occurrences[0].startsAt.localeCompare(b.occurrences[0].startsAt));
  return { calls };
});

on('POST', '/api/calls', async ({ db, user, body, emit }) => {
  const f = callFields(body);
  const row = await db.prepare(`INSERT INTO calls
    (title, description, frequency, start_date, start_time, timezone, duration_min, link, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(f.title, f.description, f.frequency, f.start_date, f.start_time, f.timezone, f.duration_min, f.link, user.id).first();
  emit('calls:changed', null);
  return { call: await callView(db, row.id) };
}, { admin: true });

on('PATCH', '/api/calls/:id', async ({ db, params, body, emit }) => {
  const c = await loadCall(db, params);
  const f = callFields(body, c);
  await db.prepare(`UPDATE calls SET title = ?, description = ?, frequency = ?, start_date = ?, start_time = ?,
    timezone = ?, duration_min = ?, link = ? WHERE id = ?`)
    .bind(f.title, f.description, f.frequency, f.start_date, f.start_time, f.timezone, f.duration_min, f.link, c.id).run();
  emit('calls:changed', null);
  return { call: await callView(db, c.id) };
}, { admin: true });

on('DELETE', '/api/calls/:id', async ({ db, params, emit }) => {
  const c = await loadCall(db, params);
  await db.prepare('DELETE FROM calls WHERE id = ?').bind(c.id).run();
  emit('calls:changed', null);
  return { ok: true };
}, { admin: true });

on('POST', '/api/calls/:id/rsvp', async ({ db, user, params, body, emit }) => {
  const c = await loadCall(db, params);
  const occurrence = String(body.occurrence ?? '');
  if (!upcomingOccurrences(c).some((o) => o.occurrence === occurrence)) {
    throw new HttpError(400, 'That call date is not upcoming');
  }
  const stmt = body.going !== false
    ? 'INSERT OR IGNORE INTO call_rsvps (call_id, occurrence, user_id) VALUES (?, ?, ?)'
    : 'DELETE FROM call_rsvps WHERE call_id = ? AND occurrence = ? AND user_id = ?';
  await db.prepare(stmt).bind(c.id, occurrence, user.id).run();
  emit('calls:changed', null);
  return { call: await callView(db, c.id) };
});

// ---------- request handling ----------

const hub = (env) => env.HUB.get(env.HUB.idFromName('hub'));

async function userFromRequest(db, request) {
  const token = parseCookies(request.headers.get('Cookie') ?? '')[COOKIE];
  if (!token) return null;
  return db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').bind(token).first();
}

function sameOrigin(request, url) {
  const origin = request.headers.get('Origin');
  return !origin || origin === url.origin;
}

async function handleApi(request, env, ctx, url) {
  const db = env.DB;
  await ensureSchema(db);

  if (url.pathname === '/api/ws') {
    if (request.headers.get('Upgrade') !== 'websocket') throw new HttpError(426, 'Expected a WebSocket');
    if (!sameOrigin(request, url)) throw new HttpError(403, 'Forbidden');
    const user = await userFromRequest(db, request);
    if (!user) throw new HttpError(401, 'Please sign in');
    const headers = new Headers(request.headers);
    headers.set('X-User-Id', String(user.id));
    return hub(env).fetch(request.url, { headers });
  }

  let route;
  let params;
  for (const r of routes) {
    if (r.method !== request.method) continue;
    const match = r.re.exec(url.pathname);
    if (match) {
      route = r;
      params = match.groups ?? {};
      break;
    }
  }
  if (!route) throw new HttpError(404, 'Not found');

  let body = {};
  if (request.method !== 'GET') {
    // Requiring JSON (plus SameSite cookies) blocks cross-site form posts.
    if (!sameOrigin(request, url)) throw new HttpError(403, 'Forbidden');
    const text = await request.text();
    if (text) {
      if (!(request.headers.get('Content-Type') ?? '').includes('application/json')) {
        throw new HttpError(415, 'Expected JSON');
      }
      try {
        body = JSON.parse(text) ?? {};
      } catch {
        throw new HttpError(400, 'Invalid JSON');
      }
    }
  }

  let user = null;
  if (route.auth) {
    user = await userFromRequest(db, request);
    if (!user) throw new HttpError(401, 'Please sign in');
    if (route.admin && user.role !== 'admin') throw new HttpError(403, 'Only admins can do that');
  }

  const cookies = [];
  const emit = (event, data, userIds = null) => ctx.waitUntil(hub(env).broadcast(event, data, userIds));
  const result = await route.handler({
    request, env, url, db, user, params, body, emit, setCookie: (c) => cookies.push(c),
    waitUntil: (promise) => ctx.waitUntil(promise.catch((err) => console.error(err))),
  });
  const response = result instanceof Response ? result : Response.json(result);
  for (const c of cookies) response.headers.append('Set-Cookie', c);
  return response;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env, ctx, url);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error(err);
      return Response.json({ error: status >= 500 ? 'Something went wrong' : err.message }, { status });
    }
  },
};
