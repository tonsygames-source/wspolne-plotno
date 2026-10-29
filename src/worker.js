import { DurableObject } from "cloudflare:workers";

// Worker: kieruje /ws do pokoju (Durable Object), resztę oddaje jako pliki statyczne.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
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

// Jeden pokój = jedno wspólne płótno. Kreski są zapisywane w storage,
// więc płótno przetrwa zamknięcie aplikacji i restart.
export class DrawRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Odpowiada na "ping" bez wybudzania obiektu (tanio).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);

    const saved = await this.ctx.storage.list({ prefix: "s:" });
    server.send(JSON.stringify({ t: "init", strokes: [...saved.values()] }));
    this.presence();

    return new Response(null, { status: 101, webSocket: client });
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
