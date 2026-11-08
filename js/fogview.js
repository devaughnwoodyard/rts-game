// Vanguard fog-of-war view (owner: TERRAIN). Created + ticked by terrain.js.
// TODO.md (fogview):
//  - Reads world.fog {enabled, cell, cols, rows, explored, visible, version} (sim owns). Rebuilds a small RGBA
//    DataTexture (R=visible, G=explored, 3x3 tent-blurred, linear filtered) only when version/enabled changes.
//  - Ground overlay: unexplored alpha 0.92 near-black, explored 0.55 dark, visible clear. Hidden when fog is off.
//  - Terrain props/trees/lava use fogPatch() so tall scenery is darkened the same way (shared uniforms U).
//  - Entity hiding: mesh.visible follows !entity.hidden (only written on change, so other modules can still
//    toggle visibility for their own reasons). Health bars/rings for hidden entities are skipped in engine.drawOverlay.
import * as THREE from 'three';

export const FOG_GLSL = `
uniform sampler2D tFog; uniform vec4 uFogXf; uniform float uFogOn;
float fogAlpha(vec2 p) {
  vec2 f = texture2D(tFog, (p + uFogXf.zw) * uFogXf.xy).rg;
  return uFogOn * mix(0.92, 0.55, f.g) * (1.0 - f.r);
}
`;

// Patch a built-in material shader (sh from onBeforeCompile) with world position + fog-of-war darkening.
export function fogPatch(sh, U) {
  sh.uniforms.tFog = U.tFog; sh.uniforms.uFogXf = U.uFogXf; sh.uniforms.uFogOn = U.uFogOn;
  if (!/varying vec3 vGW;/.test(sh.vertexShader)) {
    sh.vertexShader = 'varying vec3 vGW;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
  { vec4 tWp4 = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    tWp4 = instanceMatrix * tWp4;
  #endif
    vGW = (modelMatrix * tWp4).xyz; }`);
  }
  sh.fragmentShader = 'varying vec3 vGW;\n' + FOG_GLSL + sh.fragmentShader.replace('#include <opaque_fragment>',
    '#include <opaque_fragment>\n  gl_FragColor.rgb *= 1.0 - fogAlpha(vGW.xz);');
}

export function createFogView(world, U) {
  const THREEm = THREE;
  let tex = null, data = null, ver = -1, wasOn = null, mesh = null, cols = 0, rows = 0;
  const mat = new THREEm.ShaderMaterial({
    uniforms: { tFog: U.tFog, uFogXf: U.uFogXf, uFogOn: U.uFogOn },
    vertexShader: `varying vec3 vGW; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vGW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `varying vec3 vGW;\n${FOG_GLSL}
void main() {
  float a = fogAlpha(vGW.xz);
  vec2 f = texture2D(tFog, (vGW.xz + uFogXf.zw) * uFogXf.xy).rg;
  vec3 c = mix(vec3(0.01, 0.015, 0.025), vec3(0.04, 0.045, 0.05), f.g);
  gl_FragColor = vec4(c, a);
}`,
    transparent: true, depthWrite: false, fog: false,
  });

  function init(fog) {
    cols = fog.cols; rows = fog.rows;
    data = new Uint8Array(cols * rows * 4);
    tex = new THREEm.DataTexture(data, cols, rows, THREEm.RGBAFormat);
    tex.magFilter = tex.minFilter = THREEm.LinearFilter; tex.wrapS = tex.wrapT = THREEm.ClampToEdgeWrapping;
    U.tFog.value = tex;
    const W = cols * fog.cell, H = rows * fog.cell;
    U.uFogXf.value.set(1 / W, 1 / H, world.map.w / 2, world.map.h / 2);
    mesh = new THREEm.Mesh(new THREEm.PlaneGeometry(world.map.w, world.map.h).rotateX(-Math.PI / 2), mat);
    mesh.position.y = 0.15; mesh.renderOrder = 6; mesh.name = 'fogOverlay'; mesh.raycast = () => {}; mesh.frustumCulled = false;
    world.scene.add(mesh);
  }
  function rebuild(fog) {
    const v = fog.visible, e = fog.explored;
    for (let z = 0; z < rows; z++) for (let x = 0; x < cols; x++) {
      let sv = 0, se = 0, sw = 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const xx = Math.min(cols - 1, Math.max(0, x + dx)), zz = Math.min(rows - 1, Math.max(0, z + dz));
        const w = (dx ? 1 : 2) * (dz ? 1 : 2), i = zz * cols + xx;
        sv += v[i] * w; se += e[i] * w; sw += w;
      }
      const k = (z * cols + x) * 4;
      data[k] = Math.round(sv / sw * 255); data[k + 1] = Math.round(Math.max(se / sw, sv / sw) * 255); data[k + 2] = 0; data[k + 3] = 255;
    }
    tex.needsUpdate = true;
  }
  function update() {
    const fog = world.fog;
    if (fog && fog.cols) {
      if (!tex || fog.cols !== cols || fog.rows !== rows) { if (mesh) world.scene.remove(mesh); init(fog); ver = -1; }
      const on = !!fog.enabled;
      if (fog.version !== ver || on !== wasOn) { ver = fog.version; wasOn = on; if (on) rebuild(fog); }
      U.uFogOn.value = on ? 1 : 0;
      mesh.visible = on;
    } else U.uFogOn.value = 0;
    for (const e of world.entities) {
      const m = e.mesh; if (!m) continue;
      const show = !e.hidden;
      if (m.userData._fvShow !== show) { m.userData._fvShow = show; m.visible = show; }
    }
  }
  return { update, get texture() { return tex; } };
}
