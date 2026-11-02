(() => {
  // Świat ma stały rozmiar WORLD x WORLD jednostek. Widok (view) to to, co aktualnie widać na ekranie:
  // przesunięcie + powiększenie. Kreski i zdjęcia są zapisane we współrzędnych świata,
  // więc u obojga wyglądają tak samo.
  const WORLD = 10000, PAPER = "#fffdf8", OUTSIDE = "#0f0f12", MAXK = 8;
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
  const tool = { color: COLORS[0], eraser: false, pan: false, sel: false };
  let room = "", selected = null;
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

    // 4) ramka zaznaczonego zdjęcia
    const m = selected && tool.sel ? images.get(selected) : null;
    if (m) {
      setT(ctx);
      const k = view.k;
      ctx.lineWidth = 2 / k;
      ctx.strokeStyle = "#7c9cff";
      ctx.setLineDash([8 / k, 6 / k]);
      ctx.strokeRect(m.x, m.y, m.w, m.h);
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(m.x + m.w, m.y + m.h, 14 / k, 0, Math.PI * 2);
      ctx.fillStyle = "#7c9cff";
      ctx.fill();
      ctx.lineWidth = 3 / k;
      ctx.strokeStyle = "#fff";
      ctx.stroke();
    }
  }

  // ---------- zdjęcia ----------
  function select(id) {
    selected = id && images.has(id) ? id : null;
    imgbar.classList.toggle("hidden", !selected || !tool.sel);
    sched();
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
    select(id);
  }

  $("photo").onclick = () => $("imgFile").click();
  $("imgFile").onchange = (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (f) addPhoto(f);
  };

  $("imgdel").onclick = () => {
    if (!selected) return;
    const id = selected;
    images.delete(id);
    imgEls.delete(id);
    select(null);
    queue({ t: "imgdel", id });
  };

  // ---------- wskaźniki: rysowanie, przesuwanie, pinch ----------
  const ptrs = new Map(); // pointerId -> {x,y} w px ekranu
  let cur = null, curPid = null, pending = [], flushTimer = 0;
  let gesture = null, panning = null, drag = null, lastMv = 0;

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

  function endDrag() {
    if (!drag) return;
    const m = images.get(drag.id);
    drag = null;
    if (m) queue({ t: "imgset", img: m });
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
      endDrag();
      panning = null;
      gesture = pinchState();
      return;
    }
    if (ptrs.size > 2) return;
    const p = ptrs.get(e.pointerId);

    if (tool.pan || e.button === 1 || e.button === 2) {
      panning = { id: e.pointerId, x: p.x, y: p.y };
      return;
    }

    if (tool.sel) {
      const cur0 = selected && images.get(selected);
      if (cur0) { // uchwyt zmiany rozmiaru w prawym dolnym rogu
        const hx = (cur0.x + cur0.w - view.x) * view.k, hy = (cur0.y + cur0.h - view.y) * view.k;
        if (Math.hypot(p.x - hx, p.y - hy) < 32) {
          drag = { mode: "resize", id: cur0.id, pid: e.pointerId, ar: cur0.w / cur0.h };
          return;
        }
      }
      const hit = hitImage(wx(p.x), wy(p.y));
      if (hit) {
        select(hit.id);
        drag = { mode: "move", id: hit.id, pid: e.pointerId, ox: wx(p.x) - hit.x, oy: wy(p.y) - hit.y };
        return;
      }
      select(null);
      panning = { id: e.pointerId, x: p.x, y: p.y }; // przeciąganie pustego miejsca przesuwa widok
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

    if (drag && drag.pid === e.pointerId) {
      const p = local(e), m = images.get(drag.id);
      if (!m) { drag = null; return; }
      if (drag.mode === "move") {
        m.x = Math.round(wx(p.x) - drag.ox);
        m.y = Math.round(wy(p.y) - drag.oy);
      } else {
        m.w = Math.round(Math.max(40, wx(p.x) - m.x));
        m.h = Math.round(m.w / drag.ar);
      }
      sched();
      const now = performance.now();
      if (now - lastMv > 60) { lastMv = now; send({ t: "imgmv", img: m }); }
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
    if (drag && drag.pid === e.pointerId) endDrag();
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
    if (!tool.sel) selected = null;
    imgbar.classList.toggle("hidden", !selected || !tool.sel);
    handBtn.classList.toggle("sel", tool.pan);
    selBtn.classList.toggle("sel", tool.sel && !tool.pan);
    eraserBtn.classList.toggle("sel", tool.eraser && !tool.pan && !tool.sel);
    cv.style.cursor = tool.pan ? "grab" : tool.sel ? "default" : "crosshair";
    colorsEl.querySelectorAll(".sw").forEach((x) =>
      x.classList.toggle("sel", !tool.pan && !tool.sel && !tool.eraser && x.dataset.c === tool.color));
    sched();
  }

  COLORS.forEach((c) => {
    const b = document.createElement("button");
    b.className = "sw";
    b.dataset.c = c;
    b.style.background = c;
    b.setAttribute("aria-label", "Kolor " + c);
    b.onclick = () => { tool.color = c; tool.eraser = false; tool.pan = false; tool.sel = false; setMode(); };
    colorsEl.appendChild(b);
  });

  eraserBtn.onclick = () => { tool.eraser = !(tool.eraser && !tool.pan && !tool.sel); tool.pan = false; tool.sel = false; setMode(); };
  handBtn.onclick = () => { tool.pan = !tool.pan; if (tool.pan) tool.sel = false; setMode(); };
  selBtn.onclick = () => { tool.sel = !tool.sel; tool.pan = false; if (tool.sel) tool.eraser = false; setMode(); };

  $("undo").onclick = () => {
    const mine = [...strokes.values()].filter((s) => s.u === me);
    const last = mine[mine.length - 1];
    if (!last) return;
    strokes.delete(last.id);
    sched();
    queue({ t: "undo", id: last.id });
  };

  $("clear").onclick = () => {
    if (!confirm("Wyczyścić całe płótno (rysunek i zdjęcia) dla Was obojga?")) return;
    strokes.clear();
    images.clear();
    imgEls.clear();
    select(null);
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
        select(selected);
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
        sched();
        break;
      case "imgset":
        images.set(m.img.id, m.img);
        sched();
        break;
      case "imgmv":
        if (!(drag && drag.id === m.img.id)) { images.set(m.img.id, m.img); sched(); }
        break;
      case "imgdel":
        images.delete(m.id);
        imgEls.delete(m.id);
        if (selected === m.id) select(null);
        sched();
        break;
      case "clear":
        strokes.clear();
        images.clear();
        imgEls.clear();
        select(null);
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
    if (changed) { strokes.clear(); images.clear(); imgEls.clear(); outbox.length = 0; select(null); }
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
