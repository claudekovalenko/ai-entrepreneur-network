import { ensureSchema } from './schema.js';
import { hashPassword, randomToken, verifyPassword } from './password.js';
import { FREQUENCIES, isValidTimeZone, upcomingOccurrences } from './schedule.js';

export { Hub } from './hub.js';

const COOKIE = 'aen_session';
const SESSION_MAX_AGE = 60 * 60 * 24 * 60;
const REACTIONS = ['🙏', '🔥', '❤️', '🙌', '💡', '😂'];
const PROJECT_STATUSES = ['looking', 'in-progress', 'launched', 'paused'];
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

on('GET', '/api/config', ({ env }) => ({ inviteRequired: Boolean(env.INVITE_CODE), reactions: REACTIONS }), { auth: false });

on('POST', '/api/auth/register', async ({ db, env, body, emit, setCookie }) => {
  const email = str(body.email, { max: 200, required: true, field: 'Email' }).toLowerCase();
  const name = str(body.name, { max: 80, required: true, field: 'Name' });
  const password = typeof body.password === 'string' ? body.password : '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Enter a valid email');
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (env.INVITE_CODE && body.inviteCode !== env.INVITE_CODE) throw new HttpError(403, 'That invite code is not valid');
  if (await db.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first()) {
    throw new HttpError(409, 'An account with that email already exists');
  }
  const hash = await hashPassword(password);
  // The very first member becomes the admin.
  const user = await db.prepare(`INSERT INTO users (email, password_hash, name, role)
    VALUES (?1, ?2, ?3, CASE WHEN EXISTS (SELECT 1 FROM users) THEN 'member' ELSE 'admin' END) RETURNING *`)
    .bind(email, hash, name).first();
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

on('POST', '/api/rooms/:room/messages', async ({ db, user, params, body, emit }) => {
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
  });
  const response = Response.json(result);
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
