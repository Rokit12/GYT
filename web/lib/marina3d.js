/*
  GYT 3D marina: berths and yachts to scale (1 unit = 1 metre), drawn with three.js.

  Shared by the web app (THREE from the npm package) and the GitHub Pages site (THREE from a CDN),
  so it only uses APIs that exist in both three r128 and r160.

  const m = createMarina3D(THREE, element, { onPick(code) {} });
  m.set({
    berths: [{ code, loa, beam, depth, state, best, label,
               moored: { loa, beam, name, misfit } | null,   // a yacht berthed there
               held:   { loa } | null }],                     // another yacht holding it
    yacht:    { name, loa, beam } | null,                     // the yacht you're finding a berth for
    selected: code | null,
  });
  m.dock(code)      // your yacht sails in and moors stern-to in that berth
  m.dispose()

  Touch: drag sideways to turn, pinch to zoom, two fingers up/down to tilt; vertical one-finger
  drags still scroll the page. Mouse: drag to turn, wheel to zoom. Tap a berth to pick it.
*/

export function createMarina3D(THREE, el, opts = {}) {
  const COLORS = {
    available: 0x2e9e6a, best: 0xd6a12e, held: 0xe08a1e, held_by_you: 0x14a3a6, mine: 0x14a3a6,
    booked: 0x8a98a6, booked_by_you: 0x14a3a6, occupied: 0x8a98a6, too_small: 0x9aa5ad, maintenance: 0x6d7880, free: 0x2e9e6a,
  };
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- renderer, scene, camera ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  // r152+ manages colour spaces itself; older builds keep their default (linear) output so colours match
  if ('outputColorSpace' in renderer && THREE.SRGBColorSpace) renderer.outputColorSpace = THREE.SRGBColorSpace;
  const canvas = renderer.domElement;
  canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:pan-y;outline:none;cursor:grab';
  canvas.setAttribute('aria-label', 'Interactive 3D view of the marina. Drag to turn, pinch or scroll to zoom, tap a berth to pick it.');
  canvas.setAttribute('role', 'img');
  el.appendChild(canvas);

  const scene = new THREE.Scene();
  const SKY = 0xcfe3ec;
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 140, 420);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.5, 1200);

  // r155+ uses physical light units: scale up so both versions look the same
  const LI = Number(THREE.REVISION) >= 155 ? Math.PI : 1;
  scene.add(new THREE.HemisphereLight(0xeaf6ff, 0x37505c, 0.5 * LI));
  const sun = new THREE.DirectionalLight(0xffffff, 0.55 * LI);
  sun.position.set(-60, 90, 70);
  scene.add(sun);

  // ---------- water ----------
  const waterGeo = new THREE.PlaneGeometry(700, 700, 48, 48);
  waterGeo.rotateX(-Math.PI / 2);
  const water = new THREE.Mesh(waterGeo, new THREE.MeshStandardMaterial({ color: 0x2b6f86, roughness: 0.32, metalness: 0.15, flatShading: true }));
  water.position.y = -0.15;
  scene.add(water);
  const wpos = waterGeo.attributes.position;
  const wbase = new Float32Array(wpos.count * 2);
  for (let i = 0; i < wpos.count; i++) { wbase[i * 2] = wpos.getX(i); wbase[i * 2 + 1] = wpos.getZ(i); }

  // ---------- helpers ----------
  const mat = (color, extra = {}) => new THREE.MeshStandardMaterial(Object.assign({ color, roughness: 0.55, metalness: 0.05 }, extra));
  const M = {
    deck: mat(0xb88a5a, { roughness: 0.8 }), pier: mat(0x9c7449, { roughness: 0.85 }), post: mat(0x4a3b2c),
    hull: mat(0xf4f6f8, { roughness: 0.35 }), stripe: mat(0x12324a, { roughness: 0.4 }), glass: mat(0x1c2c38, { roughness: 0.15, metalness: 0.4 }),
    teak: mat(0xb98c5c, { roughness: 0.7, side: THREE.DoubleSide }), shadow: new THREE.MeshBasicMaterial({ color: 0x0b2733, transparent: true, opacity: 0.28, depthWrite: false }),
  };

  function label(text, sub, color = '#0d1f2d') {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 112;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(255,255,255,0.92)';
    const r = 18; g.beginPath(); g.moveTo(r, 0); g.arcTo(256, 0, 256, 112, r); g.arcTo(256, 112, 0, 112, r); g.arcTo(0, 112, 0, 0, r); g.arcTo(0, 0, 256, 0, r); g.fill();
    g.fillStyle = color; g.textAlign = 'center';
    g.font = '700 46px system-ui, -apple-system, Segoe UI, sans-serif'; g.fillText(text, 128, 52);
    g.font = '500 30px system-ui, -apple-system, Segoe UI, sans-serif'; g.fillStyle = '#4c5d68'; g.fillText(sub, 128, 92);
    const tex = new THREE.CanvasTexture(c);
    if ('colorSpace' in tex && THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    s.scale.set(9, 3.9, 1);
    s.renderOrder = 10;
    return s;
  }

  // A motor yacht to scale: stern at local z = 0, bow at z = L, beam B, centred on x = 0.
  function yachtModel(L, B, look = 'solid', color = 0xf4f6f8) {
    const g = new THREE.Group();
    const ghost = look !== 'solid';
    const m = c => (ghost ? new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.35, transparent: true, opacity: 0.62, roughness: 0.4, depthWrite: false }) : null);
    const hullMat = ghost ? m(color) : (color === 0xf4f6f8 ? M.hull : mat(color, { roughness: 0.35 }));
    const shape = new THREE.Shape();
    const h = B / 2;
    shape.moveTo(-h * 0.92, 0);
    shape.lineTo(h * 0.92, 0);
    shape.quadraticCurveTo(h, L * 0.02, h, L * 0.12);
    shape.lineTo(h, L * 0.6);
    shape.quadraticCurveTo(h * 0.95, L * 0.86, 0, L);
    shape.quadraticCurveTo(-h * 0.95, L * 0.86, -h, L * 0.6);
    shape.lineTo(-h, L * 0.12);
    shape.quadraticCurveTo(-h, L * 0.02, -h * 0.92, 0);
    const hullH = Math.max(1.6, L * 0.085);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: hullH, bevelEnabled: false, curveSegments: 10 });
    geo.rotateX(Math.PI / 2);             // shape y -> +z (length), extrusion -> -y
    geo.translate(0, hullH * 0.72, 0);    // top of hull above the water, the rest below
    const hull = new THREE.Mesh(geo, hullMat);
    g.add(hull);
    if (!ghost) {
      // boot stripe along the waterline
      const sg = new THREE.ExtrudeGeometry(shape, { depth: 0.22, bevelEnabled: false, curveSegments: 10 });
      sg.rotateX(Math.PI / 2); sg.scale(1.012, 1, 1.004); sg.translate(0, 0.32, 0);
      g.add(new THREE.Mesh(sg, M.stripe));
      // deck
      const dg = new THREE.ShapeGeometry(shape, 10); dg.rotateX(Math.PI / 2); dg.scale(0.94, 1, 0.97); dg.translate(0, hullH * 0.72 + 0.03, L * 0.01);
      g.add(new THREE.Mesh(dg, M.teak));
      // superstructure: main deck saloon, upper deck, flybridge
      const lvl = Math.max(1.5, L * 0.055);
      const box = (w, l, hh, z0, y0, mt) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, hh, l), mt); b.position.set(0, y0 + hh / 2, z0 + l / 2); g.add(b); return b; };
      const base = hullH * 0.72;
      box(B * 0.8, L * 0.5, lvl, L * 0.14, base, M.hull);
      box(B * 0.82, L * 0.44, lvl * 0.36, L * 0.17, base + lvl * 0.38, M.glass);
      if (L >= 22) { box(B * 0.66, L * 0.34, lvl * 0.92, L * 0.2, base + lvl, M.hull); box(B * 0.68, L * 0.28, lvl * 0.32, L * 0.24, base + lvl * 1.32, M.glass); }
      if (L >= 38) { box(B * 0.5, L * 0.18, lvl * 0.8, L * 0.27, base + lvl * 1.92, M.hull); }
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, lvl * 1.4, 8), M.stripe);
      mast.position.set(0, base + lvl * (L >= 38 ? 3.2 : L >= 22 ? 2.6 : 1.8), L * 0.32); g.add(mast);
      // soft contact shadow on the water
      const sh = new THREE.Mesh(new THREE.PlaneGeometry(B * 1.25, L * 1.08), M.shadow);
      sh.rotation.x = -Math.PI / 2; sh.position.set(0, -0.12, L / 2); g.add(sh);
    } else {
      const top = new THREE.Mesh(new THREE.BoxGeometry(B * 0.78, Math.max(1.4, L * 0.05), L * 0.48), m(color));
      top.position.set(0, hullH * 0.72 + Math.max(1.4, L * 0.05) / 2, L * 0.38); g.add(top);
    }
    g.userData.L = L;
    return g;
  }

  // ---------- marina contents (rebuilt on set) ----------
  let root = new THREE.Group();
  scene.add(root);
  let slots = [];          // { code, mesh, cx, len, width, outline, held }
  let mine = null;         // your yacht's group
  let state = { berths: [], yacht: null, selected: null };
  let layout = { cx: 0, depth: 40, width: 80 };
  const disposeTree = o => o.traverse(n => { if (n.geometry) n.geometry.dispose(); if (n.material && !Object.values(M).includes(n.material)) { if (n.material.map) n.material.map.dispose(); n.material.dispose(); } });

  function build() {
    scene.remove(root); disposeTree(root);
    root = new THREE.Group(); scene.add(root);
    slots = []; mine = null;
    const bs = state.berths || [];
    if (!bs.length) return;
    const GAP = 1.2; // finger pier
    let x = 0;
    const placed = bs.map(b => { const w = Math.max(b.beam + 1.6, 5); const cx = x + w / 2; x += w + GAP; return { b, cx, w }; });
    const total = x - GAP;
    const off = -total / 2;
    const maxL = Math.max(...bs.map(b => b.loa));
    layout = { cx: 0, depth: maxL, width: total };
    // main pontoon with a walkway edge and bollards
    const pont = new THREE.Mesh(new THREE.BoxGeometry(total + 14, 0.7, 3.4), M.deck);
    pont.position.set(0, 0.2, -1.7); root.add(pont);
    const shore = new THREE.Mesh(new THREE.BoxGeometry(total + 60, 1.4, 22), mat(0xcdbf9f, { roughness: 0.95 }));
    shore.position.set(0, 0.45, -14.4); root.add(shore);
    const prom = new THREE.Mesh(new THREE.BoxGeometry(total + 60, 0.12, 4), mat(0xa7b4ba, { roughness: 0.9 }));
    prom.position.set(0, 1.2, -6); root.add(prom);
    placed.forEach(({ b, cx, w }, i) => {
      const X = off + cx;
      const len = b.loa;
      // finger pier on the right of each berth
      if (i < placed.length - 1) {
        const fp = new THREE.Mesh(new THREE.BoxGeometry(GAP * 0.8, 0.45, Math.min(len, placed[i + 1].b.loa) * 0.72), M.pier);
        fp.position.set(off + cx + w / 2 + GAP / 2, 0.1, fp.geometry.parameters.depth / 2); root.add(fp);
      }
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.6, 8), M.post);
      post.position.set(X - w / 2 + 0.4, 0.75, -0.3); root.add(post);
      const post2 = post.clone(); post2.position.x = X + w / 2 - 0.4; root.add(post2);
      // the berth's water slot, coloured by state
      const color = b.best && b.state === 'available' ? COLORS.best : (COLORS[b.state] ?? 0x8a98a6);
      const slotMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: b.state === 'too_small' ? 0.12 : 0.3, depthWrite: false });
      const slot = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.4, len), slotMat);
      slot.rotation.x = -Math.PI / 2; slot.position.set(X, -0.05, len / 2 + 0.3); root.add(slot);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w - 0.4, 0.01, len)), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 }));
      edges.position.set(X, 0.02, len / 2 + 0.3); root.add(edges);
      const lab = label(b.code, `${b.loa} m${b.best && b.state === 'available' ? ' ★' : ''}`, b.state === 'too_small' ? '#7b8790' : '#0d1f2d');
      lab.position.set(X, 4.2, len + 4.5); root.add(lab);
      const rec = { code: b.code, mesh: slot, edges, cx: X, len, w, held: null, state: b.state };
      // a yacht moored there
      if (b.moored) {
        const y = yachtModel(b.moored.loa, b.moored.beam, 'solid');
        y.position.set(X, 0, 0.8); y.userData.bob = Math.random() * 6; root.add(y);
        if (b.moored.misfit) {
          const warn = new THREE.Mesh(new THREE.PlaneGeometry(w + 0.6, Math.max(0.5, b.moored.loa - len) + 1.2), new THREE.MeshBasicMaterial({ color: 0xd9433b, transparent: true, opacity: 0.45, depthWrite: false }));
          warn.rotation.x = -Math.PI / 2; warn.position.set(X, -0.02, len + 0.3 + (b.moored.loa - len) / 2); root.add(warn);
          rec.warn = warn;
        }
      }
      // another yacht holding it: an amber outline yacht that pulses
      if (b.held) {
        const y = yachtModel(b.held.loa, Math.min(b.beam, b.held.loa * 0.24), 'ghost', 0xe08a1e);
        y.position.set(X, 0, 0.8); root.add(y); rec.held = y;
      }
      slots.push(rec);
    });
    placeMine();
  }

  // your yacht: a ghost in the selected berth (red where it doesn't fit), or moored when it's yours
  function placeMine() {
    if (mine) { root.remove(mine); disposeTree(mine); mine = null; }
    const y = state.yacht; if (!y) return;
    const s = slots.find(r => r.code === state.selected) || slots.find(r => r.state === 'held_by_you' || r.state === 'booked_by_you');
    if (!s) return;
    const fits = y.loa <= s.len && y.beam <= s.w - 0.4;
    const owned = s.state === 'held_by_you' || s.state === 'booked_by_you';
    mine = yachtModel(y.loa, y.beam, owned ? 'solid' : 'ghost', owned ? 0xf4f6f8 : fits ? 0x14a3a6 : 0xd9433b);
    mine.position.set(s.cx, 0, 0.8);
    mine.userData.code = s.code;
    mine.userData.bob = 1.3;
    root.add(mine);
  }

  // ---------- camera control ----------
  const cam = { theta: -0.55, phi: 0.95, r: 120, tx: 0, tz: 20, auto: !reduce };
  function frameAll() {
    // distance that fits the whole marina across the view, wider screens need less
    const half = Math.tan((camera.fov * Math.PI) / 360);
    const fitW = (layout.width * 0.62) / (half * Math.max(0.5, Math.min(camera.aspect, 1.8)));
    const fitD = (layout.depth * 0.5) / half;
    cam.r = Math.min(360, Math.max(40, fitW, fitD));
    cam.tx = 0; cam.tz = layout.depth * 0.45;
  }
  function placeCamera() {
    const { theta, phi, r, tx, tz } = cam;
    camera.position.set(tx + r * Math.sin(phi) * Math.sin(theta), r * Math.cos(phi), tz + r * Math.sin(phi) * Math.cos(theta));
    camera.lookAt(tx, 0, tz);
  }
  const ptrs = new Map();
  let start = null, moved = 0, pinch0 = 0, tilt0 = 0;
  canvas.addEventListener('pointerdown', e => {
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    cam.auto = false;
    if (ptrs.size === 1) { start = { x: e.clientX, y: e.clientY, t: cam.theta, p: cam.phi }; moved = 0; if (e.pointerType === 'mouse') canvas.setPointerCapture(e.pointerId); canvas.style.cursor = 'grabbing'; }
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); tilt0 = (a.y + b.y) / 2; start = { ...start, r: cam.r, p: cam.phi }; }
  });
  canvas.addEventListener('pointermove', e => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 1 && start) {
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
      cam.theta = start.t - dx * 0.008;
      if (e.pointerType === 'mouse') cam.phi = Math.min(1.35, Math.max(0.25, start.p - dy * 0.006));
    } else if (ptrs.size === 2 && start) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      cam.r = Math.min(420, Math.max(18, start.r * pinch0 / Math.max(1, d)));
      cam.phi = Math.min(1.35, Math.max(0.25, start.p - ((a.y + b.y) / 2 - tilt0) * 0.006));
      moved = 99;
    }
    wake();
  });
  const up = e => {
    const tap = ptrs.size === 1 && moved < 6;
    ptrs.delete(e.pointerId);
    canvas.style.cursor = 'grab';
    if (tap && e.type === 'pointerup') pick(e);
    if (!ptrs.size) start = null;
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', e => { e.preventDefault(); cam.auto = false; cam.r = Math.min(420, Math.max(18, cam.r * (1 + Math.sign(e.deltaY) * 0.1))); wake(); }, { passive: false });
  canvas.tabIndex = 0;
  canvas.addEventListener('keydown', e => {
    const k = e.key; let used = true;
    if (k === 'ArrowLeft') cam.theta -= 0.12; else if (k === 'ArrowRight') cam.theta += 0.12;
    else if (k === 'ArrowUp') cam.phi = Math.max(0.25, cam.phi - 0.08); else if (k === 'ArrowDown') cam.phi = Math.min(1.35, cam.phi + 0.08);
    else if (k === '+' || k === '=') cam.r = Math.max(18, cam.r * 0.9); else if (k === '-') cam.r = Math.min(420, cam.r * 1.1); else used = false;
    if (used) { e.preventDefault(); cam.auto = false; wake(); }
  });
  const ray = new THREE.Raycaster();
  function pick(e) {
    const r = canvas.getBoundingClientRect();
    const v = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(v, camera);
    const hit = ray.intersectObjects(slots.map(s => s.mesh))[0];
    if (hit) { const s = slots.find(x => x.mesh === hit.object); if (s && opts.onPick) opts.onPick(s.code); }
  }

  // ---------- docking animation ----------
  let dockAnim = null;
  function dock(code) {
    const s = slots.find(r => r.code === code); const y = state.yacht;
    if (!s || !y) return;
    if (mine) { root.remove(mine); disposeTree(mine); }
    mine = yachtModel(y.loa, y.beam, 'solid');
    mine.userData.code = code;
    root.add(mine);
    const far = { x: s.cx + 70, z: s.len + 90 };
    const turn = { x: s.cx, z: s.len + y.loa * 0.9 + 10 };
    dockAnim = { s, t0: performance.now(), dur: reduce ? 1 : 7000, far, turn };
    cam.auto = false;
    cam.tx = s.cx; cam.tz = s.len * 0.7; cam.r = Math.max(60, s.len * 2.6); cam.phi = 0.9;
    wake();
  }
  function stepDock(now) {
    const a = dockAnim; const k = Math.min(1, (now - a.t0) / a.dur); const y = mine;
    const ease = t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
    let x, z, head;
    if (k < 0.55) {            // come in bow first towards the berth
      const t = ease(k / 0.55);
      x = a.far.x + (a.turn.x - a.far.x) * t; z = a.far.z + (a.turn.z - a.far.z) * t;
      head = Math.atan2(a.turn.x - a.far.x, a.turn.z - a.far.z) + Math.PI;   // bow toward travel
    } else if (k < 0.72) {     // spin to put the stern towards the pontoon
      const t = ease((k - 0.55) / 0.17);
      x = a.turn.x; z = a.turn.z;
      const h0 = Math.atan2(a.turn.x - a.far.x, a.turn.z - a.far.z) + Math.PI;
      head = h0 + (0 - h0) * t;
    } else {                   // reverse in, stern-to
      const t = ease((k - 0.72) / 0.28);
      x = a.turn.x; z = a.turn.z + (0.8 - a.turn.z) * t; head = 0;
    }
    y.position.set(x, 0, z); y.rotation.y = head;
    if (k >= 1) { dockAnim = null; if (opts.onDocked) opts.onDocked(a.s.code); }
  }

  // ---------- loop, sizing, visibility ----------
  let raf = 0, visible = true, last = 0, idleUntil = 0;
  function wake() { idleUntil = performance.now() + 4000; if (!raf && visible) raf = requestAnimationFrame(loop); }
  function loop(now) {
    raf = 0;
    const t = now / 1000;
    if (!reduce) {
      for (let i = 0; i < wpos.count; i++) {
        const x = wbase[i * 2], z = wbase[i * 2 + 1];
        wpos.setY(i, Math.sin(x * 0.09 + t * 1.1) * 0.12 + Math.cos(z * 0.11 + t * 0.8) * 0.1);
      }
      wpos.needsUpdate = true;
      root.children.forEach(o => { if (o.userData && o.userData.L && o !== mine) o.position.y = Math.sin(t * 1.3 + (o.userData.bob || 0)) * 0.08; });
      if (mine && !dockAnim) mine.position.y = Math.sin(t * 1.3 + 1.3) * 0.08;
      slots.forEach(s => { if (s.held) s.held.children.forEach(c => { if (c.material) c.material.opacity = 0.3 + 0.25 * (0.5 + 0.5 * Math.sin(t * 3)); }); if (s.warn) s.warn.material.opacity = 0.3 + 0.25 * (0.5 + 0.5 * Math.sin(t * 4)); });
    }
    if (cam.auto) cam.theta += Math.min(0.05, (now - last) / 1000) * 0.06;
    last = now;
    if (dockAnim) stepDock(now);
    placeCamera();
    renderer.render(scene, camera);
    // keep animating while something moves; otherwise idle after a few seconds
    if (visible && (cam.auto || dockAnim || !reduce || now < idleUntil)) raf = requestAnimationFrame(loop);
  }
  function resize() {
    const w = el.clientWidth || 300, h = el.clientHeight || 240;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = w < 520 ? 52 : 42;
    camera.updateProjectionMatrix();
    wake();
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(el); else window.addEventListener('resize', resize);
  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver(es => { visible = es[0].isIntersecting && document.visibilityState === 'visible'; if (visible) wake(); }) : null;
  if (io) io.observe(el);
  const vis = () => { visible = document.visibilityState === 'visible'; if (visible) wake(); };
  document.addEventListener('visibilitychange', vis);
  resize();

  let firstFrame = true;
  return {
    set(next) {
      const prevCodes = (state.berths || []).map(b => b.code).join();
      state = Object.assign({}, state, next);
      build();
      if (firstFrame || prevCodes !== (state.berths || []).map(b => b.code).join()) { frameAll(); firstFrame = false; }
      wake();
    },
    select(code) { state.selected = code; placeMine(); const s = slots.find(r => r.code === code); if (s) { cam.tx += (s.cx - cam.tx) * 0.6; } wake(); },
    dock,
    resetView() { frameAll(); cam.auto = !reduce; wake(); },
    dispose() {
      cancelAnimationFrame(raf); if (ro) ro.disconnect(); if (io) io.disconnect();
      document.removeEventListener('visibilitychange', vis);
      disposeTree(scene); renderer.dispose(); canvas.remove();
    },
  };
}
