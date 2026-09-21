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
// Usage: node scripts/check_site.mjs [_site] [--only name,name]

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(here, '..', 'host', 'run.mjs');

const args = process.argv.slice(2);
const onlyIdx = args.indexOf('--only');
const only = onlyIdx === -1 ? null : new Set(args[onlyIdx + 1].split(','));
const site = args.find((a, i) => !a.startsWith('--') && (onlyIdx === -1 || i !== onlyIdx + 1))
  ?? path.join(here, '..', '..', '_site');

/* The harness exits 2 when it gives up at --max-time. For an application that
 * never finishes that is the expected end of the run, not a failure. */
function run(wasm, maxTimeMs, stdin, gpio) {
  /* An interactive build only reads its UART input under --interactive, and
   * under that flag it also keeps running while the guest is idle, so it
   * ends at --max-time rather than when the shell falls quiet. */
  const argv = [runner, '--max-time', String(maxTimeMs)];
  if (stdin !== undefined) argv.push('--interactive');
  /* Scripted pin movements happen at a stated guest time, so a sample that
   * waits for a button gives the same output every run. */
  for (const event of gpio ?? []) argv.push('--gpio', event);
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

const manifest = JSON.parse(await readFile(path.join(site, 'manifest.json'), 'utf8'));
let failures = 0;

for (const b of manifest.builds) {
  if (only && !only.has(b.name)) continue;

  const wasm = path.join(site, b.path);
  const maxTime = b.ci_max_time_ms ?? b.max_time_ms;
  /* An interactive build is given its input on stdin, which is how the shell
   * run in the README was checked. */
  const stdin = b.ci_stdin;
  const { code, out, err } = await run(wasm, maxTime, stdin, b.ci_gpio);

  const problems = [];
  /* A build that never finishes ends at --max-time, which is exit 2 and is
   * the expected end of its run rather than a failure. */
  const allowed = b.endless || b.interactive ? [0, 2] : [0];
  if (!allowed.includes(code)) {
    problems.push(`exit code ${code}, expected ${allowed.join(' or ')}`);
  }
  for (const want of b.expect ?? []) {
    if (!out.includes(want)) problems.push(`missing from the output: ${JSON.stringify(want)}`);
  }
  for (const [pattern, least] of Object.entries(b.expect_at_least ?? {})) {
    const n = (out.match(new RegExp(pattern, 'gm')) ?? []).length;
    if (n < least) problems.push(`${n} lines match /${pattern}/, expected at least ${least}`);
  }

  if (problems.length === 0) {
    console.log(`  ok    ${b.name.padEnd(8)} ${b.title}`);
  } else {
    failures++;
    console.log(`  FAIL  ${b.name.padEnd(8)} ${b.title}`);
    for (const p of problems) console.log(`          ${p}`);
    const tail = (out + err).trimEnd().split('\n').slice(-12);
    for (const line of tail) console.log(`        | ${line}`);
  }
}

console.log(failures === 0
  ? `all ${manifest.builds.length} builds ran; score is ${manifest.score} upstream samples`
  : `${failures} of ${manifest.builds.length} builds failed`);
process.exit(failures === 0 ? 0 : 1);
