/*
  GYT berth plan importer: turn a picture of a marina's berth plan into berths and a 3D marina.

  Shared by the web app (admin › Berth plan) and the GitHub Pages demo, like marina3d.js, so it is
  plain browser JavaScript with no framework and no build step.

  How it works:
    1. The admin loads an image of the berth plan (a drawing, a scan, a screenshot of a CAD plan).
    2. Scale: the plan's real width in metres, or click two points a known distance apart
       (the scale bar is ideal).
    3. Berths are found automatically in the browser: every closed, berth-shaped outline on the plan
       (any angle) becomes a berth. Its pontoon end is the end that touches the pontoon. Optionally an
       AI reads the plan too (berth codes and printed sizes). The admin can fix codes and sizes,
       flip a berth, delete one, or drag on the plan to draw one the detector missed.
    4. The 3D marina is built from it: the plan lies on the water and each berth sits where the
       plan shows it. Saving creates or updates the marina's berths with their position.

  Nothing is saved until the admin presses Save; the AI never saves anything on its own.

  const ui = createBerthPlanImporter(THREE, createMarina3D, element, {
    marinas: [{ id, name }], marinaId,
    sampleUrl,                         // optional: a sample plan to try
    detectAI: async (file) => ({ available, width_m, berths: [{ code, end_x, end_y, tip_x, tip_y, width_frac, length_m, beam_m, depth_m }] }),
    save: async ({ marinaId, file, width_m, height_m, berths }) => ({ message }),
  });
  ui.dispose();
*/

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r1 = v => Math.round(v * 10) / 10;

/* ------------------------------------------------------------------ detection */

/** Otsu threshold on a 256-bin luminance histogram. */
function otsu(hist, total) {
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, t = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; t = i; }
  }
  return t;
}

/**
 * Find berth outlines on a plan. `img` is an ImageData-like {data, width, height}.
 * Returns berths in that image's pixels: { ex, ey (centre of the pontoon end), dx, dy (unit vector
 * from the pontoon end towards the open end), len, wid }.
 */
export function detectBerths(img) {
  const { data, width: W, height: H } = img;
  const N = W * H;
  const lum = new Uint8Array(N); const hist = new Uint32Array(256);
  for (let i = 0; i < N; i++) { const v = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) | 0; lum[i] = v; hist[v]++; }
  const t = otsu(hist, N);
  // ink = lines, pontoons, text. Thicken it by one pixel so hairline gaps in outlines close.
  const ink0 = new Uint8Array(N); for (let i = 0; i < N; i++) ink0[i] = lum[i] <= t ? 1 : 0;
  const ink = new Uint8Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    ink[i] = ink0[i] || (x > 0 && ink0[i - 1]) || (x < W - 1 && ink0[i + 1]) || (y > 0 && ink0[i - W]) || (y < H - 1 && ink0[i + W]) ? 1 : 0;
  }
  // label the open (non-ink) regions; every closed outline is one region
  const lab = new Int32Array(N); const stack = new Int32Array(N);
  const minA = N * 0.00025, maxA = N * 0.1;
  const found = [];
  let next = 0;
  for (let s = 0; s < N; s++) {
    if (ink[s] || lab[s]) continue;
    next++;
    let sp = 0; stack[sp++] = s; lab[s] = next;
    let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, edge = false;
    while (sp) {
      const i = stack[--sp]; const x = i % W, y = (i / W) | 0;
      n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) edge = true;
      if (x > 0 && !ink[i - 1] && !lab[i - 1]) { lab[i - 1] = next; stack[sp++] = i - 1; }
      if (x < W - 1 && !ink[i + 1] && !lab[i + 1]) { lab[i + 1] = next; stack[sp++] = i + 1; }
      if (y > 0 && !ink[i - W] && !lab[i - W]) { lab[i - W] = next; stack[sp++] = i - W; }
      if (y < H - 1 && !ink[i + W] && !lab[i + W]) { lab[i + W] = next; stack[sp++] = i + W; }
    }
    if (edge || n < minA || n > maxA) continue;   // open water and the page border are not berths
    const mx = sx / n, my = sy / n;
    const cxx = sxx / n - mx * mx, cyy = syy / n - my * my, cxy = sxy / n - mx * my;
    const tr = cxx + cyy, det = cxx * cyy - cxy * cxy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const l1 = tr / 2 + disc, l2 = Math.max(1e-6, tr / 2 - disc);
    // a filled rectangle of length L has variance L²/12 along it
    const L = Math.sqrt(12 * l1), Wd = Math.sqrt(12 * l2);
    const fill = n / (L * Wd), aspect = L / Wd;
    if (fill < 0.72 || fill > 1.2 || aspect < 1.5 || aspect > 12 || Wd < 6) continue;
    const ang = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    found.push({ cx: mx, cy: my, ux: Math.cos(ang), uy: Math.sin(ang), len: L + 2.5, wid: Wd + 2.5 });
  }
  // which end is the pontoon? the end with more ink just outside it (a pontoon), not open water
  const inkAt = (x, y) => { x = x | 0; y = y | 0; return x < 0 || y < 0 || x >= W || y >= H ? 0 : ink0[y * W + x]; };
  const density = (b, sgn) => {
    let hits = 0, tot = 0;
    const nx = -b.uy, ny = b.ux;
    for (let d = 3; d <= Math.max(6, b.wid * 0.5); d += 1.5) for (let k = -0.35; k <= 0.35; k += 0.07) {
      const px = b.cx + sgn * b.ux * (b.len / 2 + d) + nx * k * b.wid, py = b.cy + sgn * b.uy * (b.len / 2 + d) + ny * k * b.wid;
      hits += inkAt(px, py); tot++;
    }
    return hits / Math.max(1, tot);
  };
  return found.map(b => {
    const sgn = density(b, -1) >= density(b, 1) ? -1 : 1;   // the pontoon is on the inkier side
    const ex = b.cx + sgn * b.ux * b.len / 2, ey = b.cy + sgn * b.uy * b.len / 2;
    return { ex, ey, dx: -sgn * b.ux, dy: -sgn * b.uy, len: b.len, wid: b.wid };
  });
}

/** Give berths codes by pontoon: berths that share a pontoon line get the same letter, numbered along it. */
export function codeBerths(bs) {
  const groups = [];
  const near = (a, b) => {
    // same pontoon: similar direction, and b's pontoon end lies on a's pontoon line
    if (a.dx * b.dx + a.dy * b.dy < 0.94) return false;
    const off = Math.abs((b.ex - a.ex) * a.dx + (b.ey - a.ey) * a.dy);
    return off < Math.max(a.wid, b.wid) * 0.6;
  };
  bs.forEach(b => { const g = groups.find(g => g.some(o => near(o, b))); if (g) g.push(b); else groups.push([b]); });
  // biggest groups first, then top-to-bottom, left-to-right
  // rows that start at about the same height count as level, then go left to right
  const tol = Math.max(...bs.map(o => o.wid), 1) * 2;
  const top = g => Math.min(...g.map(o => o.ey)), left = g => Math.min(...g.map(o => o.ex));
  groups.sort((a, b) => (Math.abs(top(a) - top(b)) > tol ? top(a) - top(b) : left(a) - left(b)));
  groups.forEach((g, gi) => {
    const nx = -g[0].dy, ny = g[0].dx;
    g.sort((a, b) => (a.ex * nx + a.ey * ny) - (b.ex * nx + b.ey * ny));
    if (Math.abs(nx) >= Math.abs(ny) ? nx < 0 : ny < 0) g.reverse();
    const letter = String.fromCharCode(65 + (gi % 26));
    g.forEach((b, i) => { b.code = b.code || `${letter}${String(i + 1).padStart(2, '0')}`; });
  });
  return bs;
}

/* ------------------------------------------------------------------ importer UI */

const CSS = `
.bp{display:grid;gap:16px;min-width:0}
.bp *{box-sizing:border-box}
.bp [hidden]{display:none!important}
.bp-steps{display:flex;flex-wrap:wrap;gap:10px;align-items:end}
.bp-field{display:grid;gap:4px;font-size:13px;color:var(--muted)}
.bp-field input,.bp-field select{font:inherit;font-size:15px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink);min-width:0;max-width:100%}
.bp-note{font-size:13px;color:var(--muted);margin:0}
.bp-note b{color:var(--ink)}
.bp-msg{font-size:14px;padding:10px 12px;border-radius:8px;background:var(--surface2);border:1px solid var(--line);margin:0}
.bp-msg.ok{background:var(--ok-bg);border-color:transparent;color:var(--ok)}
.bp-msg.err{background:var(--crit-bg);border-color:transparent;color:var(--crit)}
.bp-grid{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:16px;align-items:start}
@media (max-width:900px){.bp-grid{grid-template-columns:minmax(0,1fr)}}
.bp-pane{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--surface);min-width:0}
.bp-pane h4{margin:0;padding:10px 12px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap}
.bp-plan{position:relative;background:var(--surface2);touch-action:none;user-select:none;-webkit-user-select:none}
.bp-plan img{display:block;width:100%;height:auto;pointer-events:none}
.bp-plan svg{position:absolute;inset:0;width:100%;height:100%}
.bp-plan.drawing,.bp-plan.measuring{cursor:crosshair}
.bp-empty{padding:40px 16px;text-align:center;color:var(--muted);font-size:14px}
.bp-3d{height:380px;position:relative}
.bp-3d canvas{border-radius:0}
.bp-tools{display:flex;flex-wrap:wrap;gap:8px}
.bp-tools .btn[aria-pressed="true"]{outline:2px solid var(--accent);outline-offset:1px}
.bp-table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:12px;background:var(--surface)}
.bp-table{width:100%;border-collapse:collapse;font-size:14px;min-width:620px}
.bp-table th{text-align:left;font-weight:600;font-size:12px;color:var(--muted);padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
.bp-table td{padding:6px 10px;border-bottom:1px solid var(--line)}
.bp-table tr:last-child td{border-bottom:0}
.bp-table tr.sel td{background:var(--surface2)}
.bp-table input{font:inherit;width:84px;padding:5px 7px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink)}
.bp-table input.code{width:76px;font-family:var(--mono,monospace)}
.bp-table .act{white-space:nowrap;text-align:right}
.bp-table .act button{font:inherit;font-size:13px;border:0;background:none;color:var(--accent);cursor:pointer;padding:4px 6px}
.bp-table .act button.del{color:var(--crit)}
.bp-meas{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 12px;border-top:1px solid var(--line);font-size:14px}
.bp-meas input{width:90px;font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink)}
.bp-foot{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between}
@media (max-width:760px){.bp-3d{height:320px}.bp-field input,.bp-field select{font-size:16px}}
`;

export function createBerthPlanImporter(THREE, createMarina3D, el, opts = {}) {
  if (!document.getElementById('bp-css')) { const st = document.createElement('style'); st.id = 'bp-css'; st.textContent = CSS; document.head.appendChild(st); }
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const S = {
    marinaId: opts.marinaId || (opts.marinas && opts.marinas[0] && opts.marinas[0].id) || '',
    file: null, url: null, natW: 0, natH: 0,
    widthM: 160, berths: [], sel: null, mode: null, measure: [], depth: 4, rate: 500, msg: null, busy: false, yachts: true,
  };
  let uid = 0;
  const mpp = () => (S.natW ? S.widthM / S.natW : 0.1);
  el.innerHTML = `
  <div class="bp">
    <div class="bp-steps">
      <label class="bp-field">Marina<select data-k="marina">${(opts.marinas || []).map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</select></label>
      <label class="bp-field">Berth plan image<input type="file" accept="image/png,image/jpeg,image/webp" data-k="file"></label>
      ${opts.sampleUrl ? '<button type="button" class="btn" data-a="sample">Use the sample plan</button>' : ''}
      <label class="bp-field">Plan width (m)<input type="number" min="5" max="3000" step="0.5" data-k="width" value="${S.widthM}"></label>
      <button type="button" class="btn" data-a="measure" aria-pressed="false">Measure the scale</button>
      <label class="bp-field">Depth for new berths (m)<input type="number" min="0.5" max="40" step="0.1" data-k="depth" value="${S.depth}"></label>
      <label class="bp-field">Rate for new berths ($/day)<input type="number" min="0" step="10" data-k="rate" value="${S.rate}"></label>
    </div>
    <p class="bp-note" data-k="scale"></p>
    <div class="bp-grid">
      <div class="bp-pane">
        <h4><span>Plan</span><span class="bp-tools">
          <button type="button" class="btn sm" data-a="detect">Find berths</button>
          ${opts.detectAI ? '<button type="button" class="btn sm" data-a="ai">Read with AI</button>' : ''}
          <button type="button" class="btn sm" data-a="draw" aria-pressed="false">Draw a berth</button>
          <button type="button" class="btn sm" data-a="flipall">Flip all</button>
        </span></h4>
        <div class="bp-plan" data-k="plan"><div class="bp-empty">Load a berth plan image to start: a drawing, a scan or a screenshot of the marina's berth plan.</div></div>
        <div class="bp-meas" data-k="meas" hidden>These two points are <input type="number" min="0.5" step="0.5" value="20" data-k="measM"> m apart. <button type="button" class="btn sm primary" data-a="measok">Set scale</button> <button type="button" class="btn sm" data-a="meascancel">Cancel</button></div>
      </div>
      <div class="bp-pane">
        <h4><span>3D marina from this plan</span><span class="bp-tools"><label class="bp-note" style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-k="yachts" checked> Sample yachts</label><span data-k="count"></span></span></h4>
        <div class="bp-3d" data-k="three"><div class="bp-empty">The 3D marina appears here once berths are found.</div></div>
      </div>
    </div>
    <p class="bp-msg" data-k="msg" hidden></p>
    <div class="bp-table-wrap" data-k="tablewrap" hidden><table class="bp-table"><thead><tr><th>Code</th><th>Max length (m)</th><th>Max beam (m)</th><th>Depth (m)</th><th>Rate ($/day)</th><th></th></tr></thead><tbody data-k="rows"></tbody></table></div>
    <div class="bp-foot">
      <p class="bp-note">Berth codes and sizes come from the plan; check them before saving. Saving adds new berths and updates the size and position of berths with the same code. It never removes a berth.</p>
      <button type="button" class="btn primary" data-a="save" disabled>Save berths to marina</button>
    </div>
  </div>`;
  const q = k => el.querySelector(`[data-k="${k}"]`);
  const btn = a => el.querySelector(`[data-a="${a}"]`);
  if (S.marinaId) q('marina').value = S.marinaId;

  // ---------- messages ----------
  function say(text, kind = '') { const m = q('msg'); m.hidden = !text; m.textContent = text || ''; m.className = 'bp-msg' + (kind ? ' ' + kind : ''); }

  // ---------- the plan image + overlay ----------
  let svg = null;
  function loadImage(file, url) {
    S.file = file; if (S.url && S.url.startsWith('blob:') && S.url !== url) URL.revokeObjectURL(S.url);
    S.url = url || URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      S.natW = img.naturalWidth; S.natH = img.naturalHeight; S.berths = []; S.sel = null;
      const box = q('plan'); box.innerHTML = ''; box.appendChild(img);
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', `0 0 ${S.natW} ${S.natH}`); svg.setAttribute('preserveAspectRatio', 'none');
      box.appendChild(svg);
      bindPlan(box);
      say('Plan loaded. Set its scale, then press Find berths.');
      detect();
    };
    img.onerror = () => say('That file could not be read as an image. Use a PNG, JPEG or WebP.', 'err');
    img.src = S.url;
  }
  const corners = b => {
    const nx = -b.dy, ny = b.dx, w = b.wid / 2;
    const fx = b.ex + b.dx * b.len, fy = b.ey + b.dy * b.len;
    return [[b.ex + nx * w, b.ey + ny * w], [fx + nx * w, fy + ny * w], [fx - nx * w, fy - ny * w], [b.ex - nx * w, b.ey - ny * w]];
  };
  function drawOverlay() {
    if (!svg) return;
    const sw = Math.max(1.5, S.natW / 500);
    const parts = S.berths.map(b => {
      const c = corners(b), sel = b.id === S.sel;
      const fs = clamp(Math.min(b.wid * 0.5, b.len * 0.22), S.natW / 120, S.natW / 40);
      const mx = b.ex + b.dx * b.len * 0.5, my = b.ey + b.dy * b.len * 0.5;
      return `<g data-id="${b.id}" style="cursor:pointer">
        <polygon points="${c.map(p => p.join(',')).join(' ')}" fill="${sel ? 'rgba(20,163,166,.38)' : 'rgba(46,158,106,.22)'}" stroke="${sel ? '#0b6e73' : '#2e9e6a'}" stroke-width="${sw}"/>
        <line x1="${c[0][0]}" y1="${c[0][1]}" x2="${c[3][0]}" y2="${c[3][1]}" stroke="#d6a12e" stroke-width="${sw * 2.6}" stroke-linecap="round"/>
        <text x="${mx}" y="${my}" font-size="${fs}" font-weight="700" text-anchor="middle" dominant-baseline="middle" fill="#0b3b40" stroke="#fff" stroke-width="${fs * 0.22}" paint-order="stroke" style="font-family:system-ui,sans-serif">${esc(b.code)}</text></g>`;
    });
    if (S.measure.length) {
      const [a, b] = S.measure;
      parts.push(`<circle cx="${a[0]}" cy="${a[1]}" r="${sw * 3}" fill="#d9433b"/>`);
      if (b) parts.push(`<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="#d9433b" stroke-width="${sw * 1.6}" stroke-dasharray="${sw * 4} ${sw * 3}"/><circle cx="${b[0]}" cy="${b[1]}" r="${sw * 3}" fill="#d9433b"/>`);
    }
    if (drag && drag.rect) { const r = drag.rect; parts.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="rgba(20,163,166,.25)" stroke="#0b6e73" stroke-width="${sw}" stroke-dasharray="${sw * 3} ${sw * 2}"/>`); }
    svg.innerHTML = parts.join('');
  }
  let drag = null;
  function toPlan(e) {
    const r = svg.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * S.natW, ((e.clientY - r.top) / r.height) * S.natH];
  }
  function bindPlan(box) {
    box.addEventListener('pointerdown', e => {
      if (!svg) return;
      const p = toPlan(e);
      if (S.mode === 'measure') {
        if (S.measure.length >= 2) S.measure = [];
        S.measure.push(p); if (S.measure.length === 2) { q('meas').hidden = false; q('measM').focus({ preventScroll: true }); }
        drawOverlay(); return;
      }
      if (S.mode === 'draw') { drag = { p0: p, rect: null }; try { box.setPointerCapture(e.pointerId); } catch (_) { } e.preventDefault(); return; }
      const g = e.target.closest && e.target.closest('g[data-id]');
      if (g) { S.sel = +g.dataset.id; drawOverlay(); renderRows(); sync3d(); }
    });
    box.addEventListener('pointermove', e => {
      if (!drag) return; const p = toPlan(e);
      drag.rect = { x: Math.min(p[0], drag.p0[0]), y: Math.min(p[1], drag.p0[1]), w: Math.abs(p[0] - drag.p0[0]), h: Math.abs(p[1] - drag.p0[1]) };
      drawOverlay();
    });
    const end = () => {
      if (!drag) return; const r = drag.rect, p0 = drag.p0; drag = null;
      if (r && r.w > 4 && r.h > 4) {
        // the longer side is the berth's length; the pontoon end is the end you started dragging from
        const vertical = r.h >= r.w;
        const startNear = vertical ? (p0[1] - r.y < r.h / 2) : (p0[0] - r.x < r.w / 2);
        let b;
        if (vertical) b = { ex: r.x + r.w / 2, ey: startNear ? r.y : r.y + r.h, dx: 0, dy: startNear ? 1 : -1, len: r.h, wid: r.w };
        else b = { ex: startNear ? r.x : r.x + r.w, ey: r.y + r.h / 2, dx: startNear ? 1 : -1, dy: 0, len: r.w, wid: r.h };
        addBerths([b]);
        S.sel = S.berths[S.berths.length - 1].id;
        say(`Berth ${S.berths[S.berths.length - 1].code} added. Rename it in the table if the plan gives it another code.`);
      }
      drawOverlay(); renderAll();
    };
    box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
  }

  // ---------- berths ----------
  function addBerths(list) {
    const taken = new Set(S.berths.map(b => b.code));
    let n = S.berths.length + 1;
    list.forEach(b => {
      let code = (b.code || '').toString().trim().toUpperCase().slice(0, 20);
      if (!code || taken.has(code)) { do { code = `N${String(n++).padStart(2, '0')}`; } while (taken.has(code)); }
      taken.add(code);
      S.berths.push({ id: ++uid, code, ex: b.ex, ey: b.ey, dx: b.dx, dy: b.dy, len: b.len, wid: b.wid, depth: b.depth || S.depth, rate: b.rate != null ? b.rate : S.rate });
    });
  }
  function analyse() {
    // analyse at up to 1400 px across: plenty for a plan, fast on a phone
    const img = q('plan').querySelector('img'); if (!img) return null;
    const k = Math.min(1, 1400 / S.natW), w = Math.round(S.natW * k), h = Math.round(S.natH * k);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true }); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0, w, h);
    return { k, data: g.getImageData(0, 0, w, h) };
  }
  function detect() {
    const a = analyse(); if (!a) { say('Load a plan image first.', 'err'); return; }
    const raw = detectBerths(a.data).map(b => ({ ex: b.ex / a.k, ey: b.ey / a.k, dx: b.dx, dy: b.dy, len: b.len / a.k, wid: b.wid / a.k }));
    codeBerths(raw);
    raw.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
    S.berths = []; S.sel = null; addBerths(raw);
    say(raw.length
      ? `Found ${raw.length} berths on the plan. The gold edge marks each berth's pontoon end; use Flip if one is the wrong way round.`
      : 'No berth outlines found. Draw berths by dragging on the plan, or try a clearer image of the plan.', raw.length ? 'ok' : 'err');
    renderAll();
  }
  async function readAI() {
    if (!S.file) { say('Load a plan image first.', 'err'); return; }
    S.busy = true; btn('ai').disabled = true; say('Reading the plan with AI…');
    try {
      const out = await opts.detectAI(S.file);
      if (!out || !out.available) { say(out && out.error ? `AI is not available: ${out.error}` : 'AI is not set up on this server, so the in-browser detector is used instead.', 'err'); return; }
      if (out.width_m && out.width_m > 5) { S.widthM = r1(out.width_m); q('width').value = S.widthM; }
      const list = (out.berths || []).map(b => {
        const ex = b.end_x * S.natW, ey = b.end_y * S.natH, tx = b.tip_x * S.natW, ty = b.tip_y * S.natH;
        const len = Math.hypot(tx - ex, ty - ey) || 1;
        return { code: b.code, ex, ey, dx: (tx - ex) / len, dy: (ty - ey) / len, len, wid: Math.max(2, b.width_frac * S.natW), depth: b.depth_m };
      }).filter(b => b.len > 2);
      // where the AI read printed sizes, they win over the drawing
      S.berths = []; S.sel = null; addBerths(list);
      (out.berths || []).forEach((b, i) => { const t = S.berths[i]; if (!t) return; if (b.length_m > 2) t.len = b.length_m / mpp(); if (b.beam_m > 1) t.wid = (b.beam_m + 0.6) / mpp(); });
      say(`AI read ${S.berths.length} berths${out.width_m ? ` and a plan width of ${r1(out.width_m)} m` : ''}. Check codes and sizes before saving.`, 'ok');
      renderAll();
    } catch (e) { say('AI read failed: ' + (e && e.message ? e.message : e), 'err'); }
    finally { S.busy = false; btn('ai').disabled = false; }
  }

  // ---------- table ----------
  const lenM = b => r1(b.len * mpp());
  const beamM = b => Math.max(1.5, r1(b.wid * mpp() - 0.6));   // allow 0.3 m of fendering each side
  function renderRows() {
    q('tablewrap').hidden = !S.berths.length;
    q('rows').innerHTML = S.berths.map(b => `<tr data-id="${b.id}" class="${b.id === S.sel ? 'sel' : ''}">
      <td><input class="code" data-f="code" value="${esc(b.code)}" maxlength="20" aria-label="Berth code"></td>
      <td><input type="number" step="0.1" min="3" data-f="len" value="${lenM(b)}" aria-label="Max length for ${esc(b.code)}"></td>
      <td><input type="number" step="0.1" min="1" data-f="beam" value="${beamM(b)}" aria-label="Max beam for ${esc(b.code)}"></td>
      <td><input type="number" step="0.1" min="0.5" data-f="depth" value="${b.depth}" aria-label="Depth for ${esc(b.code)}"></td>
      <td><input type="number" step="10" min="0" data-f="rate" value="${b.rate}" aria-label="Rate for ${esc(b.code)}"></td>
      <td class="act"><button type="button" data-r="flip">Flip</button><button type="button" class="del" data-r="del">Delete</button></td></tr>`).join('');
  }
  q('rows').addEventListener('change', e => {
    const tr = e.target.closest('tr'); const b = S.berths.find(x => x.id === +tr.dataset.id); if (!b) return;
    const f = e.target.dataset.f, v = e.target.value;
    if (f === 'code') {
      const c = v.trim().toUpperCase().slice(0, 20);
      if (!c || S.berths.some(x => x !== b && x.code === c)) { say(c ? `Code ${c} is already used on this plan.` : 'A berth needs a code.', 'err'); e.target.value = b.code; return; }
      b.code = c; e.target.value = c;
    } else {
      const n = parseFloat(v); if (!isFinite(n) || n <= 0) { renderRows(); return; }
      if (f === 'len') b.len = n / mpp(); else if (f === 'beam') b.wid = (n + 0.6) / mpp(); else if (f === 'depth') b.depth = n; else if (f === 'rate') b.rate = n;
    }
    drawOverlay(); sync3d();
  });
  q('rows').addEventListener('click', e => {
    const tr = e.target.closest('tr'); if (!tr) return; const id = +tr.dataset.id; const b = S.berths.find(x => x.id === id); if (!b) return;
    const r = e.target.dataset && e.target.dataset.r;
    if (r === 'flip') flip(b);
    else if (r === 'del') { S.berths = S.berths.filter(x => x !== b); if (S.sel === id) S.sel = null; say(`Berth ${b.code} removed from the plan.`); }
    else if (e.target.tagName !== 'INPUT' || S.sel !== id) { S.sel = id; }
    else return;
    renderAll();
  });
  function flip(b) { b.ex += b.dx * b.len; b.ey += b.dy * b.len; b.dx = -b.dx; b.dy = -b.dy; }

  // ---------- 3D ----------
  let m3 = null, t3 = 0;
  function scene() {
    const k = mpp(), W = S.natW * k, H = S.natH * k;
    return {
      plan: { image: S.url, width: W, height: H },
      // sample yachts in two berths out of three, so the preview looks like a working marina
      berths: S.berths.map((b, i) => ({ code: b.code, loa: lenM(b), beam: beamM(b), depth: b.depth,
        state: b.id === S.sel ? 'held_by_you' : S.yachts && i % 3 !== 1 ? 'booked' : 'available',
        moored: S.yachts && i % 3 !== 1 && b.id !== S.sel ? { loa: r1(lenM(b) * 0.86), beam: r1(beamM(b) * 0.88) } : null,
        at: { x: r1(b.ex * k - W / 2), z: r1(b.ey * k - H / 2), rot: Math.round(Math.atan2(b.dx, b.dy) * 1e4) / 1e4 } })),
      yacht: null, selected: null,
    };
  }
  function sync3d() {
    clearTimeout(t3);
    t3 = setTimeout(() => {
      if (!S.url) return;
      const box = q('three');
      if (!m3) {
        if (!THREE || !createMarina3D) { box.innerHTML = '<div class="bp-empty">The 3D view could not load on this device.</div>'; return; }
        box.innerHTML = '';
        try { m3 = createMarina3D(THREE, box, { onPick(code) { const b = S.berths.find(x => x.code === code); if (b) { S.sel = b.id; drawOverlay(); renderRows(); } } }); }
        catch (e) { box.innerHTML = '<div class="bp-empty">3D needs WebGL, which this browser has turned off.</div>'; return; }
      }
      m3.set(scene());
    }, 120);
  }

  // ---------- the rest ----------
  function renderScale() {
    q('scale').innerHTML = S.natW
      ? `Scale: <b>1 px = ${(mpp() * 100).toFixed(1)} cm</b> · the plan covers <b>${r1(S.widthM)} × ${r1(S.natH * mpp())} m</b>. For an exact scale, press <b>Measure the scale</b> and click both ends of the plan's scale bar.`
      : '';
  }
  function renderAll() {
    renderScale(); drawOverlay(); renderRows(); sync3d();
    q('count').textContent = S.berths.length ? `${S.berths.length} berths` : '';
    btn('save').disabled = !S.berths.length || !S.marinaId;
  }
  function setMode(m) {
    S.mode = S.mode === m ? null : m;
    btn('draw').setAttribute('aria-pressed', String(S.mode === 'draw'));
    btn('measure').setAttribute('aria-pressed', String(S.mode === 'measure'));
    const box = q('plan'); box.classList.toggle('drawing', S.mode === 'draw'); box.classList.toggle('measuring', S.mode === 'measure');
    if (S.mode !== 'measure') { S.measure = []; q('meas').hidden = true; }
    if (S.mode === 'measure') say('Click two points on the plan a known distance apart, such as the two ends of its scale bar.');
    if (S.mode === 'draw') say('Drag across the plan from the pontoon end of the berth to its open end.');
    drawOverlay();
  }
  el.addEventListener('click', async e => {
    const a = e.target.closest('[data-a]'); if (!a) return;
    const act = a.dataset.a;
    if (act === 'sample') {
      try { const r = await fetch(opts.sampleUrl); const bl = await r.blob(); const f = new File([bl], 'sample-berth-plan.png', { type: bl.type || 'image/png' }); S.widthM = 160; q('width').value = 160; loadImage(f); }
      catch (_) { say('The sample plan could not be loaded.', 'err'); }
    } else if (act === 'detect') detect();
    else if (act === 'ai') readAI();
    else if (act === 'draw') { if (!S.url) return say('Load a plan image first.', 'err'); setMode('draw'); }
    else if (act === 'measure') { if (!S.url) return say('Load a plan image first.', 'err'); setMode('measure'); }
    else if (act === 'meascancel') setMode(null);
    else if (act === 'measok') {
      const [p, r] = S.measure; const m = parseFloat(q('measM').value);
      if (!p || !r || !(m > 0)) return;
      const px = Math.hypot(r[0] - p[0], r[1] - p[1]); if (px < 3) return say('Those points are too close together.', 'err');
      S.widthM = r1(m * S.natW / px); q('width').value = S.widthM;
      setMode(null); say(`Scale set: ${m} m is ${Math.round(px)} px on the plan, so the plan is ${S.widthM} m wide.`, 'ok'); renderAll();
    } else if (act === 'flipall') { S.berths.forEach(flip); renderAll(); }
    else if (act === 'save') {
      if (!S.berths.length) return;
      a.disabled = true; say('Saving…');
      try {
        const k = mpp(), W = S.natW * k, H = S.natH * k;
        const sc = scene();
        const out = await opts.save({
          marinaId: S.marinaId, file: S.file, imageUrl: S.url, width_m: r1(W), height_m: r1(H),
          berths: S.berths.map((b, i) => ({ code: b.code, max_loa_m: lenM(b), max_beam_m: beamM(b), max_draft_m: r1(b.depth), rate_usd_day: b.rate, ...sc.berths[i].at })),
        });
        say((out && out.message) || 'Saved.', 'ok');
      } catch (err) { say('Could not save: ' + (err && err.message ? err.message : err), 'err'); }
      finally { a.disabled = false; }
    }
  });
  el.addEventListener('change', e => {
    const k = e.target.dataset && e.target.dataset.k;
    if (k === 'file' && e.target.files && e.target.files[0]) {
      const f = e.target.files[0];
      if (!/^image\/(png|jpeg|webp)$/.test(f.type)) return say('Use a PNG, JPEG or WebP image of the plan.', 'err');
      if (f.size > 8 * 1024 * 1024) return say('That image is over 8 MB. Export the plan at a smaller size.', 'err');
      loadImage(f);
    } else if (k === 'width') { const v = parseFloat(e.target.value); if (v > 0) { S.widthM = v; renderAll(); } }
    else if (k === 'depth') { const v = parseFloat(e.target.value); if (v > 0) S.depth = v; }
    else if (k === 'rate') { const v = parseFloat(e.target.value); if (v >= 0) S.rate = v; }
    else if (k === 'marina') { S.marinaId = e.target.value; renderAll(); }
    else if (k === 'yachts') { S.yachts = e.target.checked; sync3d(); }
  });
  renderAll();
  return {
    /** For guided tours and tests. */
    state: () => S,
    loadSample: () => btn('sample') && btn('sample').click(),
    dispose() { clearTimeout(t3); if (m3) m3.dispose(); if (S.url && S.url.startsWith('blob:')) URL.revokeObjectURL(S.url); el.innerHTML = ''; },
  };
}
