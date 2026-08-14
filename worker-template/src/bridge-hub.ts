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

    if (url.pathname === "/status" || url.pathname === "/api/extensions") {
      return Response.json(this.getStatus());
    }

    if (url.pathname === "/command" && request.method === "POST") {
      const body = await request.json() as { cmd: Command; timeout?: number };
      const result = await this.sendCommand(body.cmd, body.timeout ?? 60_000);
      return Response.json(result);
    }

    if (url.pathname === "/poll" && request.method === "GET") {
      const agentId = url.searchParams.get("agentId") || "";
      const waitS = parseInt(url.searchParams.get("wait") || "25", 10);
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

      // Pre-auth gate: only allow auth, log, pong before authenticated
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
        if (msg.type !== "log" && msg.type !== "pong") return;
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
        reject(new Error(`Failed to send command to extension: ${err}`));
      }
    });
  }

  handleResultPost(result: Result) {
    // 1. Save to httpResults (for HTTP-polling clients)
    this.httpResults.set(result.id, result);

    // 2. Resolve any pending WS future for this cmdId (cross-channel)
    const p = this.pending.get(result.id);
    if (p) {
      clearTimeout(p.timer);
      this.pending.delete(result.id);
      if (result.ok) p.resolve(result);
      else p.reject(new Error(result.error || "Command failed"));
    }
  }

  async poll(agentId: string, waitS: number) {
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
    // Drop HTTP results older than 5 min
    for (const [id, r] of this.httpResults) {
      // Results don't carry a timestamp — assume the pending entry does
      const p = this.pending.get(id);
      if (!p && now - (r as any).ts > STALE_QUEUE_MS) this.httpResults.delete(id);
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
