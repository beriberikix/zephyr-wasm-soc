#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Run every build in the staged site and check it does what it is for.
//
// This replaces a hand-written list of greps in the CI workflow that covered
// three of the five builds. The timeslice test in particular was built on
// every run and never executed, which is the one build with a self-checking
// PASS line in it.
//
// What each build must print lives in scripts/apps.json, beside the build
// itself, so adding a build brings its acceptance criterion with it.
//
// A two-board pair is run twice, and both boards' output must be the same
// both times.
//
// Usage: node scripts/check_site.mjs [_site] [--only name,name]

import { spawn } from 'node:child_process';
import os from 'node:os';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(here, '..', 'host', 'run.mjs');

const args = process.argv.slice(2);
const onlyIdx = args.indexOf('--only');
const only = onlyIdx === -1 ? null : new Set(args[onlyIdx + 1].split(','));
/* A wsproxy relay for the builds on a real network (host/uplink.mjs). CI
 * starts one; without it those builds are skipped, and said to be. */
const relayIdx = args.indexOf('--uplink-relay');
const relay = relayIdx === -1 ? null : args[relayIdx + 1];
const values = new Set([onlyIdx, relayIdx].filter((i) => i !== -1).map((i) => i + 1));
const site = args.find((a, i) => !a.startsWith('--') && !values.has(i))
  ?? path.join(here, '..', '..', '_site');

/* The harness exits 2 when it gives up at --max-time. For an application that
 * never finishes that is the expected end of the run, not a failure. */
function run(wasm, maxTimeMs, stdin, gpio, screenshot, touches, accels, threads, peer, uplink) {
  /* An interactive build only reads its UART input under --interactive, and
   * under that flag it also keeps running while the guest is idle, so it
   * ends at --max-time rather than when the shell falls quiet. */
  const argv = [runner, '--max-time', String(maxTimeMs)];
  if (stdin !== undefined) argv.push('--interactive');
  /* Scripted pin movements happen at a stated guest time, so a sample that
   * waits for a button gives the same output every run. */
  for (const event of gpio ?? []) argv.push('--gpio', event);
  if (screenshot) argv.push('--screenshot', screenshot);
  for (const touch of touches ?? []) argv.push('--touch', touch);
  for (const accel of accels ?? []) argv.push('--accel', accel);
  if (threads) argv.push('--threads');
  /* A two-board entry: the second board runs in the same process, linked,
   * and its output goes to a file of its own. */
  if (peer) {
    argv.push('--peer', peer.wasm, '--peer-out', peer.out);
    if (peer.delayMs) argv.push('--peer-delay', String(peer.delayMs));
    if (peer.stdin) argv.push('--peer-stdin', peer.stdin);
  }
  if (uplink) argv.push('--uplink', uplink);
  argv.push(wasm);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv,
      { stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    if (stdin !== undefined) {
      child.stdin.end(stdin);
    }
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

/* The number of distinct colours in a binary PPM, as written by
 * run.mjs --screenshot. */
async function distinctColours(file) {
  const data = await readFile(file);
  let pos = 0;
  const tokens = [];
  while (tokens.length < 4) {
    while (/\s/.test(String.fromCharCode(data[pos]))) pos++;
    const start = pos;
    while (!/\s/.test(String.fromCharCode(data[pos]))) pos++;
    tokens.push(data.subarray(start, pos).toString());
  }
  pos++;
  const seen = new Set();
  for (let i = pos; i + 2 < data.length; i += 3) {
    seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
  }
  return seen.size;
}

const manifest = JSON.parse(await readFile(path.join(site, 'manifest.json'), 'utf8'));
let failures = 0;
let skipped = 0;

for (const b of manifest.builds) {
  if (only && !only.has(b.name)) continue;
  if (b.uplink && !relay) {
    skipped++;
    console.log(`  skip  ${b.name.padEnd(8)} ${b.title}: needs --uplink-relay <ws-url>`);
    continue;
  }

  /* A pair is judged board by board: each board's expect against its own
   * output. The first board is the one run.mjs writes to stdout. */
  const [first, second] = b.boards ?? [b];
  const wasm = path.join(site, first.path);
  const maxTime = b.ci_max_time_ms ?? b.max_time_ms;
  const peer = second &&
    { wasm: path.join(site, second.path), out: path.join(os.tmpdir(), `check-site-${second.name}.out`),
      delayMs: second.start_after_ms ?? 0 };
  /* What is typed into the second board goes through a file, since stdin
   * is the first board's. */
  if (second?.ci_stdin) {
    peer.stdin = path.join(os.tmpdir(), `check-site-${second.name}.in`);
    await writeFile(peer.stdin, second.ci_stdin);
  }
  /* An interactive build is given its input on stdin, which is how the shell
   * run in the README was checked. */
  const stdin = first.ci_stdin;
  /* A build with a display is also judged by what it drew: the last frame
   * has to show at least display.colors_at_least distinct colours, so a
   * blank or black screen fails even when the console looks right. */
  const shot = b.display ? path.join(os.tmpdir(), `check-site-${b.name}.ppm`) : undefined;
  const { code, out, err } = await run(wasm, maxTime, stdin, b.ci_gpio, shot, b.ci_touch, b.ci_accel,
                                       !!b.threads_expect, peer, b.uplink ? relay : null);
  const peerOut = peer ? await readFile(peer.out, 'utf8').catch(() => '') : '';

  const problems = [];
  /* A pair runs on one clock (host/pair.mjs), so it is as repeatable as a
   * single board: run it again, and both boards must say exactly the same.
   * This is what lets a pair's expectations be more than thresholds. */
  if (second) {
    const again = await run(wasm, maxTime, stdin, b.ci_gpio, shot, b.ci_touch, b.ci_accel,
                            !!b.threads_expect, peer);
    const peerAgain = await readFile(peer.out, 'utf8').catch(() => '');
    if (again.out !== out) problems.push(`the ${first.label}'s output differed on a second run`);
    if (peerAgain !== peerOut) problems.push(`the ${second.label}'s output differed on a second run`);
  }
  /* A build that never finishes ends at --max-time, which is exit 2 and is
   * the expected end of its run rather than a failure. */
  const allowed = b.endless || b.interactive ? [0, 2] : [0];
  if (!allowed.includes(code)) {
    problems.push(`exit code ${code}, expected ${allowed.join(' or ')}`);
  }
  /* ci_expect is what the scripted ci_* input should produce, which only
   * this check scripts; the browser check gives the page real input. */
  for (const want of [...(first.expect ?? []), ...(b.ci_expect ?? [])]) {
    if (!out.includes(want)) {
      problems.push(`missing from the ${second ? `${first.label}'s ` : ''}output: ${JSON.stringify(want)}`);
    }
  }
  for (const want of second?.expect ?? []) {
    if (!peerOut.includes(want)) problems.push(`missing from the ${second.label}'s output: ${JSON.stringify(want)}`);
  }
  /* The thread table goes to stderr, so the output stays what the
   * application printed. */
  for (const want of b.threads_expect ?? []) {
    if (!err.includes(want)) problems.push(`missing from the thread table: ${JSON.stringify(want)}`);
  }
  for (const [pattern, least] of Object.entries(b.expect_at_least ?? {})) {
    const n = (out.match(new RegExp(pattern, 'gm')) ?? []).length;
    if (n < least) problems.push(`${n} lines match /${pattern}/, expected at least ${least}`);
  }

  let drew = '';
  if (shot) {
    const colours = await distinctColours(shot).catch(() => 0);
    const least = b.display.colors_at_least ?? 2;
    if (colours < least) {
      problems.push(`the display showed ${colours} colours, expected at least ${least}`);
    }
    drew = ` (display: ${colours} colours)`;
  }

  if (problems.length === 0) {
    console.log(`  ok    ${b.name.padEnd(8)} ${b.title}${drew}`);
  } else {
    failures++;
    console.log(`  FAIL  ${b.name.padEnd(8)} ${b.title}`);
    for (const p of problems) console.log(`          ${p}`);
    const tail = (out + err + (second ? `\n--- ${second.label} ---\n${peerOut}` : ''))
      .trimEnd().split('\n').slice(-12);
    for (const line of tail) console.log(`        | ${line}`);
  }
}

const ran = manifest.builds.length - skipped;
console.log(failures !== 0
  ? `${failures} of ${ran} builds failed`
  : skipped === 0
    ? `all ${ran} builds ran; score is ${manifest.score} upstream samples`
    : `all ${ran} builds that ran passed; ${skipped} on a real network were skipped, ` +
      'since no relay was given');
process.exit(failures === 0 ? 0 : 1);
