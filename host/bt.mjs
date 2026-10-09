/* A Bluetooth controller, emulated, at the far end of a board's HCI UART.
 *
 * A board with the wasm-bt snippet runs Zephyr's own Bluetooth host and
 * upstream's H4 driver on its second UART (port 1). This is the other end
 * of that UART: it reads HCI commands and ACL data in H4 framing, answers
 * as a controller would, and talks over a virtual radio to the controller
 * of the other board of a pair (host/pair.mjs). Zephyr's host stack runs
 * unmodified; only the controller and the air are made up (DESIGN.md D8p).
 *
 * What it implements is the legacy (Bluetooth 4.x) LE subset that
 * advertising, scanning, connecting and GATT need: the commands the host
 * sends at init, legacy advertising and scanning, creating and cancelling a
 * connection, connection update, remote features and version, disconnect,
 * encryption, and ACL data in both directions with Number Of Completed
 * Packets. Extended advertising, data length and PHY updates are not
 * offered, and the features the controller reports say so, so the host
 * never asks for them. Anything else gets "Unknown HCI Command".
 *
 * Encryption is the procedure, not the cipher: the central's LTK goes over
 * the air with its start-encryption request, the peripheral's host is
 * asked for its own, and the link is encrypted if they match and dropped
 * with a MIC failure if they do not, as a real link would be. What crosses
 * the air afterwards is not enciphered; nothing can listen to it.
 *
 * Timing is on the board's own clock, as everything else in the host is,
 * so a pair runs the same every time:
 * - an advertiser sends an advertising PDU every advertising interval;
 * - a scanner reports every one it hears, and for active scanning of a
 *   scannable advertiser, the scan response too;
 * - an initiator connects on the first connectable PDU from the address it
 *   wants; both sides report the connection at once, and the advertiser
 *   stops advertising;
 * - on a connection, ACL data goes over the air at the next connection
 *   event, an interval apart from the moment of connection, and the sender
 *   is told its packets are done when they go.
 * The air's latency is the pair's link latency. Nothing here reads the wall
 * clock or an unseeded random number.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

/* H4 packet types. */
const H4_CMD = 0x01;
const H4_ACL = 0x02;
const H4_EVT = 0x04;

/* Events and LE subevents. */
const EVT_DISCONN_COMPLETE = 0x05;
const EVT_ENCRYPT_CHANGE = 0x08;
const EVT_REMOTE_VERSION = 0x0c;
const EVT_CMD_COMPLETE = 0x0e;
const EVT_CMD_STATUS = 0x0f;
const EVT_NUM_COMPLETED = 0x13;
const EVT_KEY_REFRESH_COMPLETE = 0x30;
const EVT_LE_META = 0x3e;
const LE_CONN_COMPLETE = 0x01;
const LE_ADV_REPORT = 0x02;
const LE_CONN_UPDATE_COMPLETE = 0x03;
const LE_REMOTE_FEATURES = 0x04;
const LE_LTK_REQUEST = 0x05;

/* Status codes. */
const OK = 0x00;
const UNKNOWN_COMMAND = 0x01;
const UNKNOWN_CONN = 0x02;
const KEY_MISSING = 0x06;
const CONN_LIMIT = 0x09;
const DISALLOWED = 0x0c;
const LOCAL_HOST_TERMINATED = 0x16;
const MIC_FAILURE = 0x3d;

/* Advertising PDU types, as LE Set Advertising Parameters gives them. */
const ADV_IND = 0x00;
const ADV_DIRECT_IND = 0x01;
const ADV_SCAN_IND = 0x02;
const ADV_NONCONN_IND = 0x03;
const ADV_DIRECT_IND_LOW = 0x04;
/* The report's event type for a scan response. */
const SCAN_RSP = 0x04;

/* What a scanner reports for every packet heard: close enough that the
 * upstream centrals that only connect to a nearby device (RSSI >= -50)
 * will. */
const RSSI = -40;

/* How many links one controller keeps at once. Upstream's multilink
 * samples ask for 61 and 62. */
const MAX_LINKS = 64;

/* The LE buffer this controller offers the host: the minimum ACL payload,
 * and as many packets as Zephyr's host keeps by default. */
const ACL_LEN = 27;
const ACL_NUM = 3;

/* 1.25 ms and 0.625 ms, the units of connection and advertising intervals. */
const UNIT_CONN_NS = 1_250_000n;
const UNIT_ADV_NS = 625_000n;

/* A byte's time on the HCI UART: ten bits at the 1 Mbaud the board's
 * devicetree gives it. As on the console's UART, bytes reach the guest no
 * faster than that (DESIGN.md D10). */
export const HCI_BYTE_NS = 10_000n;

/* The commands answered, by opcode: OGF << 10 | OCF. */
const OP = {
  DISCONNECT: 0x0406,
  READ_REMOTE_VERSION: 0x041d,
  SET_EVENT_MASK: 0x0c01,
  RESET: 0x0c03,
  READ_LOCAL_VERSION: 0x1001,
  READ_LOCAL_COMMANDS: 0x1002,
  READ_LOCAL_FEATURES: 0x1003,
  READ_BD_ADDR: 0x1009,
  LE_SET_EVENT_MASK: 0x2001,
  LE_READ_BUFFER_SIZE: 0x2002,
  LE_READ_LOCAL_FEATURES: 0x2003,
  LE_SET_RANDOM_ADDRESS: 0x2005,
  LE_SET_ADV_PARAMS: 0x2006,
  LE_READ_ADV_TX_POWER: 0x2007,
  LE_SET_ADV_DATA: 0x2008,
  LE_SET_SCAN_RSP_DATA: 0x2009,
  LE_SET_ADV_ENABLE: 0x200a,
  LE_SET_SCAN_PARAMS: 0x200b,
  LE_SET_SCAN_ENABLE: 0x200c,
  LE_CREATE_CONN: 0x200d,
  LE_CREATE_CONN_CANCEL: 0x200e,
  LE_READ_FAL_SIZE: 0x200f,
  LE_CLEAR_FAL: 0x2010,
  LE_CONN_UPDATE: 0x2013,
  LE_READ_REMOTE_FEATURES: 0x2016,
  LE_RAND: 0x2018,
  LE_START_ENCRYPTION: 0x2019,
  LE_LTK_REPLY: 0x201a,
  LE_LTK_NEG_REPLY: 0x201b,
};

/* Read Local Supported Commands: the bit for each command above, as
 * [octet, bit] from the Core specification's table. Host flow control
 * (10.5) is left out on purpose, so the host does not use it. */
const SUPPORTED = [
  [0, 5],                                   // Disconnect
  [2, 7],                                   // Read Remote Version Information
  [5, 6], [5, 7],                           // Set Event Mask, Reset
  [14, 3], [14, 5],                         // Read Local Version, Features
  [15, 1],                                  // Read BD_ADDR
  [25, 0], [25, 1], [25, 2], [25, 4], [25, 5], [25, 6], [25, 7],
  [26, 0], [26, 1], [26, 2], [26, 3], [26, 4], [26, 5], [26, 6], [26, 7],
  [27, 2], [27, 5], [27, 7],                // Conn Update, Remote Features, Rand
  [28, 0], [28, 1], [28, 2],                // Start Encryption, LTK (Negative) Reply
];

const le16 = (v) => [v & 0xff, (v >> 8) & 0xff];
const rd16 = (b, i) => b[i] | (b[i + 1] << 8);
const minBig = (a, b) => (a === null ? b : b === null ? a : (a < b ? a : b));

export class BtController {
  /**
   * @param opts  address: the board's public address, six bytes in HCI
   *              order (least significant first); seed: for LE Rand;
   *              airSend(pdu, atNs): hand a PDU to the air, to arrive at
   *              atNs on this board's clock (omitted on a board alone,
   *              whose controller still answers but is heard by no one)
   */
  constructor(opts) {
    this.address = [...opts.address];
    this.airSend = opts.airSend ?? null;
    this.s = BtController.initialState(opts.seed ?? 1);
  }

  static initialState(seed) {
    return {
      /* Bytes for the guest, and the UART's line rate towards it, as
       * core.mjs keeps for the console. */
      rx: [],
      rxTaken: 0,
      rxRaisedAt: 0,
      rxReadyNs: 0n,
      /* An H4 packet from the guest, as far as it has come. */
      pkt: [],
      rng: (seed >>> 0) || 1,
      randomAddr: null,
      adv: { type: ADV_IND, ownType: 0, intervalNs: 100_000_000n, data: [], scanRsp: [],
             enabled: false, nextNs: null },
      scan: { active: false, enabled: false, filterDup: false, seen: [] },
      initiating: null,
      /* Links, by handle. Each has a key, the central's handle for it,
       * which every PDU about the link carries: one central can use the
       * same address for all its links, so the addresses cannot tell them
       * apart. */
      conns: [],
      /* PDUs from the other board's controller, by arrival time. */
      air: [],
      airSent: 0,
      airReceived: 0,
    };
  }

  snapshot() { return structuredClone(this.s); }
  restore(s) { this.s = structuredClone(s); }

  /* ---- The UART, guest side ---------------------------------------- */

  /* Whether a byte for the guest has come down the wire. */
  rxReady(nowNs) {
    return this.s.rx.length > 0 && nowNs >= this.s.rxReadyNs;
  }

  /* The guest's UART reads a byte: the next, if it has come. */
  rxTake(nowNs) {
    if (!this.rxReady(nowNs)) return -1;
    this.s.rxTaken++;
    this.s.rxReadyNs = nowNs + HCI_BYTE_NS;
    return this.s.rx.shift();
  }

  /* A byte the guest wrote, at nowNs on the board's clock. */
  fromHost(byte, nowNs) {
    const p = this.s.pkt;
    p.push(byte);
    const type = p[0];
    if (type === H4_CMD) {
      if (p.length >= 4 && p.length === 4 + p[3]) {
        this.s.pkt = [];
        this.command(rd16(p, 1), p.slice(4), nowNs);
      }
    } else if (type === H4_ACL) {
      if (p.length >= 5 && p.length === 5 + rd16(p, 3)) {
        this.s.pkt = [];
        this.aclFromHost(p.slice(1), nowNs);
      }
    } else {
      /* Nothing else is sent to a controller; resynchronise on the next
       * byte. */
      this.s.pkt = [];
    }
  }

  /* ---- Time ------------------------------------------------------------ */

  /* The next time anything here happens on its own, on the board's clock,
   * or null: a byte coming down the wire, an advertising event, a
   * connection event with something to send, or a PDU arriving. */
  nextNs(nowNs) {
    const s = this.s;
    let at = s.rx.length > 0 && s.rxReadyNs > nowNs ? s.rxReadyNs : null;
    if (s.adv.enabled) at = minBig(at, s.adv.nextNs);
    const link = this.nextLink();
    if (link) at = minBig(at, link.at);
    if (s.air.length > 0) at = minBig(at, s.air[0].atNs);
    return at;
  }

  /* The link whose next connection event comes first among those with
   * something to send, and when; ties go to the lower handle. */
  nextLink() {
    let best = null;
    for (const c of this.s.conns) {
      if (c.tx.length === 0 && c.pending.length === 0) continue;
      const at = this.connEventAt(c, c.since);
      if (best === null || at < best.at) best = { c, at };
    }
    return best;
  }

  /* Do everything due by nowNs, in time order. */
  advance(nowNs) {
    for (;;) {
      const s = this.s;
      const advAt = s.adv.enabled ? s.adv.nextNs : null;
      const link = this.nextLink();
      const connAt = link ? link.at : null;
      const airAt = s.air.length > 0 ? s.air[0].atNs : null;
      const at = minBig(minBig(advAt, connAt), airAt);
      if (at === null || at > nowNs) return;
      /* Ties: what arrived first, then the connection, then advertising,
       * so the order is fixed. */
      if (airAt === at) this.receive(s.air.shift(), at);
      else if (connAt === at) this.connEvent(link.c, at);
      else this.advEvent(at);
    }
  }

  /* The first connection event of link c at or after t. */
  connEventAt(c, t) {
    if (t <= c.anchorNs) return c.anchorNs;
    const n = (t - c.anchorNs + c.intervalNs - 1n) / c.intervalNs;
    return c.anchorNs + n * c.intervalNs;
  }

  /* A PDU from the other controller, due at atNs on this board's clock. */
  fromAir(pdu, atNs) {
    const q = this.s.air;
    let i = q.length;
    while (i > 0 && q[i - 1].atNs > atNs) i--;
    q.splice(i, 0, { atNs, pdu });
  }

  send(pdu, atNs) {
    this.s.airSent++;
    if (this.airSend) this.airSend(pdu, atNs);
  }

  /* ---- Events to the host ---------------------------------------------- */

  event(code, params) {
    this.s.rx.push(H4_EVT, code, params.length, ...params);
  }

  leMeta(sub, params) {
    this.event(EVT_LE_META, [sub, ...params]);
  }

  complete(op, params) {
    this.event(EVT_CMD_COMPLETE, [1, ...le16(op), ...params]);
  }

  status(op, st) {
    this.event(EVT_CMD_STATUS, [st, 1, ...le16(op)]);
  }

  rand8() {
    const out = [];
    let x = this.s.rng;
    for (let i = 0; i < 8; i++) {
      x ^= x << 13; x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5; x >>>= 0;
      out.push(x & 0xff);
    }
    this.s.rng = x;
    return out;
  }

  byHandle(handle) {
    return this.s.conns.find((c) => c.handle === handle) ?? null;
  }

  byKey(key) {
    return this.s.conns.find((c) => c.key === key) ?? null;
  }

  /* A link is gone: whatever it still had to send goes with it, and no
   * Number Of Completed Packets follows, since the host takes those
   * packets back itself. */
  drop(c) {
    this.s.conns = this.s.conns.filter((x) => x !== c);
  }

  /* A PDU about link c, to the other end of it. */
  sendOn(c, pdu, atNs) {
    this.send({ ...pdu, key: c.key }, atNs);
  }

  /* The address this controller advertises or connects with. */
  ownAddress(ownType) {
    if ((ownType & 1) && this.s.randomAddr) return { type: 1, addr: this.s.randomAddr };
    return { type: 0, addr: this.address };
  }

  /* ---- Commands -------------------------------------------------------- */

  command(op, p, nowNs) {
    const s = this.s;
    switch (op) {
      case OP.RESET: {
        const { rx, rxTaken, rxRaisedAt, rxReadyNs, rng, airSent, airReceived } = s;
        this.s = { ...BtController.initialState(rng), rx, rxTaken, rxRaisedAt, rxReadyNs,
                   airSent, airReceived };
        this.complete(op, [OK]);
        return;
      }
      case OP.SET_EVENT_MASK:
      case OP.LE_SET_EVENT_MASK:
      case OP.LE_CLEAR_FAL:
        this.complete(op, [OK]);
        return;
      case OP.READ_LOCAL_VERSION:
        /* Bluetooth 5.0, from no company in particular (0xffff is the
         * identifier the specification sets aside for testing). */
        this.complete(op, [OK, 0x09, ...le16(0), 0x09, ...le16(0xffff), ...le16(0)]);
        return;
      case OP.READ_LOCAL_COMMANDS: {
        const bits = new Array(64).fill(0);
        for (const [octet, bit] of SUPPORTED) bits[octet] |= 1 << bit;
        this.complete(op, [OK, ...bits]);
        return;
      }
      case OP.READ_LOCAL_FEATURES: {
        /* LE supported (controller), BR/EDR not supported. */
        const f = new Array(8).fill(0);
        f[4] = 0x40 | 0x20;
        this.complete(op, [OK, ...f]);
        return;
      }
      case OP.READ_BD_ADDR:
        this.complete(op, [OK, ...this.address]);
        return;
      case OP.LE_READ_BUFFER_SIZE:
        this.complete(op, [OK, ...le16(ACL_LEN), ACL_NUM]);
        return;
      case OP.LE_READ_LOCAL_FEATURES:
        /* LE Encryption, and none of the other optional features: no
         * data length, privacy, 2M or extended advertising. */
        this.complete(op, [OK, 0x01, 0, 0, 0, 0, 0, 0, 0]);
        return;
      case OP.LE_SET_RANDOM_ADDRESS:
        s.randomAddr = p.slice(0, 6);
        this.complete(op, [OK]);
        return;
      case OP.LE_SET_ADV_PARAMS:
        if (s.adv.enabled) { this.complete(op, [DISALLOWED]); return; }
        s.adv.intervalNs = BigInt(rd16(p, 0)) * UNIT_ADV_NS;
        s.adv.type = p[4];
        s.adv.ownType = p[5];
        this.complete(op, [OK]);
        return;
      case OP.LE_READ_ADV_TX_POWER:
        this.complete(op, [OK, 0]);
        return;
      case OP.LE_SET_ADV_DATA:
        s.adv.data = p.slice(1, 1 + Math.min(p[0], 31));
        this.complete(op, [OK]);
        return;
      case OP.LE_SET_SCAN_RSP_DATA:
        s.adv.scanRsp = p.slice(1, 1 + Math.min(p[0], 31));
        this.complete(op, [OK]);
        return;
      case OP.LE_SET_ADV_ENABLE:
        s.adv.enabled = !!p[0];
        s.adv.nextNs = s.adv.enabled ? nowNs : null;
        this.complete(op, [OK]);
        return;
      case OP.LE_SET_SCAN_PARAMS:
        if (s.scan.enabled) { this.complete(op, [DISALLOWED]); return; }
        s.scan.active = p[0] === 1;
        this.complete(op, [OK]);
        return;
      case OP.LE_SET_SCAN_ENABLE:
        s.scan.enabled = !!p[0];
        s.scan.filterDup = !!p[1];
        s.scan.seen = [];
        this.complete(op, [OK]);
        return;
      case OP.LE_CREATE_CONN:
        if (s.initiating) { this.status(op, DISALLOWED); return; }
        if (s.conns.length >= MAX_LINKS) { this.status(op, CONN_LIMIT); return; }
        s.initiating = {
          peerType: p[5], peerAddr: p.slice(6, 12), ownType: p[12],
          interval: rd16(p, 13), latency: rd16(p, 17), timeout: rd16(p, 19),
        };
        this.status(op, OK);
        return;
      case OP.LE_CREATE_CONN_CANCEL:
        if (!s.initiating) { this.complete(op, [DISALLOWED]); return; }
        s.initiating = null;
        this.complete(op, [OK]);
        this.leMeta(LE_CONN_COMPLETE, [UNKNOWN_CONN, ...new Array(17).fill(0)]);
        return;
      case OP.LE_READ_FAL_SIZE:
        this.complete(op, [OK, 8]);
        return;
      case OP.LE_RAND:
        this.complete(op, [OK, ...this.rand8()]);
        return;
      case OP.LE_LTK_REPLY:
      case OP.LE_LTK_NEG_REPLY: {
        const handle = rd16(p, 0) & 0x0fff;
        const c = this.byHandle(handle);
        if (!c || !c.encPending) {
          this.complete(op, [DISALLOWED, ...le16(handle)]);
          return;
        }
        this.complete(op, [OK, ...le16(handle)]);
        const theirs = c.encPending.ltk;
        c.encPending = null;
        if (op === OP.LE_LTK_NEG_REPLY) {
          this.sendOn(c, { kind: 'enc_rsp', ok: false }, nowNs);
        } else if (p.slice(2, 18).every((b, i) => b === theirs[i])) {
          /* At once, not at the next connection event: the central hears
           * that the link is encrypted before anything this side's host
           * sends now that it is. */
          this.encrypted(c, OK);
          this.sendOn(c, { kind: 'enc_rsp', ok: true }, nowNs);
        } else {
          /* The keys differ, so neither side can read the other's first
           * encrypted packet: both drop the link. */
          this.sendOn(c, { kind: 'terminate', reason: MIC_FAILURE }, nowNs);
          this.event(EVT_DISCONN_COMPLETE, [OK, ...le16(c.handle), MIC_FAILURE]);
          this.drop(c);
        }
        return;
      }
      case OP.LE_START_ENCRYPTION:
      case OP.LE_CONN_UPDATE:
      case OP.LE_READ_REMOTE_FEATURES:
      case OP.READ_REMOTE_VERSION:
      case OP.DISCONNECT: {
        const c = this.byHandle(rd16(p, 0) & 0x0fff);
        if (!c) { this.status(op, UNKNOWN_CONN); return; }
        this.status(op, OK);
        /* Done at the next connection event, where the other side would
         * hear of it. */
        c.pending.push({ op, p: [...p] });
        return;
      }
      default:
        this.complete(op, [UNKNOWN_COMMAND]);
    }
  }

  /* ---- ACL data ---------------------------------------------------------- */

  aclFromHost(pkt, nowNs) {
    const s = this.s;
    const hdr = rd16(pkt, 0);
    const c = this.byHandle(hdr & 0x0fff);
    if (!c) return;
    /* Packet boundary: what the host calls "first non-flushable" (0b00)
     * arrives at the other host as "first flushable" (0b10). */
    const pb = (hdr >> 12) & 0x3;
    c.tx.push({ pb: pb === 0x1 ? 0x1 : 0x2, data: pkt.slice(4) });
  }

  /* ---- The radio ---------------------------------------------------------- */

  advEvent(atNs) {
    const s = this.s;
    s.adv.nextNs = atNs + s.adv.intervalNs;
    const own = this.ownAddress(s.adv.ownType);
    this.send({ kind: 'adv', type: s.adv.type, addrType: own.type, addr: own.addr,
                data: s.adv.data, scanRsp: s.adv.scanRsp }, atNs);
  }

  connEvent(c, atNs) {
    const sent = c.tx.length;
    for (const pkt of c.tx) this.sendOn(c, { kind: 'acl', pb: pkt.pb, data: pkt.data }, atNs);
    c.tx = [];
    if (sent > 0) this.event(EVT_NUM_COMPLETED, [1, ...le16(c.handle), ...le16(sent)]);
    const pending = c.pending;
    c.pending = [];
    for (const { op, p } of pending) {
      if (!this.s.conns.includes(c)) break;
      if (op === OP.DISCONNECT) {
        this.sendOn(c, { kind: 'terminate', reason: p[2] }, atNs);
        this.event(EVT_DISCONN_COMPLETE, [OK, ...le16(c.handle), LOCAL_HOST_TERMINATED]);
        this.drop(c);
      } else if (op === OP.LE_CONN_UPDATE) {
        const upd = { interval: rd16(p, 4), latency: rd16(p, 6), timeout: rd16(p, 8) };
        this.sendOn(c, { kind: 'update', ...upd }, atNs);
        this.applyUpdate(c, upd, atNs);
      } else if (op === OP.LE_START_ENCRYPTION) {
        /* After the ACL queued before it, which went first above: the
         * peripheral's host must have it before it is asked for a key. */
        this.sendOn(c, { kind: 'enc_req', rand: p.slice(2, 10), ediv: p.slice(10, 12),
                         ltk: p.slice(12, 28) }, atNs);
      } else if (op === OP.LE_READ_REMOTE_FEATURES) {
        this.leMeta(LE_REMOTE_FEATURES, [OK, ...le16(c.handle), 0x01, 0, 0, 0, 0, 0, 0, 0]);
      } else if (op === OP.READ_REMOTE_VERSION) {
        this.event(EVT_REMOTE_VERSION, [OK, ...le16(c.handle), 0x09, ...le16(0xffff), ...le16(0)]);
      }
    }
    c.since = atNs + 1n;
  }

  /* Encryption is on: a change for a link that was not encrypted, a key
   * refresh for one that was, since the host ignores an Encryption Change
   * that changes nothing. */
  encrypted(c, status) {
    if (status !== OK) {
      this.event(EVT_ENCRYPT_CHANGE, [status, ...le16(c.handle), 0x00]);
    } else if (c.encrypted) {
      this.event(EVT_KEY_REFRESH_COMPLETE, [OK, ...le16(c.handle)]);
    } else {
      c.encrypted = true;
      this.event(EVT_ENCRYPT_CHANGE, [OK, ...le16(c.handle), 0x01]);
    }
  }

  applyUpdate(c, upd, atNs) {
    c.intervalNs = BigInt(upd.interval) * UNIT_CONN_NS;
    c.anchorNs = atNs;
    c.interval = upd.interval;
    c.latency = upd.latency;
    c.timeout = upd.timeout;
    this.leMeta(LE_CONN_UPDATE_COMPLETE, [OK, ...le16(c.handle), ...le16(upd.interval),
                                          ...le16(upd.latency), ...le16(upd.timeout)]);
  }

  /* A new link, on the lowest free handle; key as for conns above. Returns
   * it. */
  connect(role, key, peerType, peerAddr, params, atNs) {
    let handle = 0;
    while (this.byHandle(handle)) handle++;
    const c = {
      handle, key: key ?? handle, role, peerType, peerAddr: [...peerAddr],
      interval: params.interval, latency: params.latency, timeout: params.timeout,
      intervalNs: BigInt(params.interval) * UNIT_CONN_NS,
      anchorNs: atNs, since: atNs, tx: [], pending: [], encrypted: false, encPending: null,
    };
    this.s.conns.push(c);
    this.leMeta(LE_CONN_COMPLETE, [OK, ...le16(handle), role, peerType, ...peerAddr,
                                   ...le16(params.interval), ...le16(params.latency),
                                   ...le16(params.timeout), 0x00]);
    return c;
  }

  report(type, addrType, addr, data) {
    const s = this.s;
    if (s.scan.filterDup) {
      const key = `${type}:${addrType}:${addr.join(',')}`;
      if (s.scan.seen.includes(key)) return;
      s.scan.seen.push(key);
    }
    this.leMeta(LE_ADV_REPORT, [1, type, addrType, ...addr, data.length, ...data, RSSI & 0xff]);
  }

  receive({ pdu }, atNs) {
    const s = this.s;
    s.airReceived++;
    switch (pdu.kind) {
      case 'adv': {
        const connectable = pdu.type === ADV_IND || pdu.type === ADV_DIRECT_IND ||
                            pdu.type === ADV_DIRECT_IND_LOW;
        const scannable = pdu.type === ADV_IND || pdu.type === ADV_SCAN_IND;
        if (s.initiating && connectable && pdu.addrType === (s.initiating.peerType & 1) &&
            pdu.addr.every((b, i) => b === s.initiating.peerAddr[i])) {
          const ini = s.initiating;
          s.initiating = null;
          const own = this.ownAddress(ini.ownType);
          const params = { interval: ini.interval, latency: ini.latency, timeout: ini.timeout };
          const c = this.connect(0x00, null, pdu.addrType, pdu.addr, params, atNs);
          /* To that advertiser, and no other that might be listening. */
          this.sendOn(c, { kind: 'connect', addrType: own.type, addr: own.addr,
                           targetType: pdu.addrType, target: pdu.addr, ...params }, atNs);
          return;
        }
        if (!s.scan.enabled) return;
        /* A directed advertisement is reported as ADV_DIRECT_IND. */
        const type = pdu.type === ADV_DIRECT_IND_LOW ? ADV_DIRECT_IND : pdu.type;
        this.report(type, pdu.addrType, pdu.addr, pdu.type === ADV_DIRECT_IND ||
                    pdu.type === ADV_DIRECT_IND_LOW ? [] : pdu.data);
        if (s.scan.active && scannable) this.report(SCAN_RSP, pdu.addrType, pdu.addr, pdu.scanRsp);
        return;
      }
      case 'connect': {
        /* Only an advertiser that is still connectable, at the address the
         * initiator heard, takes it. */
        const own = this.ownAddress(s.adv.ownType);
        if (!s.adv.enabled || s.conns.length >= MAX_LINKS ||
            !(s.adv.type === ADV_IND || s.adv.type === ADV_DIRECT_IND ||
              s.adv.type === ADV_DIRECT_IND_LOW) ||
            pdu.targetType !== own.type || pdu.target.some((b, i) => b !== own.addr[i])) return;
        s.adv.enabled = false;
        s.adv.nextNs = null;
        this.connect(0x01, pdu.key, pdu.addrType, pdu.addr, pdu, atNs);
        return;
      }
      default: {
        /* Everything else is about a link, which the key names. */
        const c = this.byKey(pdu.key);
        if (!c) return;
        if (pdu.kind === 'acl') {
          s.rx.push(H4_ACL, ...le16(c.handle | (pdu.pb << 12)), ...le16(pdu.data.length),
                    ...pdu.data);
        } else if (pdu.kind === 'update') {
          this.applyUpdate(c, pdu, atNs);
        } else if (pdu.kind === 'enc_req') {
          c.encPending = { ltk: pdu.ltk };
          this.leMeta(LE_LTK_REQUEST, [...le16(c.handle), ...pdu.rand, ...pdu.ediv]);
        } else if (pdu.kind === 'enc_rsp') {
          this.encrypted(c, pdu.ok ? OK : KEY_MISSING);
        } else if (pdu.kind === 'terminate') {
          this.event(EVT_DISCONN_COMPLETE, [OK, ...le16(c.handle), pdu.reason]);
          this.drop(c);
        }
      }
    }
  }
}
