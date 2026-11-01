(() => {
  // Logiczny rozmiar płótna - taki sam na każdym telefonie, więc rysunek wygląda tak samo u obojga.
  const W = 6000, H = 6000, PAPER = "#fffdf8";
  const COLORS = ["#1b1b1f", "#e63946", "#f4a261", "#f2cc3a", "#2a9d5c", "#2f80ed", "#8e5cf5", "#ff7eb6"];

  const cv = document.getElementById("c");
  const ctx = cv.getContext("2d");
  cv.width = W; cv.height = H;

  const stage = document.getElementById("stage");
  const dot = document.getElementById("dot");
  const who = document.getElementById("who");
  const join = document.getElementById("join");
  const roomInput = document.getElementById("roomInput");
  const sizeEl = document.getElementById("size");
  const eraserBtn = document.getElementById("eraser");

  const me = Math.random().toString(36).slice(2, 8);
  const strokes = new Map(); // id -> {id,u,c,s,e,p:[[x,y],...]}
  const tool = { color: COLORS[0], eraser: false };
  let room = "";
  let ws = null, retry = 0, pingTimer = 0, online = 1;
  const outbox = [];

  // ---------- rysowanie ----------
  function draw(st, from = 0) {
    const p = st.p;
    if (!p.length) return;
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.strokeStyle = ctx.fillStyle = st.e ? PAPER : st.c;
    ctx.lineWidth = st.s;
    if (p.length === 1) {
      ctx.beginPath();
      ctx.arc(p[0][0], p[0][1], st.s / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    const i0 = Math.max(0, from - 1);
    ctx.beginPath();
    ctx.moveTo(p[i0][0], p[i0][1]);
    for (let i = i0 + 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
    ctx.stroke();
  }

  function redraw() {
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, W, H);
    for (const st of strokes.values()) draw(st);
  }

  function fit() {
    const r = stage.getBoundingClientRect();
    const k = Math.min((r.width - 16) / W, (r.height - 8) / H);
    cv.style.width = Math.floor(W * k) + "px";
    cv.style.height = Math.floor(H * k) + "px";
  }
  new ResizeObserver(fit).observe(stage);

  function pos(e) {
    const r = cv.getBoundingClientRect();
    return [Math.round(((e.clientX - r.left) * W) / r.width), Math.round(((e.clientY - r.top) * H) / r.height)];
  }

  // ---------- wskaźnik ----------
  let cur = null, pending = [], flushTimer = 0, activePointer = null;

  function meta(st) { return { id: st.id, u: st.u, c: st.c, s: st.s, e: st.e }; }

  function flush() {
    if (!cur || !pending.length) return;
    send({ t: "pts", ...meta(cur), p: pending });
    pending = [];
  }

  cv.addEventListener("pointerdown", (e) => {
    if (activePointer !== null) return;
    activePointer = e.pointerId;
    cv.setPointerCapture(e.pointerId);
    const pt = pos(e);
    cur = {
      id: Date.now().toString().padStart(15, "0") + "-" + me + Math.random().toString(36).slice(2, 5),
      u: me, c: tool.color, s: +sizeEl.value, e: tool.eraser, p: [pt],
    };
    strokes.set(cur.id, cur);
    draw(cur, 0);
    pending = [pt];
    flushTimer = setInterval(flush, 60);
  });

  cv.addEventListener("pointermove", (e) => {
    if (!cur || e.pointerId !== activePointer) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const from = cur.p.length;
    for (const ev of evs.length ? evs : [e]) {
      const pt = pos(ev);
      const last = cur.p[cur.p.length - 1];
      if (pt[0] === last[0] && pt[1] === last[1]) continue;
      cur.p.push(pt);
      pending.push(pt);
    }
    if (cur.p.length > from) draw(cur, from);
  });

  function endStroke(e) {
    if (!cur || e.pointerId !== activePointer) return;
    clearInterval(flushTimer);
    flush();
    queue({ t: "end", stroke: cur });
    cur = null; pending = []; activePointer = null;
  }
  cv.addEventListener("pointerup", endStroke);
  cv.addEventListener("pointercancel", endStroke);
  cv.addEventListener("contextmenu", (e) => e.preventDefault());

  // ---------- narzędzia ----------
  const colorsEl = document.getElementById("colors");
  COLORS.forEach((c, i) => {
    const b = document.createElement("button");
    b.className = "sw" + (i === 0 ? " sel" : "");
    b.style.background = c;
    b.setAttribute("aria-label", "Kolor " + (i + 1));
    b.onclick = () => {
      tool.color = c; tool.eraser = false;
      eraserBtn.classList.remove("sel");
      colorsEl.querySelectorAll(".sw").forEach((x) => x.classList.toggle("sel", x === b));
    };
    colorsEl.appendChild(b);
  });

  eraserBtn.onclick = () => {
    tool.eraser = !tool.eraser;
    eraserBtn.classList.toggle("sel", tool.eraser);
    if (tool.eraser) colorsEl.querySelectorAll(".sw").forEach((x) => x.classList.remove("sel"));
    else colorsEl.querySelector(".sw").click();
  };

  document.getElementById("undo").onclick = () => {
    const mine = [...strokes.values()].filter((s) => s.u === me);
    const last = mine[mine.length - 1];
    if (!last) return;
    strokes.delete(last.id);
    redraw();
    queue({ t: "undo", id: last.id });
  };

  document.getElementById("clear").onclick = () => {
    if (!confirm("Wyczyścić całe płótno dla Was obojga?")) return;
    strokes.clear();
    redraw();
    queue({ t: "clear" });
  };

  document.getElementById("save").onclick = () => {
    cv.toBlob(async (blob) => {
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
        const local = [...strokes.values()].filter((s) => keep.has(s.id));
        strokes.clear();
        for (const s of m.strokes) strokes.set(s.id, s);
        for (const s of local) strokes.set(s.id, s);
        redraw();
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
        draw(st, from);
        break;
      }
      case "undo":
        strokes.delete(m.id);
        redraw();
        break;
      case "clear":
        strokes.clear();
        redraw();
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
    if (changed) { strokes.clear(); outbox.length = 0; redraw(); }
    connect();
  }

  document.getElementById("roomBtn").onclick = openJoin;
  document.getElementById("closeJoin").onclick = () => room && join.classList.add("hidden");
  document.getElementById("joinForm").onsubmit = (e) => { e.preventDefault(); setRoom(roomInput.value); };
  document.getElementById("shareBtn").onclick = async () => {
    const code = roomInput.value.trim() || room;
    if (!code) return;
    const link = location.origin + "/#" + encodeURIComponent(code);
    try {
      if (navigator.share) { await navigator.share({ title: "Wspólne płótno", text: "Rysujemy razem:", url: link }); return; }
    } catch (err) { if (err && err.name === "AbortError") return; }
    try { await navigator.clipboard.writeText(link); alert("Skopiowano link"); } catch { prompt("Skopiuj link:", link); }
  };

  // ---------- start ----------
  fit();
  redraw();
  let saved = "";
  try { saved = localStorage.getItem("room") || ""; } catch {}
  const fromHash = decodeURIComponent(location.hash.slice(1));
  if (fromHash) { history.replaceState(null, "", location.pathname); setRoom(fromHash); }
  else if (saved) setRoom(saved);
  else openJoin();

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
})();
