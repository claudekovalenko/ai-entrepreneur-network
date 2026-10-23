import { DurableObject } from 'cloudflare:workers';
import { ensureSchema } from './schema.js';
import { sendPush } from './push.js';
import { upcomingOccurrences } from './schedule.js';

const REMINDER_LEAD_MS = 15 * 60_000;
const ALARM_EVERY_MS = 5 * 60_000;

// Sends one reminder per call occurrence, about 15 minutes before it starts.
async function sendCallReminders(env) {
  const db = env.DB;
  await ensureSchema(db);
  const now = Date.now();
  const { results: calls } = await db.prepare('SELECT * FROM calls').all();
  for (const call of calls) {
    const next = upcomingOccurrences(call, now, 1)[0];
    if (!next) continue;
    const startsIn = Date.parse(next.startsAt) - now;
    if (startsIn < 0 || startsIn > REMINDER_LEAD_MS) continue;
    const { meta } = await db.prepare('INSERT OR IGNORE INTO call_reminders (call_id, occurrence) VALUES (?, ?)')
      .bind(call.id, next.occurrence).run();
    if (!meta.changes) continue;
    const { results: people } = await db.prepare('SELECT DISTINCT user_id FROM push_subscriptions').all();
    const minutes = Math.max(1, Math.round(startsIn / 60_000));
    await sendPush(env, people.map((p) => p.user_id), {
      title: `${call.title} starts in ${minutes} min`,
      body: call.link ? 'Tap to open the call details and join.' : 'Tap to see the call details.',
      url: '/#/calls',
      tag: `call:${call.id}:${next.occurrence}`,
    });
  }
}

// A single Durable Object holds every member's WebSocket and fans out realtime
// events. It uses the hibernation API, so idle connections cost nothing.
export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Answer client keep-alives without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // Called by the Worker after it has authenticated the user.
  async fetch(request) {
    const userId = Number(request.headers.get('X-User-Id'));
    const { 0: client, 1: server } = new WebSocketPair();
    const wasOnline = this.socketsFor(userId).length > 0;
    this.ctx.acceptWebSocket(server, [`user:${userId}`]);
    server.serializeAttachment({ userId, active: true });
    // Keep the call-reminder check running once anyone has connected.
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + this.checkEvery());
    if (!wasOnline) this.send(null, 'presence', { userId, online: true });
    return new Response(null, { status: 101, webSocket: client });
  }

  // RPC: send an event to everyone (userIds = null) or to specific members.
  broadcast(event, data, userIds = null) {
    this.send(userIds, event, data);
  }

  // RPC: closes every connection of a removed member.
  disconnectUser(userId) {
    for (const ws of this.ctx.getWebSockets(`user:${userId}`)) {
      try {
        ws.close(4001, 'removed');
      } catch {
        // Already closed.
      }
    }
  }

  // RPC: members with the app open and visible right now (they don't need a push).
  activeUserIds() {
    const ids = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att?.userId && att.active && ws.readyState === WebSocket.OPEN) ids.add(att.userId);
    }
    return [...ids];
  }

  // How often to look for upcoming calls (tests shorten it).
  checkEvery() {
    return Number(this.env.REMINDER_CHECK_MS) || ALARM_EVERY_MS;
  }

  async alarm() {
    try {
      await sendCallReminders(this.env);
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + this.checkEvery());
    }
  }

  // RPC: the ids of members with at least one open connection.
  onlineUserIds() {
    const ids = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      const userId = ws.deserializeAttachment()?.userId;
      if (userId && ws.readyState === WebSocket.OPEN) ids.add(userId);
    }
    return [...ids];
  }

  async webSocketMessage(ws, message) {
    let parsed;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    // The app reports when it goes to the background or comes back.
    if (parsed?.type === 'active') {
      ws.serializeAttachment({ ...ws.deserializeAttachment(), active: parsed.active === true });
      return;
    }
    if (parsed?.type !== 'typing') return;
    const { userId } = ws.deserializeAttachment();
    const room = String(parsed.room);
    const match = /^([cd]):(\d+)$/.exec(room);
    if (!match) return;
    if (match[1] === 'c') return this.send(null, 'typing', { room, userId });
    const convo = await this.env.DB.prepare('SELECT user_a, user_b FROM conversations WHERE id = ?')
      .bind(Number(match[2])).first();
    if (convo && (convo.user_a === userId || convo.user_b === userId)) {
      this.send([convo.user_a, convo.user_b], 'typing', { room, userId });
    }
  }

  webSocketClose(ws, code) {
    this.handleGone(ws);
    try {
      ws.close(code, 'closing');
    } catch {
      // Already closed by the runtime.
    }
  }

  webSocketError(ws) {
    this.handleGone(ws);
  }

  handleGone(ws) {
    const userId = ws.deserializeAttachment()?.userId;
    if (userId && this.socketsFor(userId, ws).length === 0) {
      this.send(null, 'presence', { userId, online: false });
    }
  }

  socketsFor(userId, except) {
    return this.ctx.getWebSockets(`user:${userId}`)
      .filter((ws) => ws !== except && ws.readyState === WebSocket.OPEN);
  }

  send(userIds, event, data) {
    const payload = JSON.stringify({ event, data });
    const sockets = userIds
      ? [...new Set(userIds)].flatMap((id) => this.ctx.getWebSockets(`user:${id}`))
      : this.ctx.getWebSockets();
    for (const ws of sockets) {
      try {
        ws.send(payload);
      } catch {
        // Socket is closing; its close handler will clean up.
      }
    }
  }
}
