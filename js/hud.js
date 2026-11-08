// Vanguard HUD (owner: Engine). DOM HUD in #hud + 2D minimap.
// TODO.md (hud):
//  - Queue shape is read defensively: building.queue (per-entity) or world.ui.queues[kind]; items may be
//    strings or {kind, t|elapsed, total|buildTime, progress, remaining}.
//  - Costs/build times come from sim.config or config.js CONFIG; FALLBACK table used if neither loads.
//  - Defense calls: sim.buildDefense() → else world.defense.buildDefense(0). Tier info from world.defense.tierInfo(0).
let CONFIG = null;
try { ({ CONFIG } = await import('./config.js')); } catch { /* optional */ }

const FALLBACK = {
  units: { warden: { cost: 60, buildTime: 20 }, raider: { cost: 90, buildTime: 25 }, tank: { cost: 200, buildTime: 45 }, harvester: { cost: 100, buildTime: 40 } },
  buildings: { cc: { produces: [] }, barracks: { produces: ['warden', 'raider'] }, factory: { produces: ['tank', 'harvester'] } },
};
const NAMES = { warden: 'Warden', raider: 'Raider', tank: 'Tank', harvester: 'Harvester', cc: 'Command', barracks: 'Barracks', factory: 'Factory' };
const VIEW_LABEL = { aerial: 'Aerial', tactical: 'Tactical', low: 'Low' };
const hex = (n) => '#' + (n >>> 0).toString(16).padStart(6, '0');

export function createHud(world, sim) {
  const root = document.getElementById('hud');
  const cfg = () => sim?.config || CONFIG || FALLBACK;
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const stop = (e) => e.stopPropagation();

  root.innerHTML = '';
  // ---- top bar
  const top = el('div', 'v-top');
  const stats = el('div', 'v-panel v-stats');
  stats.innerHTML = `
    <span class="v-stat"><i class="v-ico cr"></i><span data-k="cr">0</span></span>
    <span class="v-stat"><small>SUP</small><span data-k="sup">0/0</span></span>
    <span class="v-stat"><small>T</small><span data-k="time">00:00</span></span>
    <span class="v-stat"><i class="v-phase" data-k="phase"></i><small data-k="phaseTxt">Day</small></span>`;
  const q = (k) => stats.querySelector(`[data-k="${k}"]`);
  const btnDef = el('button', 'v-def', 'Defenses');
  const btnView = el('button', '', 'Tactical');
  const btnSpeed = el('button', '', '1x');
  top.append(stats, el('div', 'v-sp'), btnDef, btnView, btnSpeed);
  root.append(top);

  btnView.addEventListener('click', () => {
    const order = ['aerial', 'tactical', 'low'];
    world.setView(order[(order.indexOf(world.view) + 1) % 3]);
  });
  btnSpeed.addEventListener('click', () => { world.clock.speed = world.clock.speed >= 2 ? 1 : 2; });

  // ---- banner
  const banner = el('div', 'v-panel v-banner');
  root.append(banner);
  let busMsg = null, busUntil = 0, lastUiMsg = null, uiUntil = 0;
  world.bus?.addEventListener?.('message', (e) => { busMsg = e.detail?.text; busUntil = performance.now() + (e.detail?.ms || 2500); });

  // ---- minimap
  const mini = el('div', 'v-panel v-mini');
  const mc = document.createElement('canvas');
  mini.append(mc); root.append(mini);
  const MW = 120, MH = 75, mdpr = Math.min(window.devicePixelRatio || 1, 2);
  mc.width = MW * mdpr; mc.height = MH * mdpr;
  const m = mc.getContext('2d');
  const toMini = (x, z) => [(x / world.map.w + 0.5) * MW, (z / world.map.h + 0.5) * MH];
  function miniJump(e) {
    const r = mc.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width - 0.5) * world.map.w, z = ((e.clientY - r.top) / r.height - 0.5) * world.map.h;
    world.jumpTo ? world.jumpTo(x, z) : Object.assign(world.camTarget, { x, z });
  }
  let miniDown = false;
  mc.addEventListener('pointerdown', (e) => { e.preventDefault(); stop(e); miniDown = true; try { mc.setPointerCapture(e.pointerId); } catch {} miniJump(e); });
  mc.addEventListener('pointermove', (e) => { if (miniDown) { e.preventDefault(); miniJump(e); } });
  for (const ev of ['pointerup', 'pointercancel']) mc.addEventListener(ev, () => { miniDown = false; });

  // ---- selection chip
  const chip = el('div', 'v-panel v-chip');
  root.append(chip);

  // ---- build panel
  const build = el('div', 'v-panel v-build');
  root.append(build);
  let buildFor = null, buildBtns = [];
  function makeBuildPanel(b) {
    build.innerHTML = '';
    buildBtns = [];
    const kinds = cfg().buildings?.[b.kind]?.produces || FALLBACK.buildings[b.kind]?.produces || [];
    build.append(el('h4', '', `<span>${NAMES[b.kind] || b.kind}</span><span data-k="hp"></span>`));
    const row = el('div', 'row');
    for (const k of kinds) {
      const u = cfg().units?.[k] || FALLBACK.units[k] || {};
      const bt = el('button', 'v-bbtn', `<span class="n">${NAMES[k] || k}</span><span class="c">${u.cost ?? '?'} <small>· ${u.buildTime ?? '?'}s</small></span><span class="q"></span><span class="pb"></span>`);
      bt.addEventListener('click', (e) => {
        stop(e);
        const r = sim?.enqueue?.(b, k);
        if (!sim?.enqueue) flash('Production offline');
        else if (r && r.ok === false) flash(r.reason === 'crystals' ? 'Not enough crystals' : r.reason === 'supply' ? 'Supply cap reached' : r.reason || 'Cannot build');
        else if (r === false) flash('Cannot build');
      });
      bt.dataset.kind = k;
      row.append(bt); buildBtns.push(bt);
    }
    if (b.kind === 'cc') {
      const bt = el('button', 'v-bbtn', `<span class="n">Defenses</span><span class="c" data-k="defc">Tier ${world.ui.defenseTier || 0}</span><span class="pb"></span>`);
      bt.addEventListener('click', (e) => { stop(e); sheetOpen = !sheetOpen; });
      row.append(bt);
    }
    build.append(row);
    buildFor = b;
  }
  function queueOf(b) {
    if (Array.isArray(b.queue)) return b.queue;
    if (Array.isArray(world.ui.queues?.[b.id])) return world.ui.queues[b.id];
    const qs = world.ui.queues?.[b.kind];
    if (Array.isArray(qs)) return qs;
    if (qs && typeof qs === 'object') return qs[b.id] || [];
    return [];
  }
  const itemKind = (it) => (typeof it === 'string' ? it : it?.kind);
  function itemProgress(it) {
    if (!it || typeof it !== 'object') return 0;
    if (it.progress != null) return it.progress;
    const total = it.total ?? it.buildTime ?? cfg().units?.[it.kind]?.buildTime;
    if (it.remaining != null && total) return 1 - it.remaining / total;
    const t = it.t ?? it.elapsed;
    return t != null && total ? t / total : 0;
  }

  // ---- defense sheet
  const sheet = el('div', 'v-panel v-sheet');
  sheet.innerHTML = `<span class="t">Next defense tier</span><span class="nm">—</span><span class="meta"></span>
    <div class="prog"><i></i></div><div class="row"><button class="b">Build</button><button class="x">Close</button></div>`;
  root.append(sheet);
  let sheetOpen = false;
  btnDef.addEventListener('click', () => { sheetOpen = !sheetOpen; });
  sheet.querySelector('.x').addEventListener('click', () => { sheetOpen = false; });
  sheet.querySelector('.b').addEventListener('click', () => {
    const r = sim?.buildDefense ? sim.buildDefense() : world.defense?.buildDefense?.(0);
    if (r && r.ok === false) flash(r.reason === 'crystals' ? 'Not enough crystals' : r.reason === 'busy' ? 'Already building' : r.reason === 'maxed' ? 'All tiers built' : r.reason);
    else if (r === undefined && !sim?.buildDefense && !world.defense?.buildDefense) flash('Defense offline');
  });

  // ---- game over
  const over = el('div', 'v-over');
  over.innerHTML = `<div class="v-panel box"><h2></h2><span class="sub"></span><button>Restart</button></div>`;
  over.querySelector('button').addEventListener('click', () => location.reload());
  root.append(over);

  let flashUntil = 0, flashText = '';
  function flash(t) { flashText = t; flashUntil = performance.now() + 1600; }

  // ---- update
  const fmt = (s) => { s = Math.max(0, Math.floor(s)); return String((s / 60) | 0).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
  let miniAcc = 1, lastSel = '';
  function setText(node, t) { if (node.textContent !== t) node.textContent = t; }

  function drawMini() {
    m.setTransform(mdpr, 0, 0, mdpr, 0, 0);
    m.fillStyle = '#7a5434'; m.fillRect(0, 0, MW, MH);
    m.fillStyle = '#5d6066';
    for (const o of world.obstacles || []) {
      const [x, y] = toMini(o.x, o.z); m.beginPath(); m.arc(x, y, Math.max(1.2, o.r / world.map.w * MW), 0, 7); m.fill();
    }
    const surv = !!(world.ui.surveillance || world.ui.surveillanceBy?.[0]);
    for (const e of world.entities) {
      const [x, y] = toMini(e.x, e.z);
      if (e.kind === 'crystal') { m.fillStyle = '#4fe6ff'; m.fillRect(x - 1, y - 1, 2, 2); continue; }
      if (e.team === 1 && e.cls !== 'bld' && !surv) continue;
      m.fillStyle = hex(world.colors[e.team] ?? 0xcccccc);
      if (e.cls === 'bld') {
        const s = e.kind === 'wall' ? 1.6 : Math.max(2.5, (e.r || 2) / world.map.w * MW * 1.6);
        m.fillRect(x - s / 2, y - s / 2, s, s);
      } else {
        m.beginPath(); m.arc(x, y, world.input.selected.has(e) ? 1.8 : 1.3, 0, 7); m.fill();
        if (world.input.selected.has(e)) { m.strokeStyle = '#fff'; m.lineWidth = 0.6; m.stroke(); }
      }
    }
    const vc = world.viewCorners?.();
    if (vc) {
      m.strokeStyle = 'rgba(255,255,255,0.9)'; m.lineWidth = 1; m.beginPath();
      vc.forEach((c, i) => { const [x, y] = toMini(c.x, c.z); i ? m.lineTo(x, y) : m.moveTo(x, y); });
      m.closePath(); m.stroke();
    }
  }

  function update() {
    const ui = world.ui, now = performance.now();
    setText(q('cr'), String(Math.floor(ui.crystals || 0)));
    const supTxt = `${ui.supply || 0}/${ui.supplyCap || 0}`;
    setText(q('sup'), supTxt);
    q('sup').classList.toggle('v-full', ui.supplyCap > 0 && ui.supply >= ui.supplyCap);
    setText(q('time'), fmt(ui.time || world.clock.t));
    const night = ui.phase === 'night';
    q('phase').classList.toggle('night', night);
    setText(q('phaseTxt'), night ? 'Night' : 'Day');
    setText(btnView, VIEW_LABEL[world.view] || world.view);
    setText(btnSpeed, (world.clock.speed >= 2 ? 2 : 1) + 'x');

    // banner
    if (ui.message && ui.message !== lastUiMsg) { lastUiMsg = ui.message; uiUntil = now + 2600; }
    if (!ui.message) lastUiMsg = null;
    let msg = null;
    if (flashUntil > now) msg = flashText;
    else if (busUntil > now) msg = busMsg;
    else if (ui.message && uiUntil > now) msg = ui.message;
    if (msg) setText(banner, msg);
    banner.classList.toggle('on', !!msg);

    // selection
    const sel = [...world.input.selected];
    const bld = sel.length === 1 && sel[0].team === 0 && ['cc', 'barracks', 'factory'].includes(sel[0].kind) ? sel[0] : null;
    const units = sel.filter(e => e.cls === 'inf' || e.cls === 'veh');
    const key = units.map(e => e.id).join(',');
    if (key !== lastSel) {
      lastSel = key;
      const counts = {};
      for (const e of units) counts[e.kind] = (counts[e.kind] || 0) + 1;
      chip.innerHTML = Object.entries(counts).map(([k, n]) => `<span><b>${n}</b> ${NAMES[k] || k}</span>`).join('');
    }
    chip.classList.toggle('on', units.length > 0);

    // build panel
    if (bld !== buildFor) { if (bld) makeBuildPanel(bld); else buildFor = null; }
    build.classList.toggle('on', !!bld);
    if (bld) {
      const queue = queueOf(bld);
      const hpEl = build.querySelector('[data-k="hp"]');
      if (hpEl && bld.hpMax) setText(hpEl, `${Math.ceil(bld.hp)}/${bld.hpMax}`);
      for (const bt of buildBtns) {
        const k = bt.dataset.kind;
        const n = queue.filter(it => itemKind(it) === k).length;
        const badge = bt.querySelector('.q');
        setText(badge, String(n)); badge.classList.toggle('on', n > 0);
        const head = queue[0];
        const p = head && itemKind(head) === k ? itemProgress(head) : 0;
        bt.querySelector('.pb').style.width = (Math.max(0, Math.min(1, p)) * 100).toFixed(1) + '%';
        const cost = cfg().units?.[k]?.cost;
        bt.disabled = cost != null && (ui.crystals || 0) < cost;
      }
      const defc = build.querySelector('[data-k="defc"]');
      if (defc) setText(defc, `Tier ${ui.defenseTier || 0}/10`);
    }

    // defense sheet
    sheet.classList.toggle('on', sheetOpen);
    btnDef.classList.toggle('on', sheetOpen);
    if (sheetOpen) {
      const info = world.defense?.tierInfo?.(0) || sim?.tierInfo?.(0);
      const nm = sheet.querySelector('.nm'), meta = sheet.querySelector('.meta'), bar = sheet.querySelector('.prog i'), bb = sheet.querySelector('.b');
      const building = info?.building || (ui.defenseBuild ? { ...ui.defenseBuild } : null);
      if (building) {
        setText(nm, `Tier ${building.tier}: ${building.name}`);
        setText(meta, building.remaining != null ? `Building… ${Math.ceil(building.remaining)}s left` : 'Building…');
        bar.style.width = ((building.progress || 0) * 100).toFixed(1) + '%';
        bb.disabled = true; setText(bb, 'Building');
      } else if (info?.next) {
        setText(nm, `Tier ${info.next.tier}: ${info.next.name}`);
        setText(meta, `${info.next.cost} crystals · ${info.next.buildTime}s`);
        bar.style.width = '0%';
        bb.disabled = (ui.crystals || 0) < info.next.cost; setText(bb, 'Build');
      } else if (info) {
        setText(nm, 'All tiers complete'); setText(meta, `Tier ${info.current}/10`); bb.disabled = true; setText(bb, 'Maxed');
      } else {
        setText(nm, `Tier ${(ui.defenseTier || 0) + 1}`); setText(meta, 'Defense module offline'); bb.disabled = !sim?.buildDefense; setText(bb, 'Build');
      }
    }

    // game over
    const go = ui.gameOver;
    over.classList.toggle('on', !!go);
    if (go && !over.classList.contains(go)) {
      over.classList.remove('win', 'lose'); over.classList.add(go);
      setText(over.querySelector('h2'), go === 'win' ? 'VICTORY' : 'DEFEAT');
      setText(over.querySelector('.sub'), go === 'win' ? 'Enemy command destroyed' : 'Your command center has fallen');
    }

    miniAcc += 1;
    if (miniAcc >= 3) { miniAcc = 0; drawMini(); } // ~20Hz is plenty
  }

  update();
  return { update };
}
