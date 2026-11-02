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

      case "clear":
        await this.ctx.storage.deleteAll();
        this.others(ws, raw);
        break;
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
