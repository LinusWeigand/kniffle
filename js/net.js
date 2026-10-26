// Peer-to-peer transport over PeerJS (global `Peer` from vendor/peerjs.min.js).
// The host's browser owns the game under a well-known peer id; guests connect straight to it.
// Both sides ping every few seconds so dead links (locked phones, flaky Wi-Fi) are noticed and healed.

const PREFIX = 'kniffel-lw-';
const PEER_OPTIONS = { debug: 0 };
const PING_EVERY = 4000;
const DEAD_AFTER = 15000;
const RECOVERABLE = ['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected'];

const peerIdFor = (code) => PREFIX + code.toLowerCase();

export function makeCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function send(conn, msg) {
  try { if (conn?.open) conn.send(msg); } catch {}
}

// Marks the link alive on any inbound traffic, answers pings, and hands real messages on.
function wire(conn, onMessage) {
  conn.on('data', (msg) => {
    conn.pingedAt = 0;
    if (msg?.t === 'ping') return send(conn, { t: 'pong' });
    if (msg?.t === 'pong') return;
    onMessage(msg);
  });
}

// True when a ping went unanswered for too long; otherwise sends the next ping.
function pingIsDead(conn) {
  if (conn.pingedAt && Date.now() - conn.pingedAt > DEAD_AFTER) return true;
  if (!conn.pingedAt) conn.pingedAt = Date.now();
  send(conn, { t: 'ping' });
  return false;
}

export class HostNet {
  constructor(code, { onStatus, onMessage, onClose }) {
    this.code = code;
    this.handlers = { onStatus, onMessage, onClose };
    this.conns = new Set();
    this.claimAttempts = 0;
    this.openPeer();
    this.pinger = setInterval(() => this.heartbeat(), PING_EVERY);
  }

  openPeer() {
    if (this.closed) return;
    this.peer?.destroy();
    const peer = (this.peer = new Peer(peerIdFor(this.code), PEER_OPTIONS));
    peer.on('open', () => {
      this.claimAttempts = 0;
      this.handlers.onStatus('online');
    });
    peer.on('connection', (conn) => this.accept(conn));
    peer.on('disconnected', () => {
      this.handlers.onStatus('reconnecting');
      setTimeout(() => this.revive(), 1500);
    });
    peer.on('error', (err) => {
      // After a reload the signalling server can hold our old id for a few seconds.
      if (err.type === 'unavailable-id' && this.claimAttempts++ < 20) {
        this.handlers.onStatus('reconnecting');
        setTimeout(() => this.openPeer(), 2000);
      } else if (RECOVERABLE.includes(err.type)) {
        this.handlers.onStatus('reconnecting');
        setTimeout(() => this.revive(), 3000);
      } else {
        this.handlers.onStatus('error', err);
      }
    });
  }

  revive() {
    if (this.closed) return;
    if (this.peer.destroyed) this.openPeer();
    else if (this.peer.disconnected) this.peer.reconnect();
  }

  accept(conn) {
    wire(conn, (msg) => this.handlers.onMessage(conn, msg));
    conn.on('open', () => this.conns.add(conn));
    conn.on('close', () => this.drop(conn));
    conn.on('error', () => this.drop(conn));
  }

  drop(conn) {
    if (!this.conns.delete(conn)) return;
    try { conn.close(); } catch {}
    this.handlers.onClose(conn);
  }

  heartbeat() {
    for (const conn of this.conns) if (pingIsDead(conn)) this.drop(conn);
    if (!this.closed && (this.peer.destroyed || this.peer.disconnected)) this.revive();
  }

  sendTo(conn, msg) { send(conn, msg); }

  broadcast(msg) {
    for (const conn of this.conns) if (conn.pid) send(conn, msg);
  }

  close() {
    this.broadcast({ t: 'closed' });
    this.closed = true;
    clearInterval(this.pinger);
    setTimeout(() => this.peer.destroy(), 300);
  }
}

export class GuestNet {
  constructor(code, hello, { onStatus, onMessage }) {
    this.code = code;
    this.hello = hello;
    this.handlers = { onStatus, onMessage };
    this.openPeer();
    this.pinger = setInterval(() => this.heartbeat(), PING_EVERY);
    this.onVisible = () => {
      if (document.visibilityState === 'visible' && !this.conn?.open) this.retry(0);
    };
    document.addEventListener('visibilitychange', this.onVisible);
  }

  openPeer() {
    if (this.closed) return;
    this.peer?.destroy();
    const peer = (this.peer = new Peer(PEER_OPTIONS));
    peer.on('open', () => this.connect());
    peer.on('disconnected', () => setTimeout(() => this.retry(0), 1500));
    peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') {
        this.handlers.onStatus('host-offline');
        this.retry(3000);
      } else if (RECOVERABLE.includes(err.type)) {
        this.handlers.onStatus('reconnecting');
        this.retry(3000);
      } else {
        this.handlers.onStatus('error', err);
      }
    });
  }

  connect() {
    if (this.closed) return;
    if (this.peer.destroyed) return this.openPeer();
    if (this.peer.disconnected) return this.peer.reconnect(); // 'open' fires again and calls connect()

    const old = this.conn;
    this.conn = null;
    try { old?.close(); } catch {}

    const conn = (this.conn = this.peer.connect(peerIdFor(this.code), { reliable: true, serialization: 'json' }));
    clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => {
      if (this.conn === conn && !conn.open) this.retry(0);
    }, 10000);

    wire(conn, (msg) => this.conn === conn && this.handlers.onMessage(msg));
    conn.on('open', () => {
      clearTimeout(this.connectTimer);
      conn.pingedAt = 0;
      send(conn, { t: 'hello', ...this.hello });
    });
    const lost = () => {
      if (this.conn !== conn || this.closed) return;
      this.handlers.onStatus('reconnecting');
      this.retry(1500);
    };
    conn.on('close', lost);
    conn.on('error', lost);
  }

  retry(ms) {
    if (this.closed) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), ms);
  }

  heartbeat() {
    if (this.conn?.open && pingIsDead(this.conn)) {
      this.handlers.onStatus('reconnecting');
      this.retry(0);
    }
  }

  send(msg) { send(this.conn, msg); }

  close() {
    this.closed = true;
    clearInterval(this.pinger);
    clearTimeout(this.retryTimer);
    clearTimeout(this.connectTimer);
    document.removeEventListener('visibilitychange', this.onVisible);
    this.peer?.destroy();
  }
}
