# SKILL-consumer.md — Check Emails from priv.email (ImprovMX)

> **Purpose**: read emails sent to `*@priv.email` to extract verification codes,
> login links, or other inbound mail content. This is a **consumer** skill — it
> does NOT develop the mail kit, deploy anything, or modify DNS.
>
> Use this when you need to "check the inbox at admin@priv.email" for a
> verification code that a service just sent.

## TL;DR — quick check

```bash
# List the last 20 emails received at any *@priv.email alias
curl -sS -u "api:sk_691ff26633c94b0d80523433afe3a369" \
  "https://api.improvmx.com/v3/domains/priv.email/logs?take=20" \
  | python3 -c "
import sys, json, datetime
d = json.load(sys.stdin)
for log in d.get('logs', []):
    ts = datetime.datetime.fromtimestamp(log['created']/1000, tz=datetime.timezone.utc).strftime('%Y-%m-%d %H:%M:%SZ')
    print(f'[{ts}] from={log[\"sender\"][\"email\"]} to={log[\"recipient\"][\"email\"]}')
    print(f'  subject: {log.get(\"subject\", \"(none)\")[:120]}')
    print(f'  forward_to: {log[\"forward\"][\"email\"]}  delivered: {any(e[\"status\"]==\"DELIVERED\" for e in log.get(\"events\",[]))}')
    print()
"
```

The output gives you sender, recipient, subject, delivery status. If a subject
contains the verification code, you're done — copy it out. If the code is in
the body (not the subject), see **§4 — Getting the body** below.

## 1. What this skill does NOT cover

- Deploying or modifying the mail kit (see `.agents/SKILL.md` for that)
- Sending email outbound (ImprovMX free plan cannot send — `daily_send=0`)
- Reading mail from the Hotmail inbox directly (we use ImprovMX's log API
  instead, which is faster and avoids Hotmail's Junk folder routing)
- Anything related to privatimail.com (the original v3 deployment, now
  blocked by Notion and other services after too many tests)

## 2. Setup — the priv.email mail flow

```
sender ─SMTP─▶ mx1/mx2.improvmx.com ─forward─▶ ansgareutychis@hotmail.com
                       │
                       └─also logs─▶ ImprovMX API (this skill reads this)
```

**All 6 active aliases** (each forwards to `ansgareutychis@hotmail.com`):
- `admin@priv.email`
- `support@priv.email`
- `noreply@priv.email`
- `billing@priv.email`
- `security@priv.email`
- `*@priv.email` (catch-all — anything else @priv.email)

When you register for a service using one of these addresses, the service
sends an email to that address → ImprovMX receives it on `mx1/mx2.improvmx.com`
→ ImprovMX forwards to Hotmail AND logs the email (subject, sender, events).
**The ImprovMX log API is the source of truth** — use it, not Hotmail.

## 3. Secrets (only what's needed for this skill)

```
ImprovMX API key:  sk_691ff26633c94b0d80523433afe3a369
Domain:            priv.email
```

**Auth**: HTTP Basic — `username: "api"`, `password: <api_key>`. The full
Authorization header is:

```
Authorization: Basic base64("api:sk_691ff26633c94b0d80523433afe3a369")
```

In curl: `-u "api:sk_691ff26633c94b0d80523433afe3a369"`.

## 4. API endpoints you'll use

### List recent emails (subject + sender + delivery status)

```
GET https://api.improvmx.com/v3/domains/priv.email/logs?take=20
```

Query params:
- `take=N` — number of logs to return (max 100, default 50)
- `skip=0` — pagination offset

**Response shape** (truncated to the useful fields):

```json
{
  "success": true,
  "logs": [
    {
      "created": 1787615086101,        // epoch ms
      "subject": "Your verification code is 123456",
      "sender": { "email": "noreply@example.com", "name": null },
      "recipient": { "email": "admin@priv.email", "name": null },
      "forward": { "email": "ansgareutychis@hotmail.com", "name": null },
      "events": [
        { "status": "QUEUED",   "code": 250, "message": "2.0.0 Email queued for forwarding." },
        { "status": "DELIVERED", "code": 250, "message": "2.6.0 ... Queued mail for delivery -> 250 2.1.5" }
      ],
      "messageId": "<...@example.com>",
      "id": "20260824234447.a5e7125e31ca4b4891b74e4ed95151a2"
    }
  ]
}
```

**Note on delivery status**:
- `DELIVERED` = ImprovMX successfully handed off to Hotmail's MX. It does
  NOT mean it landed in inbox — Hotmail's spam filter often routes
  ImprovMX-forwarded mail to **Junk**. Always check the ImprovMX log API,
  not Hotmail, when looking for a verification code.
- `QUEUED` only = ImprovMX received the email but hasn't completed forwarding
  yet. Wait 10-30s and re-query.
- `BOUNCED` / `DEFERRED` = delivery issue; check the `events[]` `message`
  field for the SMTP response from Hotmail.

### Filter by alias (recipient)

The API doesn't support server-side filtering by recipient, but you can
filter client-side. To find emails sent to `admin@priv.email` only:

```bash
curl -sS -u "api:sk_691ff26633c94b0d80523433afe3a369" \
  "https://api.improvmx.com/v3/domains/priv.email/logs?take=50" \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
for log in d.get('logs', []):
    if log['recipient']['email'] == 'admin@priv.email':
        print(f'{log[\"subject\"]} (from {log[\"sender\"][\"email\"]})')
"
```

### Get a single email's full body

**Important limitation**: the ImprovMX `/logs` endpoint returns metadata
(subject, sender, recipient, events) but NOT the email body. If the
verification code is in the body rather than the subject, you have two
options:

1. **Check Hotmail directly** — log into `ansgareutychis@hotmail.com` (you
   need the Hotmail account password, which is NOT in this skill — the user
   must check manually). Remember to check the **Junk folder** first.
2. **Use the email's `messageId`** to correlate with Hotmail's inbox via
   IMAP/Graph API (requires Hotmail credentials — out of scope here).

**Practical tip**: most verification code emails put the code in the subject
line (e.g., `"Your code is 123456"` or `"123456 is your verification code"`).
Check the subject first — it's usually enough.

### Get domain verification status (sanity check)

```
GET https://api.improvmx.com/v3/domains/priv.email
```

Returns `{ domain: { active: true/false, ... } }`. If `active: false`,
ImprovMX's own verification check hasn't passed — but forwarding still
works (it's just ImprovMX's internal status flag).

## 5. Practical patterns

### Pattern A: "I just registered at service X with admin@priv.email — get the code"

```bash
# Wait ~10s for the email to arrive, then:
curl -sS -u "api:sk_691ff26633c94b0d80523433afe3a369" \
  "https://api.improvmx.com/v3/domains/priv.email/logs?take=3" \
  | python3 -c "
import sys, json, datetime, re
d = json.load(sys.stdin)
now = datetime.datetime.now(datetime.timezone.utc)
for log in d.get('logs', []):
    ts = datetime.datetime.fromtimestamp(log['created']/1000, tz=datetime.timezone.utc)
    age_sec = (now - ts).total_seconds()
    if age_sec < 120:  # last 2 minutes
        print(f'[{int(age_sec)}s ago] from={log[\"sender\"][\"email\"]}')
        print(f'  subject: {log[\"subject\"]}')
        # extract 4-8 digit codes from subject
        codes = re.findall(r'\\b\\d{4,8}\\b', log['subject'])
        if codes:
            print(f'  codes found: {codes}')
"
```

### Pattern B: "Poll until the email arrives"

```bash
# Poll every 10s for up to 2 minutes
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  echo "--- attempt $i ---"
  curl -sS -u "api:sk_691ff26633c94b0d80523433afe3a369" \
    "https://api.improvmx.com/v3/domains/priv.email/logs?take=1" \
    | python3 -c "
import sys, json, datetime
d = json.load(sys.stdin)
if d.get('logs'):
    log = d['logs'][0]
    ts = datetime.datetime.fromtimestamp(log['created']/1000, tz=datetime.timezone.utc)
    age = (datetime.datetime.now(datetime.timezone.utc) - ts).total_seconds()
    print(f'latest: {int(age)}s ago — {log[\"subject\"][:80]}')
"
  sleep 10
done
```

### Pattern C: "Find a specific sender's email"

```bash
curl -sS -u "api:sk_691ff26633c94b0d80523433afe3a369" \
  "https://api.improvmx.com/v3/domains/priv.email/logs?take=50" \
  | python3 -c "
import sys, json
sender_filter = 'noreply@github.com'  # change me
d = json.load(sys.stdin)
for log in d.get('logs', []):
    if sender_filter in log['sender']['email']:
        print(f'  {log[\"subject\"]}')
        print(f'    from: {log[\"sender\"][\"email\"]}')
        print(f'    to:   {log[\"recipient\"][\"email\"]}')
"
```

## 6. Common failure modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| `{"code":401,"error":"Authentication required"}` | Wrong API key / wrong Basic Auth format | Use `-u "api:sk_691ff26633c94b0d80523433afe3a369"` in curl (username `api`, password = the key) |
| `{"code":404,"error":"Not found."}` | Wrong domain in URL | URL must be `/v3/domains/priv.email/logs` (not `/v3/logs/priv.email`) |
| Logs show `QUEUED` but not `DELIVERED` after 30s | Hotmail MX is slow / greylisting | Wait 1-2 min and re-query. The email is in ImprovMX's queue — it WILL be delivered. |
| Logs show `DELIVERED` but no code visible in subject | Code is in the email body, not subject | Either extract via Hotmail IMAP (out of scope) or look at the email's plaintext body via ImprovMX dashboard (https://app.improvmx.com) |
| No new logs at all after triggering a send | Email hasn't reached ImprovMX yet — sender's MTA may be slow / blocked | Verify sender actually sent it. Check DNS: `curl -sS "https://dns.google/resolve?name=priv.email&type=MX"` should return mx1/mx2.improvmx.com |
| Logs older than expected | ImprovMX free plan retains logs for **7 days only** (`email_log_retention_days: 7`) | If you need older mail, check Hotmail directly (Junk folder) |
| Rate limit (HTTP 429) | ImprovMX free plan: 300 req/5min, 10 req/min on /logs endpoint | Add `sleep 5` between polls; don't hammer the API |

## 7. Rate limits (free plan)

From the account response (`GET /v3/account`):

- **API rate limit**: 300 requests / 5 min (account-wide)
- **Log endpoint**: ~10 req / min (empirical — back off if 429)
- **Log retention**: 7 days (`email_log_retention_days: 7`)
- **Aliases**: 25 max (currently using 6)
- **Domains**: 1 max (priv.email)
- **Daily receive quota**: 500 emails/day

**Practical guidance**: when polling for a verification code, poll every
10s (not faster). The email usually arrives within 5-30s of the sender
triggering it. If you don't see it after 2 min, the sender likely had an
issue — verify with the sender's side.

## 8. What you should NOT do

- **Don't try to send email** — ImprovMX free plan has `daily_send=0`. For
  outbound, use Resend (see `.agents/SKILL.md` for Resend integration).
- **Don't modify aliases or domain settings** — this is a consumer skill.
  Use `mail-kit teardown` / `mail-kit apply` if you need to change the setup.
- **Don't rely on Hotmail's inbox** — ImprovMX forwards using its own sender
  signature, so SPF alignment fails and Hotmail routes most forwarded mail
  to **Junk**. Use the ImprovMX log API instead.
- **Don't query logs older than 7 days** — they're gone (free plan
  retention). If you need a permanent record, copy them to your own storage.
- **Don't share the API key** — it has full account access (can delete
  aliases, delete the domain, etc.). Treat it as a secret.

## 9. Quick reference

```bash
# ImprovMX API base
API_BASE="https://api.improvmx.com/v3"
AUTH="api:sk_691ff26633c94b0d80523433afe3a369"
DOMAIN="priv.email"

# Recent emails
curl -sS -u "$AUTH" "$API_BASE/domains/$DOMAIN/logs?take=20"

# Domain status (verification flag)
curl -sS -u "$AUTH" "$API_BASE/domains/$DOMAIN"

# List aliases
curl -sS -u "$AUTH" "$API_BASE/domains/$DOMAIN/aliases"

# DNS check (Google DoH — no dig needed)
curl -sS "https://dns.google/resolve?name=$DOMAIN&type=MX"
```

## 10. Integration with the onboard-automation extension

When writing a macro that needs to poll for a verification email at
`*@priv.email`, use the ImprovMX `/logs` endpoint (NOT the old
`mail-api.privatimail.com` worker). The macro's `extractionJs` should:

1. `fetch` the `/logs?take=5` endpoint with the `Authorization: Basic` header
2. Parse the JSON response, filter by recipient + age
3. Extract the code from the **subject** first (most common)
4. Fall back to body parsing only if the subject has no code (requires
   Hotmail access — out of scope for the macro)

Example extraction JS for a Notion-style 6-char alphanumeric code in the
subject:

```js
(args) => {
  const data = JSON.parse(args.body);
  const logs = data.logs || [];
  const sinceMs = args.sinceMs || 0;
  for (const log of logs) {
    if (sinceMs && log.created < sinceMs) continue;
    if (args.recipient && log.recipient.email !== args.recipient) continue;
    const subj = log.subject || '';
    // Notion: "Your login code is ABC123" or "ABC123 is your verification code"
    const m = subj.match(/([0-9A-Za-z]{6})\s+is\s+your|your\s+(?:login\s+)?code\s+is\s+([0-9A-Za-z]{6})/i);
    if (m) return { code: m[1] || m[2], source: 'improvmx-subject', logId: log.id };
  }
  return { code: null, source: 'not-found', logCount: logs.length };
}
```

**Important**: the macro `inputs` must include:
- `emailWorkerUrl`: `https://api.improvmx.com/v3/domains/priv.email/logs?take=20`
  (the full inbox endpoint — the shared email chunk fetches it verbatim)
- `emailWorkerToken`: `api:sk_691ff26633c94b0d80523433afe3a369` (raw Basic pair —
  the chunk's `email-auth` step base64-encodes it into the Authorization header;
  a ready-made `Basic ...`/`Bearer ...` header value also works)
- `email`: the specific alias used (e.g. `admin@priv.email`)

The popup's **Email & Storage config panel** (IMPLEMENTED) has fields for
`emailWorkerUrl` + `emailWorkerToken` — configure once, and every email-flow
preset pre-fills and runs with them (per-run inputs still win if set).
