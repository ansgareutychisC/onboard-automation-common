// worker-template/src/index.ts
//
// Worker entry point. Minimal Hono router with auth middleware.
// Routes all extension-bridge traffic to the BridgeHub Durable Object.
//
// Service-specific routes (e.g. /api/run, /api/accounts, dashboard) should
// be added in a sibling file (e.g. service.ts) and mounted here. This
// template intentionally contains ZERO service logic.

import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, Command, Result } from "./types";
import { BridgeHub } from "./bridge-hub";

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["content-type", "authorization", "x-request-id"],
}));

// ---------------------------------------------------------------------------
// Auth middleware — gate /api/* on Bearer token unless BRIDGE_NO_AUTH=1
// ---------------------------------------------------------------------------

app.use("/api/*", async (c, next) => {
  if (c.env.BRIDGE_NO_AUTH === "1") return next();
  const auth = c.req.header("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== c.env.BRIDGE_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
});

// ---------------------------------------------------------------------------
// Public endpoints (no auth)
// ---------------------------------------------------------------------------

app.get("/", (c) => c.text("Onboard Automation Bridge Worker. See /health, /api/extensions, /api/token.", 200, { "content-type": "text/plain" }));

app.get("/health", (c) => c.json({ ok: true, service: "onboard-automation-bridge", protocolVersion: "1.0", time: new Date().toISOString() }));

app.get("/api/token", (c) => c.json({ token: c.env.BRIDGE_TOKEN || "" }));

// ---------------------------------------------------------------------------
// Bridge routes — proxy to the BridgeHub DO
// ---------------------------------------------------------------------------

function getHub(c: any): DurableObjectStub {
  const id = c.env.BRIDGE_HUB.idFromName("default");
  return c.env.BRIDGE_HUB.get(id);
}

// ISSUE-R3-1 fix: helper to forward the caller's Authorization header as
// x-bridge-token on ALL proxied DO requests. Without this, the DO's auth
// check (bridge-hub.ts:58-63) rejects /api/poll, /api/result, /api/send-http,
// and /api/result/:id with 401 — breaking the entire HTTP SOS fallback path
// when BRIDGE_TOKEN is set in production.
function forwardWithToken(c: any, method: string, url: string, body?: unknown): Request {
  const token = c.req.header("authorization")?.startsWith("Bearer ")
    ? c.req.header("authorization")!.slice(7) : "";
  const headers: Record<string, string> = { "x-bridge-token": token };
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

app.get("/api/extensions", async (c) => {
  const hub = getHub(c);
  return hub.fetch(forwardWithToken(c, "GET", "https://do/status"));
});

app.post("/api/command", async (c) => {
  const hub = getHub(c);
  const body = await c.req.json();
  return hub.fetch(forwardWithToken(c, "POST", "https://do/command", body));
});

app.get("/api/poll", async (c) => {
  const hub = getHub(c);
  const agentId = c.req.query("agentId") || "";
  const wait = c.req.query("wait") || "25";
  return hub.fetch(forwardWithToken(c, "GET", `https://do/poll?agentId=${encodeURIComponent(agentId)}&wait=${wait}`));
});

app.post("/api/result", async (c) => {
  const hub = getHub(c);
  const body = await c.req.json();
  return hub.fetch(forwardWithToken(c, "POST", "https://do/result", body));
});

app.post("/api/send-http", async (c) => {
  const hub = getHub(c);
  const body = await c.req.json();
  return hub.fetch(forwardWithToken(c, "POST", "https://do/send-http", body));
});

app.get("/api/result/:id", async (c) => {
  const hub = getHub(c);
  const id = c.req.param("id");
  return hub.fetch(forwardWithToken(c, "GET", `https://do/result/${id}`));
});

// WebSocket upgrade — for the extension AND for dashboard subscribers
app.all("/ws", async (c) => {
  if (c.req.header("upgrade") !== "websocket") {
    return c.text("expected websocket", 426);
  }
  const hub = getHub(c);
  // Forward Authorization as x-bridge-token so DO can auth
  const doReq = new Request(c.req.raw, { headers: { ...c.req.raw.headers, "x-bridge-token": c.req.header("authorization")?.startsWith("Bearer ") ? c.req.header("authorization")!.slice(7) : "" } });
  return hub.fetch(doReq);
});

// Also accept WS at "/" (Caddy XTransformPort requires path "/")
app.all("/", async (c) => {
  if (c.req.header("upgrade") === "websocket") {
    return app.fetch(new Request("https://example.com/ws", c.req.raw), c.env, c.executionCtx as any);
  }
  return c.text("Onboard Automation Bridge Worker. See /health, /api/extensions, /api/token.", 200, { "content-type": "text/plain" });
});

// ---------------------------------------------------------------------------
// Service-specific routes — ADD YOURS HERE
// ---------------------------------------------------------------------------
// Example:
//   import { createServiceRouter } from "./service";
//   app.route("/api/svc", createServiceRouter());
//
// Or inline:
//   app.post("/api/run", async (c) => { /* your pipeline */ });

export default app;
export { BridgeHub };
