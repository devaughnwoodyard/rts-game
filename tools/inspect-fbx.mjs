// Lists which Mixamo FBX files carry a skinned mesh vs animation only. Usage: node tools/inspect-fbx.mjs
import { chromium } from 'playwright'; import fs from 'node:fs'; import path from 'node:path';
import { serve, root } from './serve.mjs';
const { server, url } = await serve();
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
page.on('console', m => console.log('[page]', m.text())); page.on('pageerror', e => console.log('[err]', e));
await page.goto(url + '/tools/fbx-page.html'); await page.waitForFunction(() => window.ready);
const files = fs.readdirSync(path.join(root, 'assets/src/anims')).filter(f => f.endsWith('.fbx'));
for (const f of files) {
  const info = await page.evaluate(async (u) => {
    const o = await window.loadFBX(u); let meshes = [], bones = 0;
    o.traverse(c => { if (c.isSkinnedMesh) meshes.push({ name: c.name, verts: c.geometry.attributes.position.count, mats: [].concat(c.material).map(m => m.name + ':' + m.type + (m.map ? '+map' : '')), bones: c.skeleton.bones.length }); if (c.isBone) bones++; });
    const box = new window.THREE.Box3().setFromObject(o);
    return { meshes, bones, scale: o.scale.toArray(), size: box.getSize(new window.THREE.Vector3()).toArray().map(v => +v.toFixed(1)), anims: o.animations.map(a => ({ n: a.name, d: +a.duration.toFixed(2), tracks: a.tracks.length })) };
  }, '/assets/src/anims/' + encodeURIComponent(f));
  console.log(f, JSON.stringify(info));
}
await browser.close(); server.close();
