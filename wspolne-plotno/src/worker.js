import { DurableObject } from "cloudflare:workers";

// Worker: kieruje /ws i /img do pokoju (Durable Object), resztę oddaje jako pliki statyczne.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/ws" || url.pathname === "/img") {
      if (url.pathname === "/ws" && request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 426 });
      }
      const room = (url.searchParams.get("room") || "").trim().slice(0, 64);
      if (!room) return new Response("room required", { status: 400 });
      const stub = env.ROOM.get(env.ROOM.idFromName(room));
      return stub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_IMG_BYTES = 1_600_000; // limit wartości w Durable Object to 2 MB

const num = (v, lo, hi) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);

// Sprawdza i czyści opis zdjęcia {id,x,y,w,h}.
function cleanImg(m) {
  if (!m || !ID_RE.test(String(m.id))) return null;
  const x = num(m.x, -100000, 100000), y = num(m.y, -100000, 100000);
  const w = num(m.w, 10, 100000), h = num(m.h, 10, 100000);
  if (x === null || y === null || w === null || h === null) return null;
  return { id: String(m.id), x, y, w, h };
}

// ---- Przekształcenie zaznaczenia (przesunięcie + skalowanie względem punktu) ----
// x' = (x - ax) * k + ax + dx. Ten sam wzór i to samo zaokrąglanie jest na stronie (app.js),
// więc serwer i obie osoby dostają identyczny wynik z tego samego stanu wyjściowego.
const MAX_IDS = 7000;
const r1 = (v) => Math.round(v * 10) / 10;

function cleanIds(a) {
  if (!Array.isArray(a) || a.length > MAX_IDS) return null;
  for (const id of a) if (typeof id !== "string" || !ID_RE.test(id)) return null;
  return a;
}

function cleanXf(m) {
  if (!m || typeof m.g !== "string" || !ID_RE.test(m.g)) return null;
  const k = num(m.k, 0.01, 100);
  const ax = num(m.ax, -1e6, 1e6), ay = num(m.ay, -1e6, 1e6);
  const dx = num(m.dx, -1e6, 1e6), dy = num(m.dy, -1e6, 1e6);
  if (k === null || ax === null || ay === null || dx === null || dy === null) return null;
  const out = { g: m.g, k, ax, ay, dx, dy };
  if (m.ids !== undefined) { out.ids = cleanIds(m.ids); if (!out.ids) return null; }
  if (m.iids !== undefined) { out.iids = cleanIds(m.iids); if (!out.iids) return null; }
  return out;
}

const xfStroke = (st, x) => ({
  ...st,
  p: st.p.map((q) => [r1((q[0] - x.ax) * x.k + x.ax + x.dx), r1((q[1] - x.ay) * x.k + x.ay + x.dy)]),
  s: Math.max(1, r1(st.s * x.k)),
});

const xfImg = (m, x) => ({
  id: m.id,
  x: r1((m.x - x.ax) * x.k + x.ax + x.dx),
  y: r1((m.y - x.ay) * x.k + x.ay + x.dy),
  w: Math.max(1, r1(m.w * x.k)),
  h: Math.max(1, r1(m.h * x.k)),
});

const chunks = (arr, n = 100) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

// Jeden pokój = jedno wspólne płótno. Kreski i zdjęcia są zapisywane w storage,
// więc płótno przetrwa zamknięcie aplikacji i restart.
export class DrawRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Odpowiada na "ping" bez wybudzania obiektu (tanio).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/img") return this.imgRequest(request, url);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);

    const strokes = await this.ctx.storage.list({ prefix: "s:" });
    const images = await this.ctx.storage.list({ prefix: "m:" });
    server.send(JSON.stringify({ t: "init", strokes: [...strokes.values()], images: [...images.values()] }));
    this.presence();

    return new Response(null, { status: 101, webSocket: client });
  }

  // Zdjęcia idą osobnym żądaniem HTTP (WebSocket ma limit ok. 1 MB na wiadomość).
  async imgRequest(request, url) {
    const id = url.searchParams.get("id") || "";
    if (!ID_RE.test(id)) return new Response("bad id", { status: 400 });

    if (request.method === "POST" || request.method === "PUT") {
      const buf = await request.arrayBuffer();
      if (!buf.byteLength || buf.byteLength > MAX_IMG_BYTES) return new Response("bad size", { status: 413 });
      const head = new Uint8Array(buf, 0, 2);
      if (head[0] !== 0xff || head[1] !== 0xd8) return new Response("jpeg only", { status: 415 });
      await this.ctx.storage.put("b:" + id, buf);
      return new Response("ok");
    }

    const buf = await this.ctx.storage.get("b:" + id);
    if (!buf) return new Response("not found", { status: 404 });
    return new Response(buf, {
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "private, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      },
    });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 200000) return;
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }

    switch (m.t) {
      case "pts": // kawałek kreski na żywo - tylko przekaż dalej
        this.others(ws, raw);
        break;

      case "end": {
        const s = m.stroke;
        if (s && ID_RE.test(String(s.id)) && Array.isArray(s.p) && s.p.length <= 20000) {
          await this.ctx.storage.put("s:" + s.id, s);
        }
        break;
      }

      case "undo":
        if (ID_RE.test(String(m.id))) {
          await this.ctx.storage.delete("s:" + m.id);
          this.others(ws, raw);
        }
        break;

      case "imgmv": { // przeciąganie na żywo: tylko przekaż dalej
        const img = cleanImg(m.img);
        if (img) this.others(ws, JSON.stringify({ t: "imgmv", img }));
        break;
      }

      case "imgset": { // nowe zdjęcie albo końcowa pozycja: zapisz i przekaż
        const img = cleanImg(m.img);
        if (img) {
          await this.ctx.storage.put("m:" + img.id, img);
          this.others(ws, JSON.stringify({ t: "imgset", img }));
        }
        break;
      }

      case "imgdel":
        if (ID_RE.test(String(m.id))) {
          await this.ctx.storage.delete(["m:" + m.id, "b:" + m.id]);
          this.others(ws, JSON.stringify({ t: "imgdel", id: m.id }));
        }
        break;

      case "xfmv": { // przeciąganie zaznaczenia na żywo: tylko przekaż dalej
        const x = cleanXf(m);
        if (x) this.others(ws, JSON.stringify({ t: "xfmv", ...x }));
        break;
      }

      case "xf": { // końcowe przekształcenie zaznaczenia: zapisz i przekaż
        const x = cleanXf(m);
        if (!x) break;
        await this.applyXf(x);
        this.others(ws, JSON.stringify({ t: "xf", ...x }));
        break;
      }

      case "xdel": { // usunięcie zaznaczenia (kreski + zdjęcia)
        const ids = cleanIds(m.ids || []), iids = cleanIds(m.iids || []);
        if (!ids || !iids) break;
        for (const part of chunks(ids.map((i) => "s:" + i))) await this.ctx.storage.delete(part);
        for (const part of chunks(iids.flatMap((i) => ["m:" + i, "b:" + i]))) await this.ctx.storage.delete(part);
        this.others(ws, JSON.stringify({ t: "xdel", ids, iids }));
        break;
      }

      case "clear":
        await this.ctx.storage.deleteAll();
        this.others(ws, raw);
        break;
    }
  }

  async applyXf(x) {
    const jobs = [
      [(x.ids || []).map((i) => "s:" + i), (v) => xfStroke(v, x)],
      [(x.iids || []).map((i) => "m:" + i), (v) => xfImg(v, x)],
    ];
    for (const [keys, fn] of jobs) {
      for (const part of chunks(keys)) {
        const got = await this.ctx.storage.get(part);
        const out = {};
        for (const [k, v] of got) out[k] = fn(v);
        if (Object.keys(out).length) await this.ctx.storage.put(out);
      }
    }
  }

  webSocketClose(ws) {
    try {
      ws.close(1000);
    } catch {}
    this.presence(ws);
  }

  webSocketError(ws) {
    this.presence(ws);
  }

  others(sender, data) {
    for (const w of this.ctx.getWebSockets()) {
      if (w !== sender) {
        try {
          w.send(data);
        } catch {}
      }
    }
  }

  presence(exclude) {
    const all = this.ctx.getWebSockets().filter((w) => w !== exclude);
    const msg = JSON.stringify({ t: "presence", n: all.length });
    for (const w of all) {
      try {
        w.send(msg);
      } catch {}
    }
  }
}
