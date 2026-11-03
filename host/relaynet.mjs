// relaynet.js: a reconnecting transport for the relaynet relay.v1 protocol.
//
// It owns the WebSocket and nothing else: frames go to and from your TCP/IP
// stack unchanged. What it adds is the session lifecycle a page has to get
// right anyway: a heartbeat that notices a dead socket after sleep or a
// network change, reconnecting with backoff, waking up on visibility and
// network events, telling final closes (revoked token, quota) from
// transient ones, and dropping frames instead of queueing them while
// disconnected (TCP retransmits; stale frames only confuse the stack).
//
// Each reconnect is a new relay session. Its TCP connections to the internet
// are gone; the address is kept if the stack reconnects within the relay's
// hold (60 s) with the same MAC or keeps sending from its old address.
// onOpen({ reconnect: true }) is where the app restarts what depended on
// the old session.
//
// Works in browsers and in Node 22+ (global WebSocket), no dependencies.
// https://relaynet.network/docs#when-a-session-drops

export const RELAY_URL = "wss://relay.relaynet.network/";
export const SUBPROTOCOL = "relay.v1";

const OPEN = 1;
// A session must stay open this long before backoff starts over, so a relay
// that accepts and immediately closes does not cause a tight loop.
const STABLE_SESSION_MS = 10000;
// After a deploy (1001) the relay is back within seconds.
const RESTART_DELAY_MS = 2000;
// Events after which a session may have died unnoticed or a dead network
// may be back: on window, and on document (Page Lifecycle).
const WINDOW_WAKE_EVENTS = ["online", "pageshow"];
const DOCUMENT_WAKE_EVENTS = ["visibilitychange", "resume"];

// What to do after the relay closes an open session: "final" stops,
// "restart" reconnects soon, "retry" reconnects with backoff.
export function classifyClose(code, reason) {
  if (code === 1008) return "final"; // revoked, suspended, deleted, quota, operator
  if (code === 1000 && reason === "idle timeout") return "final";
  if (code === 1000 && reason === "session expired") return "restart";
  if (code === 1001) return "restart";
  return "retry";
}

export function connectRelay(options) {
  return new RelayConnection(options);
}

export class RelayConnection {
  constructor({
    token,
    url = RELAY_URL,
    onFrame = () => {},
    onOpen = () => {},
    onClose = () => {},
    onStateChange = () => {},
    heartbeatMs = 20000,
    heartbeatTimeoutMs = 10000,
    initialBackoffMs = 1000,
    maxBackoffMs = 60000,
    maxBufferedBytes = 1024 * 1024,
    checkToken = true,
    WebSocket: WebSocketImpl = globalThis.WebSocket,
    fetch: fetchImpl = globalThis.fetch,
    window: win = globalThis.document ? globalThis : null,
  } = {}) {
    if (!WebSocketImpl) throw new Error("relaynet: no WebSocket implementation; pass one as options.WebSocket");
    this.url = url;
    this.token = token;
    this.handlers = { onFrame, onOpen, onClose, onStateChange };
    this.heartbeatMs = heartbeatMs;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.initialBackoffMs = initialBackoffMs;
    this.maxBackoffMs = maxBackoffMs;
    this.maxBufferedBytes = maxBufferedBytes;
    this.checkToken = checkToken && typeof fetchImpl === "function" && Boolean(token);
    this.WebSocket = WebSocketImpl;
    this.fetch = fetchImpl;
    this.window = win;

    this.state = "idle";
    this.ws = null;
    this.sessions = 0; // sessions opened so far
    this.failures = 0; // consecutive attempts that did not last
    this.openedAt = 0;
    this.retryTimer = null;
    this.heartbeatTimer = null;
    this.probeTimer = null;
    this.probeSentAt = 0;
    this.lastTick = 0;
    this.lastReceived = 0;
    this.stats = { framesSent: 0, framesReceived: 0, framesDropped: 0, reconnects: 0 };

    this.onPageHide = () => this.suspend();
    this.onWake = (event) => {
      if (event.type === "visibilitychange" && this.window.document.visibilityState !== "visible") return;
      this.wake();
    };
    this.listenForWake("addEventListener");
    this.connect();
  }

  // Sends one Ethernet frame. Returns false, dropping it, while there is no
  // open session or the socket is backed up.
  send(frame) {
    const ws = this.ws;
    if (this.state !== "open" || !ws || ws.readyState !== OPEN || ws.bufferedAmount > this.maxBufferedBytes) {
      this.stats.framesDropped += 1;
      return false;
    }
    ws.send(frame);
    this.stats.framesSent += 1;
    return true;
  }

  // Checks the session now (when open) or reconnects now (when waiting).
  wake() {
    if (this.state === "open") this.probe();
    else if (this.state === "waiting") this.connect();
  }

  // The page is being unloaded or put in the back/forward cache, where the
  // browser may keep the socket open: close it so the relay ends the session
  // now (and holds the address) instead of keeping a session nobody uses.
  // pageshow reconnects if the page comes back.
  suspend() {
    if (this.state === "closed" || this.state === "idle") return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.stopHeartbeat();
    const ws = this.ws;
    this.detach();
    if (ws && ws.readyState <= OPEN) ws.close(1000, "page hidden");
    this.setState("waiting");
  }

  // Ends the session and stops reconnecting.
  close() {
    this.listenForWake("removeEventListener");
    clearTimeout(this.retryTimer);
    this.stopHeartbeat();
    const ws = this.ws;
    this.detach();
    if (ws && ws.readyState <= OPEN) ws.close(1000, "client closed");
    this.setState("closed");
  }

  // Internals.

  listenForWake(method) {
    if (!this.window) return;
    for (const type of WINDOW_WAKE_EVENTS) this.window[method](type, this.onWake);
    this.window[method]("pagehide", this.onPageHide);
    for (const type of DOCUMENT_WAKE_EVENTS) this.window.document?.[method](type, this.onWake);
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.handlers.onStateChange(state);
  }

  connect() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.state === "closed" || this.state === "connecting" || this.state === "open") return;
    this.setState("connecting");
    const protocols = this.token ? [SUBPROTOCOL, `relay.token.${this.token}`] : [SUBPROTOCOL];
    let ws;
    try {
      ws = new this.WebSocket(this.url, protocols);
    } catch (error) {
      this.finish({ code: 0, reason: error.message, error });
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      if (ws.protocol && ws.protocol !== SUBPROTOCOL) {
        this.detach();
        ws.close(1000, "unexpected subprotocol");
        this.finish({ code: 0, reason: `unexpected subprotocol "${ws.protocol}"` });
        return;
      }
      this.openedAt = Date.now();
      this.lastReceived = this.openedAt;
      const reconnect = this.sessions > 0;
      this.sessions += 1;
      if (reconnect) this.stats.reconnects += 1;
      this.setState("open");
      this.startHeartbeat();
      this.handlers.onOpen({ reconnect });
    };
    ws.onmessage = (event) => {
      this.lastReceived = Date.now();
      this.probeSentAt = 0; // anything received answers a probe
      if (typeof event.data === "string") return; // pong:
      this.stats.framesReceived += 1;
      this.handlers.onFrame(new Uint8Array(event.data));
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.detach();
      this.closed(opened, event.code, event.reason || "");
    };
    ws.onerror = () => {}; // onclose follows with the code
  }

  // The socket ended: decide whether and when to reconnect.
  closed(opened, code, reason) {
    this.stopHeartbeat();
    if (opened && Date.now() - this.openedAt >= STABLE_SESSION_MS) this.failures = 0;
    if (!opened) {
      // Browsers hide the HTTP status of a refused upgrade (1006). Ask the
      // account API once per streak whether the token is the problem.
      const first = this.failures === 0;
      this.failures += 1;
      if (first && this.checkToken) {
        this.setState("waiting");
        this.tokenRefused().then((refusal) => {
          if (this.state !== "waiting") return;
          if (refusal) this.finish({ code, reason: refusal });
          else this.retryIn(this.backoff(), { code, reason });
        });
        return;
      }
      this.retryIn(this.backoff(), { code, reason });
      return;
    }
    const verdict = classifyClose(code, reason);
    if (verdict === "final") {
      this.finish({ code, reason });
    } else if (verdict === "restart") {
      this.failures = 0;
      this.retryIn(code === 1001 ? Math.round(RESTART_DELAY_MS * (0.5 + Math.random())) : 0, { code, reason });
    } else {
      this.failures += 1;
      this.retryIn(this.failures === 1 ? 0 : this.backoff(), { code, reason });
    }
  }

  // Exponential backoff with jitter: about 1, 2, 4 … 60 s.
  backoff() {
    const base = Math.min(this.maxBackoffMs, this.initialBackoffMs * 2 ** Math.max(0, this.failures - 1));
    return Math.round(base * (0.5 + Math.random() / 2));
  }

  retryIn(ms, { code, reason }) {
    if (this.state === "closed") return;
    this.setState("waiting");
    this.handlers.onClose({ code, reason, final: false, retryInMs: ms });
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), ms);
  }

  finish({ code, reason, error = null }) {
    this.close();
    this.handlers.onClose({ code, reason, final: true, retryInMs: null, error });
  }

  // Resolves to a reason when the account API refuses the token, else null.
  async tokenRefused() {
    try {
      const api = new URL("/api/me", this.url.replace(/^ws/, "http"));
      const response = await this.fetch(api, { headers: { Authorization: `Bearer ${this.token}` } });
      if (response.status !== 401 && response.status !== 403) return null;
      const body = await response.json().catch(() => ({}));
      return body.error || `HTTP ${response.status}`;
    } catch {
      return null; // unreachable, or blocked by CORS on third-party pages
    }
  }

  detach() {
    const ws = this.ws;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    this.ws = null;
  }

  // Heartbeat: a ping: on each heartbeatMs tick when nothing was received
  // for half of it, and at once after a timer gap (the machine slept, or the
  // tab was frozen). A probe that gets no reply within heartbeatTimeoutMs
  // means the socket is dead. The relay ignores ping: for its idle timeout.
  startHeartbeat() {
    this.stopHeartbeat();
    this.lastTick = Date.now();
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      const slept = now - this.lastTick > 2 * this.heartbeatMs;
      this.lastTick = now;
      // Half the interval: a tick that just misses a full one would
      // otherwise wait another whole interval.
      if (slept || now - this.lastReceived >= this.heartbeatMs / 2) this.probe();
    }, this.heartbeatMs);
  }

  stopHeartbeat() {
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.probeTimer);
    this.heartbeatTimer = this.probeTimer = null;
    this.probeSentAt = 0;
  }

  probe() {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN || this.probeSentAt) return;
    const sentAt = Date.now();
    this.probeSentAt = sentAt;
    ws.send(`ping:${sentAt}`);
    clearTimeout(this.probeTimer);
    this.probeTimer = setTimeout(() => this.probeExpired(sentAt), this.heartbeatTimeoutMs);
  }

  probeExpired(sentAt) {
    if (this.probeSentAt !== sentAt || this.ws === null) return;
    // A timer that fired far too late ran in a throttled or frozen page; the
    // reply may simply not have been processed yet. Probe again rather than
    // drop a session that may be fine.
    if (Date.now() - sentAt > 2 * this.heartbeatTimeoutMs) {
      this.probeSentAt = 0;
      this.probe();
      return;
    }
    const ws = this.ws;
    this.detach();
    try {
      ws.close(4000, "heartbeat timeout");
    } catch {
      // Already closing.
    }
    this.closed(true, 1006, "heartbeat timeout");
  }
}
