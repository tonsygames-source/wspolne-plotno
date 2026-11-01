(() => {
  // Świat ma stały rozmiar WORLD x WORLD jednostek. Widok (view) to to, co aktualnie widać na ekranie:
  // przesunięcie + powiększenie. Kreski są zapisane we współrzędnych świata, więc u obojga wyglądają tak samo.
  const WORLD = 8000, PAPER = "#fffdf8", OUTSIDE = "#0f0f12", MAXK = 8;
  const COLORS = ["#1b1b1f", "#e63946", "#f4a261", "#f2cc3a", "#2a9d5c", "#2f80ed", "#8e5cf5", "#ff7eb6"];
  const MAX_POINTS = 6000; // dłuższe kreski dzielimy na kawałki

  const $ = (id) => document.getElementById(id);
  const cv = $("c");
  const ctx = cv.getContext("2d");
  const stage = $("stage");
  const dot = $("dot");
  const who = $("who");
  const join = $("join");
  const roomInput = $("roomInput");
  const sizeEl = $("size");
  const eraserBtn = $("eraser");
  const handBtn = $("hand");

  const me = Math.random().toString(36).slice(2, 8);
  const strokes = new Map(); // id -> {id,u,c,s,e,p:[[x,y],...]}
  const tool = { color: COLORS[0], eraser: false, pan: false };
  let room = "";
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
    for (const st of strokes.values()) {
      const b = box(st);
      if (!b) continue;
      r = r ? [Math.min(r[0], b[0]), Math.min(r[1], b[1]), Math.max(r[2], b[2]), Math.max(r[3], b[3])] : b.slice();
    }
    return r;
  }

  function draw(c, st, from) {
    const p = st.p;
    if (!p.length) return;
    c.lineCap = c.lineJoin = "round";
    c.strokeStyle = c.fillStyle = st.e ? PAPER : st.c;
    c.lineWidth = st.s;
    if (p.length === 1) {
      c.beginPath();
      c.arc(p[0][0], p[0][1], st.s / 2, 0, Math.PI * 2);
      c.fill();
      return;
    }
    const i0 = Math.max(0, from - 1);
    c.beginPath();
    c.moveTo(p[i0][0], p[i0][1]);
    for (let i = i0 + 1; i < p.length; i++) c.lineTo(p[i][0], p[i][1]);
    c.stroke();
  }

  function redraw() {
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
    const x0 = view.x, y0 = view.y, x1 = view.x + cssW / view.k, y1 = view.y + cssH / view.k;
    for (const st of strokes.values()) {
      const b = box(st);
      if (!b || b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1) continue;
      draw(ctx, st, 0);
    }
    ctx.restore();
  }

  // ---------- wskaźniki: rysowanie, przesuwanie, pinch ----------
  const ptrs = new Map(); // pointerId -> {x,y} w px ekranu
  let cur = null, curPid = null, pending = [], flushTimer = 0;
  let gesture = null, panning = null;

  const newId = () => Date.now().toString().padStart(15, "0") + "-" + me + Math.random().toString(36).slice(2, 5);
  const ser = (st) => ({ id: st.id, u: st.u, c: st.c, s: st.s, e: st.e, p: st.p });
  const meta = (st) => ({ id: st.id, u: st.u, c: st.c, s: st.s, e: st.e });
  const clamp = (v) => Math.round(Math.min(WORLD, Math.max(0, v)) * 10) / 10;

  function toWorld(sx, sy) {
    return [clamp(view.x + sx / view.k), clamp(view.y + sy / view.k)];
  }

  function flush() {
    if (!cur || !pending.length) return;
    send({ t: "pts", ...meta(cur), p: pending });
    pending = [];
  }

  function startStroke(pt, pid) {
    cur = { id: newId(), u: me, c: tool.color, s: +sizeEl.value, e: tool.eraser, p: [pt] };
    curPid = pid;
    strokes.set(cur.id, cur);
    draw(ctx, cur, 0);
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
      panning = null;
      gesture = pinchState();
      return;
    }
    if (ptrs.size > 2) return;
    const p = ptrs.get(e.pointerId);
    if (tool.pan || e.button === 1 || e.button === 2) {
      panning = { id: e.pointerId, x: p.x, y: p.y };
    } else {
      startStroke(toWorld(p.x, p.y), e.pointerId);
    }
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
      if (cur.p.length > from) draw(ctx, cur, from);
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
    handBtn.classList.toggle("sel", tool.pan);
    eraserBtn.classList.toggle("sel", tool.eraser && !tool.pan);
    cv.style.cursor = tool.pan ? "grab" : "crosshair";
    colorsEl.querySelectorAll(".sw").forEach((x) =>
      x.classList.toggle("sel", !tool.pan && !tool.eraser && x.dataset.c === tool.color));
  }

  COLORS.forEach((c) => {
    const b = document.createElement("button");
    b.className = "sw";
    b.dataset.c = c;
    b.style.background = c;
    b.setAttribute("aria-label", "Kolor " + c);
    b.onclick = () => { tool.color = c; tool.eraser = false; tool.pan = false; setMode(); };
    colorsEl.appendChild(b);
  });

  eraserBtn.onclick = () => { tool.eraser = !(tool.eraser && !tool.pan); tool.pan = false; setMode(); };
  handBtn.onclick = () => { tool.pan = !tool.pan; setMode(); };

  $("undo").onclick = () => {
    const mine = [...strokes.values()].filter((s) => s.u === me);
    const last = mine[mine.length - 1];
    if (!last) return;
    strokes.delete(last.id);
    sched();
    queue({ t: "undo", id: last.id });
  };

  $("clear").onclick = () => {
    if (!confirm("Wyczyścić całe płótno dla Was obojga?")) return;
    strokes.clear();
    sched();
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
    const oc = document.createElement("canvas");
    oc.width = Math.max(1, Math.ceil(w * sc));
    oc.height = Math.max(1, Math.ceil(h * sc));
    const c = oc.getContext("2d");
    c.fillStyle = PAPER;
    c.fillRect(0, 0, oc.width, oc.height);
    c.setTransform(sc, 0, 0, sc, -b[0] * sc, -b[1] * sc);
    for (const st of strokes.values()) draw(c, st, 0);
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

  // Zmiany trwałe (end/undo/clear) czekają w kolejce, jeśli nie ma połączenia.
  function queue(m) {
    if (ws && ws.readyState === 1) send(m);
    else outbox.push(m);
  }

  function handle(m) {
    switch (m.t) {
      case "init": {
        const keep = new Set(outbox.filter((o) => o.t === "end").map((o) => o.stroke.id));
        const localS = [...strokes.values()].filter((s) => keep.has(s.id));
        const live = cur;
        strokes.clear();
        for (const s of m.strokes) strokes.set(s.id, s);
        for (const s of localS) strokes.set(s.id, s);
        if (live) strokes.set(live.id, live);
        sched();
        while (outbox.length) send(outbox.shift());
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
        draw(ctx, st, from);
        break;
      }
      case "undo":
        strokes.delete(m.id);
        sched();
        break;
      case "clear":
        strokes.clear();
        sched();
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
    if (changed) { strokes.clear(); outbox.length = 0; sched(); }
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
