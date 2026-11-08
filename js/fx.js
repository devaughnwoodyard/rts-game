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
//  - Abilities: `ability` events. Hero ids (bulwark/chain/eruption/rootbind) or generic `kind`: rain, flood, erupt,
//    burrow, burn, stun, heal, shield, speed, charge, lightning, aoe. Fields used: x, z, r|radius, duration, targets,
//    unit|hero, from/to, color (defaults to team colour).
//  - Shot kinds: 'hero' (styled by nearest world.heroes hero), arrow, spear, minimissile, ironball (instanced, arcing,
//    impacts are visual only), bullet, laser, lightning, slug. detail.air (or from.y > 5) adds an engine glow.

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
  function ring(x, z, s0, s1, lf, color = 0x38e8ff) {
    const r = rings[ringNext]; ringNext = (ringNext + 1) % rings.length;
    r.m.material.color.setHex(color);
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
    if (heroShot(d)) return;
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

  // ======================================================= abilities / heroes / projectiles
  // (see ABILITY FX section below; inserted here so it can use every pool above)
  // ABILITY FX. Pools: quad batch 768 (immediate-mode, rebuilt per frame: bolts, trails, rain, wind),
  // ground glows 16, cloud discs 4, hex bubbles 6, root spikes 128 (instanced), water discs 4, mounds 8,
  // projectiles 4 kinds x 64 (instanced). Ability events: {hero|unit, id, kind, x, z, r, duration, targets, ...}.
  const qbN = 768;
  const qPos = new Float32Array(qbN * 12), qCol = new Float32Array(qbN * 12), qAl = new Float32Array(qbN * 4);
  const qIdx = new Uint16Array(qbN * 6);
  for (let i = 0; i < qbN; i++) { const v = i * 4, o = i * 6; qIdx.set([v, v + 1, v + 2, v + 2, v + 1, v + 3], o); }
  const qGeo = new THREE.BufferGeometry();
  const qPA = new THREE.BufferAttribute(qPos, 3).setUsage(THREE.DynamicDrawUsage);
  const qCA = new THREE.BufferAttribute(qCol, 3).setUsage(THREE.DynamicDrawUsage);
  const qAA = new THREE.BufferAttribute(qAl, 1).setUsage(THREE.DynamicDrawUsage);
  qGeo.setAttribute('position', qPA); qGeo.setAttribute('aColor', qCA); qGeo.setAttribute('aAlpha', qAA);
  qGeo.setIndex(new THREE.BufferAttribute(qIdx, 1)); qGeo.setDrawRange(0, 0);
  const qMesh = new THREE.Mesh(qGeo, tMat); qMesh.frustumCulled = false; qMesh.renderOrder = 7; qMesh.name = 'fx-quads';
  scene.add(qMesh);
  let qn = 0;
  function qseg(ax, ay, az, bx, by, bz, w, r, g, b, a) {
    if (qn >= qbN) return;
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const mx = (ax + bx) / 2 - camPos.x, my = (ay + by) / 2 - camPos.y, mz = (az + bz) / 2 - camPos.z;
    let sx = dy * mz - dz * my, sy = dz * mx - dx * mz, sz = dx * my - dy * mx;
    const hw = w * 0.5 / (Math.hypot(sx, sy, sz) || 1); sx *= hw; sy *= hw; sz *= hw;
    const v = qn * 12;
    qPos[v] = ax - sx; qPos[v + 1] = ay - sy; qPos[v + 2] = az - sz; qPos[v + 3] = ax + sx; qPos[v + 4] = ay + sy; qPos[v + 5] = az + sz;
    qPos[v + 6] = bx - sx; qPos[v + 7] = by - sy; qPos[v + 8] = bz - sz; qPos[v + 9] = bx + sx; qPos[v + 10] = by + sy; qPos[v + 11] = bz + sz;
    for (let k = 0; k < 4; k++) { qCol[v + k * 3] = r; qCol[v + k * 3 + 1] = g; qCol[v + k * 3 + 2] = b; qAl[qn * 4 + k] = a; }
    qn++;
  }
  // jagged bolt along a polyline (re-randomized every call)
  function jag(pts, w, r, g, b, a, jit) {
    for (let i = 0; i + 1 < pts.length; i++) {
      const A = pts[i], B = pts[i + 1];
      const L = Math.hypot(B.x - A.x, B.y - A.y, B.z - A.z), n = Math.max(3, Math.min(10, Math.ceil(L / 1.4)));
      let px = A.x, py = A.y, pz = A.z;
      for (let k = 1; k <= n; k++) {
        const f = k / n, j = k < n ? jit : 0;
        const x = A.x + (B.x - A.x) * f + rand(-j, j), y = A.y + (B.y - A.y) * f + rand(-j, j) * 0.7, z = A.z + (B.z - A.z) * f + rand(-j, j);
        qseg(px, py, pz, x, y, z, w * 3.2, r * 0.5, g * 0.6, b, a * 0.35);
        qseg(px, py, pz, x, y, z, w, r, g, b, a);
        if (Math.random() < 0.18 && k < n) qseg(x, y, z, x + rand(-1.4, 1.4), y + rand(-1, 0.6), z + rand(-1.4, 1.4), w * 0.6, r, g, b, a * 0.7);
        px = x; py = y; pz = z;
      }
    }
  }

  // ---- radial texture (ground glows, clouds)
  const radTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();
  const flatGeo = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
  function meshPool(n, make) { const a = []; for (let i = 0; i < n; i++) { const m = make(i); m.visible = false; m.frustumCulled = false; scene.add(m); a.push({ m, life: 0, max: 1 }); } let k = 0; return { a, next() { const r = a[k]; k = (k + 1) % n; return r; } }; }
  const glows = meshPool(16, () => { const m = new THREE.Mesh(flatGeo, new THREE.MeshBasicMaterial({ map: radTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffffff })); m.renderOrder = 2; m.name = 'fx-gglow'; return m; });
  function gglow(x, z, r, color, dur, o = {}) {
    const g = glows.next(); g.m.visible = true; g.m.material.color.setHex(color); g.m.position.set(x, 0.09, z); g.m.scale.set(r, 1, r);
    g.life = g.max = dur; g.a = o.alpha ?? 0.8; g.pulse = o.pulse || 0; g.follow = o.follow || null; g.r = r; return g;
  }
  const clouds = meshPool(4, () => { const m = new THREE.Mesh(flatGeo, new THREE.MeshBasicMaterial({ map: radTex, transparent: true, depthWrite: false, color: 0x1a2028 })); m.renderOrder = 8; m.name = 'fx-cloud'; return m; });

  // ---- hex shield bubbles
  const hexMat = () => new THREE.ShaderMaterial({
    uniforms: { uT: { value: 0 }, uA: { value: 1 }, uC: { value: new THREE.Color(0x58e0ff) } },
    vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform float uT; uniform float uA; uniform vec3 uC; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      float hexd(vec2 p){ p = abs(p); return max(dot(p, vec2(0.8660254, 0.5)), p.y); }
      void main(){
        vec2 p = vUv * vec2(18.0, 9.0); vec2 r = vec2(1.0, 1.7320508); vec2 h = r * 0.5;
        vec2 a = mod(p, r) - h; vec2 b = mod(p - h, r) - h; vec2 g = dot(a,a) < dot(b,b) ? a : b;
        float edge = smoothstep(0.40, 0.48, hexd(g));
        float fres = pow(1.0 - abs(dot(vN, vV)), 2.2);
        float scan = 0.5 + 0.5 * sin(vUv.y * 30.0 - uT * 6.0);
        float al = (0.08 + edge * (0.55 + 0.25 * scan) + fres * 0.6) * uA;
        gl_FragColor = vec4(uC * (0.6 + edge + fres), al);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const bubGeo = new THREE.SphereGeometry(1, 24, 14);
  const bubbles = meshPool(6, () => { const m = new THREE.Mesh(bubGeo, hexMat()); m.renderOrder = 9; m.name = 'fx-bubble'; return m; });

  // ---- root spikes (instanced)
  const RN = 128;
  const spikeGeo = new THREE.ConeGeometry(0.28, 1.8, 5).translate(0, 0.9, 0);
  const spikeMat = new THREE.MeshStandardMaterial({ color: 0x4a3a1e, roughness: 0.8, emissive: 0x6a8a1a, emissiveIntensity: 0.55 });
  const spikes = new THREE.InstancedMesh(spikeGeo, spikeMat, RN);
  spikes.instanceMatrix.setUsage(THREE.DynamicDrawUsage); spikes.count = 0; spikes.frustumCulled = false; spikes.name = 'fx-roots';
  scene.add(spikes);
  const roots = []; // {x,z,h,rx,rz,t,dur,delay}
  function rootSpike(x, z, h, dur, delay) {
    if (roots.length >= RN) roots.shift();
    roots.push({ x, z, h, rx: rand(-0.35, 0.35), rz: rand(-0.35, 0.35), ry: rand(0, 6.3), t: -delay, dur });
  }

  // ---- flood water discs + foam rings
  const waterMat = () => new THREE.ShaderMaterial({
    uniforms: { uT: { value: 0 }, uA: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform float uT; uniform float uA; varying vec2 vUv;
      void main(){ vec2 p = vUv - 0.5; float d = length(p) * 2.0; if (d > 1.0) discard;
        float w = sin(p.x * 40.0 + uT * 2.3) * sin(p.y * 37.0 - uT * 1.9) * 0.5 + 0.5;
        float rip = sin(d * 30.0 - uT * 4.0) * 0.5 + 0.5;
        vec3 c = mix(vec3(0.05,0.22,0.35), vec3(0.25,0.55,0.7), w * 0.6 + rip * 0.25);
        float foam = smoothstep(0.86, 0.97, d);
        c = mix(c, vec3(0.9,0.95,1.0), foam);
        gl_FragColor = vec4(c, uA * (0.62 + foam * 0.3) * (1.0 - smoothstep(0.97, 1.0, d))); }`,
    transparent: true, depthWrite: false,
  });
  const discGeo = new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2);
  const waters = meshPool(4, () => { const m = new THREE.Mesh(discGeo, waterMat()); m.renderOrder = 2; m.name = 'fx-water'; return m; });
  // ---- dirt mounds
  const moundGeo = new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  const moundMat = new THREE.MeshStandardMaterial({ color: 0x5a4430, roughness: 1, flatShading: true });
  const mounds = meshPool(8, () => { const m = new THREE.Mesh(moundGeo, moundMat); m.name = 'fx-mound'; m.castShadow = false; return m; });

  // ---- projectiles (instanced per kind)
  const PN = 64;
  const projMk = (geo, mat) => { const m = new THREE.InstancedMesh(geo, mat, PN); m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.count = 0; m.frustumCulled = false; scene.add(m); return m; };
  const PM = {
    arrow: projMk(new THREE.BoxGeometry(1.0, 0.05, 0.05), new THREE.MeshBasicMaterial({ color: 0xd8c08a })),
    spear: projMk(new THREE.CylinderGeometry(0.06, 0.06, 2.4, 5).rotateZ(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x7a5530, roughness: 0.8 })),
    minimissile: projMk(new THREE.CylinderGeometry(0.11, 0.11, 0.7, 6).rotateZ(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x3a3f45, metalness: 0.6, roughness: 0.4 })),
    ironball: projMk(new THREE.SphereGeometry(0.42, 10, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff7a20).multiplyScalar(1.5) })),
  };
  const projs = [];
  const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _X = new THREE.Vector3(1, 0, 0), _s1 = new THREE.Vector3(1, 1, 1), _p = new THREE.Vector3();
  function launch(kind, ax, ay, az, bx, by, bz) {
    const dist = Math.hypot(bx - ax, bz - az);
    const spd = { arrow: 70, spear: 38, minimissile: 34, ironball: 22 }[kind];
    const arc = { arrow: 0.06, spear: 0.18, minimissile: 0.04, ironball: 0.45 }[kind];
    if (projs.length >= PN * 3) projs.shift();
    projs.push({ kind, ax, ay, az, bx, by, bz, t: 0, dur: Math.max(0.12, dist / spd), apex: dist * arc + (kind === 'ironball' ? 3 : 0), stuck: 0, wob: rand(0, 6) });
  }
  function projPos(p, u, out) { out.set(p.ax + (p.bx - p.ax) * u, p.ay + (p.by - p.ay) * u + 4 * p.apex * u * (1 - u), p.az + (p.bz - p.az) * u); return out; }
  function impact(p) {
    const x = p.bx, z = p.bz;
    if (p.kind === 'minimissile') {
      for (let k = 0; k < 8; k++) glow.spawn(x, 0.6, z, rand(-5, 5), rand(1, 6), rand(-5, 5), 1, rand(0.4, 0.7), 0.1, rand(0.6, 1.1), rand(0.2, 0.4), { grav: 8, drag: 2, grow: 0.6 });
      glow.spawn(x, 0.8, z, 0, 0, 0, 1, 0.85, 0.5, 2.6, 0.14, { grow: 0.6 });
      sparks(x, 0.6, z, 0, 0, 6); smoke(x, 0.6, z, 3, 1.1, 1.2, 0.8, 1.6);
      decal(x, z, rand(2.2, 3), 3, 20, 0.7);
    } else if (p.kind === 'ironball') {
      glow.spawn(x, 0.8, z, 0, 0, 0, 1, 0.6, 0.15, 3.6, 0.2, { grow: 0.8 });
      for (let k = 0; k < 26; k++) { const a = Math.random() * 6.283, sp = rand(3, 10); glow.spawn(x, 0.5, z, Math.cos(a) * sp, rand(4, 11), Math.sin(a) * sp, 1, rand(0.35, 0.6), 0.05, rand(0.3, 0.55), rand(0.6, 1.1), { grav: GRAV, drag: 0.4, ground: true }); }
      smoke(x, 0.6, z, 4, 1.5, 1.8, 1.2, 1.8); decal(x, z, rand(3.5, 4.5), 3, 40, 0.95);
      gglow(x, z, 2.6, 0xff5010, 2.2, { alpha: 0.7 });
    } else if (p.kind === 'spear') { p.stuck = 1.6; smoke(x, 0.2, z, 1, 0.6, 0.6, 0.2, 0.6); }
    else { for (let k = 0; k < 3; k++) crisp.spawn(x, 0.1, z, rand(-1.5, 1.5), rand(1, 3), rand(-1.5, 1.5), 0.45, 0.38, 0.28, 0.2, 0.4, { grav: GRAV, ground: true }); }
  }
  function updateProjectiles(dt) {
    const cnt = { arrow: 0, spear: 0, minimissile: 0, ironball: 0 };
    for (let i = projs.length - 1; i >= 0; i--) {
      const p = projs[i];
      if (p.stuck > 0) { p.stuck -= dt; if (p.stuck <= 0) { projs.splice(i, 1); continue; } }
      else {
        p.t += dt;
        if (p.t >= p.dur) { impact(p); if (p.stuck <= 0) { projs.splice(i, 1); continue; } }
      }
      const u = Math.min(1, p.t / p.dur);
      projPos(p, u, _p); projPos(p, Math.min(1, u + 0.02), _v);
      if (p.stuck > 0) { _v.set(p.bx - p.ax, -Math.hypot(p.bx - p.ax, p.bz - p.az) * 0.5, p.bz - p.az); _p.set(p.bx, 0.7, p.bz); _p.addScaledVector(_v.clone().normalize(), -0.2); }
      else _v.sub(_p);
      if (p.kind === 'minimissile' && p.stuck <= 0) { _p.y += Math.sin(p.t * 30 + p.wob) * 0.12; _p.x += Math.cos(p.t * 26 + p.wob) * 0.1; }
      if (_v.lengthSq() < 1e-8) _v.set(1, 0, 0);
      _q.setFromUnitVectors(_X, _v.normalize());
      const m = PM[p.kind], k = cnt[p.kind]++;
      if (k < PN) { _m4.compose(_p, _q, _s1); m.setMatrixAt(k, _m4); }
      if (p.stuck > 0) continue;
      if (p.kind === 'arrow') qseg(_p.x, _p.y, _p.z, _p.x - _v.x * 1.4, _p.y - _v.y * 1.4, _p.z - _v.z * 1.4, 0.09, 0.9, 0.85, 0.7, 0.5);
      else if (p.kind === 'minimissile') {
        glow.spawn(_p.x - _v.x * 0.4, _p.y, _p.z - _v.z * 0.4, 0, 0, 0, 1, 0.7, 0.3, 0.45, 0.06, {});
        if (Math.random() < 0.6) soft.spawn(_p.x - _v.x * 0.5, _p.y, _p.z - _v.z * 0.5, rand(-0.3, 0.3), rand(0.2, 0.6), rand(-0.3, 0.3), 0.55, 0.55, 0.55, 0.45, 0.8, { grow: 2, alpha: 0.5, drag: 1 });
      } else if (p.kind === 'ironball') {
        if (Math.random() < 0.7) glow.spawn(_p.x, _p.y, _p.z, rand(-0.5, 0.5), rand(-0.5, 0.5), rand(-0.5, 0.5), 1, 0.45, 0.1, rand(0.3, 0.5), 0.35, { grav: 3 });
        if (Math.random() < 0.3) soft.spawn(_p.x, _p.y, _p.z, 0, 0.4, 0, 0.3, 0.27, 0.25, 0.6, 1.0, { grow: 2, alpha: 0.45 });
      }
    }
    for (const k in PM) { PM[k].count = Math.min(PN, cnt[k]); if (cnt[k]) PM[k].instanceMatrix.needsUpdate = true; }
  }

  // ---- timed emitters (bolts, trails, rain, patches, heal, stun, wind, bubbles)
  const fxs = [];
  const MAXFX = 48;
  const addFx = (o) => { if (fxs.length >= MAXFX) fxs.shift(); o.t = 0; fxs.push(o); return o; };
  const teamCol = (e) => world.colors?.[e?.team] ?? 0x39d8ff;
  const yOf = (e) => (world.entityHeight?.(e) ?? 2);
  const alive = (e) => e && e.state !== 'dead';
  const hex3 = (h) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];

  function bolt(points, dur = 0.3, col = [0.75, 0.88, 1]) {
    addFx({ type: 'bolt', dur, pts: points, col });
    for (let i = 1; i < points.length; i++) { const p = points[i]; glow.spawn(p.x, p.y, p.z, 0, 0, 0, 0.85, 0.92, 1, 3.2, 0.16, { grow: 0.5 }); sparks(p.x, p.y, p.z, 0, 0, 5); }
    const a = points[0]; glow.spawn(a.x, a.y, a.z, 0, 0, 0, 0.8, 0.9, 1, 2.4, 0.12, {});
  }
  function shield(ent, x, z, r, dur, color) {
    const b = bubbles.next(); b.m.visible = true; b.life = b.max = dur; b.ent = ent; b.x = x; b.z = z; b.r = r;
    b.m.material.uniforms.uC.value.setHex(color ?? 0x58e0ff);
    b.m.position.set(x, r * 0.35, z); b.m.scale.setScalar(0.01);
    ring(x, z, r * 0.5, r * 1.6, 0.5, color ?? 0x58e0ff);
  }
  function rootsAt(x, z, r, dur, targets) {
    const n = Math.min(30, Math.max(10, Math.round(6.283 * r / 1.1)));
    for (let i = 0; i < n; i++) { const a = i / n * 6.283 + rand(-0.1, 0.1), rr = r * rand(0.82, 1.02); rootSpike(x + Math.cos(a) * rr, z + Math.sin(a) * rr, rand(0.9, 1.6), dur, i / n * 0.25); }
    for (let i = 0; i < 10; i++) { const a = Math.random() * 6.283, rr = Math.random() * r * 0.75; rootSpike(x + Math.cos(a) * rr, z + Math.sin(a) * rr, rand(0.4, 0.9), dur, rand(0, 0.3)); }
    for (const e of targets || []) for (let k = 0; k < 4; k++) { const a = k / 4 * 6.283 + rand(-0.3, 0.3), rr = (e.r || 1) * 0.9; rootSpike(e.x + Math.cos(a) * rr, e.z + Math.sin(a) * rr, rand(1, 1.5), dur, 0.05); }
    gglow(x, z, r * 1.1, 0x9ac83a, dur, { alpha: 0.55, pulse: 3 });
    ring(x, z, r * 0.3, r * 1.15, 0.6, 0xc8e04a);
    for (let k = 0; k < 24; k++) { const a = Math.random() * 6.283, rr = r * rand(0.6, 1); crisp.spawn(x + Math.cos(a) * rr, 0.2, z + Math.sin(a) * rr, Math.cos(a) * 2, rand(3, 6), Math.sin(a) * 2, 0.32, 0.25, 0.16, rand(0.25, 0.4), rand(0.5, 0.9), { grav: GRAV, ground: true }); }
  }
  function burnPatch(x, z, r, dur) {
    addFx({ type: 'burn', x, z, r, dur, acc: 0 });
    gglow(x, z, r * 1.25, 0xff5a12, dur, { alpha: 0.75, pulse: 7 });
    decal(x, z, r * 2.3, 3, dur + 6, 0.9);
  }
  function healOn(list, dur, x, z, r) {
    addFx({ type: 'heal', list: (list || []).slice(0, 24), dur, acc: 0 });
    if (x != null) { gglow(x, z, r || 6, 0xffd24a, Math.min(1.2, dur), { alpha: 0.5 }); ring(x, z, 1, r || 6, 0.7, 0xffd24a); }
  }
  function charge(ax, az, bx, bz, col = [1, 0.5, 0.12], w = 1.6) {
    addFx({ type: 'charge', ax, az, bx, bz, dur: 0.45, col, w });
    const L = Math.hypot(bx - ax, bz - az);
    for (let k = 0; k < Math.min(24, L * 1.5); k++) { const f = Math.random(); smoke(ax + (bx - ax) * f, 0.3, az + (bz - az) * f, 1, 0.8, 0.7, 0.3, 0.8); }
  }
  function onAbility(d) {
    if (!d) return;
    const src = d.hero || d.unit;
    const x = d.x ?? src?.x ?? 0, z = d.z ?? src?.z ?? 0;
    const id = d.id, dur = d.duration ?? 0;
    // hero abilities
    if (id === 'bulwark') { shield(src, src?.x ?? x, src?.z ?? z, 2.8, dur || 6, 0x58e0ff); return; }
    if (id === 'chain') {
      const pts = (d.points || [src, ...(d.targets || [])]).filter(Boolean).map((p, i) => ({ x: p.x, z: p.z, y: i === 0 ? 2.4 : 1.4 }));
      if (pts.length > 1) bolt(pts, 0.3);
      return;
    }
    if (id === 'eruption') {
      const f = d.from || src, t = d.to || { x, z }, dir = d.dir || { x: 1, z: 0 };
      charge(f.x, f.z, t.x, t.z);
      for (let k = 0; k < 46; k++) {
        const a = Math.atan2(dir.z, dir.x) + rand(-0.75, 0.75), sp = rand(6, 16);
        glow.spawn(t.x, rand(0.5, 1.5), t.z, Math.cos(a) * sp, rand(0.5, 4), Math.sin(a) * sp, 1, rand(0.3, 0.7), 0.05, rand(0.7, 1.3), rand(0.3, 0.55), { drag: 3, grav: -2, grow: 0.6 });
      }
      const pt = d.patch || { x: t.x, z: t.z, r: 4, duration: 4 };
      burnPatch(pt.x, pt.z, pt.r, pt.duration);
      return;
    }
    if (id === 'rootbind') { rootsAt(x, z, d.r || 8, dur || 3, d.targets); healOn(d.allies, dur || 3, src?.x, src?.z, d.healR || 10); return; }
    // generic kinds (roster abilities)
    const r = d.r ?? d.radius ?? 6, col = d.color ?? teamCol(src);
    switch (d.kind) {
      case 'rain': {
        const c = clouds.next(); c.m.visible = true; c.life = c.max = dur || 5; c.m.position.set(x, 9, z); c.m.scale.set(r * 1.3, 1, r * 1.3); c.r = r;
        addFx({ type: 'rain', x, z, r, dur: dur || 5, acc: 0 });
        break;
      }
      case 'flood': {
        const w = waters.next(); w.m.visible = true; w.life = w.max = dur || 5; w.m.position.set(x, 0.05, z); w.m.scale.set(r, 1, r); w.r = r;
        ring(x, z, r * 0.6, r * 1.1, 0.8, 0xdff4ff);
        break;
      }
      case 'erupt': {
        for (let k = 0; k < 34; k++) { const a = Math.random() * 6.283, sp = rand(2, 9); const c = rand(0.22, 0.38); crisp.spawn(x, 0.5, z, Math.cos(a) * sp, rand(6, 13), Math.sin(a) * sp, c * 1.2, c, c * 0.75, rand(0.3, 0.6), rand(0.8, 1.4), { grav: GRAV, ground: true }); }
        smoke(x, 0.5, z, 8, 2.2, 1.8, 1.5, 2.5); ring(x, z, 1, r * 1.2, 0.6, 0xb08a5a);
        decal(x, z, r * 1.4, 3, 25, 0.75);
        const mo = mounds.next(); mo.m.visible = true; mo.life = mo.max = 3; mo.m.position.set(x, 0, z); mo.r = Math.min(3, r * 0.4);
        break;
      }
      case 'burrow': {
        for (let k = 0; k < 18; k++) { const c = rand(0.25, 0.35); soft.spawn(x + rand(-1, 1), 0.3, z + rand(-1, 1), rand(-1, 1), rand(2, 5), rand(-1, 1), c * 1.2, c, c * 0.75, rand(1.2, 1.8), rand(1, 1.6), { grow: 1.6, alpha: 0.7, drag: 1.2 }); }
        for (let k = 0; k < 12; k++) crisp.spawn(x, 0.4, z, rand(-4, 4), rand(4, 8), rand(-4, 4), 0.3, 0.24, 0.17, 0.35, 0.9, { grav: GRAV, ground: true });
        const mo = mounds.next(); mo.m.visible = true; mo.life = mo.max = dur || 3; mo.m.position.set(x, 0, z); mo.r = 1.6;
        break;
      }
      case 'burn': burnPatch(x, z, r, dur || 4); break;
      case 'stun': for (const e of d.targets?.length ? d.targets : [src]) if (e) addFx({ type: 'stun', ent: e, dur: dur || 1.5 }); break;
      case 'heal': healOn(d.targets?.length ? d.targets : [src], dur || 2, x, z, r); break;
      case 'shield': for (const e of d.targets?.length ? d.targets : [src]) if (e) shield(e, e.x, e.z, Math.max(1.8, (e.r || 1.2) * 1.8), dur || 5, col); break;
      case 'speed': for (const e of d.targets?.length ? d.targets : [src]) if (e) addFx({ type: 'speed', ent: e, dur: dur || 4, acc: 0 }); break;
      case 'charge': { const f = d.from || src || { x, z }, t = d.to || { x, z }; charge(f.x, f.z, t.x, t.z, hex3(col).map(v => Math.min(1, v + 0.2)), 1.3); break; }
      case 'lightning': {
        const pts = [src || { x, z }, ...(d.targets || [])].filter(Boolean).map((p, i) => ({ x: p.x, z: p.z, y: i === 0 ? 2.2 : 1.3 }));
        if (pts.length < 2) pts.unshift({ x, z, y: 14 });
        bolt(pts, 0.3); break;
      }
      case 'aoe': default: {
        ring(x, z, 0.5, r, 0.55, col); ring(x, z, 0.3, r * 0.7, 0.4, 0xffffff);
        gglow(x, z, r * 0.9, col, 0.5, { alpha: 0.7 });
        smoke(x, 0.4, z, 4, 1.4, 1, r * 0.4, 1.2);
      }
    }
  }
  bus.addEventListener('ability', (ev) => { try { onAbility(ev.detail); } catch (err) { console.warn('[fx] ability fx', err?.message); } });

  // hero / projectile basic-attack shots. Returns true when handled.
  function heroShot(d) {
    const f = d.from || {}, t = d.to || {};
    const ax = f.x ?? 0, ay = f.y ?? 1.2, az = f.z ?? 0, bx = t.x ?? 0, by = t.y ?? 1, bz = t.z ?? 0;
    const k = String(d.kind || '');
    if (d.air || ay > 5) glow.spawn(ax, ay, az, 0, 0, 0, 1, 0.75, 0.4, 0.9, 0.1, {}); // air: engine/muzzle glow
    if (k === 'hero') {
      let h = null, bd = 4;
      for (const e of world.heroes?.list?.() || []) { const dd = Math.hypot(e.x - ax, e.z - az); if (dd < bd) { bd = dd; h = e; } }
      const fac = h?.faction, dist = Math.hypot(bx - ax, bz - az), hy = h ? Math.min(2.6, yOf(h) * 0.55) : ay;
      if (fac === 'vanguard') return laser(ax, hy, az, bx, by, bz), true;
      if (fac === 'earth') { tracer(ax, hy, az, bx, by, bz, 0.09, 0.16, 1, 0.82, 0.3, false); glow.spawn(ax, hy, az, 0, 0, 0, 1, 0.85, 0.4, 0.5, 0.07, {}); return true; }
      if (fac === 'storm' || (fac === 'volcanic' && dist < 6.5)) {
        const c = fac === 'storm' ? [0.8, 0.9, 1] : [1, 0.5, 0.1];
        glow.spawn(bx, by + 0.3, bz, 0, 0, 0, c[0], c[1], c[2], 2.2, 0.12, { grow: 0.4 });
        for (let i = 0; i < 10; i++) glow.spawn(bx, by + 0.3, bz, rand(-6, 6), rand(1, 6), rand(-6, 6), c[0], c[1], c[2], rand(0.25, 0.4), rand(0.15, 0.3), { grav: GRAV, drag: 1 });
        if (fac === 'storm') addFx({ type: 'bolt', dur: 0.12, pts: [{ x: bx, y: by + 2.2, z: bz }, { x: bx, y: by, z: bz }], col: [0.8, 0.9, 1] });
        else addFx({ type: 'charge', ax: ax + (bx - ax) * 0.4, az: az + (bz - az) * 0.4, bx: bx + (bz - az) * 0.15, bz: bz - (bx - ax) * 0.15, dur: 0.16, col: [1, 0.55, 0.15], w: 0.5, y: by + 0.4 });
        return true;
      }
      if (fac === 'volcanic') { tracer(ax, hy, az, bx, by, bz, 0.24, 0.13, 1, 0.5, 0.12, false); glow.spawn(ax, hy, az, 0, 0, 0, 1, 0.6, 0.2, 1.0, 0.07, {}); return true; }
      return false;
    }
    switch (k) {
      case 'arrow': launch('arrow', ax, ay, az, bx, by, bz); return true;
      case 'spear': launch('spear', ax, ay, az, bx, by, bz); return true;
      case 'minimissile': launch('minimissile', ax, ay, az, bx, by, bz); glow.spawn(ax, ay, az, 0, 0, 0, 1, 0.7, 0.3, 0.9, 0.08, {}); smoke(ax, ay, az, 1, 0.6, 0.5, 0.1, 0.6); return true;
      case 'ironball': launch('ironball', ax, ay, az, bx, by, bz); glow.spawn(ax, ay, az, 0, 0, 0, 1, 0.55, 0.15, 1.8, 0.12, {}); smoke(ax, ay, az, 2, 1, 0.8, 0.2, 1); return true;
      case 'bullet': tracer(ax, ay, az, bx, by, bz, 0.16, 0.1, 1, 0.92, 0.6, false); glow.spawn(ax, ay, az, 0, 0, 0, 1, 0.9, 0.6, 0.55, 0.06, {}); return true;
      case 'laser': laser(ax, ay, az, bx, by, bz); return true;
      case 'lightning': bolt([{ x: ax, y: ay, z: az }, { x: bx, y: by, z: bz }], 0.2); return true;
      case 'slug': tracer(ax, ay, az, bx, by, bz, 0.42, 0.16, 1, 0.55, 0.15, false); glow.spawn(ax, ay, az, 0, 0, 0, 1, 0.6, 0.2, 1.3, 0.08, {}); smoke(ax, ay, az, 1, 0.8, 0.6, 0.1, 0.8); sparks(bx, by, bz, 0, 0, 4); return true;
    }
    return false;
  }
  function laser(ax, ay, az, bx, by, bz) {
    tracer(ax, ay, az, bx, by, bz, 0.55, 0.16, 0.1, 0.7, 1, false);
    tracer(ax, ay, az, bx, by, bz, 0.16, 0.16, 0.85, 1, 1, false);
    glow.spawn(ax, ay, az, 0, 0, 0, 0.4, 0.9, 1, 0.9, 0.08, {});
    glow.spawn(bx, by, bz, 0, 0, 0, 0.4, 0.9, 1, 1.2, 0.1, {});
    for (let i = 0; i < 4; i++) glow.spawn(bx, by, bz, rand(-4, 4), rand(1, 4), rand(-4, 4), 0.5, 0.95, 1, 0.25, 0.2, { grav: GRAV });
  }

  let fxT = 0;
  function updateAbilityFx(dt) {
    fxT += dt; qn = 0;
    if (!world.camera) return;
    for (let i = fxs.length - 1; i >= 0; i--) {
      const f = fxs[i]; f.t += dt;
      if (f.t >= f.dur || (f.ent && !alive(f.ent))) { fxs.splice(i, 1); continue; }
      const u = f.t / f.dur, a = 1 - u;
      switch (f.type) {
        case 'bolt': jag(f.pts, 0.16, f.col[0], f.col[1], f.col[2], Math.min(1, a * 1.6), 0.55); break;
        case 'charge': {
          const y = f.y ?? 1.0, fa = a * a;
          qseg(f.ax, y, f.az, f.bx, y, f.bz, f.w, f.col[0], f.col[1] * 0.8, f.col[2] * 0.6, fa * 0.6);
          qseg(f.ax, y, f.az, f.bx, y, f.bz, f.w * 0.35, 1, 0.9, 0.6, fa);
          break;
        }
        case 'burn': {
          f.acc += dt;
          while (f.acc > 0.035) {
            f.acc -= 0.035;
            const ang = Math.random() * 6.283, rr = Math.sqrt(Math.random()) * f.r;
            glow.spawn(f.x + Math.cos(ang) * rr, 0.15, f.z + Math.sin(ang) * rr, rand(-0.4, 0.4), rand(2, 4.5), rand(-0.4, 0.4), 1, rand(0.3, 0.65), 0.05, rand(0.6, 1.1), rand(0.35, 0.7), { grav: -1.5, drag: 1, grow: -0.4 });
            if (Math.random() < 0.12) smoke(f.x + Math.cos(ang) * rr, 1.2, f.z + Math.sin(ang) * rr, 1, 1, 1.4, 0.3, 1.6);
          }
          break;
        }
        case 'heal': {
          f.acc += dt;
          while (f.acc > 0.06) {
            f.acc -= 0.06;
            for (const e of f.list) if (alive(e) && Math.random() < 0.5) glow.spawn(e.x + rand(-0.8, 0.8), rand(0.2, 1.4), e.z + rand(-0.8, 0.8), 0, rand(1.5, 3), 0, rand(0.55, 1), rand(0.85, 1), rand(0.25, 0.5), rand(0.25, 0.42), rand(0.6, 1), { grav: -0.5, fin: 0.2 });
          }
          break;
        }
        case 'stun': {
          const e = f.ent, y = yOf(e) + 0.5;
          for (let k = 0; k < 3; k++) { const ang = fxT * 7 + k * 2.094; glow.spawn(e.x + Math.cos(ang) * 0.7, y, e.z + Math.sin(ang) * 0.7, 0, 0, 0, 1, 0.92, 0.4, 0.4, 0.09, {}); }
          break;
        }
        case 'speed': {
          const e = f.ent, c = Math.cos(e.rot || 0), s = -Math.sin(e.rot || 0);
          for (let k = 0; k < 3; k++) {
            const off = (k - 1) * 0.6, ph = ((fxT * 3 + k * 0.37) % 1);
            const bx = e.x - c * (0.6 + ph * 1.5) - s * off, bz = e.z - s * (0.6 + ph * 1.5) + c * off, y = 0.5 + k * 0.45;
            qseg(bx, y, bz, bx - c * 1.6, y, bz - s * 1.6, 0.07, 0.9, 0.95, 1, 0.45 * (1 - ph) * Math.min(1, a * 3));
          }
          break;
        }
        case 'rain': {
          const n = Math.min(70, Math.round(f.r * f.r * 0.9) + 10), fa = Math.min(1, f.t * 2, a * 3);
          for (let k = 0; k < n; k++) {
            const ang = k * 2.39996, rr = Math.sqrt(((k * 0.618) % 1)) * f.r;
            const ph = ((fxT * 1.6 + k * 0.137) % 1), y = 8.5 * (1 - ph);
            const x = f.x + Math.cos(ang) * rr, z = f.z + Math.sin(ang) * rr;
            qseg(x, y + 0.9, z, x - 0.12, y, z, 0.05, 0.55, 0.7, 0.9, 0.55 * fa);
          }
          f.acc += dt;
          while (f.acc > 0.04) { f.acc -= 0.04; const ang = Math.random() * 6.283, rr = Math.sqrt(Math.random()) * f.r; glow.spawn(f.x + Math.cos(ang) * rr, 0.12, f.z + Math.sin(ang) * rr, 0, 0.8, 0, 0.5, 0.65, 0.8, 0.35, 0.25, { grow: 1.5, alpha: 0.6 }); }
          break;
        }
      }
    }
    // ground glows
    for (const g of glows.a) {
      if (!g.m.visible) continue;
      g.life -= dt; if (g.life <= 0) { g.m.visible = false; continue; }
      const u = 1 - g.life / g.max, env = Math.min(1, u * 8, (1 - u) * 4);
      g.m.material.opacity = g.a * env * (g.pulse ? 0.8 + 0.2 * Math.sin(fxT * g.pulse) : 1);
    }
    for (const c of clouds.a) {
      if (!c.m.visible) continue;
      c.life -= dt; if (c.life <= 0) { c.m.visible = false; continue; }
      const u = 1 - c.life / c.max; c.m.material.opacity = 0.75 * Math.min(1, u * 5, (1 - u) * 4);
    }
    for (const b of bubbles.a) {
      if (!b.m.visible) continue;
      b.life -= dt;
      if (b.life <= 0 || (b.ent && !alive(b.ent))) { b.m.visible = false; continue; }
      const u = 1 - b.life / b.max, grow = Math.min(1, u * b.max / 0.25);
      if (b.ent) { b.x = b.ent.x; b.z = b.ent.z; }
      b.m.position.set(b.x, b.r * 0.3, b.z);
      b.m.scale.setScalar(b.r * (0.2 + 0.8 * (1 - (1 - grow) ** 3)) * (1 + 0.02 * Math.sin(fxT * 9)));
      const un = b.m.material.uniforms; un.uT.value = fxT; un.uA.value = Math.min(1, b.life / 0.5) * (b.ent?.hidden ? 0 : 1);
    }
    for (const w of waters.a) {
      if (!w.m.visible) continue;
      w.life -= dt; if (w.life <= 0) { w.m.visible = false; continue; }
      const u = 1 - w.life / w.max, env = Math.min(1, u * 4, (1 - u) * 3);
      w.m.position.y = 0.05 + 0.5 * env; w.m.scale.set(w.r * (0.6 + 0.4 * env), 1, w.r * (0.6 + 0.4 * env));
      w.m.material.uniforms.uT.value = fxT; w.m.material.uniforms.uA.value = env;
    }
    for (const mo of mounds.a) {
      if (!mo.m.visible) continue;
      mo.life -= dt; if (mo.life <= 0) { mo.m.visible = false; continue; }
      const u = 1 - mo.life / mo.max, env = Math.min(1, u * 6, (1 - u) * 2.5);
      mo.m.scale.set(mo.r, mo.r * 0.45 * env, mo.r);
    }
    // root spikes
    let rn = 0;
    for (let i = roots.length - 1; i >= 0; i--) {
      const r = roots[i]; r.t += dt;
      if (r.t >= r.dur) { roots.splice(i, 1); continue; }
      if (r.t < 0) continue;
      const grow = Math.min(1, r.t / 0.14), sink = Math.min(1, (r.dur - r.t) / 0.45), s = r.h * Math.min(grow * (1.15 - 0.15 * grow), sink);
      _q.setFromEuler(new THREE.Euler(r.rx, r.ry, r.rz)); _p.set(r.x, 0, r.z); _v.set(1, Math.max(0.01, s), 1);
      _m4.compose(_p, _q, _v); spikes.setMatrixAt(rn++, _m4);
    }
    spikes.count = rn; if (rn) spikes.instanceMatrix.needsUpdate = true;
    spikeMat.emissiveIntensity = 0.45 + 0.2 * Math.sin(fxT * 5);
    updateProjectiles(dt);
    qGeo.setDrawRange(0, qn * 6);
    if (qn) qPA.needsUpdate = qCA.needsUpdate = qAA.needsUpdate = true;
  }
  function abilityStats() { return { quads: qn, fx: fxs.length, roots: spikes.count, projectiles: projs.length, bubbles: bubbles.a.filter(b => b.m.visible).length }; }

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
      updateAbilityFx(dt);
    },
    // debug/test hooks
    _stats: () => ({ crisp: crisp.count, soft: soft.count, glow: glow.count, tracers: tN, smokeEmitters: smokeEmitters.length }),
    _emit: emit,
    ability: (detail) => onAbility(detail),
    _abilityStats: () => abilityStats(),
  };
}
