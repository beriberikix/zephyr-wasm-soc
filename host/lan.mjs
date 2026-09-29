/* The host's own network: a LAN a single board can be plugged into.
 *
 * A board with the wasm-ethernet snippet hands the host whole Ethernet
 * frames. Here the host is the other end: a second IP stack, at 192.0.2.2,
 * the address upstream's networking samples expect their Linux host to
 * have. It answers ARP and ping, hands out an address by DHCP, answers DNS,
 * and serves or dials TCP and UDP (host/lan_services.mjs), so those
 * samples run unmodified with no network outside the tab.
 *
 * The stack is lwIP, as tcpip.js compiles it to wasm (host/web/vendor/,
 * MIT and BSD-3). Only the module is used: tcpip.js's own JavaScript drives
 * lwIP from a wall-clock setInterval through async streams, and a LAN here
 * has to run on the board's virtual clock, one call at a time, so that a
 * run is as repeatable as any other. Nothing in lwIP reads the outside
 * world but the clock: time comes from the one WASI call it imports,
 * clock_time_get, which this answers with the board's time. Ports,
 * sequence numbers and IP identifiers are counters, so they repeat too.
 *
 * Everything is synchronous. A frame from the board goes in with
 * send_tap_interface, and lwIP answers during that call: frames it sends
 * come back through receive_frame, TCP and UDP events through the other
 * imports. What the services do in reaction happens inside those callbacks
 * too, except closing a connection, which waits until lwIP has returned.
 *
 * Three things tcpip.js's C glue does that matter here, noted in DESIGN.md
 * D8m:
 * - a frame given to lwIP is used in place (PBUF_REF) and lwIP may keep it,
 *   so its memory is never freed;
 * - a frame lwIP sends is handed over as its first buffer's payload with
 *   the whole chain's length. lwIP chains a second buffer onto a segment
 *   when a write is added to one that has not gone yet, and that frame
 *   went out with whatever followed the first buffer in memory, failed its
 *   checksum, and failed again on every retransmission. receive_frame
 *   finds the chain itself (frameAt, below);
 * - received data is read from the first buffer of a chain only, which is
 *   all there is for segments that arrive in order, as they do here.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

export const LAN_IP = [192, 0, 2, 2];
export const BOARD_IP = [192, 0, 2, 1];
/* Locally administered, and not the board's: its MAC comes from its seed. */
const LAN_MAC = [0x02, 0x00, 0x5e, 0x00, 0x02, 0x02];
const NETMASK = [255, 255, 255, 0];

/* lwIP's timers are checked on this grid of the board's clock. Its own
 * timers run at 250 ms and up, so a tick of 50 ms is on time to within a
 * fifth of the finest one. */
const TICK_NS = 50_000_000n;

const WASI_EBADF = 8;

export class Lan {
  /**
   * @param bytes  tcpip.wasm
   * @param log    called with a line about what the LAN did, for stderr
   * @param at     { ip, mac }: the LAN's own address, 192.0.2.2 unless a
   *               check wants a second stack to talk to it
   */
  static async create(bytes, log = () => {}, at = {}) {
    const module = await WebAssembly.compile(bytes);
    return new Lan(module, log, at);
  }

  constructor(module, log, { ip = LAN_IP, mac = LAN_MAC } = {}) {
    this.log = log;
    this.clockNs = 0n;
    this.emitted = [];       // frames lwIP sent during the current call
    this.later = [];         // what waits until lwIP has returned
    this.timers = [];        // services' own events: { atNs, fn }, in order
    this.tcp = new Map();    // pcb -> TcpConn
    this.listeners = new Map();
    this.udp = new Map();    // pcb -> handler
    this.depth = 0;

    const lan = this;
    const view = () => new DataView(lan.ex.memory.buffer);
    const bytesAt = (ptr, len) => new Uint8Array(lan.ex.memory.buffer, ptr, len).slice();
    const imports = {
      wasi_snapshot_preview1: {
        clock_time_get(_id, _precision, out) {
          view().setBigUint64(out, lan.clockNs, true);
          return 0;
        },
        /* lwIP prints nothing in this build; anything it did would go
         * nowhere, and saying it went is enough. */
        fd_write(_fd, iovs, count, written) {
          const v = view();
          let n = 0;
          for (let i = 0; i < count; i++) n += v.getUint32(iovs + i * 8 + 4, true);
          v.setUint32(written, n, true);
          return 0;
        },
        fd_close: () => 0,
        fd_fdstat_get: () => WASI_EBADF,
        fd_seek: () => WASI_EBADF,
      },
      env: {
        register_loopback_interface() {},
        register_tun_interface() {},
        register_tap_interface() {},
        receive_packet() {},
        receive_icmp_echo_reply() {},
        receive_frame(_netif, ptr, len) {
          lan.emitted.push(lan.frameAt(ptr, len));
        },
        accept_tcp_connection(listener, pcb) {
          const conn = new TcpConn(lan, pcb);
          lan.tcp.set(pcb, conn);
          lan.listeners.get(listener)?.(conn);
        },
        connected_tcp_connection(pcb) {
          lan.tcp.get(pcb)?.onConnect?.();
        },
        receive_tcp_chunk(pcb, ptr, len) {
          const data = bytesAt(ptr, len);
          lan.ex.update_tcp_receive_buffer(pcb, len);
          lan.tcp.get(pcb)?.onData?.(data);
        },
        sent_tcp_chunk(pcb) {
          lan.tcp.get(pcb)?.pump();
        },
        /* The other end closed its side, or the connection is gone. */
        closed_tcp_connection(pcb) {
          const conn = lan.tcp.get(pcb);
          if (!conn) return;
          conn.onEnd?.();
          conn.end();
        },
        receive_udp_datagram(pcb, addr, port, ptr, len) {
          const from = [...bytesAt(addr, 4)];
          lan.udp.get(pcb)?.(bytesAt(ptr, len), from, port);
        },
      },
    };
    this.ex = new WebAssembly.Instance(module, imports).exports;
    /* lwip_init(), at time zero on the board's clock. */
    this.ex._initialize();
    this.netif = this.call(() => this.withBytes([...mac, ...ip, ...NETMASK],
      (p) => this.ex.create_tap_interface(p, p + 6, p + 10)));
  }

  /* A frame lwIP is sending, from the payload of its first buffer and the
   * chain's total length, which is what tcpip.js's glue passes. A buffer
   * lwIP allocated keeps its struct pbuf just before the payload once every
   * header is on: next, payload, tot_len, len, in 16 bytes on wasm32. That
   * struct is taken as the frame's only if it says so -- its payload is
   * this pointer and its tot_len this length -- and then the chain is
   * followed. Anything else was one buffer, and is copied as it is. */
  frameAt(ptr, len) {
    const v = new DataView(this.ex.memory.buffer);
    const p = ptr - 16;
    if (p > 0 && v.getUint32(p + 4, true) === ptr && v.getUint16(p + 8, true) === len &&
        v.getUint16(p + 10, true) < len) {
      const frame = new Uint8Array(len);
      let at = 0;
      for (let q = p; q && at < len; q = v.getUint32(q, true)) {
        const n = Math.min(v.getUint16(q + 10, true), len - at);
        frame.set(new Uint8Array(this.ex.memory.buffer, v.getUint32(q + 4, true), n), at);
        at += n;
      }
      return frame;
    }
    return new Uint8Array(this.ex.memory.buffer, ptr, len).slice();
  }

  /* Bytes into the module's memory for the length of one call. */
  withBytes(bytes, fn) {
    const ptr = this.ex.malloc(Math.max(bytes.length, 1));
    new Uint8Array(this.ex.memory.buffer, ptr, bytes.length).set(bytes);
    try {
      return fn(ptr);
    } finally {
      this.ex.free(ptr);
    }
  }

  /* Every entry into lwIP goes through here, so that what has to wait for
   * lwIP to return -- closing a connection -- runs once it has, and the
   * frames it sent are collected in one place. */
  call(fn) {
    this.depth++;
    let result;
    try {
      result = fn();
    } finally {
      this.depth--;
    }
    if (this.depth === 0) {
      while (this.later.length) {
        const job = this.later.shift();
        this.depth++;
        try { job(); } finally { this.depth--; }
      }
    }
    return result;
  }

  defer(job) {
    if (this.depth === 0) this.call(job);
    else this.later.push(job);
  }

  /* The clock only moves forwards: a frame stamped earlier than the last
   * thing the LAN did is taken now. */
  setClock(ns) {
    if (ns > this.clockNs) this.clockNs = ns;
  }

  takeEmitted() {
    const frames = this.emitted;
    this.emitted = [];
    return frames;
  }

  /**
   * A frame from the board, arriving at atNs on the board's timeline.
   * Returns the frames the LAN sent in answer, all at atNs.
   */
  input(frame, atNs) {
    this.setClock(atNs);
    this.call(() => {
      /* Used in place by lwIP (PBUF_REF), which may hold on to it, so it
       * is not freed: see the header. */
      const ptr = this.ex.malloc(frame.length);
      new Uint8Array(this.ex.memory.buffer, ptr, frame.length).set(frame);
      this.ex.send_tap_interface(this.netif, ptr, frame.length);
      this.ex.process_queued_packets();
    });
    return this.takeEmitted();
  }

  /* When the LAN next has something to do: its own timers, on the tick
   * grid, or a service's event, whichever is sooner. */
  nextNs() {
    const tick = (this.clockNs / TICK_NS + 1n) * TICK_NS;
    const timer = this.timers[0]?.atNs;
    return timer !== undefined && timer < tick ? timer : tick;
  }

  /* Time has reached ns: run lwIP's timers and any service events due.
   * Returns the frames sent. */
  advance(ns) {
    this.setClock(ns);
    this.call(() => {
      this.ex.process_timeouts();
      while (this.timers.length && this.timers[0].atNs <= this.clockNs) {
        this.timers.shift().fn();
      }
      this.ex.process_queued_packets();
    });
    return this.takeEmitted();
  }

  /* A service's event at a time on the board's timeline. */
  at(ns, fn) {
    let i = this.timers.length;
    while (i > 0 && this.timers[i - 1].atNs > ns) i--;
    this.timers.splice(i, 0, { atNs: ns, fn });
  }

  /* TCP: onAccept(conn) for each connection to port. */
  tcpListen(port, onAccept) {
    const pcb = this.call(() => this.ex.create_tcp_listener(0, port));
    if (!pcb) throw new Error(`the LAN could not listen on TCP port ${port}`);
    this.listeners.set(pcb, onAccept);
  }

  /* TCP: a connection to ip:port. Set onConnect, onData and onEnd on what
   * comes back; a connection that is refused never calls onConnect. */
  tcpConnect(ip, port) {
    const pcb = this.call(() => this.withBytes(ip, (p) => this.ex.create_tcp_connection(p, port)));
    if (!pcb) return null;
    const conn = new TcpConn(this, pcb);
    this.tcp.set(pcb, conn);
    return conn;
  }

  /* UDP: a socket on port (0 for any), and handler(data, fromIp, fromPort)
   * for what arrives. */
  udpOpen(port, handler) {
    const pcb = this.call(() => this.ex.open_udp_socket(0, port));
    if (!pcb) throw new Error(`the LAN could not open UDP port ${port}`);
    this.udp.set(pcb, handler);
    return {
      send: (data, ip, toPort) => this.call(() => this.withBytes(ip,
        (ipPtr) => this.withBytes(data,
          (dataPtr) => this.ex.send_udp_datagram(pcb, ipPtr, toPort, dataPtr, data.length)))),
      close: () => this.defer(() => {
        this.udp.delete(pcb);
        this.ex.close_udp_socket(pcb);
      }),
    };
  }
}

/* One TCP connection. write() queues and sends as lwIP has room; end()
 * closes once everything written has gone. */
class TcpConn {
  constructor(lan, pcb) {
    this.lan = lan;
    this.pcb = pcb;
    this.queue = [];
    this.ending = false;
    this.closed = false;
  }

  write(bytes) {
    if (this.closed || this.ending) return;
    this.queue.push(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes);
    this.pump();
  }

  end() {
    this.ending = true;
    this.pump();
  }

  pump() {
    const { lan } = this;
    while (!this.closed && this.queue.length) {
      const chunk = this.queue[0].subarray(0, 0xffff);
      const sent = lan.call(() => lan.withBytes(chunk,
        (p) => lan.ex.send_tcp_chunk(this.pcb, p, chunk.length)));
      if (sent === 0) return;    // no room: sent_tcp_chunk calls again
      this.queue[0] = this.queue[0].subarray(sent);
      if (this.queue[0].length === 0) this.queue.shift();
    }
    if (this.ending && !this.closed && this.queue.length === 0) {
      this.closed = true;
      lan.defer(() => {
        lan.tcp.delete(this.pcb);
        lan.ex.close_tcp_connection(this.pcb);
      });
    }
  }
}
