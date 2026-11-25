(() => {
  // Świat ma stały rozmiar WORLD x WORLD jednostek. Widok (view) to to, co aktualnie widać na ekranie:
  // przesunięcie + powiększenie. Kreski i zdjęcia są zapisane we współrzędnych świata,
  // więc u obojga wyglądają tak samo.
  const WORLD = 12000, PAPER = "#fffdf8", OUTSIDE = "#0f0f12", MAXK = 8;
  const COLORS = ["#1b1b1f", "#e63946", "#f4a261", "#f2cc3a", "#2a9d5c", "#2f80ed", "#8e5cf5", "#ff7eb6"];
  const MAX_POINTS = 6000; // dłuższe kreski dzielimy na kawałki
  const IMG_MAX_SIDE = 1600, IMG_MAX_BYTES = 1_400_000;

  const $ = (id) => document.getElementById(id);
  const cv = $("c");
  const ctx = cv.getContext("2d");
  const layer = document.createElement("canvas"); // warstwa na kreski (gumka ściera tylko je, nie zdjęcia)
  const lctx = layer.getContext("2d");
  const stage = $("stage");
  const dot = $("dot");
  const who = $("who");
  const join = $("join");
  const roomInput = $("roomInput");
  const sizeEl = $("size");
  const eraserBtn = $("eraser");
  const handBtn = $("hand");
  const selBtn = $("sel");
  const imgbar = $("imgbar");

  const me = Math.random().toString(36).slice(2, 8);
  const strokes = new Map(); // id -> {id,u,c,s,e,p:[[x,y],...]}
  const images = new Map();  // id -> {id,x,y,w,h}
  const imgEls = new Map();  // id -> HTMLImageElement
  const tool = { color: COLORS[0], eraser: false, pan: false, sel: false, pick: false };
  let room = "";
  const selStrokes = new Set(), selImgs = new Set(); // zaznaczone kreski i zdjęcia (po id)
  let marquee = null;      // prostokąt zaznaczania w trakcie przeciągania
  let xfd = null;          // trwające przesuwanie / skalowanie zaznaczenia
  let remoteXf = null;     // przekształcenie wykonywane na żywo przez drugą osobę
  const undoStack = [];    // moje akcje do cofnięcia: kreska albo przekształcenie
  let ws = null, retry = 0, pingTimer = 0, online = 1;
  const outbox = [];

  // ---------- widok ----------
  let cssW = 1, cssH = 1, dpr = 1, minK = 0.05, viewReady = false;
  const view = { x: 0, y: 0, k: 1 };

  let raf = 0;
  function sched() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; redraw(); });
  }

  function setT(c) {
    c.setTransform(dpr * view.k, 0, 0, dpr * view.k, -view.x * view.k * dpr, -view.y * view.k * dpr);
  }

  function clampView() {
    view.k = Math.min(MAXK, Math.max(minK, view.k));
    const vw = cssW / view.k, vh = cssH / view.k;
    view.x = Math.min(WORLD - vw * 0.2, Math.max(-vw * 0.8, view.x));
    view.y = Math.min(WORLD - vh * 0.2, Math.max(-vh * 0.8, view.y));
  }

  function centerOn(wx, wy, k) {
    view.k = k;
    view.x = wx - cssW / (2 * view.k);
    view.y = wy - cssH / (2 * view.k);
    clampView();
    sched();
  }

  function initView() {
    centerOn(WORLD / 2, WORLD / 2, Math.min(MAXK, Math.max(minK, cssW / 1200)));
  }

  function zoomAt(sx, sy, f) {
    const wx = view.x + sx / view.k, wy = view.y + sy / view.k;
    view.k = Math.min(MAXK, Math.max(minK, view.k * f));
    view.x = wx - sx / view.k;
    view.y = wy - sy / view.k;
    clampView();
    sched();
  }

  function fitAll() {
    const b = allBox();
    if (!b) return initView();
    const pad = 80;
    const bw = b[2] - b[0] + pad * 2, bh = b[3] - b[1] + pad * 2;
    centerOn((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, Math.min(2, cssW / bw, cssH / bh));
  }

  function resize() {
    const r = stage.getBoundingClientRect();
    cssW = Math.max(1, Math.floor(r.width));
    cssH = Math.max(1, Math.floor(r.height));
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
    cv.style.width = cssW + "px";
    cv.style.height = cssH + "px";
    minK = (Math.min(cssW, cssH) / WORLD) * 0.9;
    if (!viewReady) { viewReady = true; initView(); }
    clampView();
    redraw();
  }

  // ---------- rysowanie ----------
  const boxes = new WeakMap();
  function box(st) {
    const n = st.p.length;
    if (!n) return null;
    const c = boxes.get(st);
    if (c && c.n === n) return c.b;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const q of st.p) {
      if (q[0] < x0) x0 = q[0];
      if (q[0] > x1) x1 = q[0];
      if (q[1] < y0) y0 = q[1];
      if (q[1] > y1) y1 = q[1];
    }
    const h = st.s / 2 + 1;
    const b = [x0 - h, y0 - h, x1 + h, y1 + h];
    boxes.set(st, { n, b });
    return b;
  }

  function allBox() {
    let r = null;
    const add = (b) => { r = r ? [Math.min(r[0], b[0]), Math.min(r[1], b[1]), Math.max(r[2], b[2]), Math.max(r[3], b[3])] : b.slice(); };
    for (const st of strokes.values()) { const b = box(st); if (b) add(b); }
    for (const m of images.values()) add([m.x, m.y, m.x + m.w, m.y + m.h]);
    return r;
  }

  function draw(c, st, from) {
    const p = st.p;
    if (!p.length) return;
    c.globalCompositeOperation = st.e ? "destination-out" : "source-over";
    c.lineCap = c.lineJoin = "round";
    c.strokeStyle = c.fillStyle = st.e ? "#000" : st.c;
    c.lineWidth = st.s;
    if (p.length === 1) {
      c.beginPath();
      c.arc(p[0][0], p[0][1], st.s / 2, 0, Math.PI * 2);
      c.fill();
    } else {
      const i0 = Math.max(0, from - 1);
      c.beginPath();
      c.moveTo(p[i0][0], p[i0][1]);
      for (let i = i0 + 1; i < p.length; i++) c.lineTo(p[i][0], p[i][1]);
      c.stroke();
    }
    c.globalCompositeOperation = "source-over";
  }

  // Kreska rysowana na żywo prosto na ekranie (gumka wymaga warstwy, więc ona idzie przez pełny redraw).
  function drawLive(st, from) {
    if (st.e) return sched();
    setT(ctx);
    draw(ctx, st, from);
  }

  function getImg(m) {
    let el = imgEls.get(m.id);
    if (!el) {
      el = new Image();
      el.onload = sched;
      el.onerror = () => setTimeout(() => { if (imgEls.get(m.id) === el) { imgEls.delete(m.id); sched(); } }, 3000);
      el.src = "/img?room=" + encodeURIComponent(room) + "&id=" + encodeURIComponent(m.id);
      imgEls.set(m.id, el);
    }
    return el;
  }

  const sortedImages = () => [...images.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  function drawImages(c) {
    for (const m of sortedImages()) {
      const el = getImg(m);
      if (el.complete && el.naturalWidth) c.drawImage(el, m.x, m.y, m.w, m.h);
    }
  }

  function drawStrokes(c, x0, y0, x1, y1) {
    for (const st of strokes.values()) {
      const b = box(st);
      if (!b || b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1) continue;
      draw(c, st, 0);
    }
  }

  function redraw() {
    if (layer.width !== cv.width || layer.height !== cv.height) { layer.width = cv.width; layer.height = cv.height; }
    const x0 = view.x, y0 = view.y, x1 = view.x + cssW / view.k, y1 = view.y + cssH / view.k;

    // 1) kreski na przezroczystej warstwie
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.clearRect(0, 0, layer.width, layer.height);
    setT(lctx);
    drawStrokes(lctx, x0, y0, x1, y1);

    // 2) tło i zdjęcia
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = OUTSIDE;
    ctx.fillRect(0, 0, cv.width, cv.height);
    setT(ctx);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, WORLD, WORLD);
    ctx.clip();
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, WORLD, WORLD);
    drawImages(ctx);

    // 3) kreski na wierzchu (w granicach płótna)
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(layer, 0, 0);
    ctx.restore();

    // 4) ramka zaznaczenia z uchwytami w rogach i prostokąt zaznaczania
    const sb = tool.sel ? selBox() : null;
    if (sb || (marquee && marquee.moved)) {
      setT(ctx);
      const k = view.k;
      if (sb) {
        ctx.lineWidth = 2 / k;
        ctx.strokeStyle = "#7c9cff";
        ctx.setLineDash([8 / k, 6 / k]);
        ctx.strokeRect(sb[0], sb[1], sb[2] - sb[0], sb[3] - sb[1]);
        ctx.setLineDash([]);
        for (const [hx, hy] of [[sb[0], sb[1]], [sb[2], sb[1]], [sb[2], sb[3]], [sb[0], sb[3]]]) {
          ctx.beginPath();
          ctx.arc(hx, hy, 12 / k, 0, Math.PI * 2);
          ctx.fillStyle = "#7c9cff";
          ctx.fill();
          ctx.lineWidth = 3 / k;
          ctx.strokeStyle = "#fff";
          ctx.stroke();
        }
      }
      if (marquee && marquee.moved) {
        const mx = Math.min(marquee.x0, marquee.x1), my = Math.min(marquee.y0, marquee.y1);
        const mw = Math.abs(marquee.x1 - marquee.x0), mh = Math.abs(marquee.y1 - marquee.y0);
        ctx.fillStyle = "rgba(124,156,255,0.16)";
        ctx.fillRect(mx, my, mw, mh);
        ctx.lineWidth = 2 / k;
        ctx.strokeStyle = "#7c9cff";
        ctx.setLineDash([8 / k, 6 / k]);
        ctx.strokeRect(mx, my, mw, mh);
        ctx.setLineDash([]);
      }
    }
  }

  // ---------- zaznaczanie, przesuwanie i skalowanie ----------
  const r1 = (v) => Math.round(v * 10) / 10;
  const connected = () => !!(ws && ws.readyState === 1);

  // Ramka zaznaczenia: otoczka widocznych kresek (bez gumki) i zdjęć. null = nic nie zaznaczono.
  function selBox() {
    let r = null;
    const add = (b) => { r = r ? [Math.min(r[0], b[0]), Math.min(r[1], b[1]), Math.max(r[2], b[2]), Math.max(r[3], b[3])] : b.slice(); };
    for (const id of selStrokes) {
      const st = strokes.get(id);
      if (!st || st.e) continue;
      const b = box(st);
      if (b) add(b);
    }
    for (const id of selImgs) {
      const m = images.get(id);
      if (m) add([m.x, m.y, m.x + m.w, m.y + m.h]);
    }
    return r;
  }
  const hasSel = () => selBox() !== null;

  function updateSelUI() {
    const has = tool.sel && hasSel();
    imgbar.classList.toggle("hidden", !has);
    let txt = "";
    if (tool.pick) txt = "Dotknij płótna, żeby pobrać kolor";
    else if (tool.sel && !has && !marquee && !xfd) txt = "Przeciągnij, żeby zaznaczyć obszar";
    $("hint").classList.toggle("hidden", !txt);
    if (txt) $("hinttxt").textContent = txt;
    $("hintx").classList.toggle("hidden", !tool.pick);
  }

  function setSelection(ids, iids) {
    selStrokes.clear(); selImgs.clear();
    for (const i of ids) selStrokes.add(i);
    for (const i of iids) selImgs.add(i);
    if (!hasSel()) { selStrokes.clear(); selImgs.clear(); } // same kreski gumki nie tworzą zaznaczenia
    updateSelUI();
    sched();
  }
  const clearSelection = () => setSelection([], []);

  // Po usunięciu czegoś (przez którąkolwiek osobę) wyrzuć z zaznaczenia to, czego już nie ma.
  function pruneSel() {
    for (const id of [...selStrokes]) if (!strokes.has(id)) selStrokes.delete(id);
    for (const id of [...selImgs]) if (!images.has(id)) selImgs.delete(id);
    if (!hasSel()) { selStrokes.clear(); selImgs.clear(); }
    updateSelUI();
  }

  function distSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  // Najwyżej leżąca kreska (bez gumki) pod palcem, z tolerancją ok. 12 px ekranu.
  function hitStroke(X, Y) {
    const tol = 12 / view.k;
    const list = [...strokes.values()];
    for (let i = list.length - 1; i >= 0; i--) {
      const st = list[i];
      if (st.e) continue;
      const b = box(st);
      if (!b) continue;
      const t = tol + st.s / 2;
      if (X < b[0] - t || X > b[2] + t || Y < b[1] - t || Y > b[3] + t) continue;
      const p = st.p;
      if (p.length === 1) { if (Math.hypot(X - p[0][0], Y - p[0][1]) <= t) return st; continue; }
      for (let j = 1; j < p.length; j++) {
        if (distSeg(X, Y, p[j - 1][0], p[j - 1][1], p[j][0], p[j][1]) <= t) return st;
      }
    }
    return null;
  }

  function hitObject(X, Y) {
    const s = hitStroke(X, Y);
    if (s) return { kind: "s", id: s.id };
    const m = hitImage(X, Y);
    return m ? { kind: "i", id: m.id } : null;
  }

  // Zaznaczenie prostokątem: bierzemy całe obiekty, których co najmniej połowa leży w prostokącie.
  function selectArea(x0, y0, x1, y1) {
    const ids = [], iids = [];
    for (const st of strokes.values()) {
      const p = st.p;
      if (!p.length) continue;
      const b = box(st);
      if (b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1) continue;
      let inside = 0;
      for (const q of p) if (q[0] >= x0 && q[0] <= x1 && q[1] >= y0 && q[1] <= y1) inside++;
      if (inside * 2 >= p.length) ids.push(st.id);
    }
    for (const m of images.values()) {
      const ow = Math.min(x1, m.x + m.w) - Math.max(x0, m.x);
      const oh = Math.min(y1, m.y + m.h) - Math.max(y0, m.y);
      if (ow > 0 && oh > 0 && (ow * oh) / (m.w * m.h) >= 0.5) iids.push(m.id);
    }
    setSelection(ids, iids);
  }

  // Przekształcenie x' = (x - ax) * k + ax + dx. Ten sam wzór i zaokrąglanie jest na serwerze (worker.js).
  function snapshotSel(ids, iids) {
    const s = new Map(), im = new Map();
    for (const id of ids) { const st = strokes.get(id); if (st) s.set(id, { p: st.p, s: st.s }); }
    for (const id of iids) { const m = images.get(id); if (m) im.set(id, { x: m.x, y: m.y, w: m.w, h: m.h }); }
    return { s, im };
  }

  function applySnap(base, x) {
    for (const [id, b] of base.s) {
      const st = strokes.get(id);
      if (!st) continue;
      st.p = b.p.map((q) => [r1((q[0] - x.ax) * x.k + x.ax + x.dx), r1((q[1] - x.ay) * x.k + x.ay + x.dy)]);
      st.s = Math.max(1, r1(b.s * x.k));
      boxes.delete(st);
    }
    for (const [id, b] of base.im) {
      const m = images.get(id);
      if (!m) continue;
      m.x = r1((b.x - x.ax) * x.k + x.ax + x.dx);
      m.y = r1((b.y - x.ay) * x.k + x.ay + x.dy);
      m.w = Math.max(1, r1(b.w * x.k));
      m.h = Math.max(1, r1(b.h * x.k));
    }
    sched();
  }

  function restoreSnap(base) {
    for (const [id, b] of base.s) {
      const st = strokes.get(id);
      if (st) { st.p = b.p; st.s = b.s; boxes.delete(st); }
    }
    for (const [id, b] of base.im) {
      const m = images.get(id);
      if (m) { m.x = b.x; m.y = b.y; m.w = b.w; m.h = b.h; }
    }
    sched();
  }

  // Największe skalowanie względem punktu (ax,ay), przy którym ramka nadal mieści się w płótnie.
  function maxScale(b, ax, ay) {
    let kmax = Infinity;
    for (const [lo, hi, a] of [[b[0], b[2], ax], [b[1], b[3], ay]]) {
      if (hi > a) kmax = Math.min(kmax, (WORLD - a) / (hi - a));
      if (lo < a) kmax = Math.min(kmax, a / (a - lo));
    }
    return Math.max(kmax, 1);
  }

  const rawK = (X, Y) => ((X - xfd.ax) * xfd.vx + (Y - xfd.ay) * xfd.vy) / (xfd.vx * xfd.vx + xfd.vy * xfd.vy);

  function startXf(mode, corner, pid, p) {
    if (!connected()) return false; // zmiany idą od razu na serwer, więc bez połączenia ich nie robimy
    const b = selBox();
    if (!b) return false;
    const ids = [...selStrokes].filter((i) => strokes.has(i));
    const iids = [...selImgs].filter((i) => images.has(i));
    if (ids.length > 6000) { alert("Zaznaczenie jest za duże (ponad 6000 kresek). Zaznacz mniejszy obszar."); return false; }
    xfd = { g: newId(), mode, corner, pid, b, ids, iids, base: snapshotSel(ids, iids),
      ox: wx(p.x), oy: wy(p.y), ax: 0, ay: 0, vx: 1, vy: 1, k: 1, dx: 0, dy: 0, k0: 1, sentStart: false, lastMv: 0 };
    if (mode === "scale") {
      const pts = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];
      const a = pts[(corner + 2) % 4], h = pts[corner];
      xfd.ax = a[0]; xfd.ay = a[1]; xfd.vx = h[0] - a[0]; xfd.vy = h[1] - a[1];
      xfd.k0 = rawK(wx(p.x), wy(p.y)) || 1; // żeby chwycenie uchwytu nie powodowało skoku
    }
    updateSelUI();
    return true;
  }

  function moveXf(p) {
    const X = wx(p.x), Y = wy(p.y), b = xfd.b;
    if (xfd.mode === "move") {
      xfd.dx = r1(Math.min(WORLD - b[2], Math.max(-b[0], X - xfd.ox)));
      xfd.dy = r1(Math.min(WORLD - b[3], Math.max(-b[1], Y - xfd.oy)));
      xfd.k = 1;
    } else {
      const size = Math.max(b[2] - b[0], b[3] - b[1]);
      let k = rawK(X, Y) / xfd.k0;
      k = Math.max(Math.max(0.02, 12 / size), k);
      k = Math.min(maxScale(b, xfd.ax, xfd.ay), k);
      xfd.k = k; xfd.dx = 0; xfd.dy = 0;
    }
    applySnap(xfd.base, xfd);
    const now = performance.now();
    if (now - xfd.lastMv > 60) {
      xfd.lastMv = now;
      const m = { t: "xfmv", g: xfd.g, k: xfd.k, ax: xfd.ax, ay: xfd.ay, dx: xfd.dx, dy: xfd.dy };
      if (!xfd.sentStart) { m.ids = xfd.ids; m.iids = xfd.iids; xfd.sentStart = true; } // listę id wysyłamy tylko raz
      send(m);
    }
  }

  function endXf() {
    const x = xfd;
    xfd = null;
    if (!x) return;
    if (x.k === 1 && x.dx === 0 && x.dy === 0) { restoreSnap(x.base); updateSelUI(); return; }
    if (!connected()) { restoreSnap(x.base); updateSelUI(); return; } // połączenie zniknęło w trakcie: cofnij lokalnie
    const msg = { g: x.g, ids: x.ids, iids: x.iids, k: x.k, ax: x.ax, ay: x.ay, dx: x.dx, dy: x.dy };
    send({ t: "xf", ...msg });
    undoStack.push({ kind: "x", ...msg });
    if (undoStack.length > 100) undoStack.shift();
    updateSelUI();
  }

  function hitImage(wx, wy) {
    const list = sortedImages();
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (wx >= m.x && wx <= m.x + m.w && wy >= m.y && wy <= m.y + m.h) return m;
    }
    return null;
  }

  // Wczytuje zdjęcie, zmniejsza (długi bok max 1600 px) i zamienia na JPEG, żeby było lekkie.
  async function prepareImage(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      let w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) throw new Error("pusty obraz");
      let scale = Math.min(1, IMG_MAX_SIDE / Math.max(w, h));
      let q = 0.85;
      for (let i = 0; i < 6; i++) {
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(w * scale));
        c.height = Math.max(1, Math.round(h * scale));
        const g = c.getContext("2d");
        g.fillStyle = "#fff";
        g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, 0, 0, c.width, c.height);
        const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", q));
        if (blob && blob.size <= IMG_MAX_BYTES) return { blob, w: c.width, h: c.height };
        q = Math.max(0.5, q - 0.1);
        scale *= 0.85;
      }
      throw new Error("zdjęcie za duże");
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function addPhoto(file) {
    if (!room) { alert("Najpierw wpisz kod pokoju"); return; }
    let prep;
    try { prep = await prepareImage(file); }
    catch (err) { alert("Nie udało się wczytać zdjęcia: " + (err && err.message ? err.message : err)); return; }

    const id = newId();
    try {
      const res = await fetch("/img?room=" + encodeURIComponent(room) + "&id=" + encodeURIComponent(id), { method: "POST", body: prep.blob });
      if (!res.ok) throw new Error("serwer odpowiedział " + res.status);
    } catch (err) {
      alert("Nie udało się wysłać zdjęcia (czy jest internet?). " + (err && err.message ? err.message : ""));
      return;
    }

    // Rozmiar na płótnie: ok. 60% szerokości widoku, środek widoku.
    const vw = cssW / view.k, vh = cssH / view.k;
    let w = Math.min(vw * 0.6, vh * 0.6 * (prep.w / prep.h));
    w = Math.max(60, Math.min(w, WORLD));
    const h = (w * prep.h) / prep.w;
    const m = { id, x: Math.round(view.x + vw / 2 - w / 2), y: Math.round(view.y + vh / 2 - h / 2), w: Math.round(w), h: Math.round(h) };

    const el = new Image(); // dla siebie używamy lokalnej kopii, bez ponownego pobierania
    el.onload = sched;
    el.src = URL.createObjectURL(prep.blob);
    imgEls.set(id, el);
    images.set(id, m);
    queue({ t: "imgset", img: m });
    tool.sel = true; tool.pan = false; tool.eraser = false;
    setMode();
    setSelection([], [id]);
  }

  $("photo").onclick = () => $("imgFile").click();
  $("imgFile").onchange = (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (f) addPhoto(f);
  };

  // "Usuń zaznaczone": kreski i zdjęcia naraz.
  $("imgdel").onclick = () => {
    if (!hasSel()) return;
    if (!connected()) { alert("Brak połączenia z serwerem, spróbuj za chwilę."); return; }
    const ids = [...selStrokes].filter((i) => strokes.has(i));
    const iids = [...selImgs].filter((i) => images.has(i));
    if (ids.length > 6000) { alert("Zaznaczenie jest za duże (ponad 6000 kresek). Usuń je w kilku częściach."); return; }
    for (const i of ids) strokes.delete(i);
    for (const i of iids) { images.delete(i); imgEls.delete(i); }
    clearSelection();
    send({ t: "xdel", ids, iids });
  };

  // ---------- wskaźniki: rysowanie, przesuwanie, pinch ----------
  const ptrs = new Map(); // pointerId -> {x,y} w px ekranu
  let cur = null, curPid = null, pending = [], flushTimer = 0;
  let gesture = null, panning = null;

  const newId = () => Date.now().toString().padStart(15, "0") + "-" + me + Math.random().toString(36).slice(2, 5);
  const ser = (st) => ({ id: st.id, u: st.u, c: st.c, s: st.s, e: st.e, p: st.p });
  const meta = (st) => ({ id: st.id, u: st.u, c: st.c, s: st.s, e: st.e });
  const clamp = (v) => Math.round(Math.min(WORLD, Math.max(0, v)) * 10) / 10;

  const wx = (sx) => view.x + sx / view.k;
  const wy = (sy) => view.y + sy / view.k;
  function toWorld(sx, sy) { return [clamp(wx(sx)), clamp(wy(sy))]; }

  function flush() {
    if (!cur || !pending.length) return;
    send({ t: "pts", ...meta(cur), p: pending });
    pending = [];
  }

  function startStroke(pt, pid) {
    cur = { id: newId(), u: me, c: tool.color, s: +sizeEl.value, e: tool.eraser, p: [pt] };
    curPid = pid;
    strokes.set(cur.id, cur);
    drawLive(cur, 0);
    pending = [pt];
    flushTimer = setInterval(flush, 60);
  }

  function finishStroke() {
    if (!cur) return;
    clearInterval(flushTimer);
    flush();
    queue({ t: "end", stroke: ser(cur) });
    undoStack.push({ kind: "s", id: cur.id });
    if (undoStack.length > 100) undoStack.shift();
    cur = null; curPid = null; pending = [];
  }

  // Drugi palec = to był pinch, nie rysowanie: wycofaj kropkę, którą zaczął pierwszy palec.
  function cancelStroke() {
    if (!cur) return;
    clearInterval(flushTimer);
    const id = cur.id;
    strokes.delete(id);
    cur = null; curPid = null; pending = [];
    send({ t: "undo", id });
    sched();
  }

  function pinchState() {
    const [a, b] = [...ptrs.values()];
    return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
  }

  function local(e) {
    const r = cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  cv.addEventListener("pointerdown", (e) => {
    cv.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, local(e));
    if (ptrs.size === 2) {
      cancelStroke();
      endXf();
      marquee = null;
      updateSelUI();
      panning = null;
      gesture = pinchState();
      return;
    }
    if (ptrs.size > 2) return;
    const p = ptrs.get(e.pointerId);

    if (tool.pick) { pickColorAt(p.x, p.y); return; }

    if (tool.pan || e.button === 1 || e.button === 2) {
      panning = { id: e.pointerId, x: p.x, y: p.y };
      return;
    }

    if (tool.sel) {
      const X = wx(p.x), Y = wy(p.y), b = selBox();
      if (b) {
        // uchwyt w rogu ramki = skalowanie, wnętrze ramki = przesuwanie
        const pts = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];
        for (let i = 0; i < 4; i++) {
          const hx = (pts[i][0] - view.x) * view.k, hy = (pts[i][1] - view.y) * view.k;
          if (Math.hypot(p.x - hx, p.y - hy) < 30) { startXf("scale", i, e.pointerId, p); return; }
        }
        if (X >= b[0] && X <= b[2] && Y >= b[1] && Y <= b[3]) { startXf("move", -1, e.pointerId, p); return; }
      }
      // dotknięcie kreski albo zdjęcia zaznacza je i od razu można nim przesuwać
      const hit = hitObject(X, Y);
      if (hit) {
        setSelection(hit.kind === "s" ? [hit.id] : [], hit.kind === "i" ? [hit.id] : []);
        startXf("move", -1, e.pointerId, p);
        return;
      }
      // puste miejsce: zaznaczanie prostokątem (samo stuknięcie czyści zaznaczenie)
      clearSelection();
      marquee = { pid: e.pointerId, sx: p.x, sy: p.y, x0: X, y0: Y, x1: X, y1: Y, moved: false };
      updateSelUI();
      return;
    }

    startStroke(toWorld(p.x, p.y), e.pointerId);
  });

  cv.addEventListener("pointermove", (e) => {
    if (!ptrs.has(e.pointerId)) return;

    if (ptrs.size === 2) {
      ptrs.set(e.pointerId, local(e));
      if (!gesture) return;
      const s = pinchState();
      zoomAt(gesture.cx, gesture.cy, s.d / gesture.d);
      view.x -= (s.cx - gesture.cx) / view.k;
      view.y -= (s.cy - gesture.cy) / view.k;
      clampView();
      sched();
      gesture = s;
      return;
    }

    if (xfd && xfd.pid === e.pointerId) {
      moveXf(local(e));
      return;
    }

    if (marquee && marquee.pid === e.pointerId) {
      const p = local(e);
      marquee.x1 = wx(p.x);
      marquee.y1 = wy(p.y);
      if (Math.hypot(p.x - marquee.sx, p.y - marquee.sy) > 6) { marquee.moved = true; updateSelUI(); }
      sched();
      return;
    }

    if (panning && panning.id === e.pointerId) {
      const p = local(e);
      view.x -= (p.x - panning.x) / view.k;
      view.y -= (p.y - panning.y) / view.k;
      panning.x = p.x; panning.y = p.y;
      clampView();
      sched();
      return;
    }

    if (cur && curPid === e.pointerId) {
      const r = cv.getBoundingClientRect();
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      const from = cur.p.length;
      for (const ev of evs.length ? evs : [e]) {
        const pt = toWorld(ev.clientX - r.left, ev.clientY - r.top);
        const last = cur.p[cur.p.length - 1];
        if (pt[0] === last[0] && pt[1] === last[1]) continue;
        cur.p.push(pt);
        pending.push(pt);
      }
      if (cur.p.length > from) drawLive(cur, from);
      if (cur.p.length >= MAX_POINTS) {
        const last = cur.p[cur.p.length - 1], pid = curPid;
        finishStroke();
        startStroke(last, pid);
      }
    }
  });

  function pointerEnd(e) {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.delete(e.pointerId);
    if (cur && curPid === e.pointerId) finishStroke();
    if (xfd && xfd.pid === e.pointerId) endXf();
    if (marquee && marquee.pid === e.pointerId) {
      const mq = marquee;
      marquee = null;
      if (mq.moved) selectArea(Math.min(mq.x0, mq.x1), Math.min(mq.y0, mq.y1), Math.max(mq.x0, mq.x1), Math.max(mq.y0, mq.y1));
      updateSelUI();
      sched();
    }
    if (panning && panning.id === e.pointerId) panning = null;
    if (ptrs.size < 2) gesture = null;
  }
  cv.addEventListener("pointerup", pointerEnd);
  cv.addEventListener("pointercancel", pointerEnd);
  cv.addEventListener("contextmenu", (e) => e.preventDefault());

  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)));
  }, { passive: false });

  // iOS Safari: nie pozwól stronie robić własnego powiększania
  for (const ev of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(ev, (e) => e.preventDefault());
  }

  // ---------- narzędzia ----------
  const colorsEl = $("colors");
  function setMode() {
    if (!tool.sel) { selStrokes.clear(); selImgs.clear(); marquee = null; }
    handBtn.classList.toggle("sel", tool.pan);
    selBtn.classList.toggle("sel", tool.sel && !tool.pan);
    eraserBtn.classList.toggle("sel", tool.eraser && !tool.pan && !tool.sel);
    cv.style.cursor = tool.pan ? "grab" : tool.sel ? "default" : "crosshair";
    const drawing = !tool.pan && !tool.sel && !tool.eraser && !tool.pick;
    const isPreset = COLORS.includes(tool.color);
    colorsEl.querySelectorAll(".sw").forEach((x) =>
      x.classList.toggle("sel", drawing && (x === pickBtn ? !isPreset : x.dataset.c === tool.color)));
    pickBtn.style.setProperty("--cur", tool.color);
    updateSelUI();
    sched();
  }

  COLORS.forEach((c) => {
    const b = document.createElement("button");
    b.className = "sw";
    b.dataset.c = c;
    b.style.background = c;
    b.setAttribute("aria-label", "Kolor " + c);
    b.onclick = () => setColor(c, true);
    colorsEl.appendChild(b);
  });

  // Ostatni przycisk w rzędzie: tęczowe kółko pokazujące aktualny kolor, otwiera pełny wybór koloru.
  const pickBtn = document.createElement("button");
  pickBtn.className = "sw pickbtn";
  pickBtn.setAttribute("aria-label", "Więcej kolorów");
  pickBtn.onclick = () => openPicker();
  colorsEl.appendChild(pickBtn);

  eraserBtn.onclick = () => { tool.eraser = !(tool.eraser && !tool.pan && !tool.sel); tool.pan = false; tool.sel = false; setMode(); };
  handBtn.onclick = () => { tool.pan = !tool.pan; if (tool.pan) tool.sel = false; setMode(); };
  selBtn.onclick = () => { tool.sel = !tool.sel; tool.pan = false; if (tool.sel) tool.eraser = false; setMode(); };

  // ---------- wybór koloru ----------
  const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const rgb2hex = (r, g, b) => "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
  function hsv2rgb(h, s, v) {
    const f = (n, k = (n + h / 60) % 6) => v - v * s * Math.max(Math.min(k, 4 - k, 1), 0);
    return [f(5) * 255, f(3) * 255, f(1) * 255];
  }
  function rgb2hsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return [h, mx ? d / mx : 0, mx];
  }
  function hsl2hex(h, s, l) {
    s /= 100; l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    return rgb2hex(f(0) * 255, f(8) * 255, f(4) * 255);
  }
  const c01 = (v) => Math.min(1, Math.max(0, v));
  const HEX_RE = /^#[0-9a-f]{6}$/;
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

  // Paleta: rząd odcieni szarości + 5 odcieni jasności dla 9 kolorów.
  const PALETTE = [
    ...[100, 85, 70, 55, 40, 25, 15, 8, 0].map((l) => hsl2hex(0, 0, l)),
    ...[85, 70, 55, 42, 28].flatMap((l) => [0, 25, 48, 90, 150, 190, 225, 270, 320].map((h) => hsl2hex(h, 78, l))),
  ];

  const picker = $("picker"), psv = $("psv"), psvH = $("psvh"), phue = $("phue"), phueH = $("phueh");
  const phex = $("phex"), pprev = $("pprev");
  let hsv = [0, 0, 0], recent = [];
  try { recent = JSON.parse(lsGet("recent") || "[]").filter((c) => HEX_RE.test(c)).slice(0, 9); } catch {}

  function updatePickerUI(skipHex) {
    psv.style.background =
      `linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, hsl(${hsv[0]}, 100%, 50%))`;
    psvH.style.left = hsv[1] * 100 + "%";
    psvH.style.top = (1 - hsv[2]) * 100 + "%";
    psvH.style.background = tool.color;
    phueH.style.left = (hsv[0] / 360) * 100 + "%";
    phueH.style.background = `hsl(${hsv[0]}, 100%, 50%)`;
    pprev.style.background = tool.color;
    if (!skipHex) phex.value = tool.color;
    picker.querySelectorAll(".cell").forEach((x) => x.classList.toggle("sel", x.dataset.c === tool.color));
  }

  // Ustawia aktualny kolor pisaka i zapamiętuje go. syncHsv=false przy przeciąganiu po polu koloru,
  // żeby odcień nie "skakał" przy szarościach i czerni.
  function setColor(hex, syncHsv, skipHex) {
    hex = hex.toLowerCase();
    if (!HEX_RE.test(hex)) return;
    tool.color = hex;
    tool.eraser = tool.pan = tool.sel = tool.pick = false;
    if (syncHsv) hsv = rgb2hsv(...hex2rgb(hex));
    lsSet("color", hex);
    setMode();
    updatePickerUI(skipHex);
  }

  function addRecent(hex) {
    if (COLORS.includes(hex)) return;
    recent = [hex, ...recent.filter((c) => c !== hex)].slice(0, 9);
    lsSet("recent", JSON.stringify(recent));
    renderGrids();
  }

  function renderGrid(el, list) {
    el.textContent = "";
    for (const c of list) {
      const b = document.createElement("button");
      b.className = "cell";
      b.dataset.c = c;
      b.style.background = c;
      b.setAttribute("aria-label", "Kolor " + c);
      b.onclick = () => setColor(c, true);
      el.appendChild(b);
    }
  }
  function renderGrids() {
    renderGrid($("precent"), recent);
    renderGrid($("ppal"), PALETTE);
    updatePickerUI(true);
  }

  function openPicker() {
    hsv = rgb2hsv(...hex2rgb(tool.color));
    picker.classList.remove("hidden");
    updatePickerUI();
  }
  function closePicker() {
    picker.classList.add("hidden");
    addRecent(tool.color);
  }

  function dragArea(el, fn) {
    let on = false;
    el.addEventListener("pointerdown", (e) => { on = true; el.setPointerCapture(e.pointerId); fn(e); });
    el.addEventListener("pointermove", (e) => { if (on) fn(e); });
    const end = () => { on = false; };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }
  dragArea(psv, (e) => {
    const r = psv.getBoundingClientRect();
    hsv[1] = c01((e.clientX - r.left) / r.width);
    hsv[2] = 1 - c01((e.clientY - r.top) / r.height);
    setColor(rgb2hex(...hsv2rgb(...hsv)), false);
  });
  dragArea(phue, (e) => {
    const r = phue.getBoundingClientRect();
    hsv[0] = Math.min(359.99, c01((e.clientX - r.left) / r.width) * 360);
    setColor(rgb2hex(...hsv2rgb(...hsv)), false);
  });

  phex.addEventListener("input", () => {
    let v = phex.value.trim().toLowerCase();
    if (v && v[0] !== "#") v = "#" + v;
    if (/^#[0-9a-f]{3}$/.test(v)) v = "#" + [...v.slice(1)].map((x) => x + x).join("");
    if (HEX_RE.test(v)) setColor(v, true, true);
  });
  $("pdone").onclick = closePicker;
  picker.addEventListener("pointerdown", (e) => { if (e.target === picker) closePicker(); });

  // Pipeta: kolor z dowolnego miejsca płótna (kreska, tło, zdjęcie), dokładnie taki, jaki widzisz.
  $("peye").onclick = () => {
    picker.classList.add("hidden");
    tool.pick = true;
    tool.eraser = tool.pan = tool.sel = false;
    setMode();
  };
  $("hintx").onclick = () => { tool.pick = false; setMode(); };

  function pickColorAt(sx, sy) {
    const x = wx(sx), y = wy(sy);
    if (x < 0 || y < 0 || x > WORLD || y > WORLD) return; // poza płótnem: czekaj na dotknięcie w środku
    if (raf) { cancelAnimationFrame(raf); raf = 0; redraw(); } // upewnij się, że obraz jest aktualny
    const d = ctx.getImageData(Math.round(sx * dpr), Math.round(sy * dpr), 1, 1).data;
    setColor(rgb2hex(d[0], d[1], d[2]), true);
    addRecent(tool.color);
  }

  // Cofnij: ostatnia moja akcja, czyli narysowana kreska (znika) albo przesunięcie/skalowanie (wraca).
  $("undo").onclick = () => {
    while (undoStack.length) {
      const a = undoStack.pop();
      if (a.kind === "s") {
        if (!strokes.has(a.id)) continue; // już usunięta przez kogoś
        strokes.delete(a.id);
        pruneSel();
        sched();
        queue({ t: "undo", id: a.id });
        return;
      }
      const ids = a.ids.filter((i) => strokes.has(i)), iids = a.iids.filter((i) => images.has(i));
      if (!ids.length && !iids.length) continue;
      if (!connected()) { undoStack.push(a); alert("Brak połączenia z serwerem, spróbuj za chwilę."); return; }
      // odwrotność przekształcenia x' = (x - ax) * k + ax + dx
      const inv = { g: newId(), k: 1 / a.k, ax: a.ax, ay: a.ay, dx: -a.dx / a.k, dy: -a.dy / a.k };
      applySnap(snapshotSel(ids, iids), inv);
      send({ t: "xf", ...inv, ids, iids });
      updateSelUI();
      return;
    }
  };

  $("clear").onclick = () => {
    if (!confirm("Wyczyścić całe płótno (rysunek i zdjęcia) dla Was obojga?")) return;
    strokes.clear();
    images.clear();
    imgEls.clear();
    undoStack.length = 0;
    clearSelection();
    queue({ t: "clear" });
  };

  $("zin").onclick = () => zoomAt(cssW / 2, cssH / 2, 1.5);
  $("zout").onclick = () => zoomAt(cssW / 2, cssH / 2, 1 / 1.5);
  $("zfit").onclick = fitAll;

  $("save").onclick = () => {
    let b = allBox();
    if (!b) { alert("Płótno jest puste"); return; }
    const pad = 40;
    b = [Math.max(0, b[0] - pad), Math.max(0, b[1] - pad), Math.min(WORLD, b[2] + pad), Math.min(WORLD, b[3] + pad)];
    const w = b[2] - b[0], h = b[3] - b[1];
    const sc = Math.min(2, 4096 / Math.max(w, h));
    const W = Math.max(1, Math.ceil(w * sc)), H = Math.max(1, Math.ceil(h * sc));
    const oc = document.createElement("canvas");
    oc.width = W; oc.height = H;
    const c = oc.getContext("2d");
    c.fillStyle = PAPER;
    c.fillRect(0, 0, W, H);
    c.setTransform(sc, 0, 0, sc, -b[0] * sc, -b[1] * sc);
    drawImages(c);
    const lc = document.createElement("canvas");
    lc.width = W; lc.height = H;
    const l = lc.getContext("2d");
    l.setTransform(sc, 0, 0, sc, -b[0] * sc, -b[1] * sc);
    for (const st of strokes.values()) draw(l, st, 0);
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(lc, 0, 0);
    oc.toBlob(async (blob) => {
      if (!blob) return;
      const file = new File([blob], "plotno.png", { type: "image/png" });
      try {
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file] });
          return;
        }
      } catch (err) {
        if (err && err.name === "AbortError") return;
      }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "plotno.png";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }, "image/png");
  };

  // ---------- sieć ----------
  function setStatus() {
    const open = ws && ws.readyState === 1;
    dot.classList.toggle("on", !!open);
    who.textContent = !room ? "wpisz kod" : !open ? "łączenie…" : online > 1 ? "jesteście razem" : "tylko Ty";
  }

  function send(m) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(m));
  }

  // Zmiany trwałe (end/undo/clear/imgset/imgdel) czekają w kolejce, jeśli nie ma połączenia.
  function queue(m) {
    if (ws && ws.readyState === 1) send(m);
    else outbox.push(m);
  }

  function handle(m) {
    switch (m.t) {
      case "init": {
        const keep = new Set(outbox.filter((o) => o.t === "end").map((o) => o.stroke.id));
        const localS = [...strokes.values()].filter((s) => keep.has(s.id));
        const localI = outbox.filter((o) => o.t === "imgset").map((o) => o.img);
        const delI = outbox.filter((o) => o.t === "imgdel").map((o) => o.id);
        const live = cur;
        strokes.clear();
        for (const s of m.strokes) strokes.set(s.id, s);
        for (const s of localS) strokes.set(s.id, s);
        if (live) strokes.set(live.id, live);
        images.clear();
        for (const im of m.images || []) images.set(im.id, im);
        for (const im of localI) images.set(im.id, im);
        for (const id of delI) { images.delete(id); imgEls.delete(id); }
        for (const id of [...imgEls.keys()]) if (!images.has(id)) imgEls.delete(id);
        remoteXf = null;
        pruneSel();
        while (outbox.length) send(outbox.shift());
        sched();
        break;
      }
      case "pts": {
        let st = strokes.get(m.id);
        if (!st) {
          st = { id: m.id, u: m.u, c: m.c, s: m.s, e: m.e, p: [] };
          strokes.set(m.id, st);
        }
        const from = st.p.length;
        st.p.push(...m.p);
        drawLive(st, from);
        break;
      }
      case "undo":
        strokes.delete(m.id);
        pruneSel();
        sched();
        break;
      case "imgset":
        images.set(m.img.id, m.img);
        sched();
        break;
      case "imgmv":
        images.set(m.img.id, m.img);
        sched();
        break;
      case "imgdel":
        images.delete(m.id);
        imgEls.delete(m.id);
        pruneSel();
        sched();
        break;
      case "xfmv":
      case "xf": {
        // Druga osoba przesuwa/skaluje zaznaczenie: liczymy od stanu z początku jej gestu, tym samym wzorem co serwer.
        let r = remoteXf;
        if (!r || r.g !== m.g) {
          if (m.t === "xfmv" && !m.ids && !m.iids) break; // przegapiliśmy początek gestu
          const ids = m.ids || [], iids = m.iids || [];
          r = remoteXf = { g: m.g, base: snapshotSel(ids, iids) };
        }
        applySnap(r.base, m);
        if (m.t === "xf") remoteXf = null;
        break;
      }
      case "xdel":
        for (const id of m.ids || []) strokes.delete(id);
        for (const id of m.iids || []) { images.delete(id); imgEls.delete(id); }
        pruneSel();
        sched();
        break;
      case "clear":
        strokes.clear();
        images.clear();
        imgEls.clear();
        undoStack.length = 0;
        clearSelection();
        break;
      case "presence":
        online = m.n;
        setStatus();
        break;
    }
  }

  function connect() {
    if (!room) return;
    clearTimeout(retry);
    if (ws) { ws.onclose = ws.onmessage = ws.onopen = null; try { ws.close(); } catch {} }
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(room)}`);
    ws.onopen = () => {
      setStatus();
      clearInterval(pingTimer);
      pingTimer = setInterval(() => { if (ws.readyState === 1) ws.send("ping"); }, 25000);
    };
    ws.onmessage = (e) => {
      if (e.data === "pong") return;
      try { handle(JSON.parse(e.data)); } catch {}
    };
    ws.onclose = () => {
      online = 1;
      setStatus();
      clearInterval(pingTimer);
      retry = setTimeout(connect, 1500);
    };
    setStatus();
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && room && (!ws || ws.readyState > 1)) connect();
  });
  window.addEventListener("online", () => room && connect());

  // ---------- kod pokoju ----------
  function openJoin() {
    roomInput.value = room;
    join.classList.remove("hidden");
    setTimeout(() => roomInput.focus(), 50);
  }
  function setRoom(r) {
    r = r.trim();
    if (!r) return;
    const changed = r !== room;
    room = r;
    try { localStorage.setItem("room", room); } catch {}
    join.classList.add("hidden");
    if (changed) { strokes.clear(); images.clear(); imgEls.clear(); outbox.length = 0; undoStack.length = 0; clearSelection(); }
    connect();
  }

  $("roomBtn").onclick = openJoin;
  $("closeJoin").onclick = () => room && join.classList.add("hidden");
  $("joinForm").onsubmit = (e) => { e.preventDefault(); setRoom(roomInput.value); };
  $("shareBtn").onclick = async () => {
    const code = roomInput.value.trim() || room;
    if (!code) return;
    const link = location.origin + "/#" + encodeURIComponent(code);
    try {
      if (navigator.share) { await navigator.share({ title: "Wspólne płótno", text: "Rysujemy razem:", url: link }); return; }
    } catch (err) { if (err && err.name === "AbortError") return; }
    try { await navigator.clipboard.writeText(link); alert("Skopiowano link"); } catch { prompt("Skopiuj link:", link); }
  };

  // ---------- start ----------
  const savedColor = (lsGet("color") || "").toLowerCase();
  if (HEX_RE.test(savedColor)) tool.color = savedColor;
  hsv = rgb2hsv(...hex2rgb(tool.color));
  renderGrids();
  setMode();
  resize();
  new ResizeObserver(resize).observe(stage);
  let saved = "";
  try { saved = localStorage.getItem("room") || ""; } catch {}
  const fromHash = decodeURIComponent(location.hash.slice(1));
  if (fromHash) { history.replaceState(null, "", location.pathname); setRoom(fromHash); }
  else if (saved) setRoom(saved);
  else openJoin();

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
})();
