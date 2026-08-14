// worker-template/src/bridge-hub.ts
//
// BridgeHub Durable Object — the cloud relay between Python/TS orchestrators
// (clients) and the browser extension.
//
// Design:
//   - Connections are tracked in a Map keyed by connId. Each connection
//     carries a `context` field ("worker" for the SW, "page" for the sandbox).
//   - Commands are routed by context: `sandbox.fetch` goes only to PAGE
//     connections, everything else goes to WORKER connections (round-robin).
//   - Pending futures are keyed by cmdId. A command sent via WS can be
//     answered via HTTP POST /api/result if the WS died mid-flight —
//     cross-channel correlation is the key invariant.
//   - Stale commands are swept every 60s. Zombie connections (no message
//     in 90s) are force-closed so the extension's watchdog can detect
//     half-open connections and reconnect.

import { DurableObject } from "cloudflare:workers";
import type {
  Command, CommandType, Result, Event, ExtensionConnection, PendingCommand,
  Env, MSG, CONTEXT,
} from "./types";

const STALE_QUEUE_MS = 5 * 60 * 1000;
const ZOMBIE_CONN_MS = 90 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const MAX_QUEUE = 1000;

export class BridgeHub extends DurableObject<Env> {
  connections = new Map<string, ExtensionConnection>();
  pending = new Map<string, PendingCommand>();
  rrIndexWorker = 0;
  rrIndexPage = 0;
  httpCommandQueue: { id: string; cmd: Command; queuedAt: number; context?: string }[] = [];
  httpResults = new Map<string, Result>();
  sweeperInterval: ReturnType<typeof setInterval> | null = null;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade
    if (request.headers.get("upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      const connId = "ext_" + crypto.randomUUID().slice(0, 12);
      const token = request.headers.get("x-bridge-token") || "";
      this.handleExtension(server, connId, token).catch((err) => {
        console.error("[bridge-hub] handleExtension error", err);
        try { server.close(1011, "internal error"); } catch {}
      });
      return new Response(null, { status: 101, webSocket: client });
    }

    // ISSUE-R2-9 fix: defense-in-depth — validate x-bridge-token on all routes
    // (the worker's /api/* middleware should have already done this, but if the
    // DO is ever exposed directly via a misconfigured proxy, this prevents
    // unauthenticated queue/poll access). Skip when BRIDGE_NO_AUTH === "1".
    if (this.env.BRIDGE_NO_AUTH !== "1" && this.env.BRIDGE_TOKEN) {
      const token = request.headers.get("x-bridge-token") || "";
      if (token !== this.env.BRIDGE_TOKEN && url.pathname !== "/status" && url.pathname !== "/api/extensions") {
        return new Response("unauthorized", { status: 401 });
      }
    }

    if (url.pathname === "/status" || url.pathname === "/api/extensions") {
      return Response.json(this.getStatus());
    }

    if (url.pathname === "/command" && request.method === "POST") {
      const body = await request.json() as { cmd: Command; timeout?: number };
      // ISSUE-5 + ISSUE-R2-11 + ISSUE-R3-4 + ISSUE-R3-5 fix: distinguish failure modes:
      //   - "No extension connected" → HTTP 503 (Python client falls back to HTTP queue)
      //   - "Extension disconnected" (mid-command) → HTTP 503 (same fallback semantics)
      //   - "Command X timed out after Yms" → HTTP 504 (Python client raises BridgeTimeoutError)
      //   - Command returned ok:false (e.g. selector not found, fetch 404) → HTTP 200
      //     with {ok:false, error:...} body (Python client calls raise_for_error()
      //     to get a typed BridgeCommandError)
      //   - Internal error (anything else) → HTTP 500
      try {
        const result = await this.sendCommand(body.cmd, body.timeout ?? 60_000);
        return Response.json(result);
      } catch (err) {
        const errMsg = String((err as Error).message || err);
        if (errMsg.includes("No extension connected") || errMsg.includes("Extension disconnected")) {
          return Response.json({ ok: false, error: errMsg }, { status: 503 });
        }
        if (errMsg.includes("timed out") || errMsg.includes("timeout")) {
          return Response.json({ ok: false, error: errMsg }, { status: 504 });
        }
        return Response.json({ ok: false, error: errMsg }, { status: 500 });
      }
    }

    if (url.pathname === "/poll" && request.method === "GET") {
      const agentId = url.searchParams.get("agentId") || "";
      // ISSUE-24 fix: cap waitS at 60s to prevent a client from holding the
      // DO in a polling loop for an arbitrary duration.
      const waitS = Math.min(parseInt(url.searchParams.get("wait") || "25", 10), 60);
      return Response.json(await this.poll(agentId, waitS));
    }

    if (url.pathname === "/result" && request.method === "POST") {
      const result = await request.json() as Result;
      this.handleResultPost(result);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/send-http" && request.method === "POST") {
      const body = await request.json() as { cmd: Command };
      const id = "cmd_" + crypto.randomUUID().slice(0, 12);
      const cmd: Command = { ...body.cmd, id };
      this.httpCommandQueue.push({ id, cmd, queuedAt: Date.now() });
      if (this.httpCommandQueue.length > MAX_QUEUE) this.httpCommandQueue.shift();
      return Response.json({ id });
    }

    const resultMatch = url.pathname.match(/^\/result\/(.+)$/);
    if (resultMatch && request.method === "GET") {
      const id = resultMatch[1];
      const r = this.httpResults.get(id);
      if (!r) return new Response("not ready", { status: 404 });
      this.httpResults.delete(id);
      return Response.json(r);
    }

    return new Response("not found", { status: 404 });
  }

  // -----------------------------------------------------------------------
  // Extension connection handler
  // -----------------------------------------------------------------------

  async handleExtension(ws: WebSocket, connId: string, token: string) {
    const conn: ExtensionConnection = {
      ws,
      connId,
      agentId: "",
      context: "worker",  // default; updated on connect message
      protocolVersion: "1.0",
      capabilities: [],
      authenticated: false,
      commandCount: 0,
      lastSeen: Date.now(),
    };

    // ISSUE-23 fix: if the worker forwarded an x-bridge-token header, treat
    // it as equivalent to a successful in-band AUTH message. This allows the
    // extension to skip the AUTH round-trip when the worker already validated
    // the token via its auth middleware.
    if (token && (token === this.env.BRIDGE_TOKEN || this.env.BRIDGE_NO_AUTH === "1")) {
      conn.authenticated = true;
    }

    this.connections.set(connId, conn);

    // Start sweeper on first connection
    if (!this.sweeperInterval) {
      this.sweeperInterval = setInterval(() => this.sweepStale(), SWEEP_INTERVAL_MS);
    }

    // Send keepalive ping every 30s
    const pingTimer = setInterval(() => {
      try { ws.send(JSON.stringify({ type: "ping", ts: Date.now() })); } catch {}
    }, 30_000);

    ws.addEventListener("message", async (event) => {
      let msg: any;
      try { msg = JSON.parse(event.data as string); } catch { return; }
      conn.lastSeen = Date.now();

      // Pre-auth gate: only allow auth, log, pong before authenticated.
      // ISSUE-23 fix: tightened to ONLY allow `auth` (previously allowed `log`
      // and `pong` — log injection / spam vector).
      if (!conn.authenticated) {
        if (msg.type === "auth") {
          if (this.env.BRIDGE_NO_AUTH === "1" || msg.token === this.env.BRIDGE_TOKEN) {
            conn.authenticated = true;
            ws.send(JSON.stringify({ type: "auth-ok" }));
          } else {
            try { ws.close(1008, "Invalid token"); } catch {}
          }
          return;
        }
        // Only `auth` is allowed pre-auth — drop everything else silently.
        return;
      }

      switch (msg.type) {
        case "connect":
          conn.agentId = msg.agentId || "";
          conn.context = msg.context || "worker";
          conn.protocolVersion = msg.protocolVersion || "1.0";
          conn.capabilities = msg.capabilities || [];
          console.log(`[bridge-hub] extension connected: agentId=${conn.agentId} context=${conn.context} caps=${conn.capabilities.length}`);
          break;

        case "result":
          this.handleResultPost(msg as Result);
          break;

        case "log":
          console.log(`[ext:${conn.agentId}] ${msg.message}`, msg.data || "");
          break;

        case "pong":
          // keepalive reply — already updated lastSeen
          break;

        case "event":
          // Async event from an activatable debug stream. Forward to subscribers
          // (e.g. a dashboard WS). For now, just log.
          console.log(`[ext:${conn.agentId}] event: ${msg.event}`, msg.data);
          break;

        default:
          console.warn(`[bridge-hub] unknown message type: ${msg.type}`);
      }
    });

    ws.addEventListener("close", () => {
      clearInterval(pingTimer);
      this.connections.delete(connId);
      // Reject any pending commands tied to this connId
      for (const [id, p] of this.pending) {
        if (p.connId === connId) {
          clearTimeout(p.timer);
          p.reject(new Error("Extension disconnected"));
          this.pending.delete(id);
        }
      }
      console.log(`[bridge-hub] extension disconnected: connId=${connId} agentId=${conn.agentId}`);
    });

    ws.addEventListener("error", (err) => {
      console.error(`[bridge-hub] ws error on connId=${connId}`, err);
    });
  }

  // -----------------------------------------------------------------------
  // Command dispatch
  // -----------------------------------------------------------------------

  pickExtension(context: "worker" | "page"): ExtensionConnection | null {
    const open = [...this.connections.values()].filter(
      (c) => c.ws.readyState === WebSocket.OPEN && c.authenticated && c.context === context
    );
    if (open.length === 0) return null;
    const idx = context === "worker" ? this.rrIndexWorker : this.rrIndexPage;
    const chosen = open[idx % open.length];
    if (context === "worker") this.rrIndexWorker++;
    else this.rrIndexPage++;
    return chosen;
  }

  async sendCommand(cmd: Command, timeoutMs = 60_000): Promise<Result> {
    const context = cmd.type === "sandbox.fetch" ? "page" : "worker";
    const conn = this.pickExtension(context);
    if (!conn) {
      throw new Error(`No extension connected (context=${context})`);
    }

    const cmdId = cmd.id || ("cmd_" + crypto.randomUUID().slice(0, 12));
    const fullCmd: Command = { ...cmd, id: cmdId };

    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(cmdId);
        reject(new Error(`Command ${cmd.type} timed out after ${timeoutMs}ms`));
      }, timeoutMs + 5000);  // +5s grace

      this.pending.set(cmdId, {
        resolve, reject, timer,
        type: cmd.type as CommandType,
        startedAt: Date.now(),
        connId: conn.connId,
        traceId: cmd.traceId,
      });

      try {
        conn.ws.send(JSON.stringify(fullCmd));
        conn.commandCount++;
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(cmdId);
        // ISSUE-R4-1 fix: ws.send() throws when the WS transitioned OPEN→CLOSING
        // between pickExtension's check and now. The command was NEVER sent.
        // Treat as "Extension disconnected" so the /command handler returns 503
        // and the Python client falls back to the HTTP queue (safe — no
        // duplicate-execution risk since the command was never delivered).
        reject(new Error(`Extension disconnected (failed to send command to extension: ${err})`));
      }
    });
  }

  handleResultPost(result: Result) {
    // ISSUE-9 fix: stamp a received-at timestamp so the sweeper can evict
    // old entries. Previously the sweeper checked `r.ts` (which is undefined
    // on the Result type) — no entries were ever swept, leading to unbounded
    // memory growth in the DO.
    const stamped = { ...result, _receivedAt: Date.now() } as Result & { _receivedAt: number };
    this.httpResults.set(result.id, stamped);

    // 2. Resolve any pending WS future for this cmdId (cross-channel)
    const p = this.pending.get(result.id);
    if (p) {
      clearTimeout(p.timer);
      this.pending.delete(result.id);
      // ISSUE-R2-11 fix: RESOLVE (not reject) the future with the full result
      // object, even when ok:false. This lets the /command handler return
      // HTTP 200 with {ok:false, error:...} so the Python client can raise
      // a typed BridgeCommandError via CommandResult.raise_for_error().
      // Previously, ok:false caused a rejection → HTTP 500 → BridgeProtocolError.
      p.resolve(result);
    }
  }

  async poll(agentId: string, waitS: number) {
    // ISSUE-R2-7: the `agentId` parameter is accepted for forward compatibility
    // but NOT used to filter the queue. HTTP-mode polling is round-robin: any
    // extension polling via /api/poll receives the next queued command regardless
    // of which agent it was intended for. This matches /send-http, which doesn't
    // accept a targetAgentId. If per-agent routing is needed in the future,
    // /send-http must accept targetAgentId and this method must filter by it.
    const deadline = Date.now() + waitS * 1000;
    while (Date.now() < deadline) {
      const cmds = this.httpCommandQueue.splice(0, 50);
      if (cmds.length > 0) return { commands: cmds.map((c) => c.cmd) };
      await new Promise((r) => setTimeout(r, 500));
    }
    return { commands: [] };
  }

  // -----------------------------------------------------------------------
  // Sweeper — drop stale queued commands + zombie connections
  // -----------------------------------------------------------------------

  sweepStale() {
    const now = Date.now();
    // Drop queued HTTP commands older than 5 min
    this.httpCommandQueue = this.httpCommandQueue.filter((c) => now - c.queuedAt < STALE_QUEUE_MS);
    // ISSUE-9 fix: sweep httpResults by the _receivedAt timestamp we stamp in
    // handleResultPost. Previously the sweeper checked `r.ts` (undefined on
    // Result) — no entries were ever swept, causing unbounded memory growth.
    for (const [id, r] of this.httpResults) {
      const receivedAt = (r as any)._receivedAt || 0;
      if (now - receivedAt > STALE_QUEUE_MS) {
        this.httpResults.delete(id);
      }
    }
    // Close zombie connections (no message in 90s)
    for (const [connId, conn] of this.connections) {
      if (now - conn.lastSeen > ZOMBIE_CONN_MS) {
        console.log(`[bridge-hub] closing zombie conn ${connId} (silent ${now - conn.lastSeen}ms)`);
        try { conn.ws.close(4001, "zombie"); } catch {}
        this.connections.delete(connId);
      }
    }
  }

  getStatus() {
    return {
      extensions: [...this.connections.values()].map((c) => ({
        connId: c.connId,
        agentId: c.agentId,
        context: c.context,
        protocolVersion: c.protocolVersion,
        capabilities: c.capabilities,
        authenticated: c.authenticated,
        commandCount: c.commandCount,
        lastSeen: c.lastSeen,
        readyState: c.ws.readyState,
      })),
      pendingCount: this.pending.size,
      queuedCommands: this.httpCommandQueue.length,
      httpResults: this.httpResults.size,
    };
  }
}
