#!/usr/bin/env node
/*
 * The host's LAN (host/lan.mjs), checked without a board.
 *
 * A second lwIP stands in for the board at 192.0.2.1 and uses every service
 * the LAN offers at 192.0.2.2: DHCP, DNS, SNTP, TFTP, HTTP, a WebSocket
 * echo, CoAP over TCP and FTP, and answers the LAN's pings. Then it
 * sends 4 MB through an echo on the LAN and checks it comes back whole,
 * and that every TCP segment on the wire had a good checksum. An echo
 * writes as it reads, so lwIP adds writes to segments not yet sent and
 * chains their buffers, and tcpip.js hands such a frame over as its first
 * buffer only (Lan.frameAt). Before the LAN followed the chain, 4 MB came
 * back 2,256 bytes short: one segment went out with a bad checksum, and
 * again on every retransmission.
 *
 * The whole exchange runs twice, and every frame on the wire must be the
 * same both times: the LAN runs on the clock it is given and nothing else.
 *
 * Usage: node scripts/check_lan.mjs
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import process from 'node:process';

import { Lan, LAN_IP, BOARD_IP } from '../host/lan.mjs';
import {
  startServices, TFTP_FILES, LAN_EPOCH_UNIX, FTP_FILES, COAP_RESOURCES,
  sha1, websocketAccept, coapTcpEncode, coapTcpDecode,
} from '../host/lan_services.mjs';

const wasm = fs.readFileSync(new URL('../host/web/vendor/tcpip.wasm', import.meta.url));
const enc = new TextEncoder();
const dec = new TextDecoder();
const MS = 1_000_000n;

async function scenario() {
  const lanLog = [];
  const lan = await Lan.create(wasm, (line) => lanLog.push(line));
  startServices(lan, { ping: [50, 60] });
  const board = await Lan.create(wasm, () => {}, { ip: BOARD_IP, mac: [2, 0, 0, 0, 0, 1] });
  const wire = createHash('sha256');
  let frames = 0;
  let badSums = 0;
  const look = (f) => {
    wire.update(f);
    frames++;
    if (f.length >= 54 && f[12] === 8 && f[13] === 0 && f[23] === 6 && !tcpSumOk(f)) badSums++;
  };
  let now = 0n;

  /* Frames go both ways, each a tenth of a millisecond on the wire, until
   * neither side has anything more to say; then time moves on. */
  const settle = (fromBoard, fromLan) => {
    let a = fromBoard;
    let b = fromLan;
    while (a.length || b.length) {
      now += 100_000n;
      const next = [];
      for (const f of a) { look(f); b.push(...lan.input(f, now)); }
      for (const f of b.splice(0)) { look(f); next.push(...board.input(f, now)); }
      a = next;
    }
  };
  const tick = (ms) => {
    const end = now + BigInt(ms) * MS;
    while (now < end) {
      now += 10n * MS;
      settle(board.advance(now), lan.advance(now));
    }
  };
  const results = {};

  /* DHCP: a DISCOVER, broadcast, from the board's port 68. */
  const dhcp = board.udpOpen(68, (msg) => {
    results.dhcp = { type: msg[242], yiaddr: [...msg.subarray(16, 20)].join('.') };
  });
  const discover = new Uint8Array(300);
  discover.set([1, 1, 6, 0, 1, 2, 3, 4]);
  discover.set([2, 0, 0, 0, 0, 1], 28);
  discover.set([99, 130, 83, 99, 53, 1, 1, 255], 236);
  dhcp.send(discover, [255, 255, 255, 255], 67);
  settle(board.takeEmitted(), []);
  tick(100);

  /* DNS: google.com, type A. */
  const dns = board.udpOpen(0, (msg) => {
    results.dns = { answers: msg[7], address: [...msg.subarray(msg.length - 4)].join('.') };
  });
  dns.send(new Uint8Array([0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0,
                           6, ...enc.encode('google'), 3, ...enc.encode('com'), 0, 0, 1, 0, 1]),
           LAN_IP, 53);
  settle(board.takeEmitted(), []);
  tick(100);

  /* SNTP: the LAN's clock is its epoch plus the time now. */
  const sntp = board.udpOpen(0, (msg) => {
    results.sntp = new DataView(msg.buffer, msg.byteOffset).getUint32(40) - 2208988800;
  });
  const q = new Uint8Array(48);
  q[0] = 0x23;
  sntp.send(q, LAN_IP, 123);
  const sntpAt = now;
  settle(board.takeEmitted(), []);
  tick(100);

  /* TFTP: read file1.bin, one block, and ack it. */
  const got = [];
  const tftp = board.udpOpen(0, (msg, from, port) => {
    if (msg[1] !== 3) return;
    got.push(msg.subarray(4));
    tftp.send(new Uint8Array([0, 4, msg[2], msg[3]]), from, port);
  });
  tftp.send(new Uint8Array([0, 1, ...enc.encode('file1.bin'), 0, ...enc.encode('octet'), 0]),
            LAN_IP, 69);
  settle(board.takeEmitted(), []);
  tick(200);
  results.tftp = dec.decode(Buffer.concat(got));

  /* HTTP: "/" on google.com. */
  let page = '';
  const http = board.tcpConnect(LAN_IP, 80);
  http.onConnect = () => http.write('GET / HTTP/1.1\r\nHost: google.com\r\n\r\n');
  http.onData = (d) => { page += dec.decode(d); };
  settle(board.takeEmitted(), []);
  tick(1000);
  results.http = page;

  /* WebSocket: the handshake, then a message in two masked frames, the
   * first with a line break in it, which comes back whole in one. */
  let ws = new Uint8Array(0);
  const sock = board.tcpConnect(LAN_IP, 9001);
  sock.onConnect = () => sock.write('GET / HTTP/1.1\r\nHost: 192.0.2.2\r\nUpgrade: websocket\r\n' +
    'Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
    'Sec-WebSocket-Version: 13\r\n\r\n');
  sock.onData = (d) => { ws = Buffer.concat([ws, d]); };
  settle(board.takeEmitted(), []);
  tick(100);
  const mask = [1, 2, 3, 4];
  const wsFrame = (first, fin, t) => {
    const b = enc.encode(t);
    return [(fin ? 0x80 : 0) | (first ? 1 : 0), 0x80 | b.length, ...mask, ...b.map((x, i) => x ^ mask[i & 3])];
  };
  sock.write(Uint8Array.from([...wsFrame(true, false, 'first line\nsec'), ...wsFrame(false, true, 'ond\n')]));
  settle(board.takeEmitted(), []);
  tick(100);
  const head = dec.decode(ws).split('\r\n\r\n')[0];
  results.ws = { head, messages: [] };
  for (let rest = ws.subarray(head.length + 4); rest.length >= 2;) {
    const n = rest[1] & 0x7f;
    results.ws.messages.push([rest[0], dec.decode(rest.subarray(2, 2 + n))]);
    rest = rest.subarray(2 + n);
  }

  /* CoAP over TCP: CSM both ways, a ping, GET /test, and a release. */
  let coapIn = new Uint8Array(0);
  results.coap = [];
  const coap = board.tcpConnect(LAN_IP, 5683);
  coap.onConnect = () => coap.write(coapTcpEncode({ code: 0xe1 }));
  coap.onData = (d) => {
    coapIn = Buffer.concat([coapIn, d]);
    let got;
    while ((got = coapTcpDecode(coapIn))) {
      coapIn = coapIn.subarray(got.size);
      results.coap.push([got.message.code, [...got.message.token], dec.decode(got.message.payload)]);
    }
  };
  coap.onEnd = () => results.coap.push(['closed']);
  settle(board.takeEmitted(), []);
  tick(100);
  coap.write(coapTcpEncode({ code: 0xe2, token: Uint8Array.of(9) }));
  coap.write(coapTcpEncode({ code: 0x01, token: Uint8Array.of(1, 2),
                            options: [[11, enc.encode('test')]] }));
  coap.write(coapTcpEncode({ code: 0x01, token: Uint8Array.of(3), options: [[11, enc.encode('nope')]] }));
  coap.write(coapTcpEncode({ code: 0xe4 }));
  settle(board.takeEmitted(), []);
  tick(100);

  /* FTP: log in, list /, read readme.txt, and store a file, the way
   * Zephyr's client does: PASV, the command, and the data connection once
   * 150 has come back. */
  const ftpCtl = board.tcpConnect(LAN_IP, 21);
  let ctl = '';
  ftpCtl.onData = (d) => { ctl += dec.decode(d); };
  settle(board.takeEmitted(), []);
  tick(50);
  const ftpData = (cmd, put) => {
    ftpCtl.write('PASV\r\n');
    settle(board.takeEmitted(), []);
    tick(50);
    const m = /\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)\s*$/.exec(ctl.trimEnd().split('\r\n').pop());
    ftpCtl.write(`${cmd}\r\n`);
    settle(board.takeEmitted(), []);
    tick(50);
    let got = '';
    const data = board.tcpConnect(LAN_IP, Number(m[5]) * 256 + Number(m[6]));
    data.onConnect = () => { if (put) { data.write(put); data.end(); } };
    data.onData = (d) => { got += dec.decode(d); };
    settle(board.takeEmitted(), []);
    tick(100);
    return got;
  };
  for (const c of ['USER anonymous', 'PASS guest']) {
    ftpCtl.write(`${c}\r\n`);
    settle(board.takeEmitted(), []);
    tick(50);
  }
  results.ftp = { list: ftpData('NLST'), readme: ftpData('RETR readme.txt') };
  ftpData('STOR pub/new.txt', 'written by the check\n');
  results.ftp.back = ftpData('RETR /pub/new.txt');
  results.ftp.control = ctl;

  results.lanLog = lanLog;

  /* 4 MB through an echo on the LAN. */
  lan.tcpListen(7, (conn) => { conn.onData = (d) => conn.write(d); });
  const sent = new Uint8Array(4 * 1024 * 1024);
  for (let i = 0; i < sent.length; i++) sent[i] = (i * 7 + (i >> 8)) & 0xff;
  const back = [];
  const echo = board.tcpConnect(LAN_IP, 7);
  echo.onConnect = () => echo.write(sent);
  echo.onData = (d) => back.push(d);
  settle(board.takeEmitted(), []);
  tick(20_000);
  results.echo = Buffer.concat(back);

  return { results, frames, badSums, wire: wire.digest('hex'), sntpAt, sent };
}

/* The TCP checksum of an IPv4 frame, over the pseudo-header. */
function tcpSumOk(f) {
  const ihl = (f[14] & 15) * 4;
  const len = ((f[16] << 8) | f[17]) - ihl;
  const t = 14 + ihl;
  let sum = 6 + len;
  for (let i = 26; i < 34; i += 2) sum += (f[i] << 8) | f[i + 1];
  for (let i = t; i < t + len; i += 2) sum += (f[i] << 8) | (i + 1 < t + len ? f[i + 1] : 0);
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
  return sum === 0xffff;
}

const first = await scenario();
const second = await scenario();
const { results, sntpAt, sent } = first;

const problems = [];
const expect = (what, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? `: ${detail}` : ''}`);
  if (!ok) problems.push(what);
};

expect('DHCP offers 192.0.2.1', results.dhcp?.type === 2 && results.dhcp?.yiaddr === '192.0.2.1',
       JSON.stringify(results.dhcp));
expect('DNS answers every name with 192.0.2.2',
       results.dns?.answers === 1 && results.dns?.address === '192.0.2.2', JSON.stringify(results.dns));
const wantTime = LAN_EPOCH_UNIX + Number(sntpAt / 1_000_000_000n);
expect('SNTP gives the epoch plus the clock', results.sntp === wantTime, `${results.sntp}`);
expect('TFTP serves file1.bin whole', results.tftp === dec.decode(TFTP_FILES['file1.bin']),
       `${results.tftp.length} bytes`);
expect('HTTP answers "/" with a redirect',
       results.http.startsWith('HTTP/1.1 301') && results.http.includes('The document has moved'),
       JSON.stringify(results.http.split('\r\n')[0]));
const hex = (b) => Buffer.from(b).toString('hex');
expect('SHA-1 of "abc" is the FIPS 180 value',
       hex(sha1(enc.encode('abc'))) === 'a9993e364706816aba3e25717850c26c9cd0d89d');
expect('SHA-1 of a million a\'s is the FIPS 180 value',
       hex(sha1(enc.encode('a'.repeat(1_000_000)))) === '34aa973cd4c4daa4f61eeb2bdbad27316534016f');
expect('the WebSocket accept value is RFC 6455\'s example',
       websocketAccept('dGhlIHNhbXBsZSBub25jZQ==') === 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
expect('WebSocket: 101, with that accept value',
       results.ws.head.startsWith('HTTP/1.1 101') &&
       results.ws.head.includes('Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo='),
       JSON.stringify(results.ws.head.split('\r\n')[0]));
expect('WebSocket: a message comes back whole, as one text message',
       JSON.stringify(results.ws.messages) === JSON.stringify([[0x81, 'first line\nsecond\n']]),
       JSON.stringify(results.ws.messages));
const wantCoap = [[0xe1, [], ''], [0xe3, [9], ''], [0x45, [1, 2], COAP_RESOURCES.test],
                  [0x84, [3], ''], ['closed']];
expect('CoAP over TCP: CSM, pong, 2.05 for /test, 4.04 for the rest, closed on release',
       JSON.stringify(results.coap) === JSON.stringify(wantCoap), JSON.stringify(results.coap));
expect('FTP lists / and serves readme.txt',
       results.ftp.list === 'pub\r\nreadme.txt\r\n' &&
       results.ftp.readme === dec.decode(FTP_FILES['/readme.txt']),
       JSON.stringify(results.ftp.list));
expect('FTP stores a file and gives it back', results.ftp.back === 'written by the check\n',
       JSON.stringify(results.ftp.back));
expect('FTP answers each step', ['220 ', '331 ', '230 ', '227 ', '150 ', '226 '].every(
  (c) => results.ftp.control.includes(`\r\n${c}`) || results.ftp.control.startsWith(c)),
       JSON.stringify(results.ftp.control.split('\r\n').slice(0, 4)));
expect('the LAN pings the board, and hears back',
       results.lanLog.includes('ping 192.0.2.1 seq 0: reply') &&
       results.lanLog.includes('ping 192.0.2.1 seq 1: reply'),
       JSON.stringify(results.lanLog.filter((l) => l.startsWith('ping'))));
expect('4 MB comes back through an echo, whole', Buffer.compare(results.echo, Buffer.from(sent)) === 0,
       `${results.echo.length} of ${sent.length} bytes`);
expect('every TCP segment on the wire has a good checksum', first.badSums === 0,
       `${first.badSums} bad`);
expect('two runs put the same frames on the wire',
       first.wire === second.wire && first.frames === second.frames,
       `${first.frames} frames, ${first.wire.slice(0, 16)}`);

process.exit(problems.length ? 1 : 0);
