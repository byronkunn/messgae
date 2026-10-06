/** WebSocket client with automatic reconnect and a simple pub/sub bus. */
const bus = new EventTarget();
let ws = null;
let retry = 0;
let stopped = true;
let timer = null;

function connect() {
  if (stopped) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    retry = 0;
    bus.dispatchEvent(new CustomEvent('status', { detail: { connected: true } }));
  };
  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    bus.dispatchEvent(new CustomEvent('event', { detail: msg }));
  };
  ws.onclose = (e) => {
    bus.dispatchEvent(new CustomEvent('status', { detail: { connected: false, code: e.code } }));
    if (stopped) return;
    if (e.code === 4001) bus.dispatchEvent(new CustomEvent('event', { detail: { type: 'session:revoked' } }));
    const delay = Math.min(30_000, 1000 * 2 ** retry++) + Math.random() * 500;
    timer = setTimeout(connect, delay);
  };
}

export const realtime = {
  start() {
    if (!stopped) return;
    stopped = false;
    connect();
  },
  stop() {
    stopped = true;
    clearTimeout(timer);
    ws?.close();
    ws = null;
  },
  send(msg) {
    if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
  },
  subscribe(fn) {
    const h = (e) => fn(e.detail);
    bus.addEventListener('event', h);
    return () => bus.removeEventListener('event', h);
  },
  onStatus(fn) {
    const h = (e) => fn(e.detail);
    bus.addEventListener('status', h);
    return () => bus.removeEventListener('status', h);
  },
};
