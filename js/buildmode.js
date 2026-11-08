// buildmode.js — BASE BUILDING v3 UI (owner: BUILDER). createBuildMode(world, defense) -> { update, open, close, ... }.
// HUD "Build" button -> bottom sheet with big (>=56px) buttons: Wall, Gate, turrets, Housing, Processor, Tech tab.
// While build mode is open, pointer events on #overlay are intercepted in the capture phase (engine untouched):
//   1 finger + tool: draw wall line / move placement ghost;  1 finger, no tool: tap = contextual actions, drag = pan;
//   2 fingers: pan + pinch zoom (same as engine). world.input.mode = 'build' while open.
// "Needs crew" DOM labels float over unmanned player defenses (always, not only in build mode).
// TODO.md: plot actions come from world.econ.plotActions(plot) (shape assumed [{id,label,cost,enabled,run()}]).

const CSS = `
#bm-sheet{position:fixed;left:calc(8px + env(safe-area-inset-left,0px));right:calc(8px + env(safe-area-inset-right,0px));bottom:calc(6px + env(safe-area-inset-bottom,0px));z-index:5;display:none;flex-direction:column;gap:4px;pointer-events:auto;font:14px/1.2 system-ui,-apple-system,sans-serif;color:#fff}
#bm-sheet.on{display:flex}
#bm-sheet .bm-row{display:flex;gap:6px;overflow-x:auto;overflow-y:hidden;padding:6px;background:rgba(15,22,32,.94);border:1px solid #39d8ff;border-radius:12px;box-shadow:0 0 8px rgba(57,216,255,.35);scrollbar-width:none;touch-action:pan-x}
#bm-sheet .bm-row::-webkit-scrollbar{display:none}
#bm-sheet button,.bm-fab button{font:inherit;color:#fff;background:#13202e;border:1px solid #39d8ff;border-radius:10px;min-width:72px;min-height:58px;padding:4px 10px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;flex:0 0 auto;cursor:pointer;touch-action:manipulation}
#bm-sheet button:active{background:#1d3a52}
#bm-sheet button.sel{background:#1f4a68;border-color:#ffd27a;box-shadow:0 0 10px rgba(255,210,122,.5)}
#bm-sheet button:disabled{opacity:.42}
#bm-sheet button.tab{min-width:60px;color:#ffd27a;font-weight:700}
#bm-sheet button .n{font-weight:700;white-space:nowrap}
#bm-sheet button .c{font-size:11px;color:#8feaff;white-space:nowrap}
#bm-sheet button .c.bad{color:#ff8a7a}
#bm-sheet button.tech{min-width:120px;align-items:flex-start}
#bm-sheet button.tech.done{border-color:#5fd35f}
#bm-sheet button .pb{display:block;height:3px;width:100%;background:#1d2b3a;border-radius:2px;overflow:hidden}
#bm-sheet button .pb i{display:block;height:100%;background:#ffd27a;width:0}
#bm-info{align-self:center;max-width:90%;padding:5px 14px;border-radius:9px;background:rgba(15,22,32,.92);border:1px solid #39d8ff;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}
#bm-info.bad{border-color:#ff5a4a;color:#ffb4a8}
#bm-info:empty{display:none}
.bm-fab{position:fixed;right:calc(12px + env(safe-area-inset-right,0px));z-index:6;display:none;gap:10px;pointer-events:auto}
.bm-fab.on{display:flex}
.bm-fab button{min-width:64px;min-height:64px;border-radius:50%;font-size:28px;font-weight:800}
.bm-fab .ok{background:#1d4f2a;border-color:#5fd35f}
.bm-fab .ok:disabled{opacity:.4}
.bm-fab .no{background:#4f1d1d;border-color:#ff6a5a}
#bm-labels{position:fixed;inset:0;z-index:2;pointer-events:none;overflow:hidden}
#bm-labels div{position:absolute;transform:translate(-50%,-100%);padding:1px 6px;border-radius:6px;background:rgba(40,40,40,.85);border:1px solid #ffb04a;color:#ffd27a;font:600 11px system-ui,sans-serif;white-space:nowrap}
#hud .v-top button.bm-btn{color:#7affb0}
#hud .v-top button.bm-btn.on{background:#1f4a68;border-color:#ffd27a}
`;

export function createBuildMode(world, defense) {
  defense = defense || world.defense;
  const THREE = world.THREE;
  const D = () => defense || world.defense;
  const P = 0;
  const overlay = document.getElementById('overlay');
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const style = el('style'); style.textContent = CSS; document.head.append(style);
  const msg = (text, ms = 1600) => { try { world.bus?.dispatchEvent(new CustomEvent('message', { detail: { text, ms } })); } catch (e) { /* */ } };
  const alive = e => e && e.hp > 0 && e.state !== 'dead';

  // ---------- DOM ----------
  const btn = el('button', 'bm-btn', 'Build');
  btn.dataset.bm = 'build';
  const top = document.querySelector('#hud .v-top');
  if (top) top.insertBefore(btn, top.querySelector('.v-def') || null);
  else { btn.style.cssText = 'position:fixed;top:8px;right:8px;z-index:6;height:44px;min-width:64px'; document.body.append(btn); }
  const sheet = el('div'); sheet.id = 'bm-sheet';
  const info = el('div'); info.id = 'bm-info';
  const row = el('div', 'bm-row');
  sheet.append(info, row);
  const fab = el('div', 'bm-fab');
  const okB = el('button', 'ok', '✓'), noB = el('button', 'no', '✕');
  okB.dataset.bm = 'ok'; noB.dataset.bm = 'cancel';
  fab.append(noB, okB);
  const labels = el('div'); labels.id = 'bm-labels';
  document.body.append(sheet, fab, labels);
  for (const n of [sheet, fab, btn]) for (const ev of ['pointerdown', 'pointerup', 'click']) n.addEventListener(ev, e => e.stopPropagation());

  // ---------- state ----------
  const S = { open: false, tab: 'build', tool: null, pending: null, sel: null, stroke: null };
  const bm = { get open() { return S.open; }, get tool() { return S.tool; }, get pending() { return S.pending; }, get selected() { return S.sel; } };

  // ---------- ghosts (Three.js) ----------
  const G = new THREE.Group(); G.name = 'buildGhost'; G.renderOrder = 5;
  world.scene.add(G);
  const matOk = new THREE.MeshBasicMaterial({ color: 0x4dff7a, transparent: true, opacity: 0.45, depthWrite: false });
  const matBad = new THREE.MeshBasicMaterial({ color: 0xff4a3a, transparent: true, opacity: 0.5, depthWrite: false });
  const matSel = new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide });
  const matSlot = new THREE.MeshBasicMaterial({ color: 0x39d8ff, transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide });
  const segGeo = new THREE.BoxGeometry(3.8, 2, 1.5);
  const turGeo = new THREE.CylinderGeometry(1.4, 1.6, 2.2, 14);
  const bldGeo = new THREE.BoxGeometry(6, 3, 6);
  const ringGeo = new THREE.RingGeometry(0.97, 1, 64);
  const slotGeo = new THREE.RingGeometry(1.1, 1.6, 20);
  const segPool = [];
  function seg(i) { while (segPool.length <= i) { const m = new THREE.Mesh(segGeo, matOk); m.raycast = () => {}; G.add(m); segPool.push(m); } return segPool[i]; }
  const turGhost = new THREE.Mesh(turGeo, matOk); turGhost.raycast = () => {};
  const bldGhost = new THREE.Mesh(bldGeo, matOk); bldGhost.raycast = () => {};
  const rangeRing = new THREE.Mesh(ringGeo, matOk); rangeRing.rotation.x = -Math.PI / 2; rangeRing.raycast = () => {};
  const selRing = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 40), matSel); selRing.rotation.x = -Math.PI / 2; selRing.raycast = () => {};
  G.add(turGhost, bldGhost, rangeRing, selRing);
  const slotPool = [];
  function hideGhosts() { for (const m of segPool) m.visible = false; turGhost.visible = bldGhost.visible = rangeRing.visible = false; }
  hideGhosts(); selRing.visible = false;

  // ---------- tools ----------
  const sec = () => D()?.currencyName?.(P, 'secondary') || 'Crystals';
  const pri = () => D()?.currencyName?.(P, 'primary') || 'Crystals';
  function tools() {
    const d = D(); if (!d) return [];
    const out = [{ id: 'wall', name: 'Wall', cost: `${d.DEF.cost.wall}/seg`, unlocked: true }];
    out.push({ id: 'gate', name: 'Gate', cost: `${d.DEF.cost.gate}`, unlocked: d.unlocked(P, 'gate'), need: d.techFor(P, 'gate')?.name, hint: 'Tap a wall' });
    for (const t of d.turretKinds(P)) out.push({ id: t.kind, name: t.name, cost: `${d.DEF.cost[t.kind]} · crew ${d.DEF.crew[t.kind]}`, unlocked: d.unlocked(P, t.kind), need: d.techFor(P, t.kind)?.name, turret: true });
    out.push({ id: 'housing', name: 'Housing', cost: `${d.DEF.cost.housing} ${pri()}`, unlocked: true, bld: true });
    out.push({ id: 'processor', name: 'Processor', cost: `${d.DEF.cost.processor} ${pri()}`, unlocked: true, bld: true });
    return out;
  }
  let rowSig = '';
  function render(force) {
    const d = D();
    let sig = S.tab + '|' + S.tool + '|' + (S.sel?.id ?? '') + '|' + (S.sel?.kind ?? '') + '|' + (S.sel?.widened ? 1 : 0) + (S.sel?.grade ?? '');
    if (d) sig += '|' + d.tierInfo(P)?.current + '|' + (d.tierInfo(P)?.building?.index ?? '') + '|' + d.turretKinds(P).length;
    if (!force && sig === rowSig) return refresh();
    rowSig = sig;
    row.innerHTML = '';
    const tabB = (id, label) => { const b = el('button', 'tab' + (S.tab === id && !S.sel ? ' sel' : ''), `<span class="n">${label}</span>`); b.dataset.bm = 'tab-' + id; b.onclick = () => { S.sel = null; S.tab = id; setTool(null); render(true); }; row.append(b); };
    if (S.sel) return renderContext();
    tabB('build', 'Build'); tabB('tech', 'Tech');
    if (S.tab === 'tech') return renderTech();
    for (const t of tools()) {
      const b = el('button', S.tool === t.id ? 'sel' : '', `<span class="n">${t.unlocked ? '' : '🔒 '}${t.name}</span><span class="c">${t.unlocked ? t.cost : (t.need || 'Tech')}</span>`);
      b.dataset.bm = 'tool-' + t.id; b._tool = t;
      b.onclick = () => {
        if (!t.unlocked) { msg(`Research ${t.need || 'tech'} first`); S.tab = 'tech'; render(true); return; }
        if (t.id === 'gate') { msg('Tap a wall segment, then "Make Gate"'); setTool(null); return; }
        setTool(S.tool === t.id ? null : t.id);
      };
      row.append(b);
    }
  }
  function renderTech() {
    const d = D(), ti = d?.tierInfo(P); if (!ti) return;
    for (const t of ti.list) {
      const isB = ti.building?.index === t.tier - 1;
      const b = el('button', 'tech' + (t.done ? ' done' : '') + (isB ? ' sel' : ''), `<span class="n">${t.done ? '✓ ' : ''}${t.name}</span><span class="c">${t.done ? t.desc : `${t.cost} ${sec()} · ${t.buildTime}s`}</span><span class="pb"><i></i></span>`);
      b.dataset.bm = 'tech-' + t.id; b._tech = t;
      b.onclick = () => {
        if (t.done) return msg(t.desc);
        const r = d.researchTech(P, t.tier - 1);
        if (!r.ok) msg(r.reason === 'busy' ? 'Already researching' : r.reason === 'crystals' ? `Need ${t.cost} ${sec()}` : r.reason);
        else msg(`Researching ${t.name}`);
        render(true);
      };
      row.append(b);
    }
    refresh();
  }
  function act(label, cost, fn, id, enabled = true) {
    const b = el('button', '', `<span class="n">${label}</span>${cost != null ? `<span class="c">${cost}</span>` : ''}`);
    b.dataset.bm = 'act-' + id; b.disabled = !enabled;
    b.onclick = () => { const r = fn(); if (r && r.ok === false) msg(r.reason || 'Cannot'); render(true); };
    row.append(b);
    return b;
  }
  function renderContext() {
    const d = D(), e = S.sel;
    const back = el('button', 'tab', '<span class="n">‹ Back</span>'); back.dataset.bm = 'back';
    back.onclick = () => { S.sel = null; render(true); };
    row.append(back);
    if (!e || !alive(e)) { S.sel = null; return render(true); }
    const name = e.kind === 'wall' ? `Wall (${d.grades[(e.grade || 1) - 1]?.name}${e.widened ? ', wide' : ''})` : e.kind === 'gate' ? 'Gate' : e.plot || /plot/.test(e.kind) ? 'Plot' : (d.turretKinds(P).find(t => t.kind === e.kind)?.name || e.kind);
    row.append(el('button', 'tab', `<span class="n">${name}</span><span class="c">${Math.ceil(e.hp)}/${Math.ceil(e.hpMax)}${e.crew ? ` · crew ${e.crew}${e.unmanned ? ' ⚠' : ''}` : ''}</span>`)).disabled = true;
    if (e.plot || /plot/.test(e.kind)) {
      let acts = [];
      try { acts = world.econ?.plotActions?.(e) || []; } catch (err) { acts = []; }
      if (!acts.length) row.append(el('button', '', '<span class="n">No actions</span>')).disabled = true;
      acts.forEach((a, i) => act(a.label || a.name || a.id, a.cost != null ? (typeof a.cost === 'object' ? Object.entries(a.cost).filter(([, v]) => v).map(([k, v]) => `${v} ${k === 'primary' ? pri() : sec()}`).join(' ') : a.cost) : null,
        () => { const fn = a.run || a.do || a.action; return typeof fn === 'function' ? fn.call(a) : world.econ?.doPlotAction?.(e, a.id); }, 'plot-' + (a.id || i), a.enabled !== false));
      return;
    }
    if (!d.isDefense(e)) return;
    if (e.kind === 'wall') {
      const L = d.lineOf(e);
      const wc = d.widenCost().secondary;
      act('Widen', `${wc} ${sec()}`, () => d.widenWall(e), 'widen', !e.widened && d.canPay(P, d.widenCost()));
      const rest = L ? L.segs.filter(s => s && alive(s) && s.kind === 'wall' && !s.widened).length : 0;
      if (rest > 1) act(`Widen line ×${rest}`, `${wc * rest} ${sec()}`, () => d.widenLine(e), 'widenline');
      const g = e.grade || 1, mg = d.maxGrade(P);
      if (g < d.grades.length) act(`Upgrade → ${d.grades[g].name}`, g < mg ? `${d.upgradeCost(e).secondary} ${sec()}` : `🔒 ${g === 1 ? d.tierInfo(P).list[1].name : d.tierInfo(P).list[3].name}`, () => d.upgradeWall(e), 'upgrade', g < mg);
      act('Make Gate', d.unlocked(P, 'gate') ? `${d.DEF.cost.gate} ${sec()}` : `🔒 ${d.techFor(P, 'gate')?.name}`, () => d.convertGate(e), 'gate', d.unlocked(P, 'gate') && !e.widened);
    }
    act('Demolish', `+${Math.floor((e.spent?.secondary || 0) * 0.5)} ${sec()}`, () => { const r = d.demolish(e); if (r.ok) S.sel = null; return r; }, 'demolish');
  }
  function refresh() {
    const d = D(); if (!d) return;
    const ti = d.tierInfo(P);
    for (const b of row.children) {
      if (b._tech && ti.building && ti.building.index === b._tech.tier - 1) { const i = b.querySelector('.pb i'); if (i) i.style.width = (ti.building.progress * 100).toFixed(0) + '%'; }
      if (b._tech && !b._tech.done) b.disabled = !!ti.building && ti.building.index !== b._tech.tier - 1;
    }
  }

  function setTool(id) {
    S.tool = id; S.pending = null; S.stroke = null; hideGhosts(); updateFab(); render(true);
    if (id === 'wall') setInfo('Drag on the ground to draw a wall');
    else if (id) setInfo('Drag to place · snaps onto wall slots');
    else setInfo('');
  }
  function setInfo(t, bad) { info.textContent = t || ''; info.classList.toggle('bad', !!bad); }
  function updateFab() {
    const on = S.open && !!S.tool;
    fab.classList.toggle('on', on);
    okB.disabled = !(S.pending && S.pending.ok);
    fab.style.bottom = (sheet.getBoundingClientRect().height + 16) + 'px';
  }

  // ---------- open / close ----------
  function open() {
    if (!D()) return msg('Defenses offline');
    S.open = true; S.tab = 'build'; S.sel = null;
    world.input.mode = 'build';
    world.input.selected?.clear?.();
    world.bus?.dispatchEvent(new CustomEvent('select', { detail: { selected: world.input.selected } }));
    sheet.classList.add('on'); btn.classList.add('on');
    render(true); setTool(null); updateFab();
  }
  function close() {
    S.open = false; S.tool = null; S.pending = null; S.sel = null; S.stroke = null;
    if (world.input.mode === 'build') world.input.mode = null;
    sheet.classList.remove('on'); btn.classList.remove('on'); fab.classList.remove('on');
    hideGhosts(); selRing.visible = false; for (const m of slotPool) m.visible = false;
    setInfo('');
  }
  btn.addEventListener('click', () => (S.open ? close() : open()));
  okB.addEventListener('click', confirm);
  noB.addEventListener('click', () => { if (S.pending) { S.pending = null; hideGhosts(); updateFab(); setInfo(S.tool === 'wall' ? 'Drag on the ground to draw a wall' : 'Drag to place'); } else setTool(null); });
  window.addEventListener('keydown', (e) => {
    if (/input|textarea/i.test(e.target?.tagName || '')) return;
    if (e.key === 'b' || e.key === 'B') S.open ? close() : open();
    else if (e.key === 'Escape' && S.open) S.tool ? setTool(null) : close();
    else if (e.key === 'Enter' && S.open && S.pending) confirm();
  });

  function confirm() {
    const d = D(), p = S.pending; if (!d || !p) return;
    let r;
    if (S.tool === 'wall') r = d.buildWall(P, p.x0, p.z0, p.x1, p.z1);
    else if (p.bld) r = d.placeBuilding(P, S.tool, p.x, p.z);
    else r = d.placeTurret(P, S.tool, p.x, p.z, { slot: p.slot });
    if (!r?.ok) { msg(r?.reason || 'Cannot build'); return; }
    S.pending = null; hideGhosts(); updateFab();
    setInfo(S.tool === 'wall' ? 'Wall built · drag for another' : 'Placed · drag for another');
    render(true);
  }

  // ---------- previews ----------
  function previewWall(x0, z0, x1, z1) {
    const d = D(); const plan = d.planWall(P, x0, z0, x1, z1);
    hideGhosts();
    plan.segs.forEach((s, i) => { const m = seg(i); m.visible = true; m.material = s.ok && plan.ok ? matOk : matBad; m.position.set(s.x, 1, s.z); m.rotation.y = s.rot; });
    S.pending = plan;
    setInfo(`Wall · ${plan.n} seg · ${plan.cost.secondary} ${sec()}${plan.ok ? '' : ' · ' + plan.reason}`, !plan.ok);
    updateFab();
  }
  function previewPlace(x, z) {
    const d = D(); hideGhosts();
    if (S.tool === 'housing' || S.tool === 'processor') {
      const p = d.planBuilding(P, S.tool, x, z); p.bld = true;
      bldGhost.visible = true; bldGhost.material = p.ok ? matOk : matBad; bldGhost.position.set(p.x, 1.5, p.z);
      S.pending = p;
      setInfo(`${S.tool === 'housing' ? 'Housing' : 'Processor'} · ${p.cost.primary} ${pri()}${p.ok ? '' : ' · ' + p.reason}`, !p.ok);
    } else {
      const p = d.planTurret(P, S.tool, x, z);
      const y = p.slot ? d.DEF.wallTop : 0;
      turGhost.visible = true; turGhost.material = p.ok ? matOk : matBad; turGhost.position.set(p.x, y + 1.1, p.z);
      rangeRing.visible = true; rangeRing.material = p.ok ? matOk : matBad; rangeRing.scale.setScalar(p.range); rangeRing.position.set(p.x, 0.15, p.z);
      S.pending = p;
      const nm = d.turretKinds(P).find(t => t.kind === S.tool)?.name || S.tool;
      const free = d.crewPool?.(P);
      setInfo(`${nm} · ${p.cost.secondary} ${sec()} · crew ${p.crew}${free != null && free < p.crew ? ' (needs crew!)' : ''}${p.slot ? ' · on wall +30% range' : ''}${p.ok ? '' : ' · ' + p.reason}`, !p.ok);
    }
    updateFab();
  }

  // ---------- picking ----------
  function pickAt(gp) {
    const d = D(); let best = null, bd = Infinity;
    for (const e of world.entities) {
      if (!alive(e) && !(e.plot)) continue;
      const isPlot = e.plot || /plot/.test(e.kind || '');
      if (!isPlot && !(e.team === P && d.isDefense(e))) continue;
      const r = e.kind === 'wall' ? (e.widened ? 2.6 : 2.1) : isPlot ? (e.r || 4) : (e.r || 1.5) + 0.8;
      const dd = Math.hypot(e.x - gp.x, e.z - gp.z) - r;
      const pri = e.onWall ? -1 : 0;        // turrets on walls win over the wall under them
      if (dd < 1.2 && dd + pri < bd) { bd = dd + pri; best = e; }
    }
    return best;
  }

  // ---------- pointer interception (capture phase, only while open) ----------
  const ptrs = new Map();
  let gest = null, multi = null;
  const local = e => { const r = overlay.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const ground = (p, type) => world.groundAt?.(p.x, p.y - (type === 'touch' && S.tool && S.tool !== 'wall' ? 40 : 0));
  const mine = e => S.open && e.target === overlay;
  function panBy(ax, ay, bx, by) {
    const a = world.groundAt(ax, ay), b = world.groundAt(bx, by);
    if (!a || !b) return;
    world.jumpTo ? world.jumpTo(world.camTarget.x + a.x - b.x, world.camTarget.z + a.z - b.z) : (world.camTarget.x += a.x - b.x, world.camTarget.z += a.z - b.z);
  }
  function mstate() { const ps = [...ptrs.values()]; return { cx: (ps[0].x + ps[1].x) / 2, cy: (ps[0].y + ps[1].y) / 2, dist: Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y) }; }
  function down(e) {
    if (!mine(e)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    try { overlay.setPointerCapture(e.pointerId); } catch (err) { /* */ }
    const p = local(e);
    ptrs.set(e.pointerId, { ...p, sx: p.x, sy: p.y, t: performance.now(), type: e.pointerType });
    if (ptrs.size === 2) {
      gest = 'multi'; multi = mstate();
      if (S.stroke) { S.stroke = null; S.pending = S.prevPending || null; if (!S.pending) hideGhosts(); updateFab(); }
    } else if (ptrs.size === 1) {
      const mousePan = e.pointerType === 'mouse' && (e.button === 1 || e.button === 2);
      gest = mousePan ? 'pan' : 'pending';
      if (!mousePan && S.tool) {
        const g = ground(p, e.pointerType); if (!g) return;
        S.prevPending = S.pending;
        S.stroke = { x0: g.x, z0: g.z };
        if (S.tool === 'wall') previewWall(g.x, g.z, g.x, g.z); else previewPlace(g.x, g.z);
        gest = 'stroke';
      }
    }
  }
  function move(e) {
    if (!S.open) return;
    const pt = ptrs.get(e.pointerId); if (!pt) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const p = local(e), px = pt.x, py = pt.y; pt.x = p.x; pt.y = p.y;
    if (gest === 'multi' && ptrs.size >= 2) {
      const m = mstate(); panBy(multi.cx, multi.cy, m.cx, m.cy);
      if (multi.dist > 10 && m.dist > 10) world.zoomBy?.(multi.dist / m.dist);
      multi = m;
    } else if (gest === 'pan') panBy(px, py, p.x, p.y);
    else if (gest === 'pending' && Math.hypot(p.x - pt.sx, p.y - pt.sy) >= 10) gest = 'pan';
    else if (gest === 'stroke' && S.stroke) {
      const g = ground(p, pt.type); if (!g) return;
      if (S.tool === 'wall') previewWall(S.stroke.x0, S.stroke.z0, g.x, g.z); else previewPlace(g.x, g.z);
    }
  }
  function up(e) {
    if (!S.open) { ptrs.delete(e.pointerId); return; }
    const pt = ptrs.get(e.pointerId); if (!pt) return;
    e.preventDefault(); e.stopImmediatePropagation();
    ptrs.delete(e.pointerId);
    if (gest === 'multi') { gest = ptrs.size ? 'none' : null; return; }
    if (ptrs.size) return;
    if (gest === 'stroke') { S.stroke = null; updateFab(); }
    else if (gest === 'pending' && e.type === 'pointerup' && performance.now() - pt.t < 400) {
      const g = world.groundAt(pt.x, pt.y);
      if (g) { const hit = pickAt(g); S.sel = hit; S.tab = 'build'; render(true); if (!hit) setInfo('Pick a tool, or tap a wall / turret / plot'); else setInfo(''); }
    }
    gest = null;
  }
  window.addEventListener('pointerdown', down, { capture: true, passive: false });
  window.addEventListener('pointermove', move, { capture: true, passive: false });
  window.addEventListener('pointerup', up, { capture: true, passive: false });
  window.addEventListener('pointercancel', up, { capture: true, passive: false });

  // ---------- per frame ----------
  const labelPool = [];
  let tick = 0;
  function update(dt) {
    tick += dt || 0;
    const d = D(); if (!d) return;
    // "Needs crew" labels over unmanned player defenses
    let n = 0;
    for (const e of d._defs) {
      if (e.team !== P || !e.crew || !e.unmanned || !alive(e)) continue;
      const p = world.project(e.x, (e.yOff || 0) + 3.4, e.z);
      if (!p.visible || p.x < -40 || p.y < -20 || p.x > innerWidth + 40 || p.y > innerHeight + 20) continue;
      let L = labelPool[n]; if (!L) { L = el('div'); labels.append(L); labelPool.push(L); }
      L.style.display = ''; L.textContent = `Needs crew (${e.crew})`;
      L.style.left = p.x.toFixed(0) + 'px'; L.style.top = p.y.toFixed(0) + 'px';
      if (++n >= 24) break;
    }
    for (let i = n; i < labelPool.length; i++) labelPool[i].style.display = 'none';
    if (!S.open) return;
    if (world.input.mode !== 'build') world.input.mode = 'build';
    if (world.input.selected?.size) world.input.selected.clear();
    // slot markers while placing turrets
    let k = 0;
    if (S.tool && S.tool.startsWith('turret')) for (const s of d.slotsOf(P)) {
      if (s.turret && alive(s.turret)) continue;
      let m = slotPool[k]; if (!m) { m = new THREE.Mesh(slotGeo, matSlot); m.rotation.x = -Math.PI / 2; m.raycast = () => {}; G.add(m); slotPool.push(m); }
      m.visible = true; m.position.set(s.x, d.DEF.wallTop + 0.25, s.z); k++;
    }
    for (let i = k; i < slotPool.length; i++) slotPool[i].visible = false;
    // selection ring
    if (S.sel && alive(S.sel)) { selRing.visible = true; const r = (S.sel.kind === 'wall' ? 2.6 : (S.sel.r || 2) + 0.6); selRing.scale.setScalar(r); selRing.position.set(S.sel.x, (S.sel.yOff || 0) + 0.2, S.sel.z); }
    else { selRing.visible = false; if (S.sel) { S.sel = null; render(true); } }
    if (tick > 0.25) { tick = 0; render(false); if (S.pending && !S.stroke) { const p = S.pending; if (S.tool === 'wall') previewWall(p.x0, p.z0, p.x1, p.z1); else if (S.tool) previewPlace(p.x, p.z); } }
  }

  const api = { update, open, close, confirm, setTool, select: e => { S.sel = e; render(true); }, state: bm, previewWall, previewPlace };
  world.buildMode = api;
  return api;
}
