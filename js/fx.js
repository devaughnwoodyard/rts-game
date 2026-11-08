// fx.js — Vanguard FX module (owner: FX worker)
// Blood, sparks, explosions, smoke, tracers, muzzle flashes, ground decals, tier/built rings, day/night tint.
// Everything is pooled and allocated in createFx(); no per-event geometry/material allocation afterwards.
//
// Pools: particles 1500 total (crisp 700 blood/debris, soft 300 smoke, additive 500 sparks/flash/shells),
//        tracers 128 billboarded quads (one draw call), decals 120 instanced quads (one draw call, 2x2 atlas),
//        rings 8.
//
// TODO.md (FX):
//  - shot.kind vocabulary isn't fixed by the contract; mapKind() accepts unit kinds ('warden','raider','tank',
//    'turret_mg','turret_cannon','artillery','siege') and generic names ('inf','mg','cannon').
//  - Day colors come from whatever the engine set at startup (captured base); night target is #0b1430 sky.
//  - FX shaders ignore scene fog (cheap); decals are ground-level so this is barely visible.
//  - `?fxdemo=1` self-demo dispatches fake bus events around (0,0).

export function createFx(world) {
  const THREE = world.THREE;
  const scene = world.scene;
  const bus = world.bus;
  const rand = (a, b) => a + Math.random() * (b - a);

  // ---------------------------------------------------------------- particles
  const PVERT = `
    attribute float aSize; attribute float aAlpha; attribute vec3 aColor;
    uniform float uScale;
    varying float vA; varying vec3 vC;
    void main(){
      vec4 mv = modelViewMatrix * vec4(position,1.0);
      gl_Position = projectionMatrix * mv;
      float persp = projectionMatrix[2][3] == 0.0 ? 1.0 : -mv.z;
      gl_PointSize = clamp(aSize * projectionMatrix[1][1] * uScale / max(persp, 0.001), 0.0, 256.0);
      vA = aAlpha; vC = aColor;
    }`;
  const PFRAG = `
    uniform float uSoft;
    varying float vA; varying vec3 vC;
    void main(){
      float d = length(gl_PointCoord - 0.5);
      if (d > 0.5) discard;
      float a = vA * (1.0 - smoothstep(0.5 - uSoft, 0.5, d));
      if (a < 0.01) discard;
      gl_FragColor = vec4(vC, a);
    }`;
  const pxScale = { value: 400 };

  function makePool(N, soft, additive, order) {
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
    const size = new Float32Array(N), alpha = new Float32Array(N);
    const vel = new Float32Array(N * 3);
    const life = new Float32Array(N), max = new Float32Array(N);
    const size0 = new Float32Array(N), grow = new Float32Array(N), grav = new Float32Array(N);
    const drag = new Float32Array(N), a0 = new Float32Array(N), fin = new Float32Array(N), ground = new Uint8Array(N);
    const g = new THREE.BufferGeometry();
    const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    const aCol = new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage);
    const aSize = new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage);
    const aAl = new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', aPos); g.setAttribute('aColor', aCol);
    g.setAttribute('aSize', aSize); g.setAttribute('aAlpha', aAl);
    g.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      vertexShader: PVERT, fragmentShader: PFRAG,
      uniforms: { uScale: pxScale, uSoft: { value: soft } },
      transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const pts = new THREE.Points(g, mat);
    pts.frustumCulled = false; pts.renderOrder = order; pts.name = 'fx-particles';
    scene.add(pts);
    let n = 0;
    const copy = (d, s) => {
      for (let k = 0; k < 3; k++) { pos[d*3+k] = pos[s*3+k]; vel[d*3+k] = vel[s*3+k]; col[d*3+k] = col[s*3+k]; }
      size[d] = size[s]; alpha[d] = alpha[s]; life[d] = life[s]; max[d] = max[s]; size0[d] = size0[s];
      grow[d] = grow[s]; grav[d] = grav[s]; drag[d] = drag[s]; a0[d] = a0[s]; fin[d] = fin[s]; ground[d] = ground[s];
    };
    return {
      get count() { return n; }, N,
      // o: {grav, grow, drag, alpha, fin(fade-in fraction), ground(stick to ground)}
      spawn(x, y, z, vx, vy, vz, r, gg, b, sz, lf, o) {
        let i;
        if (n < N) i = n++;
        else i = (Math.random() * N) | 0; // full: overwrite a random one
        pos[i*3] = x; pos[i*3+1] = y; pos[i*3+2] = z;
        vel[i*3] = vx; vel[i*3+1] = vy; vel[i*3+2] = vz;
        col[i*3] = r; col[i*3+1] = gg; col[i*3+2] = b;
        size0[i] = size[i] = sz; life[i] = max[i] = lf;
        grav[i] = o.grav ?? 0; grow[i] = o.grow ?? 0; drag[i] = o.drag ?? 0;
        a0[i] = o.alpha ?? 1; fin[i] = o.fin ?? 0; ground[i] = o.ground ? 1 : 0;
        alpha[i] = fin[i] > 0 ? 0 : a0[i];
      },
      update(dt) {
        let i = 0;
        while (i < n) {
          life[i] -= dt;
          if (life[i] <= 0) { n--; if (i !== n) copy(i, n); continue; }
          const j = i * 3;
          const dk = Math.max(0, 1 - drag[i] * dt);
          vel[j] *= dk; vel[j+2] *= dk; vel[j+1] = vel[j+1] * dk - grav[i] * dt;
          pos[j] += vel[j] * dt; pos[j+1] += vel[j+1] * dt; pos[j+2] += vel[j+2] * dt;
          if (ground[i] && pos[j+1] < 0.06) { pos[j+1] = 0.06; vel[j] = vel[j+1] = vel[j+2] = 0; }
          const t = 1 - life[i] / max[i];
          let f = Math.min(1, (1 - t) / 0.35);
          if (fin[i] > 0 && t < fin[i]) f = Math.min(f, t / fin[i]);
          alpha[i] = a0[i] * f;
          size[i] = size0[i] * (1 + grow[i] * t);
          i++;
        }
        g.setDrawRange(0, n);
        if (n) { aPos.needsUpdate = aCol.needsUpdate = aSize.needsUpdate = aAl.needsUpdate = true; }
      },
    };
  }
  const crisp = makePool(700, 0.08, false, 3);
  const soft = makePool(300, 0.45, false, 4);
  const glow = makePool(500, 0.4, true, 5);
  const GRAV = 22;

  // ------------------------------------------------------------------ decals
  const CELL = 256;
  const atlas = document.createElement('canvas');
  atlas.width = atlas.height = CELL * 2;
  {
    const c = atlas.getContext('2d');
    const splat = (ox, oy, seed) => {
      let s = seed;
      const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      const cx = ox + CELL / 2, cy = oy + CELL / 2;
      c.save();
      c.beginPath(); c.rect(ox, oy, CELL, CELL); c.clip();
      // main blob: lumpy polygon
      c.fillStyle = 'rgba(120,8,8,0.95)';
      c.beginPath();
      const pts = 22;
      for (let k = 0; k <= pts; k++) {
        const a = (k / pts) * Math.PI * 2, rr = CELL * (0.24 + rnd() * 0.09);
        const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
        k ? c.lineTo(x, y) : c.moveTo(x, y);
      }
      c.fill();
      // inner darker pool
      c.fillStyle = 'rgba(80,4,4,0.9)';
      c.beginPath(); c.arc(cx + (rnd() - 0.5) * 12, cy + (rnd() - 0.5) * 12, CELL * 0.15, 0, 7); c.fill();
      // streaks + droplets
      const nStreak = 5 + ((rnd() * 5) | 0);
      for (let k = 0; k < nStreak; k++) {
        const a = rnd() * Math.PI * 2, len = CELL * (0.3 + rnd() * 0.15);
        c.strokeStyle = `rgba(${140 + (rnd() * 60) | 0},10,10,0.9)`;
        c.lineWidth = 3 + rnd() * 6; c.lineCap = 'round';
        c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len); c.stroke();
        c.fillStyle = 'rgba(150,12,12,0.95)';
        c.beginPath(); c.arc(cx + Math.cos(a) * len, cy + Math.sin(a) * len, 3 + rnd() * 6, 0, 7); c.fill();
      }
      for (let k = 0; k < 26; k++) {
        const a = rnd() * Math.PI * 2, d = CELL * (0.26 + rnd() * 0.22);
        c.fillStyle = `rgba(${110 + (rnd() * 90) | 0},10,10,0.9)`;
        c.beginPath(); c.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 1.5 + rnd() * 5, 0, 7); c.fill();
      }
      c.restore();
    };
    splat(0, 0, 1234); splat(CELL, 0, 98765); splat(0, CELL, 55555);
    // scorch
    const ox = CELL, oy = CELL, cx = ox + CELL / 2, cy = oy + CELL / 2;
    const gr = c.createRadialGradient(cx, cy, 4, cx, cy, CELL * 0.48);
    gr.addColorStop(0, 'rgba(10,8,6,0.95)'); gr.addColorStop(0.45, 'rgba(25,20,15,0.8)');
    gr.addColorStop(0.8, 'rgba(40,32,24,0.35)'); gr.addColorStop(1, 'rgba(40,32,24,0)');
    c.fillStyle = gr; c.fillRect(ox, oy, CELL, CELL);
    for (let k = 0; k < 40; k++) {
      const a = Math.random() * 7, d = Math.random() * CELL * 0.42;
      c.fillStyle = `rgba(15,12,10,${0.2 + Math.random() * 0.4})`;
      c.beginPath(); c.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 2 + Math.random() * 9, 0, 7); c.fill();
    }
  }
  const atlasTex = new THREE.CanvasTexture(atlas);
  if ('colorSpace' in atlasTex) atlasTex.colorSpace = THREE.SRGBColorSpace;
  const DN = 120;
  const dGeo = new THREE.PlaneGeometry(1, 1);
  dGeo.rotateX(-Math.PI / 2);
  const dCell = new Float32Array(DN), dAlpha = new Float32Array(DN);
  const aCell = new THREE.InstancedBufferAttribute(dCell, 1).setUsage(THREE.DynamicDrawUsage);
  const aDAl = new THREE.InstancedBufferAttribute(dAlpha, 1).setUsage(THREE.DynamicDrawUsage);
  dGeo.setAttribute('aCell', aCell); dGeo.setAttribute('aAlpha', aDAl);
  const dMat = new THREE.ShaderMaterial({
    vertexShader: `
      attribute float aCell; attribute float aAlpha; varying vec2 vUv; varying float vA;
      void main(){
        vec2 cell = vec2(mod(aCell, 2.0), 1.0 - floor(aCell / 2.0));
        vUv = (uv + cell) * 0.5; vA = aAlpha;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform sampler2D uMap; uniform float uDim; varying vec2 vUv; varying float vA;
      void main(){ vec4 c = texture2D(uMap, vUv); float a = c.a * vA; if (a < 0.01) discard;
        gl_FragColor = vec4(c.rgb * uDim, a); }`,
    uniforms: { uMap: { value: atlasTex }, uDim: { value: 1 } },
    transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const decals = new THREE.InstancedMesh(dGeo, dMat, DN);
  decals.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  decals.frustumCulled = false; decals.renderOrder = 1; decals.name = 'fx-decals';
  const dLife = new Float32Array(DN), dMax = new Float32Array(DN), dA0 = new Float32Array(DN);
  const dm = decals.instanceMatrix.array;
  for (let i = 0; i < DN; i++) dm.fill(0, i * 16, i * 16 + 16); // zero scale = hidden
  scene.add(decals);
  let dNext = 0;
  function decal(x, z, w, cell, lifeS, a) {
    const i = dNext; dNext = (dNext + 1) % DN; // oldest recycled
    const r = Math.random() * Math.PI * 2, c = Math.cos(r) * w, s = Math.sin(r) * w;
    const y = 0.025 + (i % 10) * 0.003;
    const o = i * 16;
    dm[o] = c; dm[o+1] = 0; dm[o+2] = -s; dm[o+3] = 0;
    dm[o+4] = 0; dm[o+5] = 1; dm[o+6] = 0; dm[o+7] = 0;
    dm[o+8] = s; dm[o+9] = 0; dm[o+10] = c; dm[o+11] = 0;
    dm[o+12] = x; dm[o+13] = y; dm[o+14] = z; dm[o+15] = 1;
    dCell[i] = cell; dLife[i] = dMax[i] = lifeS; dA0[i] = a; dAlpha[i] = a;
    decals.instanceMatrix.needsUpdate = true; aCell.needsUpdate = true;
  }
  function updateDecals(dt) {
    let any = false;
    for (let i = 0; i < DN; i++) {
      if (dLife[i] <= 0) continue;
      dLife[i] -= dt; any = true;
      const t = Math.max(0, dLife[i] / dMax[i]);
      dAlpha[i] = dA0[i] * Math.min(1, t * 1.6); // hold, then fade
      if (dLife[i] <= 0) { dAlpha[i] = 0; dm.fill(0, i * 16, i * 16 + 16); decals.instanceMatrix.needsUpdate = true; }
    }
    if (any) aDAl.needsUpdate = true;
  }

  // ----------------------------------------------------------------- tracers
  const TN = 128;
  const tPos = new Float32Array(TN * 4 * 3), tCol = new Float32Array(TN * 4 * 3), tAl = new Float32Array(TN * 4);
  const tIdx = new Uint16Array(TN * 6);
  for (let i = 0; i < TN; i++) {
    const v = i * 4, o = i * 6;
    tIdx[o] = v; tIdx[o+1] = v + 1; tIdx[o+2] = v + 2; tIdx[o+3] = v + 2; tIdx[o+4] = v + 1; tIdx[o+5] = v + 3;
  }
  const tGeo = new THREE.BufferGeometry();
  const tPA = new THREE.BufferAttribute(tPos, 3).setUsage(THREE.DynamicDrawUsage);
  const tCA = new THREE.BufferAttribute(tCol, 3).setUsage(THREE.DynamicDrawUsage);
  const tAA = new THREE.BufferAttribute(tAl, 1).setUsage(THREE.DynamicDrawUsage);
  tGeo.setAttribute('position', tPA); tGeo.setAttribute('aColor', tCA); tGeo.setAttribute('aAlpha', tAA);
  tGeo.setIndex(new THREE.BufferAttribute(tIdx, 1));
  tGeo.setDrawRange(0, 0);
  const tMat = new THREE.ShaderMaterial({
    vertexShader: `attribute vec3 aColor; attribute float aAlpha; varying vec3 vC; varying float vA;
      void main(){ vC = aColor; vA = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `varying vec3 vC; varying float vA; void main(){ gl_FragColor = vec4(vC, vA); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const tracerMesh = new THREE.Mesh(tGeo, tMat);
  tracerMesh.frustumCulled = false; tracerMesh.renderOrder = 6; tracerMesh.name = 'fx-tracers';
  scene.add(tracerMesh);
  // tracer records (struct of arrays)
  const tr = {
    ax: new Float32Array(TN), ay: new Float32Array(TN), az: new Float32Array(TN),
    bx: new Float32Array(TN), by: new Float32Array(TN), bz: new Float32Array(TN),
    w: new Float32Array(TN), life: new Float32Array(TN), max: new Float32Array(TN),
    r: new Float32Array(TN), g: new Float32Array(TN), b: new Float32Array(TN), flick: new Uint8Array(TN),
  };
  let tN = 0;
  function tracer(ax, ay, az, bx, by, bz, w, lf, r, g, b, flick) {
    let i = tN < TN ? tN++ : (Math.random() * TN) | 0;
    tr.ax[i] = ax; tr.ay[i] = ay; tr.az[i] = az; tr.bx[i] = bx; tr.by[i] = by; tr.bz[i] = bz;
    tr.w[i] = w; tr.life[i] = tr.max[i] = lf; tr.r[i] = r; tr.g[i] = g; tr.b[i] = b; tr.flick[i] = flick ? 1 : 0;
  }
  const camPos = new THREE.Vector3();
  function updateTracers(dt) {
    let i = 0;
    while (i < tN) {
      tr.life[i] -= dt;
      if (tr.life[i] <= 0) {
        tN--;
        if (i !== tN) for (const k in tr) tr[k][i] = tr[k][tN];
        continue;
      }
      i++;
    }
    if (world.camera) world.camera.getWorldPosition(camPos);
    for (i = 0; i < tN; i++) {
      const ax = tr.ax[i], ay = tr.ay[i], az = tr.az[i], bx = tr.bx[i], by = tr.by[i], bz = tr.bz[i];
      let dx = bx - ax, dy = by - ay, dz = bz - az;
      const mx = (ax + bx) / 2 - camPos.x, my = (ay + by) / 2 - camPos.y, mz = (az + bz) / 2 - camPos.z;
      // side = dir x view
      let sx = dy * mz - dz * my, sy = dz * mx - dx * mz, sz = dx * my - dy * mx;
      const sl = Math.hypot(sx, sy, sz) || 1, hw = tr.w[i] * 0.5 / sl;
      sx *= hw; sy *= hw; sz *= hw;
      const v = i * 12;
      tPos[v] = ax - sx; tPos[v+1] = ay - sy; tPos[v+2] = az - sz;
      tPos[v+3] = ax + sx; tPos[v+4] = ay + sy; tPos[v+5] = az + sz;
      tPos[v+6] = bx - sx; tPos[v+7] = by - sy; tPos[v+8] = bz - sz;
      tPos[v+9] = bx + sx; tPos[v+10] = by + sy; tPos[v+11] = bz + sz;
      let a = tr.life[i] / tr.max[i];
      if (tr.flick[i]) a *= Math.random() < 0.5 ? 1 : 0.35;
      for (let k = 0; k < 4; k++) {
        tCol[v + k*3] = tr.r[i]; tCol[v + k*3 + 1] = tr.g[i]; tCol[v + k*3 + 2] = tr.b[i];
        tAl[i*4 + k] = k < 2 ? a * 0.55 : a; // brighter at the impact end
      }
    }
    tGeo.setDrawRange(0, tN * 6);
    if (tN) tPA.needsUpdate = tCA.needsUpdate = tAA.needsUpdate = true;
  }

  // ------------------------------------------------------------------- rings
  const ringGeo = new THREE.RingGeometry(0.9, 1, 48);
  ringGeo.rotateX(-Math.PI / 2);
  const rings = [];
  for (let i = 0; i < 8; i++) {
    const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
      color: 0x38e8ff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
    m.visible = false; m.renderOrder = 2; m.frustumCulled = false; m.name = 'fx-ring';
    scene.add(m);
    rings.push({ m, life: 0, max: 1, s0: 1, s1: 2 });
  }
  let ringNext = 0;
  function ring(x, z, s0, s1, lf) {
    const r = rings[ringNext]; ringNext = (ringNext + 1) % rings.length;
    r.m.position.set(x, 0.12, z); r.life = r.max = lf; r.s0 = s0; r.s1 = s1; r.m.visible = true;
  }
  function updateRings(dt) {
    for (const r of rings) {
      if (!r.m.visible) continue;
      r.life -= dt;
      if (r.life <= 0) { r.m.visible = false; continue; }
      const t = 1 - r.life / r.max, e = 1 - (1 - t) * (1 - t);
      const s = r.s0 + (r.s1 - r.s0) * e;
      r.m.scale.set(s, 1, s);
      r.m.material.opacity = 0.75 * (1 - t);
    }
  }

  // ------------------------------------------------------------- effect kits
  function bloodBurst(x, y, z, dirx, dirz, count, speed) {
    for (let k = 0; k < count; k++) {
      const t = Math.random();
      const r = 0.54 + t * 0.28, g = 0.06 + t * 0.04, b = 0.06 + t * 0.04;
      const spread = 0.9;
      const vx = (dirx + rand(-spread, spread)) * speed * rand(0.4, 1);
      const vz = (dirz + rand(-spread, spread)) * speed * rand(0.4, 1);
      crisp.spawn(x + rand(-0.2, 0.2), y + rand(-0.3, 0.3), z + rand(-0.2, 0.2), vx, rand(2, 7), vz,
        r, g, b, rand(0.42, 0.7), rand(0.5, 0.9), { grav: GRAV, drag: 0.6, ground: true });
    }
  }
  function sparks(x, y, z, dirx, dirz, count) {
    for (let k = 0; k < count; k++) {
      glow.spawn(x, y, z, (dirx + rand(-1, 1)) * rand(3, 9), rand(1, 8), (dirz + rand(-1, 1)) * rand(3, 9),
        1, rand(0.45, 0.75), 0.15, rand(0.3, 0.45), rand(0.18, 0.4), { grav: GRAV, drag: 1 });
    }
  }
  function smoke(x, y, z, count, sz, lf, spread, rise) {
    for (let k = 0; k < count; k++) {
      const gcol = rand(0.25, 0.45);
      soft.spawn(x + rand(-spread, spread), y + rand(0, spread * 0.5), z + rand(-spread, spread),
        rand(-0.6, 0.6), rand(rise * 0.6, rise), rand(-0.6, 0.6),
        gcol, gcol * 0.97, gcol * 0.95, sz * rand(0.8, 1.2), lf * rand(0.7, 1.1),
        { grav: -0.4, grow: 1.8, drag: 0.5, alpha: 0.6, fin: 0.12 });
    }
  }
  function explosion(x, z, scale, smokeTime) {
    // flash
    for (let k = 0; k < 6; k++)
      glow.spawn(x + rand(-0.5, 0.5) * scale, rand(0.5, 1.5) * scale, z + rand(-0.5, 0.5) * scale, 0, rand(0, 2), 0,
        1, rand(0.8, 1), rand(0.4, 0.7), rand(2.2, 3.4) * scale, rand(0.18, 0.32), { grow: 0.8 });
    // fireballs
    const nf = Math.round(18 * scale);
    for (let k = 0; k < nf; k++) {
      const a = Math.random() * Math.PI * 2, sp = rand(2, 8) * scale;
      glow.spawn(x, 0.8 * scale, z, Math.cos(a) * sp, rand(2, 9) * scale, Math.sin(a) * sp,
        1, rand(0.35, 0.8), 0.08, rand(0.6, 1.1) * scale, rand(0.35, 0.7), { grav: 9, drag: 2.2, grow: 0.5 });
    }
    sparks(x, 0.8, z, 0, 0, Math.round(14 * scale));
    // debris
    for (let k = 0; k < Math.round(10 * scale); k++) {
      const a = Math.random() * Math.PI * 2, sp = rand(3, 8);
      const c = rand(0.1, 0.22);
      crisp.spawn(x, 0.6, z, Math.cos(a) * sp, rand(5, 11), Math.sin(a) * sp, c, c, c, rand(0.3, 0.5), rand(0.8, 1.3),
        { grav: GRAV, ground: true });
    }
    smokeEmitters.push({ x, z, t: smokeTime, max: smokeTime, scale, acc: 0 });
    decal(x, z, rand(4, 5.5) * scale, 3, 45, 0.9);
  }
  const smokeEmitters = []; // small, bounded by deaths; entries are reused-free plain objects (tiny)
  function updateEmitters(dt) {
    for (let i = smokeEmitters.length - 1; i >= 0; i--) {
      const e = smokeEmitters[i];
      e.t -= dt; e.acc += dt;
      const rate = 0.09 / Math.max(0.6, e.t / e.max + 0.4);
      while (e.acc > rate) {
        e.acc -= rate;
        smoke(e.x, 0.8 * e.scale, e.z, 1, 1.6 * e.scale, 2.4, 0.8 * e.scale, 2.2);
      }
      if (e.t <= 0) smokeEmitters.splice(i, 1);
    }
    if (smokeEmitters.length > 24) smokeEmitters.splice(0, smokeEmitters.length - 24);
  }

  const isBld = (e) => e && (e.cls === 'bld' || /^(cc|barracks|factory|turret|wall|gate|artillery|siege)/.test(e.kind || ''));

  // -------------------------------------------------------------- bus events
  bus.addEventListener('hit', (ev) => {
    const d = ev.detail || {};
    const x = d.x ?? d.victim?.x ?? 0, z = d.z ?? d.victim?.z ?? 0;
    let dx = 0, dz = 0;
    if (d.attacker) { dx = x - d.attacker.x; dz = z - d.attacker.z; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l; }
    const cls = d.cls || d.victim?.cls;
    if (cls === 'inf') {
      bloodBurst(x, 1.1, z, dx, dz, 10 + ((Math.random() * 9) | 0), 3.5);
      if (Math.random() < 0.75)
        decal(x + dx * rand(0.3, 1), z + dz * rand(0.3, 1), rand(2.6, 3.8), (Math.random() * 3) | 0, 25, 0.9);
    } else if (cls === 'veh' || cls === 'bld') {
      const y = cls === 'bld' ? 2 : 1.2;
      sparks(x - dx * 0.6, y, z - dz * 0.6, -dx, -dz, 8);
      smoke(x, y, z, 2, 0.9, 1.1, 0.4, 1.5);
    }
  });

  bus.addEventListener('died', (ev) => {
    const e = ev.detail?.entity; if (!e) return;
    const x = e.x ?? 0, z = e.z ?? 0;
    if (e.cls === 'inf') {
      bloodBurst(x, 1, z, 0, 0, 30, 5);
      decal(x, z, rand(4.2, 5.2), (Math.random() * 3) | 0, 30, 0.95);
      decal(x + rand(-1.5, 1.5), z + rand(-1.5, 1.5), rand(2.4, 3.2), (Math.random() * 3) | 0, 30, 0.9);
    } else if (e.cls === 'neutral' || e.kind === 'crystal') {
      // crystal depleted: small cyan puff
      for (let k = 0; k < 12; k++) glow.spawn(x, 1, z, rand(-3, 3), rand(1, 5), rand(-3, 3), 0.3, 0.9, 1, 0.4, 0.6, { grav: 6 });
    } else if (isBld(e)) {
      const big = e.kind === 'cc' ? 2.4 : e.kind === 'wall' ? 0.9 : Math.max(1.2, (e.r || 5) / 4);
      explosion(x, z, big, e.kind === 'wall' ? 2.5 : 6 + big * 1.5);
    } else {
      explosion(x, z, 1, 3);
    }
  });

  function mapKind(k) {
    k = String(k || '');
    if (/siege/.test(k)) return 'siege';
    if (/artillery|arty/.test(k)) return 'arty';
    if (/tank|cannon/.test(k)) return 'cannon';
    if (/raider|mg/.test(k)) return 'mg';
    return 'inf';
  }
  bus.addEventListener('shot', (ev) => {
    const d = ev.detail || {}; const f = d.from || {}, t = d.to || {};
    const ax = f.x ?? 0, ay = f.y ?? 1.2, az = f.z ?? 0, bx = t.x ?? 0, by = t.y ?? 1, bz = t.z ?? 0;
    const kind = mapKind(d.kind);
    const muzzle = (sz, r, g, b) => glow.spawn(ax, ay, az, 0, 0, 0, r, g, b, sz, 0.07, {});
    if (kind === 'inf') {
      tracer(ax, ay, az, bx, by, bz, 0.18, 0.12, 1, 0.95, 0.7, false);
      muzzle(0.6, 1, 0.9, 0.6);
    } else if (kind === 'mg') {
      // short bright flicker: just the last ~45% of the path
      const s = 0.55 + Math.random() * 0.2;
      tracer(ax + (bx - ax) * s * 0.5, ay + (by - ay) * s * 0.5, az + (bz - az) * s * 0.5, bx, by, bz, 0.14, 0.09, 1, 1, 0.55, true);
      muzzle(0.7, 1, 0.85, 0.4);
    } else if (kind === 'cannon') {
      tracer(ax, ay, az, bx, by, bz, 0.35, 0.14, 1, 0.55, 0.15, false);
      muzzle(1.4, 1, 0.6, 0.2);
      smoke(ax, ay, az, 1, 0.8, 0.6, 0.1, 0.8);
    } else if (kind === 'siege') {
      tracer(ax, ay, az, bx, by, bz, 1.1, 0.35, 0.9, 0.95, 1, false);
      tracer(ax, ay, az, bx, by, bz, 0.4, 0.4, 1, 1, 1, false);
      muzzle(3, 0.9, 0.95, 1);
    } else { // artillery: arcing dotted path + travelling shell
      const T = 0.5, dist = Math.hypot(bx - ax, bz - az);
      const apex = Math.max(3, dist * 0.35);
      const G = 8 * apex / (T * T); // parabola through apex at T/2
      const vy = (by - ay + 0.5 * G * T * T) / T;
      const segs = 10;
      const P = (u) => { const tt = u * T; return [ax + (bx - ax) * u, ay + vy * tt - 0.5 * G * tt * tt, az + (bz - az) * u]; };
      for (let k = 0; k < segs; k++) {
        const p0 = P(k / segs), p1 = P((k + 0.5) / segs);
        tracer(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], 0.18, 0.5, 1, 0.7, 0.3, false);
      }
      glow.spawn(ax, ay, az, (bx - ax) / T, vy, (bz - az) / T, 1, 0.8, 0.4, 0.7, T, { grav: G });
      muzzle(1.6, 1, 0.65, 0.25);
    }
  });

  bus.addEventListener('built', (ev) => {
    const e = ev.detail?.entity; if (!e) return;
    const r = e.r || 1.5;
    ring(e.x ?? 0, e.z ?? 0, r * 0.8, r * 2.2, 0.55);
    for (let k = 0; k < 14; k++) {
      const a = (k / 14) * Math.PI * 2;
      glow.spawn((e.x ?? 0) + Math.cos(a) * r, 0.4, (e.z ?? 0) + Math.sin(a) * r, Math.cos(a) * 2, rand(2, 4), Math.sin(a) * 2,
        0.25, 0.9, 1, 0.45, 0.5, { grav: 4 });
    }
  });

  bus.addEventListener('tier', (ev) => {
    const d = ev.detail || {}; if (d.team !== 0) return;
    const cc = (world.entities || []).find((e) => e.kind === 'cc' && e.team === 0);
    const x = cc?.x ?? 0, z = cc?.z ?? 0;
    ring(x, z, 6, 34, 1.3);
    setTimeout(() => ring(x, z, 4, 24, 1.0), 180);
  });

  // ----------------------------------------------------------- day / night
  let hemi = null, dir = null, base = null, lastNF = -1, lightScanT = 0;
  const C = (h) => new THREE.Color(h);
  const NIGHT = { sky: C(0x0b1430), dir: C(0x7f9bff), hemiSky: C(0x4a5f9a), hemiGround: C(0x1a2038), dirI: 0.5, hemiI: 0.8 };
  const tmpC = new THREE.Color();
  function scanLights() {
    scene.traverse((o) => {
      if (o.isHemisphereLight && !hemi) hemi = o;
      if (o.isDirectionalLight && !dir) dir = o;
    });
    if (!base && (hemi || dir)) {
      base = {
        dirI: dir?.intensity ?? 1, dirC: dir ? dir.color.clone() : C(0xfff1d6),
        hemiI: hemi?.intensity ?? 1, hemiSky: hemi ? hemi.color.clone() : C(0xffffff),
        hemiGround: hemi ? hemi.groundColor.clone() : C(0x444444),
        sky: scene.background?.isColor ? scene.background.clone() : C(0xffd9a8),
        fog: scene.fog ? scene.fog.color.clone() : null,
      };
    }
  }
  let crystals = [], crystalScanT = 0;
  function scanCrystals() {
    crystals = [];
    const seen = new Set();
    const add = (root) => root?.traverse?.((o) => {
      const m = o.material; if (!m || seen.has(m)) return;
      for (const mm of Array.isArray(m) ? m : [m]) {
        if (!mm.emissive || seen.has(mm)) continue;
        seen.add(mm);
        if (mm.userData.fxBaseEI === undefined) mm.userData.fxBaseEI = mm.emissiveIntensity;
        if (mm.emissive.getHex() === 0) { mm.emissive.setHex(0x1fd8ff); mm.userData.fxBaseEI = 0; mm.emissiveIntensity = 0; }
        crystals.push(mm);
      }
    });
    for (const e of world.entities || []) if (e.kind === 'crystal') add(e.mesh);
    scene.traverse((o) => { if (o.userData?.kind === 'crystal') add(o); });
  }
  function updateDayNight(dt) {
    lightScanT -= dt;
    if ((!hemi || !dir) && lightScanT <= 0) { scanLights(); lightScanT = 2; }
    crystalScanT -= dt;
    if (crystalScanT <= 0) { scanCrystals(); crystalScanT = 3; }
    const nf = Math.min(1, Math.max(0, +(world.ui?.nightFactor) || 0));
    if (base && Math.abs(nf - lastNF) > 0.002) {
      lastNF = nf;
      if (dir) { dir.intensity = base.dirI + (NIGHT.dirI * base.dirI - base.dirI) * nf; dir.color.copy(base.dirC).lerp(NIGHT.dir, nf); }
      if (hemi) {
        hemi.intensity = base.hemiI + (NIGHT.hemiI * base.hemiI - base.hemiI) * nf;
        hemi.color.copy(base.hemiSky).lerp(NIGHT.hemiSky, nf);
        hemi.groundColor.copy(base.hemiGround).lerp(NIGHT.hemiGround, nf);
      }
      tmpC.copy(base.sky).lerp(NIGHT.sky, nf);
      if (scene.background?.isColor) scene.background.copy(tmpC);
      else if (!scene.background) scene.background = tmpC.clone();
      if (scene.fog) scene.fog.color.copy(base.fog || base.sky).lerp(NIGHT.sky, nf);
      dMat.uniforms.uDim.value = 1 - 0.45 * nf;
    }
    for (const m of crystals) m.emissiveIntensity = m.userData.fxBaseEI + 0.6 * nf;
  }

  // -------------------------------------------------------------- self-demo
  let demo = null;
  try { if (new URLSearchParams(location.search).get('fxdemo') === '1') demo = { a: 0, b: 0, n: 0 }; } catch {}
  const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
  let demoLast = 0;
  function updateDemo() {
    // wall-clock driven so slow/headless frame rates still show plenty of events
    const now = performance.now() / 1000, dt = demoLast ? Math.min(1, now - demoLast) : 0; demoLast = now;
    demo.a += dt; demo.b += dt;
    while (demo.a >= 0.5) {
      demo.a -= 0.5; demo.n++;
      const cx = world.camTarget?.x ?? 0, cz = world.camTarget?.z ?? 0; // engine extra; contract says near (0,0)
      const x = cx + rand(-14, 14), z = cz + rand(-9, 9);
      const atk = { x: x + rand(-15, 15), z: z + rand(-15, 15) };
      const cls = demo.n % 2 ? 'inf' : 'veh';
      emit('hit', { x, z, attacker: atk, victim: { x, z, cls }, dmg: 10, cls });
      const kinds = ['warden', 'raider', 'tank', 'artillery', 'turret_mg', 'siege'];
      emit('shot', { from: { x: atk.x, y: 1.2, z: atk.z }, to: { x, y: 1, z }, kind: kinds[demo.n % kinds.length] });
    }
    if (demo.b >= 4) {
      demo.b -= 4;
      const cx = world.camTarget?.x ?? 0, cz = world.camTarget?.z ?? 0;
      emit('died', { entity: { kind: 'warden', cls: 'inf', x: cx + rand(-12, 12), z: cz + rand(-8, 8), team: 1, r: 1.2 } });
      emit('died', { entity: { kind: 'tank', cls: 'veh', x: cx + rand(-14, 14), z: cz + rand(-9, 9), team: 1, r: 2.2 } });
    }
  }

  // ------------------------------------------------------------------ update
  return {
    update(dt) {
      dt = Math.min(0.1, dt ?? world.clock?.dt ?? 0.016);
      const cvs = world.renderer?.domElement;
      if (cvs) pxScale.value = cvs.height / 2;
      if (demo) updateDemo();
      crisp.update(dt); soft.update(dt); glow.update(dt);
      updateTracers(dt); updateDecals(dt); updateRings(dt); updateEmitters(dt);
      updateDayNight(dt);
    },
    // debug/test hooks
    _stats: () => ({ crisp: crisp.count, soft: soft.count, glow: glow.count, tracers: tN, smokeEmitters: smokeEmitters.length }),
    _emit: emit,
  };
}
