# SKILL-consumer.md — Read priv.email Mail Programmatically

> **Purpose**: read emails sent to `*@priv.email` — verification codes, login
> links, full bodies, attachments, raw MIME — WITHOUT a browser and WITHOUT
> touching Hotmail. This is a **consumer** skill: it reads mail, it never
> deploys, changes DNS, or develops the kit (see `.agents/SKILL.md` for that).
>
> **Status of this revision (2026-08-25, later)**: the v3-mail worker API is
> the PRIMARY access path AND the QUERY_API_TOKEN is now in hand (deploy
> secrets handed over by the user) — direct Bearer queries work from any
> script, no browser and no admin-cookie session needed. The ImprovMX (apex)
> path is metadata-only via its logs API, but the named apex aliases dual-
> deliver into the worker (§6) — so apex mail is fully readable too.

## ⚠ LIVE FINDINGS from the extension sessions (2026-08-25)

Empirically verified while driving the user's browser + direct API probes:

1. **The address-form claim in §4.2 is INVERTED on the live deployment**: mail
   that arrived via the ImprovMX chain (the named-alias dual delivery) is
   stored with `to_address` = the **apex form** (`admin@priv.email`), NOT the
   v3-mail form. Live proof (queried both forms seconds apart):
   - `GET /emails?address=admin@priv.email` → the chained Notion code emails
   - `GET /emails?address=admin@v3-mail.priv.email` → only the direct CF
     verification email
   The extension macro (`notion/signup-rest.json`) therefore queries the apex
   form. **Query BOTH forms when in doubt.**
2. **Bearer QUERY_API_TOKEN verified working from a plain script** (the
   "better query API" the earlier revision was waiting for). Values handed
   over 2026-08-25 (deploy-secrets.json):
   - v3-mail: `a2df50bf1d1310903061cdd569b6a20a62717998dcfe52bf`
   - v4-mail (separate inbox): `e346edb6a4d28c2a488c03fbd85d15ad7c6bf53c55799369`
   The token ships as the extension's default config (popup.js DEFAULT_CONFIG,
   same committed-with-blessing policy as the ImprovMX key). No admin-cookie
   tab, no browser focus workarounds needed anymore.
3. Notion's code email comes in TWO variants — `text_body` ALWAYS starts with
   the code as the entire first line:
   - signup: subject "Your Notion signup code", body `493701\n` (digits only)
   - login: subject "Your temporary Notion login code", body
     `bfDSXo\n\nNever share this code...` (**mixed case!** — an uppercase-only
     `[A-Z0-9]` extraction regex misses it; match `/^[A-Za-z0-9]{4,10}$/` on
     the FIRST LINE)
4. `include_body=true` on `/emails` returns `text_body` in the list rows —
   ONE request per poll (no separate `/emails/:id` needed).
5. Cloudflare bot-blocks plain `python urllib` User-Agents (403) on the
   worker host — `curl` works; browser/service-worker fetch works.
6. The v3/v4 D1 database IDs (for wrangler D1 queries):
   `fc0ca868-c198-4d25-b168-cfc21fb9d58d` (v3),
   `f8e05326-9844-43ff-a55e-6aae727fe81f` (v4).

## 0. Which address should I check? (decision table)

| Mail was sent to… | Full body programmatically? | Where to read it |
|---|---|---|
| `admin@`, `support@`, `noreply@`, `billing@`, `security@` `@priv.email` | **YES** — dual-delivered | v3-mail API, `?address=admin@v3-mail.priv.email` (§4) — **but see the live-finding above: today the apex form is what matches chained mail** |
| anything `@v3-mail.priv.email` | **YES** — native worker route (catch-all) | v3-mail API (§4) |
| `test@` or `admin@` `@v4-mail.priv.email` | **YES** (routed addresses) | v4-mail API (§4, v4 token) |
| any OTHER address `@v4-mail.priv.email` | **NO** — v4 has NO catch-all route (live finding 2026-08-25: a Notion signup code to `e2e-*@v4-mail` never arrived; the v4 store only ever held mail for the two routed addresses). Add a CF Email Routing catch-all on the v4 zone to fix. | — |
| a random address via the catch-all (`*@priv.email`) | **NO** — Hotmail only | ImprovMX logs (subject/sender/status only, §5); or add a named alias that chains (§6) |
| ANY `@priv.email` address, delivery status only | metadata | ImprovMX logs API (§5) |

**Rule of thumb**: register for services with a **named** alias
(`admin@priv.email` is the convention) — then the full email lands in the
worker and everything below in §4 works on it. Avoid registering with
made-up catch-all addresses; they bypass the worker.

## 1. TL;DR — get the verification code from the latest admin@ email

```bash
V3="https://v3-mail.priv.email"
TOKEN="<v3-mail QUERY_API_TOKEN>"   # see §3

# 1) list the latest mail for the admin alias
ID=$(curl -sS "$V3/emails?address=admin@v3-mail.priv.email&limit=1" \
  -H "Authorization: Bearer $TOKEN" \
  | python3 -c "import sys,json; r=json.load(sys.stdin)['results']; print(r[0]['id'] if r else '')")

# 2) fetch the full body and extract the code
curl -sS "$V3/emails/$ID" -H "Authorization: Bearer $TOKEN" \
  | python3 -c "
import sys, json, re
d = json.load(sys.stdin)
body = (d.get('text_body') or '') + ' ' + (d.get('html_body') or '')
codes = re.findall(r'\b\d{4,8}\b', d.get('subject') or '') or re.findall(r'\b\d{4,8}\b', body)
print('subject:', d.get('subject'))
print('codes:', codes[:5])
"
```

This works for mail sent to `admin@priv.email` AND to `admin@v3-mail.priv.email`
— the apex alias dual-delivers into the same worker inbox (§6). *(Live-session
note: query the apex form too — see the findings block above.)*

## 2. Mail topology (as of 2026-08-25)

```
                       ┌─ Hotmail (ansgareutychis@hotmail.com)   ← unchanged, human reading
apex *@priv.email ──▶ ImprovMX ─┤
  (mx1/mx2.improvmx.com)        └─ admin@v3-mail.priv.email ─▶ CF Email Routing ─▶ v3 worker ─▶ D1
                                   (named aliases only: admin,                     (THIS skill reads
                                    support, noreply, billing,                      this via API)
                                    security)

v3-mail.priv.email ──▶ route1/2/3.mx.cloudflare.net ─▶ v3 worker ─▶ D1 (same inbox)
v4-mail.priv.email ──▶ route1/2/3.mx.cloudflare.net ─▶ v4 worker ─▶ D1 (v4 surface)
```

Key facts:

- The **v3 worker** (email-worker-v3-mail) stores every inbound email in D1:
  parsed text/html bodies, headers, attachments, raw MIME. **90-day retention**
  (swept daily at 03:00 UTC).
- **ImprovMX logs** keep metadata only, 7-day retention (§5).
- The apex catch-all (`*@priv.email` → Hotmail) deliberately does NOT chain
  into the worker (keeps spam out of the D1 store). Only the five named
  aliases dual-deliver (§6).

## 3. Secrets (only what this skill needs)

```
v3-mail API bearer token (QUERY_API_TOKEN):  a2df50bf1d1310903061cdd569b6a20a62717998dcfe52bf
v3-mail admin path:                          admin-8ed5b980
v3-mail admin password:                      ZTxyfEfjHEN7WlsjEs8S  (only needed for SPA cookie auth)
v4-mail API bearer token (QUERY_API_TOKEN):  e346edb6a4d28c2a488c03fbd85d15ad7c6bf53c55799369
v4-mail admin path:                          admin-9ceb402b
v4-mail admin password:                      WvGFSMcHyoVAjYVnzf0c
v4-mail admin session secret / v3 session secret: see deploy-secrets.json
ImprovMX API key:                            sk_691ff26633c94b0d80523433afe3a369
Base URLs:                                   https://v3-mail.priv.email  (worker)
                                             https://v4-mail.priv.email  (worker, separate inbox)
                                             https://api.improvmx.com/v3 (ImprovMX)
D1 database IDs:                             v3: fc0ca868-c198-4d25-b168-cfc21fb9d58d
                                             v4: f8e05326-9844-43ff-a55e-6aae727fe81f
```

Full generated credentials live in the mail-kit deploy secrets file
(`deploy-secrets.json` — handed over by the user 2026-08-25; the QUERY_API_TOKENs
above are committed to the extension's shipped defaults with the same blessing
as the ImprovMX key). Treat the bearer tokens as secrets: they can read every
stored email. The ImprovMX key additionally can delete aliases/domains —
highest sensitivity.

**Auth modes on the worker**:
1. **Bearer** (for agents/scripts): `Authorization: Bearer <QUERY_API_TOKEN>`
   — sufficient for all READ endpoints below.
2. **Admin session cookie** (for the SPA-only endpoints): `POST
   /admin-8ed5b980/login` with form body `password=<admin password>` →
   `pm_admin_session` cookie. `SameSite=Strict`, `HttpOnly`.

## 4. The v3-mail API — PRIMARY path (full email data)

### 4.1 Endpoint auth matrix

**Bearer token works** (use these from scripts):

| Endpoint | What it returns |
|---|---|
| `GET /emails?address=<addr>&limit=&before=&include_body=` | paginated list per recipient |
| `GET /emails/:id` | full detail: `text_body`, `html_body`, parsed `headers`, `proxy_token` |
| `GET /emails/:id/raw` | the exact original MIME bytes (`message/rfc822`) |
| `GET /emails/:id/attachments` | attachment metadata list |
| `GET /emails/:id/attachments/:attId` | one attachment's metadata |
| `GET /emails/:id/attachments/:attId/download` | attachment bytes |
| `DELETE /emails/:id` | soft delete (`?permanent=true` → hard delete) |
| `GET /emails/:id/proxy?url=…&t=…` | remote-image proxy (needs the scoped `t` token, see 4.6) |

**Admin cookie required** (browser/SPA things — rarely needed by agents):

`GET /emails/all` (cross-recipient list + `q` search), `GET /emails/unread-count`,
`GET /events` (SSE), `GET /recipients`, `GET /emails/threads`, `GET
/emails/stats`, `GET /emails/export`, `GET|PATCH /admin/config`, `PATCH
/emails/:id` (read/star), `POST /emails/:id/reply|forward|restore`, `POST
/emails/send`, `POST /emails/mark-all-read`.

*(Live-session note: the admin session cookie ALSO authenticates the bearer
endpoints — that's how the extension macro reads mail today.)*

### 4.2 List mail for an address

```
GET /emails?address=admin@v3-mail.priv.email&limit=20[&include_body=true][&before=<cursor>]
Authorization: Bearer <TOKEN>
```

Response (trimmed):

```json
{
  "results": [
    {
      "id": 2,
      "from_address": "bounces-imx+…@bounces.improvmx.net",   // ⚠ envelope, SRS-rewritten (§4.5)
      "from_header": "admin@priv.email",                       // ← the REAL sender
      "to_address": "admin@v3-mail.priv.email",
      "subject": "Chained forwarding test: …",
      "received_at": "2026-08-25T06:10:12.000Z",
      "raw_size": 8544, "has_attachments": 0, "is_read": 0, "is_starred": 0
    }
  ],
  "nextCursor": null, "count": 1, "include_body": false
}
```

- `address` is **required** (400 without it). It matches the stored
  `to_address` — the doc says use the **v3-mail form**, but the 2026-08-25
  live session measured chained mail stored under the **apex form**
  (`to_address = admin@priv.email`). **Query both forms** until the coming
  query-API unifies them.
- `include_body=true` adds `text_body`/`html_body` to every row (heavier).
- Pagination: pass `nextCursor` back as `?before=<cursor>`.
- `limit` default 50, clamped to 1–500.

### 4.3 Read one email (full body)

```
GET /emails/:id
```

Always includes `text_body`, `html_body`, parsed `headers` (JSON object:
`from`, `subject`, `authentication-results`, …), `proxy_token` (scoped,
2h image-proxy token), and flags. `raw_mime` is NOT included — use `/raw`.

### 4.4 Raw MIME + attachments

```bash
# exact original message (headers + bodies + attachments, as received)
curl -sS "$V3/emails/$ID/raw" -H "Authorization: Bearer $TOKEN" -o msg.eml

# list attachments, then download one
curl -sS "$V3/emails/$ID/attachments" -H "Authorization: Bearer $TOKEN"
curl -sS "$V3/emails/$ID/attachments/3/download" -H "Authorization: Bearer $TOKEN" -o file.pdf
```

### 4.5 ⚠ SRS gotcha: `from_address` vs `from_header`

Mail that arrived through the ImprovMX chain has an **SRS-rewritten envelope
sender** (`bounces-imx+…@bounces.improvmx.net`) — that's `from_address`. The
real originator is in `from_header` (list rows) and `headers.from` (detail).
**Filter by sender using `from_header`-style values, never `from_address`.**
Mail that arrived directly at `@v3-mail` has a normal envelope sender.

### 4.6 Search — where `q` works

`GET /emails` does **not** support `q` (it's silently ignored). Full-text
`q` search lives on the admin-cookie endpoints (`/emails/all`,
`/emails/export` — which also support `unread`, `starred`, `trashed`,
`since`, `until`). For bearer-only access, filter client-side over the
paginated list — the store is small (90-day retention).

### 4.7 Remote images in HTML bodies

`html_body` contains the sender's original remote image URLs. The UI loads
them through `GET /emails/:id/proxy?url=<encoded>&t=<proxy_token>` — the
`t` token comes from the detail response (2h, scoped to that email). For
code/link extraction you rarely need images at all.

### 4.8 Limits + retention

- **Retention**: 90 days (cron sweep 03:00 UTC; configurable via
  `/admin/config` `retention_days`, 0 = keep forever).
- **Rate limiting**: none configured on v3-mail (the rate-limiter binding is
  not bound) — still, poll sanibly (≥5s).
- **Message size**: CF Email Routing caps inbound at 25 MiB; raw MIME over
  1.5 MB needs the R2 bucket (not bound on this deployment — such mail is
  rejected with a logged error).

### 4.9 Admin-cookie login (when you DO need the cookie endpoints)

```bash
curl -sS -c cookies.txt -X POST "https://v3-mail.priv.email/admin-8ed5b980/login" \
  -d "password=<ADMIN_PASSWORD>"
# then:
curl -sS -b cookies.txt "https://v3-mail.priv.email/emails/all?q=github&limit=10"
```

Sending mail (`POST /emails/send`, admin cookie) goes out via the Resend
transport (DKIM-signed `priv.email`). See `.agents/SKILL.md` §11 for the
Resend specifics — sending is out of scope for this consumer skill.

## 5. The ImprovMX logs API — apex metadata (NO bodies)

**Confirmed against the full ImprovMX v3 API surface (2026-08-25)**: the logs
endpoints return `subject`, `sender`, `recipient`, `forward`, `events`,
`messageId`, `hostname`, `transport` — **and nothing else. There is no API
endpoint that returns a received email's body, HTML, or raw MIME.**
`GET /logs/:id` and `GET /logs/search` return the same metadata shape. The
body exists only where it was forwarded to (Hotmail, or the worker via the
§6 chain).

```
GET https://api.improvmx.com/v3/domains/priv.email/logs?take=20      (list)
GET https://api.improvmx.com/v3/domains/priv.email/logs/:id          (single — metadata)
GET https://api.improvmx.com/v3/domains/priv.email/logs/search?q=…   (search)
Auth: -u "api:sk_691ff26633c94b0d80523433afe3a369" (HTTP Basic)
```

What the logs ARE good for:
- **Delivery forensics** — `events[]` shows the SMTP conversation
  (`QUEUED` → `DELIVERED`/`DEFERRED`/`BOUNCED`) per destination. This is
  the authoritative answer to "did the email even arrive?" for ANY apex
  address.
- **Subject-line codes** — many services put the code in the subject; the
  logs surface it within seconds.
- **Catch-all visibility** — mail to random `*@priv.email` addresses shows
  up here (bodies remain Hotmail-only).

Limits: 7-day retention, ~10 req/min on logs (300 req/5min account-wide),
`take` max 100.

```bash
curl -sS -u "api:sk_691ff26633c94b0d80523433afe3a369" \
  "https://api.improvmx.com/v3/domains/priv.email/logs?take=20" \
  | python3 -c "
import sys, json, datetime
for log in json.load(sys.stdin).get('logs', []):
    ts = datetime.datetime.fromtimestamp(log['created']/1000, tz=datetime.timezone.utc)
    ev = [e['status'] for e in log.get('events', [])]
    print(f'[{ts:%Y-%m-%d %H:%M:%SZ}] {log[\"sender\"][\"email\"]} → {log[\"recipient\"][\"email\"]} {ev}')
    print(f'   {log.get(\"subject\", \"(none)\")[:110]}')
"
```

## 6. The apex→worker chain (how named aliases get full-body access)

**Configured + live-verified 2026-08-25.** The five named apex aliases
dual-deliver — ImprovMX forwards to BOTH Hotmail AND `admin@v3-mail.priv.email`
(the worker's CF Email Routing MX takes it from there):

```
admin@priv.email     → ansgareutychis@hotmail.com, admin@v3-mail.priv.email
support@priv.email   → ansgareutychis@hotmail.com, admin@v3-mail.priv.email
noreply@priv.email   → ansgareutychis@hotmail.com, admin@v3-mail.priv.email
billing@priv.email   → ansgareutychis@hotmail.com, admin@v3-mail.priv.email
security@priv.email  → ansgareutychis@hotmail.com, admin@v3-mail.priv.email
*@priv.email (catch-all) → ansgareutychis@hotmail.com   (NOT chained, by design)
```

Properties (all verified with a live round-trip test):

- **Hotmail delivery is unchanged** (comma-separated = fan-out to both).
- The worker receives the full email — bodies, attachments, raw MIME —
  readable via §4. Round-trip latency ≈ 10–25s (Resend → ImprovMX → worker).
- Free-plan limit: 5 destinations per alias (we use 2).
- Envelope sender is SRS-rewritten by ImprovMX (§4.5 gotcha applies).

**To chain another alias** (e.g. you want `foo@priv.email` readable):

```bash
curl -sS -X PUT "https://api.improvmx.com/v3/domains/priv.email/aliases/foo" \
  -u "api:sk_691ff26633c94b0d80523433afe3a369" -H "Content-Type: application/json" \
  -d '{"forward": "ansgareutychis@hotmail.com,admin@v3-mail.priv.email"}'
# (POST with the same body creates the alias if it doesn't exist — 25 slots, 6 used)
```

**Alternative for custom receivers — ImprovMX webhook destinations**: an
alias `forward` may also contain an `https://` URL; ImprovMX POSTs a JSON
payload per email (`text`, `html`, base64 `attachments[]`, parsed headers,
and with `?raw_mime=true` the full original MIME base64-encoded). Retries:
2 extra attempts on non-2xx, from static IP `15.237.103.194`. We don't use
this (the SMTP chain already feeds our worker), but it's the escape hatch
if you want full apex mail delivered to any HTTP endpoint without the
worker.

## 7. Practical patterns

### Pattern A — "get the code from the latest admin@ email"

See §1. Poll variant (every 10s for 2 min):

```bash
for i in $(seq 1 12); do
  OUT=$(curl -sS "$V3/emails?address=admin@v3-mail.priv.email&limit=1" \
        -H "Authorization: Bearer $TOKEN" \
        | python3 -c "
import sys, json
r = json.load(sys.stdin)['results']
print(f'{r[0][\"id\"]} {r[0][\"received_at\"]} {r[0][\"subject\"]}' if r else '')")
  [ -n "$OUT" ] && { echo "$OUT"; break; }
  sleep 10
done
```

### Pattern B — "did the email arrive at all?" (apex, any address)

Use the ImprovMX logs (§5) — delivery status for catch-all addresses too.
`DELIVERED` = handed to the destination MX (Hotmail landing in Junk is
normal — ImprovMX's forwarder signature breaks SPF alignment).

### Pattern C — "find mail from a specific sender"

```bash
curl -sS "$V3/emails?address=admin@v3-mail.priv.email&limit=50" \
  -H "Authorization: Bearer $TOKEN" \
  | python3 -c "
import sys, json
for r in json.load(sys.stdin)['results']:
    if 'github' in (r.get('from_header') or '').lower():
        print(r['id'], r['received_at'], r['subject'][:80])"
```

### Pattern D — "download an attachment"

```bash
curl -sS "$V3/emails/$ID/attachments" -H "Authorization: Bearer $TOKEN"   # get attId
curl -sS "$V3/emails/$ID/attachments/$ATTID/download" \
  -H "Authorization: Bearer $TOKEN" -o attachment.bin
```

## 8. Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| v3-mail `{"error":"Unauthorized"}` on bearer | Wrong/expired QUERY_API_TOKEN | Use the token from deploy secrets; header must be exactly `Authorization: Bearer <token>` |
| v3-mail 401 on `/emails/all`, `/emails/unread-count`, `/emails/export`, … | Admin-cookie-only endpoints | Login flow in §4.9, or stick to the bearer endpoints |
| v3-mail `{"error":"address query param required"}` | Missing `address` on `/emails` | Always pass `?address=<recipient>` |
| Chained apex mail not in the worker | Alias not dual-destination yet, or <30s since send | Check alias config (§6); wait — chain latency is 10–25s |
| Chained mail not matching `address=` | **Queried the v3-mail form but mail stored under the apex form (live finding, top of this doc)** | Query BOTH forms |
| Apex mail in ImprovMX logs but `BOUNCED`/`DEFERRED` events | Destination rejected | Read `events[].message` — the SMTP response tells you which leg failed |
| `DELIVERED` in logs but nothing in Hotmail | Hotmail Junk folder | Normal for forwarded mail (SPF alignment) — check Junk |
| Search `q=` returns everything on `/emails` | `q` is ignored on `/emails` (§4.6) | Use admin-cookie `/emails/all?q=…`, or filter client-side |
| Sender filter matches nothing | Used `from_address` (SRS-rewritten) | Filter on `from_header` / detail `headers.from` (§4.5) |
| Old mail gone from worker | 90-day retention sweep | Export via admin-cookie `/emails/export` if needed |
| Old logs gone from ImprovMX | 7-day log retention (free plan) | The worker store is the durable copy |
| ImprovMX 429 | ~10 req/min on logs | Sleep ≥5s between polls |

## 9. Rate limits + retention summary

| Surface | Retention | Rate limit |
|---|---|---|
| v3-mail API (D1 store) | 90 days (configurable) | none configured — poll ≥5s out of courtesy |
| ImprovMX logs | 7 days | ~10 req/min (logs), 300 req/5min account-wide |
| ImprovMX forwarding quota | — | 500 received emails/day (free plan) |

## 10. What NOT to do

- **Don't register with random catch-all addresses** (`foo@priv.email`) if you
  need programmatic body access — use a named alias (or chain a new one, §6).
- **Don't try to fetch bodies from ImprovMX** — no such endpoint exists
  (confirmed §5). The chain (§6) is the supported route.
- **Don't use `from_address` for sender filtering** on chained mail — it's
  the SRS bounce address (§4.5).
- **Don't send mail with the ImprovMX key** — free plan `daily_send=0`;
  outbound goes through the worker's Resend transport (§4.9).
- **Don't leak the bearer token or the ImprovMX key** — one reads all mail,
  the other can delete the domain.
- **Don't delete emails casually** — `DELETE /emails/:id?permanent=true` is
  irreversible and the worker store is the only durable copy past 7 days.

## 11. Quick reference

```bash
V3="https://v3-mail.priv.email"
T="Authorization: Bearer <v3-mail QUERY_API_TOKEN>"
IMX="api:sk_691ff26633c94b0d80523433afe3a369"

# --- v3-mail worker (full data) ---
curl -sS "$V3/emails?address=admin@v3-mail.priv.email&limit=20" -H "$T"   # list
curl -sS "$V3/emails?address=admin@priv.email&limit=20" -H "$T"           # list (apex form — live finding)
curl -sS "$V3/emails/42"                       -H "$T"                    # full body
curl -sS "$V3/emails/42/raw"                   -H "$T" -o msg.eml        # raw MIME
curl -sS "$V3/emails/42/attachments"           -H "$T"                    # attachments
# admin-cookie endpoints: login first (§4.9)

# --- ImprovMX (apex metadata, any address) ---
curl -sS -u "$IMX" "https://api.improvmx.com/v3/domains/priv.email/logs?take=20"
curl -sS -u "$IMX" "https://api.improvmx.com/v3/domains/priv.email/logs/search?q=github"
curl -sS -u "$IMX" "https://api.improvmx.com/v3/domains/priv.email/aliases"

# --- DNS sanity (Google DoH) ---
curl -sS "https://dns.google/resolve?name=priv.email&type=MX"             # apex → improvmx
curl -sS "https://dns.google/resolve?name=v3-mail.priv.email&type=MX"    # worker → cloudflare
```
