import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { Server as SocketServer } from 'socket.io';
import { tx } from './db.js';
import { FREQUENCIES, isValidTimeZone, upcomingOccurrences } from './schedule.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const COOKIE = 'aen_session';
const REACTIONS = ['🙏', '🔥', '❤️', '🙌', '💡', '😂'];
const PROJECT_STATUSES = ['looking', 'in-progress', 'launched', 'paused'];
const MAX_MESSAGE = 4000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

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

export function createApp({ db, inviteCode = '', secureCookies = false }) {
  const app = express();
  const server = http.createServer(app);
  const io = new SocketServer(server);
  const online = new Map(); // userId -> socket count

  app.use(express.json({ limit: '100kb' }));
  app.use(express.static(PUBLIC_DIR));

  // ---------- serializers ----------

  const publicUser = (u) => u && ({
    id: u.id, name: u.name, headline: u.headline, bio: u.bio,
    skills: u.skills, ministry: u.ministry, role: u.role, createdAt: u.created_at,
  });

  const reactionsFor = db.prepare('SELECT emoji, user_id FROM reactions WHERE message_id = ? ORDER BY rowid');
  function serializeMessage(m) {
    const grouped = new Map();
    for (const r of reactionsFor.all(m.id)) {
      if (!grouped.has(r.emoji)) grouped.set(r.emoji, []);
      grouped.get(r.emoji).push(r.user_id);
    }
    return {
      id: m.id,
      room: m.channel_id ? `c:${m.channel_id}` : `d:${m.conversation_id}`,
      userId: m.user_id,
      body: m.body,
      createdAt: m.created_at,
      editedAt: m.edited_at,
      reactions: [...grouped].map(([emoji, userIds]) => ({ emoji, userIds })),
    };
  }

  // ---------- auth ----------

  const getSession = db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?');
  const userFromCookie = (header) => {
    const token = parseCookies(header)[COOKIE];
    return token ? getSession.get(token) : undefined;
  };

  function startSession(res, userId) {
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
    res.cookie(COOKIE, token, {
      httpOnly: true, sameSite: 'lax', secure: secureCookies, maxAge: 1000 * 60 * 60 * 24 * 60,
    });
  }

  function requireUser(req, _res, next) {
    req.user = userFromCookie(req.headers.cookie);
    if (!req.user) return next(new HttpError(401, 'Please sign in'));
    next();
  }

  function requireAdmin(req, _res, next) {
    if (req.user.role !== 'admin') return next(new HttpError(403, 'Only admins can do that'));
    next();
  }

  const route = (fn) => (req, res, next) => {
    try {
      const result = fn(req, res);
      if (result !== undefined) res.json(result);
    } catch (err) {
      next(err);
    }
  };
  const asyncRoute = (fn) => (req, res, next) => fn(req, res).then((r) => r !== undefined && res.json(r), next);

  app.get('/api/config', (_req, res) => res.json({ inviteRequired: Boolean(inviteCode), reactions: REACTIONS }));

  app.post('/api/auth/register', asyncRoute(async (req, res) => {
    const email = str(req.body.email, { max: 200, required: true, field: 'Email' }).toLowerCase();
    const name = str(req.body.name, { max: 80, required: true, field: 'Name' });
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Enter a valid email');
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    if (inviteCode && req.body.inviteCode !== inviteCode) throw new HttpError(403, 'That invite code is not valid');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      throw new HttpError(409, 'An account with that email already exists');
    }
    const hash = await bcrypt.hash(password, 10);
    const user = tx(db, () => {
      const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
      const role = n === 0 ? 'admin' : 'member';
      const { lastInsertRowid } = db
        .prepare('INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)')
        .run(email, hash, name, role);
      return db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
    });
    startSession(res, user.id);
    io.to('members').emit('user:updated', publicUser(user));
    return { user: { ...publicUser(user), email: user.email } };
  }));

  app.post('/api/auth/login', asyncRoute(async (req, res) => {
    const email = str(req.body.email, { max: 200 }).toLowerCase();
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      throw new HttpError(401, 'Email or password is incorrect');
    }
    startSession(res, user.id);
    return { user: { ...publicUser(user), email: user.email } };
  }));

  app.post('/api/auth/logout', route((req, res) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    res.clearCookie(COOKIE);
    return { ok: true };
  }));

  app.use('/api', requireUser);

  // ---------- profile & members ----------

  app.get('/api/me', route((req) => ({ user: { ...publicUser(req.user), email: req.user.email } })));

  app.patch('/api/me', route((req) => {
    const b = req.body;
    const name = str(b.name ?? req.user.name, { max: 80, required: true, field: 'Name' });
    const fields = {
      headline: str(b.headline ?? req.user.headline, { max: 120, field: 'Headline' }),
      bio: str(b.bio ?? req.user.bio, { max: 1000, field: 'Bio' }),
      skills: str(b.skills ?? req.user.skills, { max: 300, field: 'Skills' }),
      ministry: str(b.ministry ?? req.user.ministry, { max: 300, field: 'Ministry' }),
    };
    db.prepare('UPDATE users SET name = ?, headline = ?, bio = ?, skills = ?, ministry = ? WHERE id = ?')
      .run(name, fields.headline, fields.bio, fields.skills, fields.ministry, req.user.id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    io.to('members').emit('user:updated', publicUser(user));
    return { user: { ...publicUser(user), email: user.email } };
  }));

  app.patch('/api/users/:id/role', requireAdmin, route((req) => {
    const id = intParam(req.params.id);
    const role = req.body.role === 'admin' ? 'admin' : 'member';
    if (id === req.user.id && role !== 'admin') throw new HttpError(400, 'You cannot remove your own admin role');
    const { changes } = db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    if (!changes) throw new HttpError(404, 'Member not found');
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    io.to('members').emit('user:updated', publicUser(user));
    return { user: publicUser(user) };
  }));

  // ---------- rooms: channels & direct messages ----------

  const unreadFor = db.prepare(`
    SELECT COUNT(*) AS n FROM messages m
    WHERE (m.channel_id = :channel OR m.conversation_id = :conversation)
      AND m.user_id != :user
      AND m.id > COALESCE((SELECT last_read_id FROM reads WHERE user_id = :user AND room = :room), 0)`);

  function listChannels(userId) {
    return db.prepare('SELECT * FROM channels ORDER BY id').all().map((c) => ({
      id: c.id, room: `c:${c.id}`, name: c.name, description: c.description,
      unread: unreadFor.get({ channel: c.id, conversation: null, user: userId, room: `c:${c.id}` }).n,
    }));
  }

  function serializeConversation(c, userId) {
    const last = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1').get(c.id);
    return {
      id: c.id, room: `d:${c.id}`,
      otherUserId: c.user_a === userId ? c.user_b : c.user_a,
      lastMessageAt: last?.created_at ?? c.created_at,
      unread: unreadFor.get({ channel: null, conversation: c.id, user: userId, room: `d:${c.id}` }).n,
    };
  }

  function listConversations(userId) {
    return db.prepare('SELECT * FROM conversations WHERE user_a = ? OR user_b = ?').all(userId, userId)
      .map((c) => serializeConversation(c, userId))
      .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
  }

  // Resolves 'c:1' / 'd:2' to a room the user may access.
  function resolveRoom(room, user) {
    const match = /^([cd]):(\d+)$/.exec(String(room));
    if (!match) throw new HttpError(404, 'Conversation not found');
    const id = Number(match[2]);
    if (match[1] === 'c') {
      const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
      if (!channel) throw new HttpError(404, 'Channel not found');
      return { kind: 'channel', id, room: `c:${id}`, column: 'channel_id' };
    }
    const convo = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    if (!convo || (convo.user_a !== user.id && convo.user_b !== user.id)) {
      throw new HttpError(404, 'Conversation not found');
    }
    return { kind: 'dm', id, room: `d:${id}`, column: 'conversation_id', convo };
  }

  function emitToRoom(target, event, payload) {
    if (target.kind === 'channel') io.to('members').emit(event, payload);
    else io.to(`user:${target.convo.user_a}`).to(`user:${target.convo.user_b}`).emit(event, payload);
  }

  app.get('/api/bootstrap', route((req) => ({
    user: { ...publicUser(req.user), email: req.user.email },
    users: db.prepare('SELECT * FROM users ORDER BY name COLLATE NOCASE').all().map(publicUser),
    channels: listChannels(req.user.id),
    conversations: listConversations(req.user.id),
    online: [...online.keys()],
    reactions: REACTIONS,
  })));

  app.post('/api/channels', requireAdmin, route((req) => {
    const name = str(req.body.name, { max: 40, required: true, field: 'Channel name' })
      .toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!name) throw new HttpError(400, 'Channel name must contain letters or numbers');
    const description = str(req.body.description, { max: 200, field: 'Description' });
    if (db.prepare('SELECT 1 FROM channels WHERE name = ?').get(name)) {
      throw new HttpError(409, 'A channel with that name already exists');
    }
    const { lastInsertRowid } = db.prepare('INSERT INTO channels (name, description, created_by) VALUES (?, ?, ?)')
      .run(name, description, req.user.id);
    const channel = { id: Number(lastInsertRowid), room: `c:${lastInsertRowid}`, name, description, unread: 0 };
    io.to('members').emit('channel:new', channel);
    return { channel };
  }));

  app.delete('/api/channels/:id', requireAdmin, route((req) => {
    const id = intParam(req.params.id);
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM channels').get();
    if (n <= 1) throw new HttpError(400, 'The network needs at least one channel');
    const { changes } = db.prepare('DELETE FROM channels WHERE id = ?').run(id);
    if (!changes) throw new HttpError(404, 'Channel not found');
    io.to('members').emit('channel:deleted', { room: `c:${id}` });
    return { ok: true };
  }));

  app.post('/api/conversations', route((req) => {
    const otherId = Number(req.body.userId);
    if (otherId === req.user.id) throw new HttpError(400, 'You cannot message yourself');
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(otherId)) throw new HttpError(404, 'Member not found');
    const [a, b] = [req.user.id, otherId].sort((x, y) => x - y);
    db.prepare('INSERT OR IGNORE INTO conversations (user_a, user_b) VALUES (?, ?)').run(a, b);
    const convo = db.prepare('SELECT * FROM conversations WHERE user_a = ? AND user_b = ?').get(a, b);
    return { conversation: serializeConversation(convo, req.user.id) };
  }));

  app.get('/api/rooms/:room/messages', route((req) => {
    const target = resolveRoom(req.params.room, req.user);
    const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
    const rows = db.prepare(
      `SELECT * FROM messages WHERE ${target.column} = ? AND id < ? ORDER BY id DESC LIMIT 50`,
    ).all(target.id, before);
    return { messages: rows.reverse().map(serializeMessage), hasMore: rows.length === 50 };
  }));

  app.post('/api/rooms/:room/messages', route((req) => {
    const target = resolveRoom(req.params.room, req.user);
    const body = str(req.body.body, { max: MAX_MESSAGE, required: true, field: 'Message' });
    const { lastInsertRowid } = db.prepare(`INSERT INTO messages (${target.column}, user_id, body) VALUES (?, ?, ?)`)
      .run(target.id, req.user.id, body);
    const id = Number(lastInsertRowid);
    markRead(req.user.id, target.room, id);
    const message = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(id));
    if (target.kind === 'dm') {
      // Make sure the recipient learns about a brand-new conversation.
      for (const uid of [target.convo.user_a, target.convo.user_b]) {
        io.to(`user:${uid}`).emit('conversation:upsert', serializeConversation(target.convo, uid));
      }
    }
    emitToRoom(target, 'message:new', message);
    return { message };
  }));

  function loadOwnMessage(req, { allowAdmin = false } = {}) {
    const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(intParam(req.params.id));
    if (!m) throw new HttpError(404, 'Message not found');
    const target = resolveRoom(m.channel_id ? `c:${m.channel_id}` : `d:${m.conversation_id}`, req.user);
    const isAdmin = allowAdmin && req.user.role === 'admin';
    return { m, target, isOwner: m.user_id === req.user.id, isAdmin };
  }

  app.patch('/api/messages/:id', route((req) => {
    const { m, target, isOwner } = loadOwnMessage(req);
    if (!isOwner) throw new HttpError(403, 'You can only edit your own messages');
    const body = str(req.body.body, { max: MAX_MESSAGE, required: true, field: 'Message' });
    db.prepare("UPDATE messages SET body = ?, edited_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .run(body, m.id);
    const message = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(m.id));
    emitToRoom(target, 'message:update', message);
    return { message };
  }));

  app.delete('/api/messages/:id', route((req) => {
    const { m, target, isOwner, isAdmin } = loadOwnMessage(req, { allowAdmin: true });
    if (!isOwner && !(isAdmin && target.kind === 'channel')) {
      throw new HttpError(403, 'You can only delete your own messages');
    }
    db.prepare('DELETE FROM messages WHERE id = ?').run(m.id);
    emitToRoom(target, 'message:delete', { id: m.id, room: target.room });
    return { ok: true };
  }));

  app.post('/api/messages/:id/reactions', route((req) => {
    const { m, target } = loadOwnMessage(req);
    const emoji = req.body.emoji;
    if (!REACTIONS.includes(emoji)) throw new HttpError(400, 'Unsupported reaction');
    const existing = db.prepare('SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
      .get(m.id, req.user.id, emoji);
    if (existing) {
      db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(m.id, req.user.id, emoji);
    } else {
      db.prepare('INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(m.id, req.user.id, emoji);
    }
    const message = serializeMessage(m);
    emitToRoom(target, 'message:update', message);
    return { message };
  }));

  function markRead(userId, room, lastReadId) {
    db.prepare(`INSERT INTO reads (user_id, room, last_read_id) VALUES (?, ?, ?)
      ON CONFLICT (user_id, room) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`)
      .run(userId, room, lastReadId);
  }

  app.post('/api/rooms/:room/read', route((req) => {
    const target = resolveRoom(req.params.room, req.user);
    const lastReadId = Number(req.body.lastReadId) || 0;
    markRead(req.user.id, target.room, lastReadId);
    return { ok: true };
  }));

  // ---------- projects ----------

  function serializeProject(p, { detail = false } = {}) {
    const helpers = db.prepare(
      'SELECT user_id, note, created_at FROM project_helpers WHERE project_id = ? ORDER BY created_at',
    ).all(p.id).map((h) => ({ userId: h.user_id, note: h.note, createdAt: h.created_at }));
    const { n: commentCount } = db.prepare('SELECT COUNT(*) AS n FROM project_comments WHERE project_id = ?').get(p.id);
    const out = {
      id: p.id, userId: p.user_id, title: p.title, description: p.description,
      helpNeeded: p.help_needed, tags: p.tags, status: p.status,
      createdAt: p.created_at, updatedAt: p.updated_at, helpers, commentCount,
    };
    if (detail) {
      out.comments = db.prepare('SELECT * FROM project_comments WHERE project_id = ? ORDER BY id').all(p.id)
        .map((c) => ({ id: c.id, userId: c.user_id, body: c.body, createdAt: c.created_at }));
    }
    return out;
  }

  function loadProject(req) {
    const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(intParam(req.params.id));
    if (!p) throw new HttpError(404, 'Project not found');
    return p;
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

  const emitProject = (id) => {
    const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    io.to('members').emit('project:changed', p ? serializeProject(p) : { id, deleted: true });
  };

  app.get('/api/projects', route(() => ({
    projects: db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all().map((p) => serializeProject(p)),
    statuses: PROJECT_STATUSES,
  })));

  app.post('/api/projects', route((req) => {
    const f = projectFields(req.body);
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO projects (user_id, title, description, help_needed, tags, status) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(req.user.id, f.title, f.description, f.help_needed, f.tags, f.status);
    emitProject(Number(lastInsertRowid));
    return { project: serializeProject(db.prepare('SELECT * FROM projects WHERE id = ?').get(lastInsertRowid)) };
  }));

  app.get('/api/projects/:id', route((req) => ({ project: serializeProject(loadProject(req), { detail: true }) })));

  app.patch('/api/projects/:id', route((req) => {
    const p = loadProject(req);
    if (p.user_id !== req.user.id) throw new HttpError(403, 'Only the project owner can edit it');
    const f = projectFields(req.body, p);
    db.prepare(`UPDATE projects SET title = ?, description = ?, help_needed = ?, tags = ?, status = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
      .run(f.title, f.description, f.help_needed, f.tags, f.status, p.id);
    emitProject(p.id);
    return { project: serializeProject(db.prepare('SELECT * FROM projects WHERE id = ?').get(p.id), { detail: true }) };
  }));

  app.delete('/api/projects/:id', route((req) => {
    const p = loadProject(req);
    if (p.user_id !== req.user.id && req.user.role !== 'admin') {
      throw new HttpError(403, 'Only the project owner can delete it');
    }
    db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
    emitProject(p.id);
    return { ok: true };
  }));

  app.post('/api/projects/:id/helpers', route((req) => {
    const p = loadProject(req);
    if (p.user_id === req.user.id) throw new HttpError(400, 'This is your project');
    const note = str(req.body.note, { max: 500, field: 'Note' });
    db.prepare(`INSERT INTO project_helpers (project_id, user_id, note) VALUES (?, ?, ?)
      ON CONFLICT (project_id, user_id) DO UPDATE SET note = excluded.note`).run(p.id, req.user.id, note);
    emitProject(p.id);
    return { project: serializeProject(p, { detail: true }) };
  }));

  app.delete('/api/projects/:id/helpers', route((req) => {
    const p = loadProject(req);
    db.prepare('DELETE FROM project_helpers WHERE project_id = ? AND user_id = ?').run(p.id, req.user.id);
    emitProject(p.id);
    return { project: serializeProject(p, { detail: true }) };
  }));

  app.post('/api/projects/:id/comments', route((req) => {
    const p = loadProject(req);
    const body = str(req.body.body, { max: 2000, required: true, field: 'Comment' });
    db.prepare('INSERT INTO project_comments (project_id, user_id, body) VALUES (?, ?, ?)').run(p.id, req.user.id, body);
    emitProject(p.id);
    return { project: serializeProject(p, { detail: true }) };
  }));

  // ---------- calls ----------

  function serializeCall(c) {
    const occurrences = upcomingOccurrences(c).map((o) => ({
      ...o,
      rsvps: db.prepare('SELECT user_id FROM call_rsvps WHERE call_id = ? AND occurrence = ?')
        .all(c.id, o.occurrence).map((r) => r.user_id),
    }));
    return {
      id: c.id, title: c.title, description: c.description, frequency: c.frequency,
      startDate: c.start_date, startTime: c.start_time, timezone: c.timezone,
      durationMin: c.duration_min, link: c.link, occurrences,
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

  const loadCall = (req) => {
    const c = db.prepare('SELECT * FROM calls WHERE id = ?').get(intParam(req.params.id));
    if (!c) throw new HttpError(404, 'Call not found');
    return c;
  };
  const emitCalls = () => io.to('members').emit('calls:changed');

  app.get('/api/calls', route(() => {
    const calls = db.prepare('SELECT * FROM calls').all().map(serializeCall)
      .filter((c) => c.occurrences.length)
      .sort((a, b) => a.occurrences[0].startsAt.localeCompare(b.occurrences[0].startsAt));
    return { calls };
  }));

  app.post('/api/calls', requireAdmin, route((req) => {
    const f = callFields(req.body);
    const { lastInsertRowid } = db.prepare(`INSERT INTO calls
      (title, description, frequency, start_date, start_time, timezone, duration_min, link, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(f.title, f.description, f.frequency, f.start_date, f.start_time, f.timezone, f.duration_min, f.link, req.user.id);
    emitCalls();
    return { call: serializeCall(db.prepare('SELECT * FROM calls WHERE id = ?').get(lastInsertRowid)) };
  }));

  app.patch('/api/calls/:id', requireAdmin, route((req) => {
    const c = loadCall(req);
    const f = callFields(req.body, c);
    db.prepare(`UPDATE calls SET title = ?, description = ?, frequency = ?, start_date = ?, start_time = ?,
      timezone = ?, duration_min = ?, link = ? WHERE id = ?`)
      .run(f.title, f.description, f.frequency, f.start_date, f.start_time, f.timezone, f.duration_min, f.link, c.id);
    emitCalls();
    return { call: serializeCall(db.prepare('SELECT * FROM calls WHERE id = ?').get(c.id)) };
  }));

  app.delete('/api/calls/:id', requireAdmin, route((req) => {
    db.prepare('DELETE FROM calls WHERE id = ?').run(loadCall(req).id);
    emitCalls();
    return { ok: true };
  }));

  app.post('/api/calls/:id/rsvp', route((req) => {
    const c = loadCall(req);
    const occurrence = String(req.body.occurrence ?? '');
    if (!upcomingOccurrences(c).some((o) => o.occurrence === occurrence)) {
      throw new HttpError(400, 'That call date is not upcoming');
    }
    const going = req.body.going !== false;
    if (going) {
      db.prepare('INSERT OR IGNORE INTO call_rsvps (call_id, occurrence, user_id) VALUES (?, ?, ?)')
        .run(c.id, occurrence, req.user.id);
    } else {
      db.prepare('DELETE FROM call_rsvps WHERE call_id = ? AND occurrence = ? AND user_id = ?')
        .run(c.id, occurrence, req.user.id);
    }
    emitCalls();
    return { call: serializeCall(c) };
  }));

  // ---------- errors & SPA fallback ----------

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));
  app.get('*', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

  app.use((err, _req, res, _next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong' : err.message });
  });

  // ---------- realtime ----------

  io.use((socket, next) => {
    const user = userFromCookie(socket.handshake.headers.cookie);
    if (!user) return next(new Error('unauthorized'));
    socket.data.userId = user.id;
    next();
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId;
    socket.join('members');
    socket.join(`user:${userId}`);
    online.set(userId, (online.get(userId) || 0) + 1);
    if (online.get(userId) === 1) io.to('members').emit('presence', { userId, online: true });

    socket.on('typing', (room) => {
      try {
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
        if (!user) return;
        emitToRoom(resolveRoom(room, user), 'typing', { room, userId });
      } catch {
        // Ignore typing pings for rooms the user cannot see.
      }
    });

    socket.on('disconnect', () => {
      const count = (online.get(userId) || 1) - 1;
      if (count > 0) return online.set(userId, count);
      online.delete(userId);
      io.to('members').emit('presence', { userId, online: false });
    });
  });

  return { app, server, io };
}
