// One-off: builds assets/chars/soldier.glb from the Mixamo FBX clips in assets/src/anims (animation-only
// exports). Runs tools/convert-soldier.html in headless Chromium, streams the GLB bytes back as base64.
// Usage: node tools/convert-soldier.mjs
import { chromium } from 'playwright'; import fs from 'node:fs'; import path from 'node:path';
import { serve, root } from './serve.mjs';
const { server, url } = await serve();
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
page.on('console', m => { if (!m.text().startsWith('THREE.FBXLoader')) console.log('[page]', m.text()); });
page.on('pageerror', e => console.log('[pageerror]', e));
await page.goto(url + '/tools/convert-soldier.html'); await page.waitForFunction(() => window.ready);
const log = await page.evaluate(() => window.convert());
console.log(log.join('\n'));
const n = await page.evaluate(() => window.__glb.length), parts = [];
for (let i = 0; i < n; i += 1 << 20) parts.push(Buffer.from(await page.evaluate(([a, b]) => window.chunk(a, b), [i, 1 << 20]), 'base64'));
const out = path.join(root, 'assets/chars/soldier.glb');
fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, Buffer.concat(parts));
console.log('wrote', out, fs.statSync(out).size, 'bytes');
await browser.close(); server.close();
