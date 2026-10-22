import { DurableObject } from 'cloudflare:workers';

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
    server.serializeAttachment({ userId });
    if (!wasOnline) this.send(null, 'presence', { userId, online: true });
    return new Response(null, { status: 101, webSocket: client });
  }

  // RPC: send an event to everyone (userIds = null) or to specific members.
  broadcast(event, data, userIds = null) {
    this.send(userIds, event, data);
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
