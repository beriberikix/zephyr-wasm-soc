/* Two boards on one clock.
 *
 * A pair is two Hosts joined by an Ethernet link. Each board has its own
 * clock, which starts from zero when the board powers on, as uptime does;
 * the pair puts both on one timeline, where a board's time is its epoch
 * (when it was powered on) plus its own clock. The second board of a pair
 * is powered on start_after_ms into the first's run, in guest time.
 *
 * Frames carry the time they arrive: when they were sent, on the pair's
 * timeline, plus the wire's latency. The receiving board sees a frame when
 * its clock reaches that time, as it sees a scripted button press.
 *
 * The pair always runs the board that is behind, and lets it run only as
 * far as the other board could still reach it: the other's time plus the
 * wire's latency, since nothing the other sends can arrive sooner. An idle
 * board can send nothing before its own next event, so the one that is
 * running may go that much further. This is conservative synchronisation,
 * and it is what makes a pair repeatable: which board runs, and how far,
 * depends only on the two clocks, never on the wall clock.
 *
 * A step cannot be interrupted, so a busy board can run past its limit by
 * up to a step. A frame the other board then sends can be due before the
 * receiver's clock; it is seen at once, a little late. That is still the
 * same every run, because the order in which things run is.
 *
 * Pacing is the pair's, not each board's: the pair's time is held to the
 * wall clock the way a single paced board's is, which changes when things
 * are shown and never what they are. Unpaced, a pair runs as fast as it
 * can.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { LINK_LATENCY_NS } from './core.mjs';

/* As for a single paced board (core.mjs): how far behind before the pace
 * gives up catching up, and how long between turns for the event loop. */
const PACE_BEHIND_MS = 250;
const PACE_YIELD_NS = 50_000_000n;

const max = (a, b) => (a > b ? a : b);

export class Pair {
  /**
   * @param boards   two Hosts, not yet started
   * @param opts     delayNs: when the second board powers on, on the first
   *                 board's clock; paced; timeScale
   */
  constructor(boards, opts = {}) {
    this.boards = boards;
    this.opts = opts;
    this.platform = boards[0].platform;
    this.on = [false, false];
    this.done = false;
    this.exitCode = 0;
    boards[0].epochNs = 0n;
    boards[1].epochNs = opts.delayNs ?? 0n;
    for (const b of boards) b.opts.pair = true;
    /* What each board was last seen doing: running, or idle until an
     * event at `next` on the pair's timeline (null for nothing at all). A
     * board not yet powered on is idle until its power-on. */
    this.seen = [{ idle: false, next: null }, { idle: true, next: boards[1].epochNs }];
    /* The wire. Frames towards a board that is not powered on are lost,
     * as on a cable plugged into nothing. */
    boards.forEach((b, i) => {
      b.platform.ethSend = (frame, atNs) => this.send(1 - i, frame, atNs);
    });
  }

  send(to, frame, atNs) {
    if (!this.on[to]) return;
    this.boards[to].pushEthernet(frame, atNs);
    /* An idle board now has something to wake for. */
    const s = this.seen[to];
    if (s.idle && (s.next === null || atNs < s.next)) s.next = atNs;
    /* And it can answer as soon as the frame arrives, so the board that
     * sent it may go no further than that answer's arrival. Its limit was
     * set before it ran, from what the other board was waiting for then;
     * this frame may wake it sooner. */
    const from = this.boards[1 - to];
    const limit = atNs + LINK_LATENCY_NS - from.epochNs;
    if (from.stepLimitNs === null || limit < from.stepLimitNs) from.stepLimitNs = limit;
  }

  /* A board's time on the pair's timeline. One not yet powered on is at
   * its power-on. */
  time(i) {
    return this.on[i] ? this.boards[i].globalNs : this.boards[i].epochNs;
  }

  /* Idle with nothing to wake it: no event, no frame, no typing. */
  asleep(i) {
    const s = this.seen[i];
    const b = this.boards[i];
    return this.on[i] && s.idle && s.next === null && b.input.length === 0 &&
           (b.externalIrqs & b.enabledLines()) === 0;
  }

  stop() {
    this.done = true;
    for (const b of this.boards) b.done = true;
  }

  async run() {
    const [a, b] = this.boards;
    const plat = this.platform;
    await a.start();
    this.on[0] = true;

    const paced = !!this.opts.paced;
    let pace = null;
    let lastYield = plat.nowNs();
    /* The pair's time: the earlier of its boards that still have
     * something to do. An asleep board's clock stands still until
     * something wakes it, and must not hold the pace back. */
    const now = () => {
      let t = null;
      for (let k = 0; k < 2; k++) {
        if (!this.on[k] || this.asleep(k)) continue;
        const g = this.boards[k].globalNs;
        if (t === null || g < t) t = g;
      }
      return t ?? max(a.globalNs, this.on[1] ? b.globalNs : 0n);
    };
    const reanchor = () => {
      pace = { guest: now(), wall: plat.nowNs(), scale: this.opts.timeScale || 1 };
    };
    if (paced) reanchor();

    while (!this.done) {
      /* Nothing on either board can happen again. */
      if (this.asleep(0) && this.asleep(1)) {
        if (!paced) break;
        /* Paced, and waiting for a person: time passes as it does for
         * them, as it does on a single paced board. */
        await plat.wait(20);
        lastYield = plat.nowNs();
        const byWall = pace.guest +
          BigInt(Math.round(Number(plat.nowNs() - pace.wall) * pace.scale));
        for (const [i, h] of this.boards.entries()) {
          if (this.on[i] && h.globalNs < byWall) h.nowNs = byWall - h.epochNs;
        }
        continue;
      }

      /* The board that is behind runs; an asleep one never needs to. */
      let i = this.time(0) <= this.time(1) ? 0 : 1;
      if (this.asleep(i)) i = 1 - i;
      const j = 1 - i;
      const h = this.boards[i];

      if (!this.on[i]) {
        await h.start();
        this.on[i] = true;
        this.seen[i] = { idle: false, next: null };
        this.opts.poweredOn?.(i);
        continue;
      }

      /* How far it may go: as far as the other board could still reach
       * it. An asleep other board cannot reach it at all. */
      let limit;
      if (this.asleep(j)) limit = null;
      else if (this.seen[j].idle) {
        limit = this.seen[j].next === null ? null
          : max(this.time(j), this.seen[j].next) + LINK_LATENCY_NS;
      } else limit = this.time(j) + LINK_LATENCY_NS;

      const r = await h.runUntil(limit);
      if (r.reason === 'done') {
        this.exitCode = h.exitCode;
        break;
      }
      this.seen[i] = r.reason === 'idle' ? { idle: true, next: r.nextNs }
                                         : { idle: false, next: null };

      if (paced) {
        const scale = this.opts.timeScale || 1;
        if (scale !== pace.scale) reanchor();
        const dueNs = pace.wall + BigInt(Math.round(Number(now() - pace.guest) / scale));
        const aheadMs = Number(dueNs - plat.nowNs()) / 1e6;
        if (aheadMs >= 1) {
          await plat.wait(aheadMs);
          lastYield = plat.nowNs();
          continue;
        }
        if (aheadMs < -PACE_BEHIND_MS) reanchor();
      }
      /* Let the event loop have a turn now and then: typed input, Stop and
       * a change of speed arrive through it. */
      if (plat.nowNs() - lastYield > PACE_YIELD_NS) {
        await plat.yieldToEventLoop(a.input.length > 0 || b.input.length > 0);
        lastYield = plat.nowNs();
      }
    }
    this.stop();
    for (const [i, h] of this.boards.entries()) if (this.on[i]) h.finish();
    return this.exitCode;
  }
}
