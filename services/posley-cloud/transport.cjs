#!/usr/bin/env node
/**
 * transport.cjs — one interface over the two market-data WebSockets.
 *
 *   office : ws://192.168.50.112:8787/ws   raw WebSocket, NO auth, LAN/WireGuard only
 *   remote : https://redis-data.posley.capital   Socket.IO, Cognito ID token required
 *
 * A dashboard deployed in the office should not have to care which one it got, so both
 * are normalised to the REMOTE event shape:
 *
 *     { streamKey, region, entries: [{ id, data }], sentAt }
 *
 * (A single office entry is a one-element batch, so existing consumers written against
 * the gateway — dashboard-ui's hook, examples/btc-bid-ask — keep working unchanged.)
 *
 * Usage:
 *     const { createTransport } = require('./transport.cjs');
 *     const t = await createTransport();               // resolves office | remote
 *     t.on('data',   ({ streamKey, entries }) => …);
 *     t.on('status', ({ transport, state })  => …);
 *     await t.subscribe(['orderbook:binance:perp:BTCUSDT']);
 *
 * Selection order: opts.transport → MD_TRANSPORT env → probe the office relay's /health
 * (300 ms) → office if it answers, remote otherwise. The choice is logged, never silent.
 *
 * Office mode has ZERO dependencies (global WebSocket, Node 22+). socket.io-client is
 * required lazily inside the remote transport, so office mode runs with nothing installed.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const OFFICE_WS_URL = 'ws://192.168.50.112:8787/ws';
const OFFICE_HEALTH_URL = 'http://192.168.50.112:8787/health';
const REMOTE_URL = 'https://redis-data.posley.capital';
const DEFAULT_REGION = 'tokyo';
const PROBE_TIMEOUT_MS = 300;

/**
 * Key count an unfixed relay returns for any broad pattern. It reused
 * WS_RELAY_MAX_ACTIVE_STREAMS (50) as the scan limit and sent no `truncated` flag, so a
 * full page of exactly this many keys has to be assumed partial. A relay carrying the
 * flag is believed instead.
 */
const OFFICE_LEGACY_CAP = 50;

// ---------------------------------------------------------------------------
// transport resolution
// ---------------------------------------------------------------------------

/** Is the office relay answering right now? fetch first; WS fallback for CORS-blocked browsers. */
async function defaultProbe(healthUrl = OFFICE_HEALTH_URL, timeoutMs = PROBE_TIMEOUT_MS) {
  if (typeof fetch === 'function') {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(healthUrl, { signal: ctl.signal });
      if (res.ok) return true;
    } catch {
      // Unreachable, or a browser blocking the cross-origin fetch (the relay sends no
      // CORS headers). Fall through — the WebSocket itself is not subject to CORS.
    } finally {
      clearTimeout(timer);
    }
  }
  if (typeof WebSocket === 'undefined') return false;
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    let ws;
    try {
      ws = new WebSocket(healthUrl.replace(/^http/, 'ws').replace(/\/health$/, '/ws'));
    } catch {
      return finish(false);
    }
    ws.addEventListener('open', () => finish(true));
    ws.addEventListener('error', () => finish(false));
  });
}

async function resolveTransport({ transport, env = process.env, probe = defaultProbe } = {}) {
  const explicit = transport || env.MD_TRANSPORT;
  if (explicit) {
    const v = String(explicit).toLowerCase();
    if (v !== 'office' && v !== 'remote') {
      throw new Error(`MD_TRANSPORT must be "office" or "remote", got ${JSON.stringify(explicit)}`);
    }
    return v;
  }
  return (await probe()) ? 'office' : 'remote';
}

// ---------------------------------------------------------------------------
// shared bits
// ---------------------------------------------------------------------------

class Emitter {
  constructor() {
    this._handlers = {};
  }
  /** @param {'data'|'status'|'error'} event */
  on(event, fn) {
    (this._handlers[event] ||= []).push(fn);
    return this;
  }
  _emit(event, payload) {
    for (const fn of this._handlers[event] || []) {
      try {
        fn(payload);
      } catch (e) {
        if (event !== 'error') this._emit('error', e);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// office: raw WebSocket, no auth
// ---------------------------------------------------------------------------

class OfficeTransport extends Emitter {
  constructor({ url = OFFICE_WS_URL, wsFactory, logger = console.log, reconnectDelayMs = 1000 } = {}) {
    super();
    this.transport = 'office';
    this._url = url;
    this._wsFactory = wsFactory || ((u) => new WebSocket(u));
    this._log = logger;
    this._baseDelay = reconnectDelayMs;
    this._attempt = 0;
    this._desired = new Map(); // key -> snapshot, replayed on reconnect
    this._pendingSubs = []; // requested key arrays, matched against `subscribed` acks
    this._pendingLists = []; // resolvers awaiting a `streams` frame
    this._outbox = []; // frames queued while the socket is not open
    this._closed = false;
    this._timer = null;
    this._connect();
  }

  _connect() {
    this._ws = this._wsFactory(this._url);
    this._ws.addEventListener('open', () => {
      this._attempt = 0;
      this._emit('status', { transport: 'office', state: 'connected', detail: this._url });
      for (const frame of this._outbox.splice(0)) this._send(frame);
      // Re-establish subscriptions a dropped connection lost.
      const keys = [...this._desired.keys()];
      if (keys.length) this._send({ action: 'subscribe', keys });
    });
    this._ws.addEventListener('message', (ev) => this._onMessage(ev));
    this._ws.addEventListener('error', () => {
      this._emit('status', { transport: 'office', state: 'unreachable', detail: this._url });
    });
    this._ws.addEventListener('close', (ev) => {
      if (this._closed) return;
      this._emit('status', {
        transport: 'office',
        state: 'unreachable',
        detail: `closed (${(ev && ev.code) || '?'}) — retrying, will NOT fall back to remote`,
      });
      this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (this._closed || this._timer) return;
    const delay = Math.min(this._baseDelay * 2 ** this._attempt++, 30_000);
    this._timer = setTimeout(() => {
      this._timer = null;
      if (!this._closed) this._connect();
    }, delay);
    if (this._timer.unref) this._timer.unref();
  }

  _send(frame) {
    if (this._ws && this._ws.readyState === 1) this._ws.send(JSON.stringify(frame));
    else this._outbox.push(frame);
  }

  _onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(typeof ev === 'string' ? ev : ev.data);
    } catch (e) {
      return this._emit('error', new Error(`office: unparseable frame: ${e.message}`));
    }
    switch (msg.type) {
      case 'entry':
        // Normalise to the remote batch shape.
        this._emit('data', {
          streamKey: msg.key,
          region: 'office',
          entries: [{ id: msg.id, data: msg.fields }],
          sentAt: Date.now(),
        });
        break;
      case 'subscribed': {
        const requested = this._pendingSubs.shift() || [];
        const accepted = new Set(msg.keys || []);
        const rejected = requested.filter((k) => !accepted.has(k));
        if (rejected.length) {
          // The relay caps at 25 keys/conn and 50 active streams server-wide, and drops
          // the overflow from the ack. Surface it — a missing panel is otherwise silent.
          const err = new Error(
            `office: ${rejected.length} key(s) rejected (${rejected.join(', ')}) — ` +
              `active_streams=${msg.active_streams}/${msg.limit}`
          );
          err.rejected = rejected;
          this._emit('error', err);
        }
        break;
      }
      case 'streams': {
        const resolve = this._pendingLists.shift();
        if (!resolve) break;
        const keys = msg.keys || [];
        const truncated =
          typeof msg.truncated === 'boolean' ? msg.truncated : keys.length >= OFFICE_LEGACY_CAP;
        resolve({ keys, truncated });
        break;
      }
      case 'error':
        this._emit('error', Object.assign(new Error(`office: ${msg.message}`), { code: msg.code }));
        break;
      case 'unsubscribed':
      case 'pong':
        break;
      default:
        this._emit('error', new Error(`office: unknown frame type ${msg.type}`));
    }
  }

  async subscribe(keys, { snapshot } = {}) {
    const list = [].concat(keys);
    for (const k of list) this._desired.set(k, snapshot);
    this._pendingSubs.push(list);
    const frame = { action: 'subscribe', keys: list };
    if (snapshot != null) frame.snapshot = snapshot;
    this._send(frame);
  }

  async unsubscribe(keys) {
    const list = [].concat(keys);
    for (const k of list) this._desired.delete(k);
    this._send({ action: 'unsubscribe', keys: list });
  }

  /** @returns {Promise<{keys: string[], truncated: boolean}>} */
  listStreams(pattern) {
    return new Promise((resolve) => {
      this._pendingLists.push(resolve);
      const frame = { action: 'list' };
      if (pattern != null) frame.pattern = pattern;
      this._send(frame);
    });
  }

  close() {
    this._closed = true;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    try {
      this._ws.close();
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// remote: Socket.IO + Cognito ID token
// ---------------------------------------------------------------------------

function readToken({ idToken, env = process.env, tokenFile }) {
  if (idToken) return idToken;
  if (env.ID_TOKEN) return env.ID_TOKEN;
  const file = tokenFile || path.join(process.cwd(), 'id_token.txt');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t) return t;
  } catch {}
  return null;
}

class RemoteTransport extends Emitter {
  constructor({ url = REMOTE_URL, token, region = DEFAULT_REGION, ioFactory, logger = console.log }) {
    super();
    this.transport = 'remote';
    this._url = url;
    this._token = token;
    this._region = region;
    this._log = logger;
    this._desired = new Set();

    const factory =
      ioFactory ||
      ((u, o) => {
        let io;
        try {
          ({ io } = require('socket.io-client'));
        } catch {
          throw new Error(
            'remote transport needs socket.io-client — `npm i socket.io-client`, or set ' +
              'NODE_PATH to a node_modules that has it. (Office mode needs no packages.)'
          );
        }
        return io(u, o);
      });

    this._socket = factory(url, { auth: { token }, transports: ['websocket'] });
    this._socket.on('connect', () => {
      this._emit('status', { transport: 'remote', state: 'connected', detail: url });
      for (const k of this._desired) {
        this._socket.emit('stream:subscribe', { streamKey: k, region: this._region });
      }
    });
    this._socket.on('stream:data', (d) => this._emit('data', d)); // already canonical
    this._socket.on('stream:subscribed', (d) => {
      if (d && d.ok === false) {
        this._emit('error', new Error(`remote: subscribe rejected for ${d.streamKey}`));
      }
    });
    this._socket.on('disconnect', (reason) => {
      this._emit('status', { transport: 'remote', state: 'disconnected', detail: reason });
    });
    this._socket.on('connect_error', (e) => {
      this._emit('status', {
        transport: 'remote',
        state: 'unreachable',
        detail: `${e && e.message} — an immediate disconnect usually means an expired ID token`,
      });
    });
  }

  async subscribe(keys, _opts = {}) {
    for (const k of [].concat(keys)) {
      this._desired.add(k);
      this._socket.emit('stream:subscribe', { streamKey: k, region: this._region });
    }
  }

  async unsubscribe(keys) {
    for (const k of [].concat(keys)) {
      this._desired.delete(k);
      this._socket.emit('stream:unsubscribe', { streamKey: k, region: this._region });
    }
  }

  /** The gateway's REST listing is complete, so `truncated` is always false here. */
  async listStreams(pattern) {
    const res = await fetch(`${this._url}/redis/streams`, {
      headers: { Authorization: `Bearer ${this._token}` },
    });
    if (!res.ok) throw new Error(`remote: /redis/streams returned ${res.status}`);
    const body = await res.json();
    let keys = (body.streamKeys || []).map((s) => (typeof s === 'string' ? s : s.key));
    if (pattern) {
      const rx = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
      keys = keys.filter((k) => rx.test(k));
    }
    return { keys, truncated: false };
  }

  close() {
    try {
      this._socket.disconnect();
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

async function createTransport(opts = {}) {
  const { env = process.env, logger = console.log } = opts;
  const chosen = await resolveTransport({ transport: opts.transport, env, probe: opts.probe });

  if (chosen === 'office') {
    const url = opts.officeUrl || env.OFFICE_WS_URL || OFFICE_WS_URL;
    logger(`[transport] office relay ${url} (no auth)`);
    return new OfficeTransport({ ...opts, url, logger });
  }

  const token = readToken(opts);
  if (!token) {
    throw new Error(
      'remote transport needs a Cognito ID token: set ID_TOKEN, put one in ./id_token.txt ' +
        '(scripts/cognito-login.cjs), or pass { idToken }. In the office, set MD_TRANSPORT=office ' +
        'to use the relay instead — it needs no token.'
    );
  }
  const url = opts.remoteUrl || env.BACKEND_URL || REMOTE_URL;
  logger(`[transport] remote gateway ${url} (Cognito ID token)`);
  return new RemoteTransport({ ...opts, url, token, logger });
}

module.exports = {
  createTransport,
  resolveTransport,
  defaultProbe,
  OfficeTransport,
  RemoteTransport,
  OFFICE_WS_URL,
  OFFICE_HEALTH_URL,
  OFFICE_LEGACY_CAP,
  REMOTE_URL,
};

