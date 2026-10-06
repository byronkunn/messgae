import { WebSocketServer } from 'ws';
import { config } from '../config.js';

/**
 * WebSocket hub for live events (new messages, edits, reactions, typing, notifications).
 * Sockets authenticate with the same HttpOnly session cookie as the REST API and
 * must come from an allowed Origin (prevents cross-site WebSocket hijacking).
 */
export class Hub {
  constructor() {
    this.byUser = new Map(); // userId -> Set<ws>
    this.handlers = new Map();
  }

  attach(server, authenticate) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    server.on('upgrade', (req, socket, head) => {
      if (!req.url.startsWith('/ws')) return socket.destroy();
      const origin = req.headers.origin;
      if (origin && !config.allowedOrigins.includes(origin) && origin !== config.publicOrigin) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        return socket.destroy();
      }
      const auth = authenticate(req);
      if (!auth) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return socket.destroy();
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.#register(ws, auth));
    });
  }

  #register(ws, { user, session }) {
    ws.userId = user.id;
    ws.sessionId = session.id;
    ws.isAlive = true;
    let set = this.byUser.get(user.id);
    const wasOffline = !set || set.size === 0;
    if (!set) this.byUser.set(user.id, (set = new Set()));
    set.add(ws);
    if (wasOffline) this.emit('presence', { userId: user.id, online: true });
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const handler = this.handlers.get(msg?.type);
      if (handler) {
        try {
          handler(ws, msg);
        } catch {
          /* ignore malformed client events */
        }
      }
    });
    ws.on('close', () => {
      set.delete(ws);
      if (set.size === 0) {
        this.byUser.delete(user.id);
        this.emit('presence', { userId: user.id, online: false });
      }
    });
    ws.send(JSON.stringify({ type: 'hello', userId: user.id }));
  }

  startHeartbeat() {
    this.heartbeat = setInterval(() => {
      for (const set of this.byUser.values()) {
        for (const ws of set) {
          if (!ws.isAlive) {
            ws.terminate();
            continue;
          }
          ws.isAlive = false;
          ws.ping();
        }
      }
    }, 30_000);
    this.heartbeat.unref?.();
  }

  on(type, fn) {
    this.handlers.set(type, fn);
  }

  emit(type, data) {
    this.handlers.get(`internal:${type}`)?.(data);
  }

  isOnline(userId) {
    return (this.byUser.get(userId)?.size || 0) > 0;
  }

  onlineUserIds() {
    return [...this.byUser.keys()];
  }

  toUser(userId, event) {
    const set = this.byUser.get(userId);
    if (!set) return;
    const data = JSON.stringify(event);
    for (const ws of set) if (ws.readyState === 1) ws.send(data);
  }

  toUsers(userIds, event) {
    for (const id of new Set(userIds)) this.toUser(id, event);
  }

  closeSession(sessionId) {
    for (const set of this.byUser.values()) {
      for (const ws of set) if (ws.sessionId === sessionId) ws.close(4001, 'Session revoked');
    }
  }

  closeUser(userId) {
    for (const ws of this.byUser.get(userId) || []) ws.close(4001, 'Signed out');
  }

  close() {
    clearInterval(this.heartbeat);
    this.wss?.close();
  }
}
