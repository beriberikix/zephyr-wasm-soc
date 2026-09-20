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
// Usage: node scripts/check_browser.mjs [_site] [--headed]

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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
/* Absolute: the path is compared against a request's resolved path below,
 * and a relative one would never match. */
const site = path.resolve(args.find((a) => !a.startsWith('--')) ?? path.join(here, '..', '..', '_site'));

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
  if (ok) console.log(`  ok    ${b.name.padEnd(8)} ${b.title}`);

  await page.click('#stop').catch(() => {});
  await page.waitForFunction(() => !window.zephyrRunning(), null, { timeout: 15_000 })
    .catch(() => {});
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
