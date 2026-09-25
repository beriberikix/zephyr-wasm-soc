#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Run the staged page in a real browser and check what it shows.
//
// The page is the product, so checking the modules under Node says less than
// it looks like it does: it exercises the guest and the driver loop, but not
// the Worker, the message plumbing, the manifest, or the terminal. This runs
// each non-interactive build through the page itself and reads the output
// back out of the page's own terminal, through the hooks it already exposes
// for exactly this (window.zephyrOutput and friends).
//
// It says nothing new about engine neutrality: Chromium is V8, the same
// engine as Node. That claim rests on host/run_wasmtime.py. What this shows
// is that the harness works somewhere with no filesystem, no stdio and no
// blocking main thread.
//
// Usage: node scripts/check_browser.mjs [_site] [--headed] [--screenshots <dir>]
//
// With --screenshots, each build's page is saved as <dir>/<name>.png once its
// checks pass, for looking at: nothing here can say whether a page looks
// right.

import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const headed = args.includes('--headed');
const shotsAt = args.indexOf('--screenshots');
const shots = shotsAt >= 0 ? path.resolve(args[shotsAt + 1]) : null;
const positional = args.filter((a, i) => !a.startsWith('--') && i !== shotsAt + 1);
/* Absolute: the path is compared against a request's resolved path below,
 * and a relative one would never match. */
const site = path.resolve(positional[0] ?? path.join(here, '..', '..', '_site'));

/* Playwright is not a dependency of this repository: it is a check, not a
 * build step, and nothing else here needs node_modules. Take it from
 * wherever it is installed rather than insisting on a local copy. */
async function importPlaywright() {
  const tried = [];
  /* A local copy first, then a global one. NODE_PATH does not apply to ESM
   * imports, so a global install has to be found by asking npm where it
   * put things and importing the file directly. */
  for (const spec of ['playwright', 'playwright-core']) {
    try { return await import(spec); } catch { tried.push(spec); }
  }
  let root = process.env.NPM_GLOBAL_ROOT;
  if (!root) {
    root = await new Promise((resolve) => {
      const p = spawn('npm', ['root', '-g'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      p.stdout.on('data', (d) => { out += d; });
      p.on('close', () => resolve(out.trim()));
      p.on('error', () => resolve(''));
    });
  }
  if (root) {
    for (const name of ['playwright', 'playwright-core']) {
      const file = pathToFileURL(path.join(root, name, 'index.mjs')).href;
      try { return await import(file); } catch { tried.push(file); }
    }
  }
  const err = new Error(`could not import playwright (tried ${tried.join(', ')})`);
  err.tried = tried;
  throw err;
}

let chromium;
try {
  ({ chromium } = await importPlaywright());
} catch (err) {
  console.error(`check_browser: ${err.message}`);
  console.error('  npm install --no-save playwright && npx playwright install chromium');
  process.exit(127);
}

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.wasm': 'application/wasm',
};

/* A server, because file:// blocks both Workers and fetch. Bound to the
 * loopback address, like scripts/serve_web.sh. */
const server = createServer(async (req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.resolve(path.join(site, rel === '/' ? 'index.html' : rel));
  if (file !== site && !file.startsWith(site + path.sep)) { res.writeHead(403).end(); return; }
  try {
    const info = await stat(file);
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'content-length': info.size,
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const manifest = JSON.parse(await readFile(path.join(site, 'manifest.json'), 'utf8'));
const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage();

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

let failures = 0;
const fail = (name, why, extra = '') => {
  failures++;
  console.log(`  FAIL  ${name}`);
  console.log(`          ${why}`);
  if (extra) for (const l of extra.split('\n').slice(-12)) console.log(`        | ${l}`);
};

await page.goto(base, { waitUntil: 'load' });

/* The menu is built from the manifest, so its contents are the first thing
 * worth checking: a page that lists nothing cannot run anything. */
await page.waitForFunction(() => (window.zephyrBuilds?.() ?? []).length > 0, null,
                           { timeout: 15_000 });
const listed = await page.evaluate(() => window.zephyrBuilds().map((b) => b.name));
if (listed.length !== manifest.builds.length) {
  fail('manifest', `page lists ${listed.length} builds, manifest has ${manifest.builds.length}`);
} else {
  console.log(`  ok    manifest  ${listed.length} builds listed`);
}

for (const b of manifest.builds) {
  const expect = b.expect ?? [];

  await page.selectOption('#build', b.name);
  await page.click('#run');

  /* A build that waits for a button press gets one, through the same path a
   * person's finger takes. This is the part Node cannot check at all. */
  if (b.ci_gpio) {
    try {
      await page.waitForFunction(
        (w) => window.zephyrOutput().includes(w), expect[0],
        { timeout: 60_000, polling: 250 });
      for (const event of b.ci_gpio) {
        const [, pin, level] = /^\d+:(\d+)=([01])$/.exec(event) ?? [];
        if (pin === undefined) continue;
        await page.evaluate(([p, l]) => window.zephyrPress(p, l), [Number(pin), Number(level)]);
        await page.waitForTimeout(300);
      }
    } catch { /* the wait below reports it */ }
  }

  /* An interactive build waits for a person, so be one: the same input CI
   * feeds it on stdin goes in through the page's own keyboard path, with
   * newlines sent as the carriage return the Enter key produces. */
  if (b.interactive && b.ci_stdin) {
    try {
      await page.waitForFunction(
        (w) => window.zephyrOutput().includes(w), expect[0],
        { timeout: 60_000, polling: 250 });
      for (const line of b.ci_stdin.split('\n').filter(Boolean)) {
        await page.evaluate((t) => window.zephyrType(t), `${line}\r`);
        await page.waitForTimeout(250);
      }
    } catch { /* the wait below reports it */ }
  }

  /* A build that waits for a touch gets one: a real click on the canvas,
   * at the display pixel the manifest names, through the page's own
   * pointer handling. */
  if (b.ci_touch) {
    try {
      await page.waitForFunction(
        (w) => window.zephyrOutput().includes(w), expect[0],
        { timeout: 60_000, polling: 250 });
      /* Measured after scrolling it into view: a click outside the
       * viewport lands somewhere else entirely. */
      await page.locator('#screen').scrollIntoViewIfNeeded();
      const box = await page.locator('#screen').boundingBox();
      const size = await page.evaluate(() => {
        const c = document.getElementById('screen');
        return [c.width, c.height];
      });
      for (const touch of b.ci_touch) {
        const [, x, y] = /^\d+:(\d+),(\d+)$/.exec(touch) ?? [];
        if (x === undefined) continue;
        await page.mouse.click(box.x + (Number(x) + 0.5) * box.width / size[0],
                               box.y + (Number(y) + 0.5) * box.height / size[1]);
        await page.waitForTimeout(300);
      }
    } catch { /* the wait below reports it */ }
  }

  let ok = true;
  for (const want of expect) {
    try {
      await page.waitForFunction(
        (w) => window.zephyrOutput().includes(w), want,
        { timeout: 60_000, polling: 250 });
    } catch {
      ok = false;
      fail(b.name, `never printed ${JSON.stringify(want)}`, await page.evaluate(() => window.zephyrOutput()));
      break;
    }
  }
  /* For a build that drives LEDs, check the page drew them: the terminal
   * text could be right while the board strip stayed dark. */
  if (ok && b.name === 'blinky') {
    try {
      await page.waitForFunction(() => window.zephyrLeds() !== 0, null,
                                 { timeout: 30_000, polling: 100 });
    } catch {
      ok = false;
      fail(b.name, 'the page never lit an LED');
    }
  }

  /* For a build that draws, check the page did: the terminal can be right
   * while the canvas stays black. */
  if (ok && b.display) {
    const least = b.display.colors_at_least ?? 2;
    try {
      await page.waitForFunction((n) => window.zephyrDisplay().colours >= n, least,
                                 { timeout: 30_000, polling: 200 });
    } catch {
      ok = false;
      const got = await page.evaluate(() => window.zephyrDisplay());
      fail(b.name, `the canvas showed ${got.colours} colours after ${got.frames} frames, ` +
                   `expected at least ${least}`);
    }
  }

  if (ok) console.log(`  ok    ${b.name.padEnd(8)} ${b.title}`);
  if (shots) {
    await mkdir(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, `${b.name}.png`), fullPage: true });
  }

  await page.click('#stop').catch(() => {});
  await page.waitForFunction(() => !window.zephyrRunning(), null, { timeout: 15_000 })
    .catch(() => {});
}

/* The kernel panel, pause and step.
 *
 * Needs a build that keeps running, so a paced one: under virtual time the
 * whole run is over before a click could land, which is itself the reason
 * pacing exists. Checks the three claims separately -- that the table is
 * filled from the guest, that pausing holds, and that a step is exactly one
 * suspension -- because each could fail without the others.
 */
const stepper = manifest.builds.find((b) => b.clock === 'paced' && !b.interactive);
if (stepper) {
  try {
    await page.selectOption('#build', stepper.name);
    await page.click('#run');
    await page.waitForFunction(() => (window.zephyrState()?.threads ?? []).length > 0,
                               null, { timeout: 60_000, polling: 200 });

    await page.click('#pause');
    await page.waitForFunction(() => window.zephyrState()?.paused === true,
                               null, { timeout: 30_000, polling: 100 });
    const held = await page.evaluate(() => window.zephyrState().switches);
    await page.waitForTimeout(1200);
    const stillHeld = await page.evaluate(() => window.zephyrState().switches);
    if (stillHeld !== held) {
      fail('pause', `the guest kept running while paused: ${held} then ${stillHeld} switches`);
    }

    /* Stepping forward, and then back to exactly where it started. The
     * clock and the current thread are checked as well as the counter,
     * because restoring a counter is easy and restoring the kernel is the
     * claim. */
    const before = await page.evaluate(() => {
      const st = window.zephyrState();
      return { sw: st.switches, now: st.nowMs,
               cur: (st.threads.find((t) => t.current) || {}).name ?? '?' };
    });
    for (let i = 0; i < 3; i++) {
      await page.click('#step');
      await page.waitForTimeout(350);
    }
    const stepped = await page.evaluate(() => window.zephyrState().switches);
    if (stepped <= before.sw) {
      fail('step', `stepping did not advance the run: still ${stepped} switches`);
    } else {
      for (let i = 0; i < 3; i++) {
        await page.click('#back');
        await page.waitForTimeout(350);
      }
      const after = await page.evaluate(() => {
        const st = window.zephyrState();
        return { sw: st.switches, now: st.nowMs,
                 cur: (st.threads.find((t) => t.current) || {}).name ?? '?' };
      });
      if (after.sw !== before.sw || after.now !== before.now || after.cur !== before.cur) {
        fail('back', 'stepping back did not restore the kernel: ' +
             `${JSON.stringify(before)} then ${JSON.stringify(after)}`);
      } else {
        const names = await page.evaluate(() =>
          window.zephyrState().threads.map((t) => t.name).filter(Boolean));
        console.log(`  ok    kernel    ${names.length} threads listed, pause holds, ` +
                    `${before.sw} -> ${stepped} -> back to ${after.sw} switches ` +
                    `at ${after.now} ms on ${after.cur}`);
      }
    }
    await page.click('#stop').catch(() => {});
  } catch (err) {
    fail('kernel', `pause and step: ${err.message.split('\n')[0]}`);
  }
}

/* Flash that outlives the page. A build with persist_expect is run on an
 * erased flash, the page is reloaded -- which is the tab closing and
 * opening again, as far as the page can tell -- and it is run again. The
 * second run has to find what the first one stored. */
for (const b of manifest.builds.filter((x) => x.persist_expect)) {
  const runToEnd = async () => {
    await page.selectOption('#build', b.name);
    await page.click('#run');
    await page.waitForFunction((w) => window.zephyrOutput().includes(w), b.expect.at(-1),
                               { timeout: 60_000, polling: 250 });
    await page.waitForFunction(() => !window.zephyrRunning(), null, { timeout: 30_000 });
    await page.evaluate(() => window.zephyrFlashSaved());
    return page.evaluate(() => window.zephyrOutput());
  };
  try {
    await page.click('#stop').catch(() => {});
    await page.waitForFunction(() => !window.zephyrRunning(), null, { timeout: 15_000 });
    await page.evaluate((n) => window.zephyrEraseFlash(n), b.name);
    const first = await runToEnd();
    if (!first.includes(b.persist_absent)) {
      throw new Error(`on an erased flash it should print ${JSON.stringify(b.persist_absent)}`);
    }
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => (window.zephyrBuilds?.() ?? []).length > 0, null,
                               { timeout: 15_000 });
    const second = await runToEnd();
    if (!second.includes(b.persist_expect)) {
      throw new Error(`after a reload it never printed ${JSON.stringify(b.persist_expect)}`);
    }
    if (second.includes(b.persist_absent)) {
      throw new Error(`after a reload it printed ${JSON.stringify(b.persist_absent)}: the flash was not kept`);
    }
    console.log(`  ok    ${b.name.padEnd(8)} flash survived a page reload`);
  } catch (err) {
    fail(b.name, `flash across a reload: ${err.message.split('\n')[0]}`,
         await page.evaluate(() => window.zephyrOutput()).catch(() => ''));
  }
}

await browser.close();
server.close();

if (pageErrors.length) {
  failures++;
  console.log('  FAIL  the page reported errors');
  for (const e of pageErrors.slice(0, 10)) console.log(`        | ${e}`);
}

console.log(failures === 0
  ? `the page ran all ${manifest.builds.length} builds in Chromium`
  : `${failures} browser checks failed`);
process.exit(failures === 0 ? 0 : 1);
