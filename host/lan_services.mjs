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
 * - Dialling: connect to a port on the board at a given time and send a
 *   request, for samples that are servers.
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
 * @param opts  dial: [{ atMs, port, send }] requests to make to the board
 */
export function startServices(lan, opts = {}) {
  dhcp(lan);
  for (const port of [53, 15353]) dns(lan, port);
  sntp(lan);
  tftp(lan);
  http(lan);
  for (const d of opts.dial ?? []) dial(lan, d);
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

/* --- Dialling the board ---------------------------------------------- */

/* Connect to the board's port at atMs and send `send`, trying again a
 * second later while the board is not listening yet. */
function dial(lan, { atMs, port, send, tries = 5 }) {
  const attempt = (n) => {
    const conn = lan.tcpConnect(BOARD_IP, port);
    if (!conn) return;
    let answered = 0;
    let connected = false;
    conn.onConnect = () => {
      connected = true;
      conn.write(send);
    };
    conn.onData = (data) => { answered += data.length; };
    conn.onEnd = () => {
      lan.log(`dialled ${BOARD_IP.join('.')}:${port}, ${answered} bytes back`);
    };
    if (n > 1) {
      lan.at(lan.clockNs + 1_000_000_000n, () => { if (!connected) attempt(n - 1); });
    }
  };
  lan.at(BigInt(atMs) * 1_000_000n, () => attempt(tries));
}
