/* What the host's LAN (host/lan.mjs) offers a board, as the Linux host
 * upstream's networking samples expect at 192.0.2.2 would.
 *
 * Every answer comes from the board's clock and from constants here, never
 * from the outside world, so a run on the LAN is as repeatable as any
 * other. The LAN is a sandbox: nothing leaves it. A name resolves to the
 * LAN's own address, so whichever server a sample asks for, the LAN is it,
 * and the LAN says so wherever it answers in words.
 *
 * - DHCP on 67: offers 192.0.2.1, the address the samples use statically,
 *   with the LAN as router and DNS server.
 * - DNS on 53 (and on 15353, where dns_resolve asks): every A query is
 *   answered with 192.0.2.2; anything else with no records, since the LAN
 *   speaks only IPv4.
 * - SNTP on 123: the time is a fixed date plus the board's clock.
 * - TFTP on 69: file1.bin to read, and any file may be written.
 * - HTTP on 80: one short page for any request; for "/" on any host, a
 *   redirect, which is what http_get's upstream test expects from
 *   google.com.
 * - WebSocket on 9001: an echo, for websocket_client: each message comes
 *   back whole, as one text message.
 * - CoAP over TCP on 5683 (RFC 8323): signalling, and GET /test, as
 *   coap_client_tcp's README sets up with aiocoap.
 * - FTP on 21, passive mode only, as Zephyr's FTP client uses it: any user
 *   and password, a small tree to list and read, and room to write, which
 *   lasts as long as the page does.
 * - Dialling: connect to a port on the board at a given time and send a
 *   request, for samples that are servers.
 * - Pinging: ICMP echo requests to the board at given times, so that a
 *   sample that watches what arrives has something to see.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { LAN_IP, BOARD_IP } from './lan.mjs';

/* 2026-01-01T00:00:00Z. The LAN's clock starts there when the board's
 * does, so SNTP gives the same answer every run. */
export const LAN_EPOCH_UNIX = 1767225600;
const NTP_UNIX_OFFSET = 2208988800;

const BROADCAST = [255, 255, 255, 255];
const enc = new TextEncoder();
const dec = new TextDecoder();

export const TFTP_FILES = {
  'file1.bin': enc.encode(
    'This file was served by the host\'s LAN, lwIP at 192.0.2.2, running on\n' +
    'the board\'s own clock. Nothing left the page to fetch it.\n'),
};

/**
 * Put the services on a Lan.
 * @param lan   a Lan
 * @param opts  dial: [{ atMs, port, send }] requests to make to the board;
 *              ping: [ms] times to ping it at
 */
export function startServices(lan, opts = {}) {
  dhcp(lan);
  for (const port of [53, 15353]) dns(lan, port);
  sntp(lan);
  tftp(lan);
  http(lan);
  websocket(lan);
  coapTcp(lan);
  ftp(lan);
  for (const d of opts.dial ?? []) dial(lan, d);
  pings(lan, opts.ping ?? []);
}

/* --- DHCP ------------------------------------------------------------ */

function dhcp(lan) {
  const sock = lan.udpOpen(67, (msg) => {
    if (msg.length < 240 || msg[0] !== 1) return;                 // BOOTREQUEST
    if (msg[236] !== 99 || msg[237] !== 130 || msg[238] !== 83 || msg[239] !== 99) return;
    const type = dhcpOption(msg, 53)?.[0];
    const reply = type === 1 ? 2 : type === 3 ? 5 : 0;             // OFFER, ACK
    if (!reply) return;
    const out = new Uint8Array(300);
    out.set([2, 1, 6, 0]);                                         // BOOTREPLY, Ethernet
    out.set(msg.subarray(4, 12), 4);                               // xid, secs, flags
    out.set(BOARD_IP, 16);                                         // yiaddr
    out.set(LAN_IP, 20);                                           // siaddr
    out.set(msg.subarray(28, 44), 28);                             // chaddr
    out.set([99, 130, 83, 99], 236);
    const opts = [
      53, 1, reply,
      54, 4, ...LAN_IP,
      51, 4, 0, 1, 0x51, 0x80,                                     // a day
      1, 4, 255, 255, 255, 0,
      3, 4, ...LAN_IP,
      6, 4, ...LAN_IP,
      255,
    ];
    out.set(opts, 240);
    sock.send(out, BROADCAST, 68);
    lan.log(`DHCP ${reply === 2 ? 'offered' : 'acknowledged'} ${BOARD_IP.join('.')}`);
  });
}

function dhcpOption(msg, code) {
  for (let i = 240; i < msg.length;) {
    const c = msg[i];
    if (c === 255) break;
    if (c === 0) { i++; continue; }
    const len = msg[i + 1];
    if (c === code) return msg.subarray(i + 2, i + 2 + len);
    i += 2 + len;
  }
  return null;
}

/* --- DNS ------------------------------------------------------------- */

function dns(lan, port) {
  const sock = lan.udpOpen(port, (q, from, fromPort) => {
    if (q.length < 12 || (q[2] & 0x80)) return;                    // not a query
    let i = 12;
    const labels = [];
    while (i < q.length && q[i] !== 0) {
      labels.push(dec.decode(q.subarray(i + 1, i + 1 + q[i])));
      i += 1 + q[i];
    }
    const qEnd = i + 5;                                            // 0, type, class
    if (qEnd > q.length) return;
    const qtype = (q[i + 1] << 8) | q[i + 2];
    const answer = qtype === 1;                                    // A
    const out = new Uint8Array(qEnd + (answer ? 16 : 0));
    out.set(q.subarray(0, 2), 0);                                  // id
    out.set([0x80 | (q[2] & 0x01), 0x80, 0, 1, 0, answer ? 1 : 0, 0, 0, 0, 0], 2);  // QR, RD as asked; RA
    out.set(q.subarray(12, qEnd), 12);
    if (answer) {
      out.set([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0x0e, 0x10, 0, 4, ...LAN_IP], qEnd);
    }
    sock.send(out, from, fromPort);
    lan.log(`DNS ${labels.join('.')} ${answer ? `-> ${LAN_IP.join('.')}` : '(no IPv6 here)'}`);
  });
}

/* --- SNTP ------------------------------------------------------------ */

function sntp(lan) {
  const sock = lan.udpOpen(123, (q, from, fromPort) => {
    if (q.length < 48) return;
    const now = ntpTime(lan.clockNs);
    const out = new Uint8Array(48);
    out.set([0x24, 1, q[2], 0xec]);                                // v4, server; stratum 1
    out.set(enc.encode('LAN'), 12);                                // reference id
    out.set(now, 16);                                              // reference
    out.set(q.subarray(40, 48), 24);                               // originate
    out.set(now, 32);                                              // receive
    out.set(now, 40);                                              // transmit
    sock.send(out, from, fromPort);
    lan.log('SNTP answered');
  });
}

function ntpTime(ns) {
  const secs = BigInt(LAN_EPOCH_UNIX + NTP_UNIX_OFFSET) + ns / 1_000_000_000n;
  const frac = ((ns % 1_000_000_000n) << 32n) / 1_000_000_000n;
  const out = new Uint8Array(8);
  const v = new DataView(out.buffer);
  v.setUint32(0, Number(secs & 0xffffffffn));
  v.setUint32(4, Number(frac));
  return out;
}

/* --- TFTP ------------------------------------------------------------ */

const TFTP_BLOCK = 512;

function tftp(lan) {
  lan.udpOpen(69, (req, from, fromPort) => {
    const op = (req[0] << 8) | req[1];
    const name = dec.decode(req.subarray(2, req.indexOf(0, 2)));
    /* Each transfer has its own port, as RFC 1350 has it. */
    if (op === 1) tftpRead(lan, name, from, fromPort);
    else if (op === 2) tftpWrite(lan, name, from, fromPort);
  });
}

function tftpError(sock, to, port, code, text) {
  sock.send(new Uint8Array([0, 5, 0, code, ...enc.encode(text), 0]), to, port);
  sock.close();
}

function tftpRead(lan, name, to, port) {
  const file = TFTP_FILES[name];
  let block = 1;
  const sendBlock = () => {
    const data = file.subarray((block - 1) * TFTP_BLOCK, block * TFTP_BLOCK);
    sock.send(new Uint8Array([0, 3, block >> 8, block & 0xff, ...data]), to, port);
  };
  const sock = lan.udpOpen(0, (msg) => {
    const op = (msg[0] << 8) | msg[1];
    const acked = (msg[2] << 8) | msg[3];
    if (op !== 4) return;
    if (acked !== block) { sendBlock(); return; }                  // resend
    if ((block - 1) * TFTP_BLOCK + TFTP_BLOCK > file.length) {
      lan.log(`TFTP sent ${name}, ${file.length} bytes`);
      sock.close();
      return;
    }
    block++;
    sendBlock();
  });
  if (!file) { tftpError(sock, to, port, 1, 'File not found'); return; }
  sendBlock();
}

function tftpWrite(lan, name, to, port) {
  const parts = [];
  let expected = 1;
  const ack = (n) => sock.send(new Uint8Array([0, 4, n >> 8, n & 0xff]), to, port);
  const sock = lan.udpOpen(0, (msg) => {
    const op = (msg[0] << 8) | msg[1];
    const block = (msg[2] << 8) | msg[3];
    if (op !== 3) return;
    if (block === expected) {
      parts.push(msg.subarray(4));
      expected++;
    }
    ack(block);
    if (block === expected - 1 && msg.length - 4 < TFTP_BLOCK) {
      const size = parts.reduce((n, p) => n + p.length, 0);
      lan.log(`TFTP received ${name}, ${size} bytes`);
      sock.close();
    }
  });
  ack(0);
}

/* --- HTTP ------------------------------------------------------------ */

function http(lan) {
  lan.tcpListen(80, (conn) => {
    let buf = '';
    conn.onData = (data) => {
      buf += dec.decode(data);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const [method, path] = buf.split('\r\n', 1)[0].split(' ');
      const host = /^host:\s*(\S+)/im.exec(buf.slice(0, end))?.[1] ?? LAN_IP.join('.');
      conn.write(httpResponse(method, host, path));
      conn.end();
      lan.log(`HTTP ${method} ${host}${path}`);
    };
  });
}

/* What the LAN answers. "/" on any host is a redirect to the same host's
 * www name, the answer upstream's http_get test looks for from
 * google.com; anything else is a short page saying where it came from. */
function httpResponse(method, host, path) {
  const bare = host.replace(/:\d+$/, '').replace(/^www\./, '');
  const [status, headers, body] = path === '/' && !host.startsWith('www.')
    ? ['301 Moved Permanently', [`Location: http://www.${bare}/`],
       '<HTML><HEAD><TITLE>301 Moved</TITLE></HEAD><BODY>\n' +
       '<H1>301 Moved</H1>\n' +
       `The document has moved <A HREF="http://www.${bare}/">here</A>.\n` +
       'Answered by the host\'s LAN, not the internet.\n' +
       '</BODY></HTML>\n']
    : ['200 OK', [],
       `<HTML><BODY>\n${method} ${path} on ${host}, answered by the host's LAN ` +
       'at 192.0.2.2. Nothing left the page.\n</BODY></HTML>\n'];
  const bytes = enc.encode(body);
  return [`HTTP/1.1 ${status}`, 'Server: zephyr-wasm LAN', 'Content-Type: text/html',
          ...headers, `Content-Length: ${bytes.length}`, 'Connection: close', '', ''].join('\r\n') +
         body;
}

/* --- WebSocket (RFC 6455) --------------------------------------------- */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/* What the server sends back for a client's Sec-WebSocket-Key. */
export function websocketAccept(key) {
  return base64(sha1(enc.encode(key + WS_GUID)));
}

/* An echo by messages: each one comes back whole, as one text message,
 * however many frames it came in. websocket_client suggests websocketd
 * running cat, which answers line by line, but what it checks is that the
 * bytes it sent come back in one message, and the text it sends has line
 * breaks in it. */
function websocket(lan) {
  lan.tcpListen(9001, (conn) => {
    let head = '';
    let upgraded = false;
    let buf = new Uint8Array(0);
    let message = [];
    let messages = 0;
    const frame = (opcode, payload) => {
      const n = payload.length;
      const len = n < 126 ? [n] : n < 65536 ? [126, n >> 8, n & 0xff]
        : [127, 0, 0, 0, 0, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
      const out = new Uint8Array(1 + len.length + n);
      out.set([0x80 | opcode, ...len]);                            // FIN; unmasked
      out.set(payload, 1 + len.length);
      conn.write(out);
    };
    const onFrame = (fin, opcode, payload) => {
      if (opcode <= 2) {                                           // continuation, text, binary
        message.push(payload);
        if (fin) {
          frame(1, message.reduce(concat, new Uint8Array(0)));
          message = [];
          messages++;
        }
      } else if (opcode === 8) {                                   // close
        frame(8, payload.subarray(0, 2));
        conn.end();
      } else if (opcode === 9) {                                   // ping
        frame(10, payload);
      }
    };
    conn.onData = (data) => {
      if (!upgraded) {
        head += dec.decode(data);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) return;
        const key = /^sec-websocket-key:\s*(\S+)/im.exec(head.slice(0, end))?.[1];
        if (!key) {
          conn.write(httpResponse('GET', LAN_IP.join('.'), '/'));
          conn.end();
          return;
        }
        conn.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket',
                    'Connection: Upgrade', `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
                    '', ''].join('\r\n'));
        upgraded = true;
        lan.log('WebSocket upgraded on 9001');
        data = enc.encode(head.slice(end + 4));
      }
      buf = concat(buf, data);
      for (;;) {
        if (buf.length < 2) return;
        let n = buf[1] & 0x7f;
        let at = 2;
        if (n === 126) {
          if (buf.length < 4) return;
          n = (buf[2] << 8) | buf[3];
          at = 4;
        } else if (n === 127) {
          if (buf.length < 10) return;
          n = Number(new DataView(buf.buffer, buf.byteOffset + 2).getBigUint64(0));
          at = 10;
        }
        const masked = buf[1] & 0x80;
        const mask = masked ? buf.subarray(at, at + 4) : null;
        if (masked) at += 4;
        if (buf.length < at + n) return;
        const payload = buf.slice(at, at + n);
        if (mask) for (let i = 0; i < n; i++) payload[i] ^= mask[i & 3];
        const fin = (buf[0] & 0x80) !== 0;
        const opcode = buf[0] & 0x0f;
        buf = buf.subarray(at + n);
        onFrame(fin, opcode, payload);
      }
    };
    conn.onEnd = () => lan.log(`WebSocket closed after ${messages} messages echoed`);
  });
}

function concat(a, b) {
  if (!a.length) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/* SHA-1 (FIPS 180-4), for the handshake only. Web Crypto has one, but it
 * answers with a promise, and everything on the LAN happens within a
 * call. */
export function sha1(bytes) {
  const bits = bytes.length * 8;
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const pv = new DataView(padded.buffer);
  pv.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
  pv.setUint32(padded.length - 4, bits >>> 0);
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Uint32Array(80);
  const rotl = (x, n) => (x << n) | (x >>> (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = pv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let [a, b, c, d, e] = h;
    for (let i = 0; i < 80; i++) {
      const [f, k] = i < 20 ? [(b & c) | (~b & d), 0x5a827999]
        : i < 40 ? [b ^ c ^ d, 0x6ed9eba1]
        : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc]
        : [b ^ c ^ d, 0xca62c1d6];
      const t = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30) >>> 0;
      b = a;
      a = t;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const ov = new DataView(out.buffer);
  h.forEach((x, i) => ov.setUint32(i * 4, x));
  return out;
}

function base64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/* --- CoAP over TCP (RFC 8323) ----------------------------------------- */

const COAP = {
  GET: 0x01, CONTENT: 0x45, NOT_FOUND: 0x84, NOT_ALLOWED: 0x85,
  CSM: 0xe1, PING: 0xe2, PONG: 0xe3, RELEASE: 0xe4, ABORT: 0xe5,
};
const COAP_URI_PATH = 11;
const COAP_CONTENT_FORMAT = 12;
const COAP_MAX_MESSAGE_SIZE = 2;                                   // in a CSM

export const COAP_RESOURCES = {
  test: 'Hello from CoAP TCP, served by the page\'s simulated network.',
};

/* One message: { code, token, options: [[number, bytes]], payload }. */
export function coapTcpEncode({ code, token = new Uint8Array(0), options = [], payload }) {
  const body = [];
  let last = 0;
  for (const [num, value] of [...options].sort((x, y) => x[0] - y[0])) {
    const [d, dx] = coapNibble(num - last);
    const [l, lx] = coapNibble(value.length);
    body.push((d << 4) | l, ...dx, ...lx, ...value);
    last = num;
  }
  if (payload?.length) body.push(0xff, ...payload);
  const n = body.length;
  const [len, ext] = n < 13 ? [n, []] : n < 269 ? [13, [n - 13]]
    : n < 65805 ? [14, [(n - 269) >> 8, (n - 269) & 0xff]]
    : [15, [((n - 65805) >>> 24) & 0xff, ((n - 65805) >> 16) & 0xff,
            ((n - 65805) >> 8) & 0xff, (n - 65805) & 0xff]];
  return Uint8Array.from([(len << 4) | token.length, ...ext, code, ...token, ...body]);
}

function coapNibble(n) {
  return n < 13 ? [n, []] : n < 269 ? [13, [n - 13]] : [14, [(n - 269) >> 8, (n - 269) & 0xff]];
}

/* The first whole message in buf, and how many bytes it took, or null. */
export function coapTcpDecode(buf) {
  if (buf.length < 1) return null;
  const tkl = buf[0] & 0x0f;
  let len = buf[0] >> 4;
  let at = 1;
  const extra = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 4][len];
  if (buf.length < at + extra) return null;
  if (len === 13) len = buf[1] + 13;
  else if (len === 14) len = ((buf[1] << 8) | buf[2]) + 269;
  else if (len === 15) len = new DataView(buf.buffer, buf.byteOffset + 1).getUint32(0) + 65805;
  at += extra;
  const end = at + 1 + tkl + len;
  if (buf.length < end) return null;
  const code = buf[at];
  const token = buf.slice(at + 1, at + 1 + tkl);
  const options = [];
  let payload = new Uint8Array(0);
  let num = 0;
  for (let i = at + 1 + tkl; i < end;) {
    if (buf[i] === 0xff) { payload = buf.slice(i + 1, end); break; }
    let d = buf[i] >> 4;
    let l = buf[i] & 0x0f;
    i++;
    if (d === 13) d = buf[i++] + 13;
    else if (d === 14) { d = ((buf[i] << 8) | buf[i + 1]) + 269; i += 2; }
    if (l === 13) l = buf[i++] + 13;
    else if (l === 14) { l = ((buf[i] << 8) | buf[i + 1]) + 269; i += 2; }
    num += d;
    options.push([num, buf.slice(i, i + l)]);
    i += l;
  }
  return { message: { code, token, options, payload }, size: end };
}

function coapTcp(lan) {
  lan.tcpListen(5683, (conn) => {
    let buf = new Uint8Array(0);
    const send = (m) => conn.write(coapTcpEncode(m));
    /* Both ends open with a CSM; this one says how big a message may be. */
    send({ code: COAP.CSM, options: [[COAP_MAX_MESSAGE_SIZE, Uint8Array.from([0x04, 0x80])]] });
    conn.onData = (data) => {
      buf = concat(buf, data);
      let got;
      while ((got = coapTcpDecode(buf))) {
        buf = buf.subarray(got.size);
        const { code, token, options } = got.message;
        if (code === COAP.PING) {
          send({ code: COAP.PONG, token });
          lan.log('CoAP ping, pong');
        } else if (code === COAP.RELEASE || code === COAP.ABORT) {
          lan.log(`CoAP ${code === COAP.RELEASE ? 'release' : 'abort'}, closing`);
          conn.end();
          return;
        } else if (code >> 5 === 0 && code !== 0) {                // a request
          const path = options.filter(([n]) => n === COAP_URI_PATH)
            .map(([, v]) => dec.decode(v)).join('/');
          const found = COAP_RESOURCES[path];
          if (code !== COAP.GET) {
            send({ code: COAP.NOT_ALLOWED, token });
          } else if (found === undefined) {
            send({ code: COAP.NOT_FOUND, token });
          } else {
            send({ code: COAP.CONTENT, token, options: [[COAP_CONTENT_FORMAT, new Uint8Array(0)]],
                   payload: enc.encode(found) });
          }
          lan.log(`CoAP ${code === COAP.GET ? 'GET' : `0.${String(code).padStart(2, '0')}`} /${path}`);
        }
      }
    };
  });
}

/* --- FTP (RFC 959), passive mode ------------------------------------ */

const FTP_DATA_PORT = 50021;

/* The tree a session starts with: a path to its contents, or null for a
 * directory. */
export const FTP_FILES = {
  '/readme.txt': enc.encode(
    'This is the FTP server of the page\'s simulated network: lwIP at\n' +
    '192.0.2.2, on the board\'s own clock. Nothing here left the page.\n'),
  '/pub': null,
  '/pub/hello.txt': enc.encode('Hello from FTP on the page.\n'),
};

function ftp(lan) {
  const tree = new Map(Object.entries(FTP_FILES));
  /* Sessions whose transfer waits for its data connection, in the order
   * they asked, and data connections that arrived before their command. */
  const waiting = [];
  const early = [];
  lan.tcpListen(FTP_DATA_PORT, (data) => {
    const session = waiting.shift();
    if (session) session(data);
    else early.push(data);
  });
  const withData = (fn) => {
    const data = early.shift();
    if (data) fn(data);
    else waiting.push(fn);
  };

  lan.tcpListen(21, (conn) => {
    let line = '';
    let cwd = '/';
    let renaming = null;
    const reply = (text) => conn.write(`${text}\r\n`);
    const resolve = (arg) => {
      const parts = (arg?.startsWith('/') ? arg : `${cwd}/${arg ?? ''}`).split('/');
      const out = [];
      for (const p of parts) {
        if (p === '..') out.pop();
        else if (p && p !== '.') out.push(p);
      }
      return `/${out.join('/')}`;
    };
    const isDir = (path) => path === '/' || tree.get(path) === null;
    const children = (dir) => [...tree.keys()]
      .filter((k) => k !== dir && k.startsWith(dir === '/' ? '/' : `${dir}/`) &&
                     !k.slice(dir === '/' ? 1 : dir.length + 1).includes('/'))
      .sort();
    const listLine = (path) => {
      const name = path.slice(path.lastIndexOf('/') + 1);
      const size = isDir(path) ? 0 : tree.get(path).length;
      return `${isDir(path) ? 'drwxr-xr-x' : '-rw-r--r--'} 1 lan lan ${String(size).padStart(8)} ` +
             `Jan  1  2026 ${name}\r\n`;
    };
    const send = (bytes, what) => {
      reply(`150 Opening data connection for ${what}`);
      withData((data) => {
        data.write(bytes);
        data.end();
        reply('226 Transfer complete');
      });
    };
    const receive = (path, append) => {
      reply(`150 Ready to receive ${path}`);
      withData((data) => {
        const parts = [];
        data.onData = (d) => parts.push(d);
        data.onEnd = () => {
          const before = append && !isDir(path) ? tree.get(path) ?? new Uint8Array(0) : new Uint8Array(0);
          const body = concat(before, Uint8Array.from(parts.flatMap((p) => [...p])));
          tree.set(path, body);
          reply('226 Transfer complete');
          lan.log(`FTP stored ${path}, ${body.length} bytes`);
        };
      });
    };
    const command = (cmd, arg) => {
      const path = resolve(arg);
      switch (cmd) {
        case 'USER': return reply('331 Any password will do');
        case 'PASS': return reply('230 Logged in');
        case 'SYST': return reply('215 UNIX Type: L8');
        case 'FEAT': return reply('211-Features:\r\n PASV\r\n SIZE\r\n211 End');
        case 'PWD': return reply(`257 "${cwd}" is the current directory`);
        case 'CWD':
          if (!isDir(path)) return reply(`550 ${arg}: no such directory`);
          cwd = path;
          return reply(`250 Directory is now ${cwd}`);
        case 'CDUP':
          cwd = resolve('..');
          return reply(`250 Directory is now ${cwd}`);
        case 'TYPE': case 'MODE': case 'STRU': return reply(`200 ${cmd} set to ${arg}`);
        case 'NOOP': return reply('200 OK');
        case 'PASV':
          return reply(`227 Entering Passive Mode (${LAN_IP.join(',')},` +
                       `${FTP_DATA_PORT >> 8},${FTP_DATA_PORT & 0xff})`);
        case 'EPSV': return reply(`229 Entering Extended Passive Mode (|||${FTP_DATA_PORT}|)`);
        case 'LIST': case 'NLST': {
          /* Options such as -l come before the path, as ls takes them. */
          const target = resolve(arg?.split(' ').filter((a) => !a.startsWith('-')).pop());
          if (!isDir(target) && !tree.has(target)) return reply(`550 ${arg}: not found`);
          const entries = isDir(target) ? children(target) : [target];
          const text = entries.map((e) => (cmd === 'LIST' ? listLine(e)
            : `${e.slice(e.lastIndexOf('/') + 1)}\r\n`)).join('');
          return send(enc.encode(text), target);
        }
        case 'RETR':
          if (isDir(path) || !tree.has(path)) return reply(`550 ${arg}: no such file`);
          lan.log(`FTP sent ${path}`);
          return send(tree.get(path), `${path} (${tree.get(path).length} bytes)`);
        case 'SIZE':
          if (isDir(path) || !tree.has(path)) return reply(`550 ${arg}: no such file`);
          return reply(`213 ${tree.get(path).length}`);
        case 'STOR': case 'APPE':
          if (isDir(path) || !isDir(resolve(`${arg}/..`))) return reply(`553 ${arg}: cannot write here`);
          return receive(path, cmd === 'APPE');
        case 'DELE':
          if (isDir(path) || !tree.delete(path)) return reply(`550 ${arg}: no such file`);
          return reply(`250 Deleted ${path}`);
        case 'MKD':
          if (tree.has(path) || path === '/') return reply(`550 ${arg}: exists`);
          tree.set(path, null);
          return reply(`257 "${path}" created`);
        case 'RMD':
          if (!isDir(path) || path === '/' || children(path).length) {
            return reply(`550 ${arg}: not an empty directory`);
          }
          tree.delete(path);
          return reply(`250 Removed ${path}`);
        case 'RNFR':
          if (!tree.has(path)) return reply(`550 ${arg}: not found`);
          renaming = path;
          return reply('350 Ready for the new name');
        case 'RNTO':
          if (!renaming || tree.has(path)) return reply('503 Nothing to rename, or the name is taken');
          tree.set(path, tree.get(renaming));
          tree.delete(renaming);
          renaming = null;
          return reply(`250 Renamed to ${path}`);
        case 'QUIT':
          reply('221 Goodbye');
          return conn.end();
        default:
          return reply(`502 ${cmd} is not implemented here`);
      }
    };
    reply('220 FTP on the page\'s simulated network, lwIP at 192.0.2.2');
    conn.onData = (data) => {
      line += dec.decode(data);
      let end;
      while ((end = line.indexOf('\r\n')) >= 0) {
        const text = line.slice(0, end);
        line = line.slice(end + 2);
        const space = text.indexOf(' ');
        const cmd = (space < 0 ? text : text.slice(0, space)).toUpperCase();
        const arg = space < 0 ? undefined : text.slice(space + 1);
        lan.log(`FTP ${cmd === 'PASS' ? 'PASS ...' : text}`);
        command(cmd, arg);
      }
    };
  });
}

/* --- Pinging the board ------------------------------------------------ */

/* Each ping is logged with its answer, or with none if a second passes
 * without one. */
function pings(lan, times) {
  const to = BOARD_IP.join('.');
  lan.onPingReply = (from, seq) => lan.log(`ping ${from.join('.')} seq ${seq}: reply`);
  times.forEach((ms, seq) => lan.at(BigInt(ms) * 1_000_000n, () => {
    lan.ping(BOARD_IP, seq);
    lan.at(lan.clockNs + 1_000_000_000n, () => {
      if (lan.pinging.delete(seq)) lan.log(`ping ${to} seq ${seq}: no reply`);
    });
  }));
}

/* --- Dialling the board ---------------------------------------------- */

/* The request a dial sends: a GET for path. */
export function httpGet(path = '/') {
  return `GET ${path} HTTP/1.0\r\n\r\n`;
}

/* Connect to the board's port at atMs and send `send`, trying again a
 * second later while the board is not listening yet. What came back is
 * logged by its first line, which for HTTP is the status. */
function dial(lan, { atMs, port, send, tries = 5 }) {
  const attempt = (n) => {
    const conn = lan.tcpConnect(BOARD_IP, port);
    if (!conn) return;
    const back = [];
    let connected = false;
    conn.onConnect = () => {
      connected = true;
      conn.write(send);
    };
    conn.onData = (data) => back.push(data);
    conn.onEnd = () => {
      const all = back.reduce(concat, new Uint8Array(0));
      const first = dec.decode(all.subarray(0, 200)).split('\r\n', 1)[0];
      lan.log(`dialled ${BOARD_IP.join('.')}:${port}, ${all.length} bytes back` +
              (first ? `: ${first}` : ''));
    };
    if (n > 1) {
      lan.at(lan.clockNs + 1_000_000_000n, () => { if (!connected) attempt(n - 1); });
    }
  };
  lan.at(BigInt(atMs) * 1_000_000n, () => attempt(tries));
}
