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
  '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css',
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

/* What a person would do with each build, and what they would see. Each
 * returns a line saying what it checked, or throws saying what was wrong. */
const screen = () => page.evaluate(() => window.zephyrScreen());
const screenText = async () => (await screen()).join('\n');
const until = async (what, fn, arg, timeout = 10_000) => {
  try {
    await page.waitForFunction(fn, arg, { timeout, polling: 100 });
  } catch {
    throw new Error(`${what}; the screen showed:`);
  }
};
/* The row the cursor is on, as shown. */
const cursorRow = () => page.evaluate(() => window.zephyrScreen()[window.zephyrCursor().y]);
const canvasHash = () => page.evaluate(() => {
  const c = document.getElementById('screen');
  const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let h = 0;
  for (let i = 0; i < px.length; i += 4) h = (h * 31 + px[i] + px[i + 1] * 7 + px[i + 2] * 13) >>> 0;
  return h;
});
async function onCanvas(x, y) {
  await page.locator('#screen').scrollIntoViewIfNeeded();
  const box = await page.locator('#screen').boundingBox();
  const [w, h] = await page.evaluate(() => {
    const c = document.getElementById('screen');
    return [c.width, c.height];
  });
  return [box.x + (x + 0.5) * box.width / w, box.y + (y + 0.5) * box.height / h];
}
async function ledToggles(ms) {
  return page.evaluate((span) => new Promise((resolve) => {
    let last = window.zephyrLeds() & 1, n = 0;
    const t = setInterval(() => {
      const v = window.zephyrLeds() & 1;
      if (v !== last) { n++; last = v; }
    }, 20);
    setTimeout(() => { clearInterval(t); resolve(n); }, span);
  }), ms);
}

const PERSON = {
  async shell() {
    await page.click('#term');
    const cur = await page.evaluate(() => window.zephyrCursor());
    if (!cur.blink) throw new Error('the cursor does not blink');
    /* A typo, Backspace, and the rest. The shell deletes the character and
     * redraws the line with cursor movement; the screen has to follow. */
    await page.keyboard.type('kernel verz');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('sion');
    await until('Backspace did not remove the character from the screen',
                () => window.zephyrScreen()[window.zephyrCursor().y] === 'uart:~$ kernel version');
    const { x } = await page.evaluate(() => window.zephyrCursor());
    if (x !== 'uart:~$ kernel version'.length) {
      throw new Error(`the cursor is at column ${x}, not after the text`);
    }
    await page.keyboard.press('Enter');
    await until('the command did not run',
                () => window.zephyrScreen().some((l) => l.startsWith('Zephyr version')));
    /* History: the arrow brings the last command back. */
    await page.keyboard.press('ArrowUp');
    await until('ArrowUp did not bring back the last command',
                () => window.zephyrScreen()[window.zephyrCursor().y] === 'uart:~$ kernel version');
    /* Editing in the middle: Left twice puts the cursor before the "o";
     * Backspace takes out the "i", and typing puts it back. */
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Backspace');
    await until('Backspace in the middle of the line did not redraw it',
                () => window.zephyrScreen()[window.zephyrCursor().y] === 'uart:~$ kernel verson');
    await page.keyboard.type('i');
    await until('typing in the middle of the line did not redraw it',
                () => window.zephyrScreen()[window.zephyrCursor().y] === 'uart:~$ kernel version');
    /* Ctrl+C abandons the line. */
    await page.keyboard.press('Control+c');
    await until('Ctrl+C did not give a fresh prompt',
                () => window.zephyrScreen()[window.zephyrCursor().y] === 'uart:~$ ');
    /* Tab completes. */
    await page.keyboard.type('kern');
    await page.keyboard.press('Tab');
    await until('Tab did not complete "kern"',
                () => window.zephyrScreen()[window.zephyrCursor().y] === 'uart:~$ kernel ');
    await page.keyboard.press('Control+c');
    return 'typed with Backspace, history, editing mid-line, Ctrl+C and Tab; the screen followed';
  },

  async hsm() {
    await page.click('#term');
    await page.keyboard.type('hsm_psicc2 event A');
    await page.keyboard.press('Enter');
    await until('the state machine did not show taking event A',
                () => window.zephyrScreen().some((l) => l.includes('received EVENT_A')));
    const shown = await screen();
    const glued = shown.filter((l) => /^uart:~\$ (\[|\*\*\*)/.test(l));
    if (glued.length) throw new Error(`log lines shown behind a prompt: ${glued[0]}`);
    return 'took event A typed on the keyboard; log lines are not behind prompts';
  },

  async philo() {
    /* The sample draws a table with cursor addressing, one row per
     * philosopher, and rewrites the rows in place. */
    await page.waitForTimeout(3000);
    const rows = (await screen()).filter((l) => /Philosopher \d/.test(l));
    const ids = rows.map((l) => /Philosopher (\d)/.exec(l)[1]);
    if (rows.length !== 6 || new Set(ids).size !== 6) {
      throw new Error(`expected one row for each of six philosophers, saw ${rows.length} rows for ${[...new Set(ids)].sort()}`);
    }
    return 'six philosophers, one row each, redrawn in place';
  },

  async blinky() {
    const at1 = await ledToggles(2500);
    await page.selectOption('#speed', '4');
    const at4 = await ledToggles(2500);
    await page.selectOption('#speed', '1');
    if (at1 < 2) throw new Error(`LED 0 toggled ${at1} times in 2.5 s at 1x`);
    if (at4 < at1 * 2) throw new Error(`at 4x LED 0 toggled ${at4} times against ${at1} at 1x`);
    return `LED 0 toggled ${at1} times in 2.5 s at 1x and ${at4} at 4x`;
  },

  async button() {
    /* The ci_gpio press has been and gone; press again, and look at LED 0
     * while the button is held. */
    await page.hover('#board button[data-pin="4"]');
    await page.mouse.down();
    await until('LED 0 did not light while Button 0 was held',
                () => (window.zephyrLeds() & 1) === 1);
    await page.mouse.up();
    await until('LED 0 stayed lit after Button 0 was let go',
                () => (window.zephyrLeds() & 1) === 0);
    return 'LED 0 lit while Button 0 was held, and went out on release';
  },

  async touch() {
    const before = (await page.evaluate(() => window.zephyrOutput())).split('PRESS').length;
    const [x0, y0] = await onCanvas(40, 40);
    const [x1, y1] = await onCanvas(200, 150);
    /* At a person's pace: the sample redraws every 100 ms of the real
     * clock, so a drag over in a tenth of a second is rightly two or three
     * reports. */
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(x0 + (x1 - x0) * i / 8, y0 + (y1 - y0) * i / 8);
      await page.waitForTimeout(150);
    }
    await page.mouse.up();
    await until('the drag did not end in a release at (200, 150)',
                () => window.zephyrOutput().includes('RELEASE X, Y: (200, 150)'));
    const presses = (await page.evaluate(() => window.zephyrOutput())).split('PRESS').length - before;
    if (presses < 5) throw new Error(`a 1.2 s drag gave ${presses} touch reports, expected it to follow the pointer`);
    const out = await page.evaluate(() => window.zephyrOutput());
    if (out.includes('Event dropped')) throw new Error('the guest dropped input events');
    return `a drag gave ${presses} touch reports and released where it ended`;
  },

  async lvgl() {
    /* The heap report comes through the shell's log backend, from a thread
     * that waits behind LVGL's first frames, so it takes a few seconds. */
    await until('the heap report never reached the screen',
                () => window.zephyrScreen().some((l) => l.includes('free bytes')), null, 60_000);
    const glued = (await screen()).filter((l) => /^uart:~\$ (\[|\*\*\*)/.test(l));
    if (glued.length) throw new Error(`log lines shown behind a prompt: ${glued[0]}`);
    /* The widgets demo's second tab. */
    const before = await canvasHash();
    const [x, y] = await onCanvas(160, 22);
    await page.mouse.click(x, y);
    await until('clicking the Analytics tab changed nothing on the display',
                (h) => {
                  const c = document.getElementById('screen');
                  const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
                  let v = 0;
                  for (let i = 0; i < px.length; i += 4) v = (v * 31 + px[i] + px[i + 1] * 7 + px[i + 2] * 13) >>> 0;
                  return v !== h;
                }, before);
    return 'the Analytics tab responded to a click; log lines are not behind prompts';
  },
};

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

/* The foot of the page says which build this is, so that a report about the
 * page can say which build it was about. */
if (manifest.site?.commit) {
  const shown = await page.evaluate(() => window.zephyrBuildInfo?.() ?? '');
  if (!shown.includes(manifest.site.commit.slice(0, 7))) {
    fail('footer', `the page does not show its build: ${JSON.stringify(shown)}`);
  } else {
    console.log(`  ok    footer    ${shown}`);
  }
}
if (listed.length !== manifest.builds.length) {
  fail('manifest', `page lists ${listed.length} builds, manifest has ${manifest.builds.length}`);
} else {
  console.log(`  ok    manifest  ${listed.length} builds listed`);
}

for (const b of manifest.builds) {
  const expect = b.expect ?? [];

  await page.selectOption('#build', b.name);
  await page.click('#run');

  /* A build that waits for a button press gets one: the mouse held down on
   * the button the page draws, and let go. This is the part Node cannot
   * check at all. */
  if (b.ci_gpio) {
    try {
      await page.waitForFunction(
        (w) => window.zephyrOutput().includes(w), expect[0],
        { timeout: 60_000, polling: 250 });
      for (const event of b.ci_gpio) {
        const [, pin, level] = /^\d+:(\d+)=([01])$/.exec(event) ?? [];
        if (pin === undefined) continue;
        if (level === '0') {
          await page.hover(`#board button[data-pin="${pin}"]`);
          await page.mouse.down();
        } else {
          await page.mouse.up();
        }
        await page.waitForTimeout(300);
      }
    } catch { /* the wait below reports it */ }
  }

  /* An interactive build waits for a person, so be one: the same input CI
   * feeds it on stdin, typed on the keyboard into the terminal. */
  if (b.interactive && b.ci_stdin) {
    try {
      await page.waitForFunction(
        (w) => window.zephyrOutput().includes(w), expect[0],
        { timeout: 60_000, polling: 250 });
      await page.click('#term');
      for (const line of b.ci_stdin.split('\n').filter(Boolean)) {
        await page.keyboard.type(line);
        await page.keyboard.press('Enter');
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

  /* Then use it the way a person would, and look at what the screen shows,
   * not only at what was printed: the two differ exactly when the page
   * draws the guest's output wrongly. */
  if (ok && PERSON[b.name]) {
    try {
      const did = await PERSON[b.name]();
      console.log(`  ok    ${b.name.padEnd(8)} ${did}`);
    } catch (err) {
      ok = false;
      fail(b.name, err.message, (await page.evaluate(() => window.zephyrScreen()).catch(() => []))
        .filter((l) => l.trim()).map((l) => JSON.stringify(l)).join('\n'));
    }
  }

  if (ok) console.log(`  ok    ${b.name.padEnd(8)} ${b.title}`);
  if (shots) {
    await mkdir(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, `${b.name}.png`), fullPage: true });
  }

  await page.click('#stop', { timeout: 1000 }).catch(() => {});
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
    await page.click('#stop', { timeout: 1000 }).catch(() => {});
  } catch (err) {
    fail('kernel', `pause and step: ${err.message.split('\n')[0]}`);
  }
}

/* The page's own controls, used as a person would: what Stop says and
 * leaves behind, what a new selection clears, what Pause says, and whether
 * the numbers left up after a run are the run's last ones. */
const statusText = () => page.evaluate(() => document.getElementById('status').textContent);
const pageChecks = [
  ['stop', async () => {
    await page.selectOption('#build', 'blinky');
    await page.click('#run');
    await until('LED 0 never lit', () => (window.zephyrLeds() & 1) === 1, null, 30_000);
    await page.click('#stop');
    await until('the run did not stop', () => !window.zephyrRunning(), null, 5_000);
    const st = await statusText();
    if (st !== 'Stopped.') throw new Error(`after Stop the status read ${JSON.stringify(st)}`);
    if (await page.evaluate(() => window.zephyrLeds()) !== 0) throw new Error('an LED stayed lit after Stop');
    return 'Stop ends the run within 5 s, says "Stopped." and turns the LEDs off';
  }],
  ['select', async () => {
    await page.selectOption('#build', 'hello');
    const [out, shown] = await page.evaluate(() =>
      [window.zephyrOutput(), window.zephyrScreen().join('').trim()]);
    if (out || shown) throw new Error('the previous build\'s output was still shown');
    return 'choosing another build clears the previous one\'s output';
  }],
  ['switch', async () => {
    await page.selectOption('#build', 'philo');
    await page.click('#run');
    await until('the philosophers never started', () => window.zephyrOutput().includes('Philosopher'), null, 30_000);
    await page.selectOption('#build', 'hello');
    await until('choosing another build did not stop the run', () => !window.zephyrRunning(), null, 5_000);
    const out = await page.evaluate(() => window.zephyrOutput());
    if (out) throw new Error('output from the stopped run reached the new selection');
    return 'choosing another build mid-run stops it';
  }],
  ['pause', async () => {
    await page.selectOption('#build', 'philo');
    await page.click('#run');
    await until('the philosophers never started', () => (window.zephyrState()?.threads ?? []).length > 0, null, 30_000);
    await page.click('#pause');
    await until('Pause did not say so', () => document.getElementById('status').textContent.startsWith('Paused.'));
    await page.click('#pause');
    await until('Resume did not say so', () => document.getElementById('status').textContent.startsWith('Running.'));
    await page.click('#stop');
    await until('the run did not stop', () => !window.zephyrRunning(), null, 5_000);
    const [p, s] = await page.evaluate(() => [document.getElementById('pause'), document.getElementById('step')]
      .map((e) => e.disabled));
    if (!p || !s) throw new Error('Pause or Step stayed enabled after the run');
    return 'the status says Paused and Running; Pause and Step are off after the run';
  }],
  ['final', async () => {
    await page.selectOption('#build', 'sem');
    await page.click('#run');
    await until('the ztest never finished', () => !window.zephyrRunning(), null, 60_000);
    const [sw, kstat] = await page.evaluate(() =>
      [window.zephyrState().switches, document.getElementById('kstat').textContent]);
    if (sw < 100) throw new Error(`the page shows ${sw} switches for a run of thousands`);
    if (!kstat.startsWith('At the end of the run') || /pending|deadline/.test(kstat)) {
      throw new Error(`the stats read ${JSON.stringify(kstat)}`);
    }
    return `after the run the stats are its last: ${kstat}`;
  }],
  ['clear', async () => {
    await page.selectOption('#build', 'shell');
    await page.click('#run');
    await until('the shell never prompted', () => window.zephyrOutput().includes('uart:~$'), null, 30_000);
    await page.click('#clear');
    await until('Clear took the prompt with it',
                () => window.zephyrScreen()[window.zephyrCursor().y] === 'uart:~$ ');
    /* Straight on typing, without clicking back into the output. */
    await page.keyboard.type('kernel version');
    await page.keyboard.press('Enter');
    await until('after Clear the keyboard no longer reached the shell',
                () => window.zephyrScreen().some((l) => l.startsWith('Zephyr version')));
    await page.click('#stop');
    await until('the run did not stop', () => !window.zephyrRunning(), null, 5_000);
    return 'Clear keeps the shell\'s prompt and the keyboard';
  }],
  ['cursor', async () => {
    /* No cursor where nothing reads the keyboard, a blinking one where
     * something does -- including after the one before hid it. */
    await page.selectOption('#build', 'philo');
    await page.click('#run');
    await until('the philosophers never started', () => window.zephyrOutput().includes('Philosopher'), null, 30_000);
    if (!(await page.evaluate(() => window.zephyrCursor().hidden))) {
      throw new Error('a build that reads no keyboard showed a cursor');
    }
    await page.selectOption('#build', 'shell');
    await page.click('#run');
    await until('the shell never prompted', () => window.zephyrOutput().includes('uart:~$'), null, 30_000);
    const cur = await page.evaluate(() => window.zephyrCursor());
    if (cur.hidden || !cur.blink) throw new Error('the shell had no blinking cursor');
    await page.click('#stop');
    await until('the run did not stop', () => !window.zephyrRunning(), null, 5_000);
    return 'no cursor for the philosophers, a blinking one for the shell';
  }],
  ['pace', async () => {
    /* A paced build keeps to the wall clock, whether its steps are heavy
     * (touch redraws every frame) or it is waiting on a person with no
     * timer running (touch between presses): a five-second press has to
     * be logged as five seconds. */
    await page.selectOption('#build', 'touch');
    await page.click('#run');
    await until('the touch sample never started', () => window.zephyrState() !== null, null, 30_000);
    const g0 = await page.evaluate(() => window.zephyrState().nowMs);
    const t0 = Date.now();
    await page.waitForTimeout(5000);
    const g1 = await page.evaluate(() => window.zephyrState().nowMs);
    const wall = Date.now() - t0;
    await page.click('#stop');
    await until('the run did not stop', () => !window.zephyrRunning(), null, 5_000);
    if (Math.abs((g1 - g0) - wall) > wall * 0.25) {
      throw new Error(`the guest clock moved ${g1 - g0} ms in ${wall} ms of wall time`);
    }
    return `the guest clock moved ${g1 - g0} ms in ${wall} ms of wall time`;
  }],
  ['fetch', async () => {
    /* A server error on the module: one is retried and the run goes
     * ahead; one that persists is reported, and leaves nothing broken for
     * the next Run. */
    let failures = 1;
    await page.route('**/m/hello.wasm', (route) =>
      (failures-- > 0 ? route.fulfill({ status: 503, body: 'busy' }) : route.continue()));
    await page.selectOption('#build', 'hello');
    await page.click('#run');
    await until('a single 503 was not retried', () => window.zephyrOutput().includes('Hello World'), null, 30_000);
    failures = 1000;
    await page.click('#run');
    await until('a persistent 503 was not reported',
                () => window.zephyrOutput().includes('could not fetch'), null, 30_000);
    await until('the failed run did not end', () => !window.zephyrRunning(), null, 10_000);
    await page.waitForTimeout(500);
    const out = await page.evaluate(() => window.zephyrOutput());
    if (/worker error|Cannot read/.test(out)) throw new Error(`the failed fetch left an error behind: ${out.trim()}`);
    await page.unroute('**/m/hello.wasm');
    await page.click('#run');
    await until('Run did not work after a failed fetch', () => window.zephyrOutput().includes('Hello World'), null, 30_000);
    return 'one 503 is retried; a persistent one is reported cleanly, and the next Run works';
  }],
];
for (const [name, check] of pageChecks) {
  try {
    console.log(`  ok    ${name.padEnd(8)} ${await check()}`);
  } catch (err) {
    fail(name, err.message, (await page.evaluate(() => window.zephyrScreen()).catch(() => []))
      .filter((l) => l.trim()).map((l) => JSON.stringify(l)).join('\n'));
    await page.click('#stop', { timeout: 1000 }).catch(() => {});
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
    await page.click('#stop', { timeout: 1000 }).catch(() => {});
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
