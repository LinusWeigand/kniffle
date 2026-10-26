// Relay transport over a public MQTT broker (global `mqtt` from vendor/mqtt.min.js).
// The host's browser owns the game; guests reach it through per-room topics over secure WebSockets,
// so it works on any network without NAT traversal. The latest state is retained on the broker,
// which lets a reloading guest see the board instantly.

const BROKER = 'wss://broker.hivemq.com:8884/mqtt';
const ROOT = 'kniffel-lw/v1/';
const GUEST_PING_EVERY = 20000;

function topicsFor(code) {
  const base = ROOT + code;
  return {
    host: `${base}/host`, // guests -> host
    guests: `${base}/guests`, // host -> guests (non-state messages)
    state: `${base}/state`, // host -> guests, retained
    presence: `${base}/presence`, // host online flag, retained, cleared by its last will
  };
}

export function makeCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

const encode = (msg) => JSON.stringify(msg);
const decoder = new TextDecoder();
function decode(payload) {
  try { return payload.length ? JSON.parse(decoder.decode(payload)) : null; } catch { return null; }
}

function openClient(will, onStatus) {
  const client = mqtt.connect(BROKER, {
    clean: true,
    keepalive: 30,
    reconnectPeriod: 2000,
    connectTimeout: 10000,
    will: { ...will, payload: encode(will.payload) },
  });
  client.on('reconnect', () => onStatus('reconnecting'));
  client.on('offline', () => onStatus('reconnecting'));
  client.on('error', () => onStatus('reconnecting'));
  return client;
}

export class HostNet {
  constructor(code, { onStatus, onMessage }) {
    this.topics = topicsFor(code);
    this.client = openClient({ topic: this.topics.presence, payload: { online: false }, qos: 1, retain: true }, onStatus);
    this.client.on('connect', () => {
      this.client.subscribe(this.topics.host, { qos: 1 });
      this.client.publish(this.topics.presence, encode({ online: true }), { qos: 1, retain: true });
      if (this.state) this.publishState(this.state);
      onStatus('online');
    });
    this.client.on('message', (_topic, payload) => {
      const msg = decode(payload);
      if (msg && typeof msg.pid === 'string') onMessage(msg);
    });
  }

  publishState(state) {
    this.state = state;
    this.client.publish(this.topics.state, encode({ t: 'state', state }), { qos: 1, retain: true });
  }

  sendTo(pid, msg) {
    this.client.publish(this.topics.guests, encode({ ...msg, to: pid }), { qos: 1 });
  }

  close() {
    this.client.publish(this.topics.guests, encode({ t: 'closed' }), { qos: 1 });
    this.client.publish(this.topics.state, '', { qos: 1, retain: true });
    this.client.publish(this.topics.presence, '', { qos: 1, retain: true });
    this.client.end(false);
  }
}

export class GuestNet {
  constructor(code, hello, { onStatus, onMessage }) {
    this.topics = topicsFor(code);
    this.pid = hello.pid;
    this.client = openClient({ topic: this.topics.host, payload: { t: 'bye', pid: hello.pid }, qos: 1, retain: false }, onStatus);
    this.client.on('connect', () => {
      this.client.subscribe([this.topics.state, this.topics.guests, this.topics.presence], { qos: 1 });
      this.send({ t: 'hello', name: hello.name });
      // No retained presence at all means nobody has ever hosted this room (or it was closed).
      clearTimeout(this.presenceTimer);
      this.presenceTimer = setTimeout(() => { if (!this.sawPresence) onStatus('host-offline'); }, 6000);
    });
    this.client.on('message', (topic, payload) => {
      const msg = decode(payload);
      if (topic === this.topics.presence) {
        this.sawPresence = true;
        onStatus(msg?.online ? 'online' : 'host-offline');
      } else if (msg && !(msg.to && msg.to !== this.pid)) {
        onMessage(msg);
      }
    });
    this.pinger = setInterval(() => this.send({ t: 'ping' }), GUEST_PING_EVERY);
  }

  send(msg) {
    if (this.client.connected) this.client.publish(this.topics.host, encode({ ...msg, pid: this.pid }), { qos: 1 });
  }

  close() {
    clearInterval(this.pinger);
    clearTimeout(this.presenceTimer);
    this.send({ t: 'bye' });
    this.client.end(false);
  }
}
