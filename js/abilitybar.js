// Vanguard — ability bar (owner: ROSTER). Bottom-center row of 4 square buttons for the selected unit kind.
// createAbilityBar(world) -> { update(dt), el }
//  - Shows when the player's selection contains roster units; uses the most numerous kind in the selection.
//  - Tap active: self abilities cast on every ready selected unit of that kind; targeted abilities enter targeting
//    mode (next tap on the battlefield = target; tap the button again / Esc to cancel). Double-tap a targeted
//    ability = quick-cast at each unit's best target.
//  - Long-press (0.5s) an active toggles autocast for the selected units (glowing corner dot = on).
//  - Tap a passive: shows its description.
//  - Cooldown sweep = the soonest-ready unit in the group; badge = ready count.
// Targeting mode swallows the battlefield tap in a capture-phase listener so the engine doesn't also issue a move.
import { ROSTER } from './roster.js';
import { ABILITIES } from './abilities.js';

const CSS = `
.v-abil { position: absolute; left: 50%; transform: translateX(-50%); bottom: calc(52px + var(--sab, 0px));
  display: none; flex-direction: column; align-items: center; gap: 4px; pointer-events: none; z-index: 3; }
.v-abil.on { display: flex; }
.v-abil .row { display: flex; gap: 6px; padding: 5px; background: rgba(15,22,32,0.92); border: 1px solid #39d8ff;
  border-radius: 12px; box-shadow: 0 0 8px rgba(57,216,255,0.35); pointer-events: auto; }
.v-abil .ab { position: relative; width: 52px; height: 52px; padding: 0 !important; border-radius: 9px !important;
  border: 1px solid #39d8ff; background: #101a26 !important; overflow: hidden; cursor: pointer; touch-action: manipulation;
  -webkit-tap-highlight-color: transparent; }
.v-abil .ab canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.v-abil .ab.passive { border-style: dashed; border-color: #6f8aa3; }
.v-abil .ab.passive canvas { opacity: 0.7; }
.v-abil .ab.off canvas { filter: grayscale(0.8) brightness(0.6); }
.v-abil .ab.tgt { border-color: #ffd27a; box-shadow: 0 0 10px #ffd27a, inset 0 0 8px rgba(255,210,122,0.5); }
.v-abil .ab .cd { position: absolute; inset: 0; pointer-events: none; }
.v-abil .ab .cdt { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font: 700 15px/1 system-ui, sans-serif; color: #fff; text-shadow: 0 1px 2px #000; pointer-events: none; }
.v-abil .ab .n { position: absolute; right: 2px; bottom: 1px; font: 700 10px/1 system-ui, sans-serif; color: #cfe9ff;
  text-shadow: 0 1px 2px #000; pointer-events: none; }
.v-abil .ab .au { position: absolute; left: 3px; top: 3px; width: 7px; height: 7px; border-radius: 50%; background: #39d8ff;
  box-shadow: 0 0 6px #39d8ff; display: none; pointer-events: none; }
.v-abil .ab .au.on { display: block; }
.v-abil .tip { max-width: min(520px, 86vw); padding: 4px 10px; font: 600 12px/1.3 system-ui, sans-serif; color: #fff;
  background: rgba(15,22,32,0.92); border: 1px solid #39d8ff; border-radius: 8px; text-align: center; opacity: 0;
  transition: opacity .2s; white-space: normal; }
.v-abil .tip.on { opacity: 1; }
.v-abil .tip small { color: #9fb3c8; font-weight: 400; }
@media (max-height: 420px) { .v-abil .ab { width: 48px; height: 48px; } }
`;

const hex = (c) => '#' + (c >>> 0).toString(16).padStart(6, '0');
const FCOL = { vanguard: 0x2fb8ff, volcanic: 0xff5a12, earth: 0x5fd35f, storm: 0xe8d27a };

function glyphOf(def) {
  if (def.type === 'passive') {
    const m = def.mods || {};
    if (m.detect) return 'eye';
    if (m.aura) return 'rings';
    if (m.regen) return 'leaf';
    if (m.onHit?.dot || m.thorns) return 'flame';
    if (m.onHit?.slow) return 'thorn';
    if (m.still) return 'anchor';
    if (m.everyN) return 'chain';
    if (m.onHitSelf || m.oocSpeed || m.rootnet) return 'speed';
    if (m.moving) return 'shield';
    return 'hex';
  }
  return ({ aoe: 'burst', cone: 'cone', line: 'line', single: 'cross', chain: 'chain', dash: 'dash', heal: 'heal', shield: 'shield',
    buff: 'up', speed: 'speed', burrow: 'down', surface: 'up', erupt: 'erupt', reveal: 'eye', summon: 'swirl', zone: 'zone',
    rain: 'rain', flood: 'wave', ironball: 'ball', mines: 'mines', claymore: 'cone', demo: 'bomb' })[def.kind] || 'hex';
}

function drawIcon(cv, def, faction) {
  const S = 104; cv.width = S; cv.height = S;
  const c = cv.getContext('2d');
  const col = hex(FCOL[faction] ?? 0x39d8ff);
  const g = c.createRadialGradient(S * 0.5, S * 0.4, 6, S * 0.5, S * 0.5, S * 0.75);
  g.addColorStop(0, col + '55'); g.addColorStop(1, '#0b121b');
  c.fillStyle = g; c.fillRect(0, 0, S, S);
  c.save(); c.translate(S / 2, S / 2);
  c.strokeStyle = '#ffffff'; c.fillStyle = col; c.lineWidth = 6; c.lineJoin = 'round'; c.lineCap = 'round';
  c.shadowColor = col; c.shadowBlur = 10;
  const P = (pts, fill, close = true) => { c.beginPath(); pts.forEach(([x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y)); if (close) c.closePath(); fill ? (c.fill(), c.stroke()) : c.stroke(); };
  const circ = (x, y, r, fill) => { c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); fill ? (c.fill(), c.stroke()) : c.stroke(); };
  switch (glyphOf(def)) {
    case 'burst': circ(0, 0, 13, true); for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; P([[Math.cos(a) * 20, Math.sin(a) * 20], [Math.cos(a) * 34, Math.sin(a) * 34]], false, false); } break;
    case 'cone': P([[-30, 0], [28, -24], [28, 24]], true); break;
    case 'line': P([[-34, 10], [34, -10]], false, false); P([[34, -10], [18, -16], [24, 2]], true); c.lineWidth = 14; c.globalAlpha = 0.35; P([[-34, 10], [34, -10]], false, false); break;
    case 'cross': circ(0, 0, 22); P([[0, -34], [0, -12]], false, false); P([[0, 34], [0, 12]], false, false); P([[-34, 0], [-12, 0]], false, false); P([[34, 0], [12, 0]], false, false); circ(0, 0, 4, true); break;
    case 'chain': P([[-10, -36], [8, -8], [-6, -4], [12, 34], [-2, 4], [10, 0]], true); break;
    case 'dash': P([[-30, -20], [-6, 0], [-30, 20]], false, false); P([[-2, -20], [22, 0], [-2, 20]], false, false); break;
    case 'heal': P([[-8, -30], [8, -30], [8, -8], [30, -8], [30, 8], [8, 8], [8, 30], [-8, 30], [-8, 8], [-30, 8], [-30, -8], [-8, -8]], true); break;
    case 'shield': P([[0, -32], [28, -20], [24, 12], [0, 32], [-24, 12], [-28, -20]], true); break;
    case 'up': P([[0, -32], [26, 0], [10, 0], [10, 30], [-10, 30], [-10, 0], [-26, 0]], true); break;
    case 'down': P([[-34, 28], [34, 28]], false, false); P([[0, 18], [22, -6], [8, -6], [8, -32], [-8, -32], [-8, -6], [-22, -6]], true); break;
    case 'erupt': P([[-34, 26], [34, 26]], false, false); P([[-22, 22], [-14, -10], [-6, 22]], true); P([[-6, 22], [4, -30], [14, 22]], true); P([[14, 22], [22, -4], [30, 22]], true); break;
    case 'speed': for (const x of [-22, -2, 18]) P([[x, -22], [x + 14, 0], [x, 22]], false, false); break;
    case 'eye': P([[-34, 0], [-12, -18], [12, -18], [34, 0], [12, 18], [-12, 18]], false); circ(0, 0, 10, true); break;
    case 'rings': circ(0, 0, 8, true); c.globalAlpha = 0.8; circ(0, 0, 20); c.globalAlpha = 0.5; circ(0, 0, 32); break;
    case 'leaf': P([[-24, 26], [-20, -10], [6, -30], [28, -28], [24, 0], [6, 20]], true); P([[-24, 26], [14, -16]], false, false); break;
    case 'flame': P([[0, -34], [18, -6], [22, 14], [10, 30], [-10, 30], [-22, 14], [-14, -6], [-6, 4]], true); break;
    case 'thorn': P([[-30, 20], [30, -20]], false, false); for (const t of [-14, 2, 18]) P([[t - 2, -t * 0.66 - 2], [t + 8, -t * 0.66 + 10]], false, false); break;
    case 'anchor': P([[0, -30], [0, 28]], false, false); circ(0, -30, 6); P([[-26, 8], [-20, 24], [0, 30], [20, 24], [26, 8]], false, false); P([[-14, -14], [14, -14]], false, false); break;
    case 'swirl': c.beginPath(); for (let i = 0; i < 60; i++) { const a = i * 0.32, r = 2 + i * 0.55; c.lineTo(Math.cos(a) * r, Math.sin(a) * r); } c.stroke(); break;
    case 'zone': c.setLineDash([8, 8]); circ(0, 0, 30); c.setLineDash([]); for (const [x, y] of [[-8, -6], [10, 4], [-2, 14], [6, -14]]) circ(x, y, 4, true); break;
    case 'rain': P([[-28, -2], [-26, -20], [-10, -24], [0, -34], [18, -28], [28, -14], [26, -2]], true); for (const x of [-18, -2, 14]) P([[x, 10], [x - 6, 30]], false, false); break;
    case 'wave': for (const y of [-14, 4, 22]) { c.beginPath(); for (let x = -34; x <= 34; x += 2) c.lineTo(x, y + Math.sin(x / 7) * 6); c.stroke(); } break;
    case 'ball': c.globalAlpha = 0.5; P([[-34, 26], [-6, 8]], false, false); c.globalAlpha = 1; c.fillStyle = '#ff8a2a'; circ(8, -4, 16, true); break;
    case 'mines': for (const [x, y] of [[-16, 10], [16, 10], [0, -16]]) { circ(x, y, 9, true); P([[x, y - 9], [x, y - 15]], false, false); } break;
    case 'bomb': circ(-4, 6, 22, true); P([[10, -12], [20, -26]], false, false); c.fillStyle = '#ffd27a'; circ(24, -30, 5, true); break;
    default: P([[0, -30], [26, -15], [26, 15], [0, 30], [-26, 15], [-26, -15]], false); c.shadowBlur = 0; c.fillStyle = '#fff'; c.font = '700 30px system-ui'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText((def.name || '?')[0], 0, 2);
  }
  c.restore();
}

export function createAbilityBar(world) {
  if (typeof document === 'undefined') return { update() {} };
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  const root = document.createElement('div'); root.className = 'v-abil';
  const tip = document.createElement('div'); tip.className = 'tip';
  const row = document.createElement('div'); row.className = 'row';
  root.append(tip, row);
  (document.getElementById('hud') || document.body).appendChild(root);
  const btns = [];
  for (let i = 0; i < 4; i++) {
    const b = document.createElement('button'); b.className = 'ab'; b.type = 'button';
    const cv = document.createElement('canvas'), cd = document.createElement('div'), cdt = document.createElement('div'), n = document.createElement('div'), au = document.createElement('div');
    cd.className = 'cd'; cdt.className = 'cdt'; n.className = 'n'; au.className = 'au';
    b.append(cv, cd, cdt, n, au); row.appendChild(b);
    const o = { b, cv, cd, cdt, n, au, id: null, sweep: -1, txt: '', cnt: '', auto: null, cls: '' };
    btns.push(o);
    let pressT = 0, longFired = false, lastTap = 0, timer = null;
    b.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation(); pressT = performance.now(); longFired = false;
      clearTimeout(timer);
      timer = setTimeout(() => { longFired = true; toggleAuto(o); }, 500);
    });
    const end = (ev) => { ev.stopPropagation(); clearTimeout(timer); };
    b.addEventListener('pointerup', end); b.addEventListener('pointercancel', end); b.addEventListener('pointerleave', () => clearTimeout(timer));
    b.addEventListener('click', (ev) => {
      ev.stopPropagation(); ev.preventDefault();
      if (longFired) return;
      const now = performance.now(), dbl = now - lastTap < 320; lastTap = now;
      press(o, dbl);
    });
    b.addEventListener('contextmenu', (ev) => ev.preventDefault());
  }

  let kind = null, group = [], targeting = null, tipT = 0, sig = '';
  const A = () => world.abilities;
  const P = () => world.teams?.P ?? 0;
  const alive = (e) => e && e.state !== 'dead' && e.hp > 0;

  function showTip(html, ms = 2600) { tip.innerHTML = html; tip.classList.add('on'); tipT = ms < 0 ? Infinity : performance.now() + ms; }
  function hideTip() { tip.classList.remove('on'); tipT = 0; }
  const msg = (text) => { try { world.bus?.dispatchEvent(new CustomEvent('message', { detail: { text, ms: 1500 } })); } catch (_) {} };

  function press(o, dbl) {
    const def = ABILITIES[o.id], ab = A();
    if (!def || !ab) return;
    if (def.type === 'passive') { showTip(`<b>${def.name}</b> <small>(passive)</small><br><small>${def.desc || ''}</small>`); return; }
    if (targeting && targeting.id === o.id) {
      if (dbl) { quickCast(def); cancelTargeting(); } else cancelTargeting();
      return;
    }
    const ready = group.filter(e => ab.canCast(e, o.id));
    if (!ready.length) { showTip(`<b>${def.name}</b> <small>not ready</small><br><small>${def.desc || ''}</small>`, 1500); return; }
    if (def.target === 'self') { ab.cast(ready, o.id); showTip(`<b>${def.name}</b>`, 900); return; }
    startTargeting(def);
  }
  function quickCast(def) {
    const ab = A(); let n = 0;
    for (const e of group) if (ab.canCast(e, def.id)) n += ab.cast(e, def.id);
    if (!n) msg(`${def.name}: no target in range`);
  }
  function toggleAuto(o) {
    const def = ABILITIES[o.id], ab = A();
    if (!def || def.type !== 'active' || !ab || !group.length) return;
    const on = !ab.autocast(group[0], o.id);
    for (const e of group) ab.setAutocast(e, o.id, on);
    showTip(`<b>${def.name}</b> autocast ${on ? 'ON' : 'OFF'}`, 1400);
    try { navigator.vibrate?.(15); } catch (_) {}
  }

  // ---------------------------------------------------------------- targeting mode
  const overlay = () => document.getElementById('overlay') || document.getElementById('gl');
  let downAt = null;
  function startTargeting(def) {
    targeting = { id: def.id };
    const what = def.target === 'unit' ? 'an enemy' : def.target === 'ally' ? 'allies' : 'the ground';
    showTip(`<b>${def.name}</b>: tap ${what} <small>(tap button again to cancel, double-tap = auto)</small>`, -1);
  }
  function cancelTargeting() { targeting = null; downAt = null; hideTip(); }
  const isField = (ev) => { const t = ev.target; const ov = overlay(); return t === ov || t?.id === 'gl' || t === document.body || t === document.documentElement; };
  const swallow = (ev) => { ev.stopPropagation(); ev.stopImmediatePropagation?.(); if (ev.cancelable) ev.preventDefault(); };
  window.addEventListener('pointerdown', (ev) => {
    if (!targeting || !isField(ev)) return;
    if (downAt) { downAt = null; return; } // second finger: let pan/pinch through
    downAt = { x: ev.clientX, y: ev.clientY, t: performance.now(), id: ev.pointerId };
    swallow(ev);
  }, true);
  window.addEventListener('pointermove', (ev) => { if (targeting && downAt && ev.pointerId === downAt.id) swallow(ev); }, true);
  window.addEventListener('pointerup', (ev) => {
    if (!targeting || !downAt || ev.pointerId !== downAt.id) return;
    const d = Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y);
    downAt = null; swallow(ev);
    if (d > 24) return;
    const ov = overlay(), r = ov?.getBoundingClientRect?.() || { left: 0, top: 0 };
    const sx = ev.clientX - r.left, sy = ev.clientY - r.top;
    const gp = world.groundAt?.(sx, sy);
    if (!gp) return;
    const def = ABILITIES[targeting.id], ab = A();
    let target = { x: gp.x, z: gp.z };
    if (def.target === 'unit') {
      let best = null, bd = 5;
      for (const e of world.entities) {
        if (!alive(e) || e.team === P() || e.team < 0 || e.cls === 'neutral' || (e.hidden && world.fog?.enabled) || e.mine) continue;
        const dd = Math.hypot(e.x - gp.x, e.z - gp.z) - (e.r || 1);
        if (dd < bd) { bd = dd; best = e; }
      }
      if (!best) { msg('Tap an enemy unit'); return; }
      target = best;
    }
    const ready = group.filter(e => ab.canCast(e, def.id));
    const n = ab.cast(ready, def.id, target);
    if (!n) msg(`${def.name}: can't cast there`);
    cancelTargeting();
  }, true);
  window.addEventListener('pointercancel', () => { downAt = null; }, true);
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && targeting) { cancelTargeting(); return; }
    const k = ['1', '2', '3', '4'].indexOf(ev.key);
    if (k >= 0 && root.classList.contains('on') && !ev.repeat && !(ev.target instanceof HTMLInputElement)) press(btns[k], false);
  });

  // ---------------------------------------------------------------- per-frame
  function pickGroup() {
    const sel = world.input?.selected;
    const by = new Map();
    if (sel) for (const e of sel) {
      if (!alive(e) || e.team !== P() || !ROSTER[e.kind] || !ROSTER[e.kind].abilities?.length) continue;
      const l = by.get(e.kind); l ? l.push(e) : by.set(e.kind, [e]);
    }
    let bk = null, bl = [];
    for (const [k, l] of by) if (l.length > bl.length) { bk = k; bl = l; }
    return [bk, bl];
  }
  function update() {
    const ab = A();
    const [k, g] = ab ? pickGroup() : [null, []];
    group = g;
    if (k !== kind) {
      kind = k; if (targeting) cancelTargeting();
      if (k) {
        const ids = ROSTER[k].abilities;
        btns.forEach((o, i) => {
          o.id = ids[i] || null; o.sweep = -1; o.txt = ''; o.cnt = ''; o.auto = null; o.cls = '';
          const def = ABILITIES[o.id];
          o.b.style.visibility = def ? 'visible' : 'hidden';
          if (def) { drawIcon(o.cv, def, ROSTER[k].faction); o.b.title = `${def.name}: ${def.desc || ''}`; o.b.setAttribute('aria-label', def.name); }
        });
      }
    }
    const show = !!k;
    if (show !== root.classList.contains('on')) root.classList.toggle('on', show);
    if (tipT && performance.now() > tipT) hideTip();
    if (!show) return;
    if (targeting && !group.some(e => ab.canCast(e, targeting.id))) cancelTargeting();
    for (const o of btns) {
      const def = ABILITIES[o.id]; if (!def) continue;
      let cls = def.type === 'passive' ? 'ab passive' : 'ab';
      if (def.type === 'active') {
        let left = Infinity, nReady = 0, total = def.cd || 1, reqOk = false;
        for (const e of group) {
          const c = ab.cooldown(e, o.id);
          if (ab.canCast(e, o.id)) nReady++;
          if (c.left < left) left = c.left;
          if (!(def.req === 'burrowed' && !e.burrowed) && !(def.req === 'surfaced' && e.burrowed)) reqOk = true;
        }
        if (!reqOk) cls += ' off';
        if (targeting?.id === o.id) cls += ' tgt';
        const sw = left > 0 && Number.isFinite(left) ? Math.round(Math.min(1, left / total) * 60) : 0;
        if (sw !== o.sweep) {
          o.sweep = sw;
          o.cd.style.background = sw ? `conic-gradient(rgba(5,10,16,0.78) ${sw * 6}deg, transparent 0)` : 'none';
        }
        const txt = left > 0 && Number.isFinite(left) && !nReady ? String(Math.ceil(left)) : '';
        if (txt !== o.txt) { o.txt = txt; o.cdt.textContent = txt; }
        const cnt = group.length > 1 ? String(nReady) : '';
        if (cnt !== o.cnt) { o.cnt = cnt; o.n.textContent = cnt; }
        const au = group.length ? ab.autocast(group[0], o.id) : false;
        if (au !== o.auto) { o.auto = au; o.au.classList.toggle('on', au); }
      }
      if (cls !== o.cls) { o.cls = cls; o.b.className = cls; }
    }
    void sig;
  }
  return { update, el: root, get targeting() { return targeting; } };
}
