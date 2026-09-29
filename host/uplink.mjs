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
 * Node 22 and a Worker both have WebSocket built in, so this one module
 * serves both, with nothing to install.
 *
 * A frame from the relay is stamped with the board's time now. Real peers
 * follow the wall clock, so an uplinked board is paced, and a run is not
 * repeatable: that is the price of a peer that is not another board.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

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
 */
export function connectUplink(host, url, onStatus = () => {}) {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  let open = false;
  let closing = false;      // closed from this end, which needs no notice
  const pending = [];

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
      resolve({ close: () => { closing = true; ws.close(); } });
    };
    ws.onerror = () => {
      if (!open) reject(new Error(`could not reach the relay at ${url}`));
    };
    ws.onclose = () => {
      if (!open) {
        reject(new Error(`could not reach the relay at ${url}`));
        return;
      }
      open = false;
      if (!closing) onStatus(`*** the relay at ${url} closed the link ***`);
    };
  });
}
