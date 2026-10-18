/* A board's Ethernet link to a real network, through a relay.
 *
 * The board's driver already hands the host whole Ethernet frames, so a real
 * network is only another place to send them. A tab cannot open raw sockets,
 * so the frames go over a WebSocket to a relay that runs a TCP/IP stack of
 * its own and turns the board's traffic into real connections: NAT, as a
 * home router does, with DHCP and DNS for the board.
 *
 * The protocol is v86's "wsproxy": one Ethernet frame per binary WebSocket
 * message, in both directions, with nothing else on the wire. It is not ours,
 * which is the point: every relay written for v86 speaks it (websockproxy,
 * go-websockproxy, wsnic, RootlessRelay), so any of them will do.
 * RootlessRelay needs neither root nor a TAP device:
 *
 *   ENABLE_WSS=false npx rootlessrelay        # ws://127.0.0.1:8086/
 *
 * relaynet (https://relaynet.network) is RootlessRelay hosted for many
 * users: the same frames, behind an API token. A link to relaynet speaks
 * its relay.v1 handshake, the token in a second subprotocol entry, through
 * relaynet's own client helper (host/relaynet.mjs, vendored). The token goes
 * to relaynet's endpoint and nowhere else, whatever relay is named. The
 * helper also keeps the session alive: a ping: heartbeat notices a dead
 * socket, and a dropped session is reconnected with backoff. Each
 * reconnect is a new session. The board's MAC does not change, so a DHCP
 * renewal within the relay's 60 s hold gets its address back, but its
 * connections to the internet were reset, which the board finds out as
 * any device does after a network error.
 *
 * Node 22 and a Worker both have WebSocket built in, so this one module
 * serves both, with nothing to install.
 *
 * A frame from the relay is stamped with the board's time now. Real peers
 * follow the wall clock, so an uplinked board is paced, and a run is not
 * repeatable: that is the price of a peer that is not another board.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { connectRelay, RELAY_URL } from './relaynet.mjs';

/* relaynet's endpoint, which takes no session without a token. */
export const RELAYNET_URL = RELAY_URL;
const RELAYNET_HOST = new URL(RELAY_URL).host;
export const isRelaynet = (url) => {
  try { return new URL(url).host === RELAYNET_HOST; } catch { return false; }
};

/* An Ethernet frame without its FCS: 1500 bytes of payload, 14 of header and
 * 4 for a VLAN tag. Anything larger from either side is dropped, not
 * truncated, as a NIC would drop it. */
const FRAME_MAX = 1518;
const FRAME_MIN = 14;

/* Frames the board sends before the socket opens. The first is usually a
 * DHCP discover, a few milliseconds into boot. A small queue keeps them; the
 * guest retries anything older. */
const PENDING_MAX = 64;

/**
 * Link a Host's Ethernet to a relay. Resolves once the socket is open, or
 * rejects if it cannot open, so a run can say so before the board boots.
 *
 * @param host      the Host, before or after it starts
 * @param url       ws:// or wss:// URL of a wsproxy relay
 * @param onStatus  called with a line of text for the terminal when the link
 *                  closes or fails after opening
 * @param token     an API token, if the relay is relaynet's
 */
export function connectUplink(host, url, onStatus = () => {}, token = null) {
  if (isRelaynet(url)) {
    if (!token) {
      return Promise.reject(new Error(
        'relaynet needs an API token: create one at https://relaynet.network'));
    }
    return connectRelayV1(host, url, onStatus, token);
  }
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  let open = false;
  let closing = false;      // closed from this end, which needs no notice
  const pending = [];

  /* The platform can outlive the run (the Worker keeps one for every run),
   * so what was there before goes back when the link closes. */
  const before = host.platform.ethSend;
  const restore = () => { host.platform.ethSend = before; };
  host.platform.ethSend = (frame) => {
    if (frame.length < FRAME_MIN || frame.length > FRAME_MAX) return;
    if (open) ws.send(frame);
    else if (pending.length < PENDING_MAX) pending.push(frame);
  };

  ws.onmessage = (event) => {
    /* Text is not part of the protocol, and neither is a runt or a giant:
     * whatever the relay sends, the board sees only frames. */
    if (!(event.data instanceof ArrayBuffer)) return;
    const frame = new Uint8Array(event.data);
    if (frame.length < FRAME_MIN || frame.length > FRAME_MAX) return;
    host.pushEthernet(frame);
  };

  return new Promise((resolve, reject) => {
    ws.onopen = () => {
      open = true;
      for (const frame of pending) ws.send(frame);
      pending.length = 0;
      resolve({ close: () => { closing = true; restore(); ws.close(); } });
    };
    ws.onerror = () => {
      if (!open) {
        restore();
        reject(new Error(`could not reach the relay at ${url}`));
      }
    };
    ws.onclose = () => {
      if (!open) {
        restore();
        reject(new Error(`could not reach the relay at ${url}`));
        return;
      }
      open = false;
      if (!closing) onStatus(`*** the relay at ${url} closed the link ***`);
    };
  });
}

/* The same link to relaynet, which speaks relay.v1, through its helper,
 * which owns the socket. Resolves when the first session opens, and rejects
 * if it does not, with the relay's reason when it refused the token. */
function connectRelayV1(host, url, onStatus, token) {
  const before = host.platform.ethSend;
  const restore = () => { host.platform.ethSend = before; };
  let relay = null;
  let opened = false;
  const pending = [];
  host.platform.ethSend = (frame) => {
    if (frame.length < FRAME_MIN || frame.length > FRAME_MAX) return;
    if (opened) relay.send(frame);
    else if (pending.length < PENDING_MAX) pending.push(frame);
  };

  return new Promise((resolve, reject) => {
    relay = connectRelay({
      token,
      url,
      onFrame: (frame) => {
        if (frame.length < FRAME_MIN || frame.length > FRAME_MAX) return;
        host.pushEthernet(frame);
      },
      onOpen: ({ reconnect }) => {
        if (reconnect) {
          onStatus(`*** a new session on the relay at ${url}: the board keeps its ` +
                   'address if it renews within 60 s, and its connections to the ' +
                   'internet were reset ***');
          return;
        }
        opened = true;
        for (const frame of pending) relay.send(frame);
        pending.length = 0;
        resolve({ close: () => { restore(); relay.close(); } });
      },
      onClose: ({ code, reason, final, retryInMs }) => {
        if (!opened) {
          /* The first session never opened: the run ends with a message
           * rather than booting a board that waits for ever. */
          relay.close();
          restore();
          reject(new Error(final && reason
            ? `the relay at ${url} refused the session: ${reason}`
            : `could not reach the relay at ${url}`));
          return;
        }
        const why = reason ? `${reason}, ${code}` : `${code}`;
        if (final) {
          restore();
          onStatus(`*** the relay at ${url} ended the session (${why}) ***`);
        } else {
          onStatus(`*** the relay at ${url} dropped the session (${why}); ` +
                   `reconnecting in ${Math.round(retryInMs / 1000)} s ***`);
        }
      },
    });
  });
}
