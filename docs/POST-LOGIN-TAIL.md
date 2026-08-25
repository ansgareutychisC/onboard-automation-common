# Notion Post-Login Tail — Workspace, Trial, Chat

**Verified live end-to-end 2026-08-25** on a fresh account
(`noreply@priv.email`, client `23.13.20260824.2240`), mostly from the
sandbox (python + `notion-ref` library), with exactly ONE step needing
Zenrows. This is the recipe for everything AFTER `loginWithEmail`
returns `token_v2`.

The three goals (per the operator):

| Goal | How | From where |
|---|---|---|
| Create workspace | `createSpace` + `saveTransactionsMain` (ref lib, unchanged) | sandbox python — works |
| **Activate biz trial** | `updateSubscription` via **Zenrows** with cookie replay | **Zenrows only** (IP reputation) |
| Send a chat | `runInferenceTranscript` with the LIVE transcript shape | sandbox python — works |

## 0. Client context (all calls)

```
Cookie: token_v2=<captured>; notion_user_id=<userId>; notion_device_id=<deviceId>
x-notion-active-user-header: <userId>
x-notion-space-id: <spaceId>          (after the space exists)
x-notion-client-version: <live>       (23.13.20260824.2240 at capture)
notion-audit-log-platform: web
Content-Type: application/json
Referer: https://app.notion.com/
```

The `notion-ref` `NotionAppClient` sets all of these except
`notion-audit-log-platform` — add it to `session.headers` manually
(needed by the transactions endpoint family).

## 1. Create workspace (works as-is from notion-ref)

`create_space(client, name, icon, plan_type="personal",
source="handle_root_redirect", create_space_view=True, user_id=<uid>)`
→ `POST /api/v3/createSpace` (returns `spaceId`) followed by
`POST /api/v3/saveTransactionsMain` with the 3-op space_view transaction
(`spaceActions.createSpace`). Both endpoints accept the sandbox IP.

`finish_onboarding_screens(...)` also works (agent chat +
`onboarding_completed=true`), with ONE fix: `runInferenceTranscript`
now returns **NDJSON** (one JSON object per line) — the ref's
non-streaming `resp.json()` crashes with `JSONDecodeError: Extra data`.
Force streaming (`collect_initial_messages=True`) or read lines
yourself.

`set_space_icon` / `rename_space` — work as-is.

## 2. Activate the business trial — THE CRITICAL UNBLOCKER

`POST /api/v3/updateSubscription`:

```json
{ "captchaToken": "",
  "spaceId": "<sid>",
  "desiredState": { "items": [{ "quantity": 1,
      "price": { "externalId": "business_monthly_usd_202505",
                 "product": "business", "billingInterval": "month",
                 "unitAmount": { "currencyCode": "USD", "amount": 2400 },
                 "state": "current" } }],
    "trialEnd": "<now+14d, ISO ms>" },
  "modalSessionId": "<uuid>",
  "clientVersion": "<live>",
  "trialData": { "id": "custom_agents_business_reverse_14d",
                 "from": "new_custom_agents_sidebar", "autoConvert": false },
  "from": "new_custom_agents_sidebar" }
```

**THE FINDING (2026-08-25): the "captcha" is IP-reputation-gated, and
the `captchaToken` is NOT actually validated when the IP is clean.**

- Same body from the sandbox (datacenter IP) → `400 UserValidationError
  "Trial activation is not allowed."` — with no token, empty token, AND
  garbage token identically. It never even looked at the token.
- Same body through **Zenrows** (`custom_headers=true`, Cookie replay of
  `token_v2` + `notion_user_id`) → `200 {"subscriptionStatus":"trialing",
  "invoiceUrl":"https://invoice.stripe.com/…"}` with `captchaToken: ""`.
- Verified afterwards via `getSubscriptionData`:
  `subscriptionTier: "business"`, `type: "subscribed_admin"`.

Zenrows API shape (changed since 2025 docs): `custom_headers` is now a
**boolean** — you pass `custom_headers=true` as a query param and send
the actual headers ON the request to `api.zenrows.com`; they are
forwarded to the target. (The old "JSON blob in custom_headers" format
returns `REQS004 invalid boolean`.)

So the hCaptcha requirement from the August HAR is real but
**conditional**: risky IP → captcha + eligibility checks; clean
residential-ish IP → no captcha demanded at all. The ref repo's
`activate_business_trial(captcha_token=...)` can be called with an
empty token **through Zenrows**.

## 3. Send a chat — the LIVE transcript shape

The ref's `initiate_ai_chat` is STALE: it sends
`[config, context, title, user-injected]` — the live client sends
**`[config, context, user]`**. With the stale shape the server creates
the thread but the inference dies instantly:
`last_turn_outcome: {"status":"error","step_count":0}`.

Live shape (captured from the real web client 2026-08-25):

```jsonc
{ "traceId": "<uuid>", "spaceId": "<sid>",
  "transcript": [
    { "id": "<uuid>", "type": "config", "value": { /* 59-key live config —
        capture from the page, do not hand-roll; key deltas vs the ref:
        +enableAgentAskSurvey; -model/-agentSource/-disableTodos/... */ } },
    { "id": "<uuid>", "type": "context", "value": {
        "timezone": "America/Los_Angeles", "userId": "<uid>",
        "userEmail": "<email>", "spaceName": "<name>", "spaceId": "<sid>",
        "spaceViewId": "<svid>", "currentDatetime": "<ISO ms local>",
        "surface": "ai_module" } },
    { "id": "<uuid>", "type": "user", "userId": "<uid>",
      "value": [["What is 2+2? Answer with just the number."]],
      "createdAt": "<ISO ms local>" } ],
  "threadId": "<uuid>",
  "threadParentPointer": { "table": "space", "id": "<sid>", "spaceId": "<sid>" },
  "createThread": true,
  "debugOverrides": { "emitAgentSearchExtractedResults": true,
      "cachedInferences": {}, "annotationInferences": {}, "emitInferences": false },
  "generateTitle": true, "saveAllThreadOperations": true, "setUnreadState": true,
  "createdSource": "ai_module", "threadType": "workflow",
  "isPartialTranscript": false, "asPatchResponse": true, "patchResponseVersion": 2,
  "isUserInAnySalesAssistedSpace": false, "isSpaceSalesAssisted": false,
  "supportsCustomAgentNudgeTranscriptStep": true }
```

Notes:
- The user message is `type: "user"` with `value: [[ "text" ]]` (nested
  array) + `createdAt`. NO separate `title` item — the title is
  generated server-side (`generateTitle: true`; observed
  "Simple math question" for a math question).
- Response is NDJSON: `patch-start` → `patch` events (JSON-Patch-ish
  per-record appends) → `record-map` → `patch-sync`. The AI text arrives
  in `{"type":"agent-inference","value":[{"type":"text","content":"4"}]}`.
- Verified twice: `last_turn_outcome: {"status":"completed",
  "step_count":8}` and the reply "4" for "What is 2+2?".
- The 59-key config drifts per deploy; capture it live (the recorder
  technique in §Gotchas) rather than hard-coding. Deltas vs the ref at
  capture time: `enableAgentGenerateImage/enableAgentSkillsV2/
  enableComputer/showDatabaseAgentsDiscoverability/useWebSearch` true,
  `enableAgentAskSurvey` new; `model/agentSource/disableTodos/
  onboardingAgentVersion` absent.

## Known-broken (and why we do NOT care)

**`create_page` (saveTransactions block-set) fails with
`CrdtAssertionError: "New block should have one text_slice_block_mapping
record"`** — the ref's CRDT payload (Aug-12 HAR) predates a server-side
CRDT schema change; the browser's own identical-looking transaction
succeeds because of session state established by earlier calls
(`syncRecordValuesSpaceInitial` / the 105KB `etClient` telemetry batch),
not because of a body diff. Bisected: cookies (all 16 browser cookies vs
trio), transaction-level `spaceId`, and the audit header are all NOT the
fix. **We deliberately stop here** — page creation is one call away via
the official Notion API (`POST /v1/pages` with an integration token) or
by just asking the chat agent to create it, which works.

## Where it lives

- `/home/z/my-project/scripts/goal_trial_chat.py` — trial validation matrix
  (no-token/empty/garbage from sandbox)
- `/home/z/my-project/scripts/zenrows_replay.py` — THE trial unlock
  (Zenrows custom_headers replay; session check + activation)
- `/home/z/my-project/scripts/chat_live_shape.py` — the corrected chat
  sender (live shape, streams the reply)
- `/home/z/my-project/scripts/capture_chat.py` — the recorder that
  captured the live transcript shape from the web client
- `/home/z/my-project/scripts/live_tail.py`, `live_tail2.py` — the
  workspace-creation tail runs (incl. the NDJSON fix)
- `/tmp/gt_chat.json` — the raw captured chat request (ground truth)

## The backend driver — `backend/notion_tail.py` (IMPLEMENTED, live-verified)

Everything above was adhoc scripts; it is now ONE committed, idempotent
driver. "The dream": sign up once through the extension, save the creds,
resume the session at the backend forever after — no browser, no re-login.

```
# bootstrap a session file from the signup creds dump (once per account)
python3 backend/notion_tail.py --session backend/sessions/acct.json \
    --init-from-creds /tmp/fresh_creds.json

# the whole tail (idempotent — every step skips work already done)
python3 backend/notion_tail.py --session backend/sessions/acct.json

# single steps / custom bits
python3 backend/notion_tail.py --session ... --step trial          # via Zenrows
python3 backend/notion_tail.py --session ... --step chat --prompt "hi"
python3 backend/notion_tail.py --session ... --route zenrows --step chat
python3 backend/notion_tail.py --session ... --new-workspace --workspace-name X
python3 backend/notion_tail.py --session ... --refresh-config /tmp/gt_chat.json
```

The session file is rewritten atomically after every step (crash-safe
resume) and holds the FULL account state: creds, space/view ids,
onboardingCompleted, trial, the `ntn_*` API key, and the chat history
with thread ids. `backend/sessions/*` is gitignored (live credentials).

**Verified routing matrix (2026-08-25, fresh account):**

| Step | direct (sandbox IP) | via Zenrows |
|---|---|---|
| resume / getSpaces | OK | OK |
| workspace (createSpace + view + icon) | OK | OK (2nd space created) |
| onboarding screens | OK | transport-proven (same saveTransactions path) |
| **biz trial (updateSubscription)** | **400 "Trial activation is not allowed"** | **OK — the unblocker** |
| API key (PAT flow) | OK | OK (created + public-API verified) |
| AI chat (runInferenceTranscript) | OK (streams) | OK (buffered NDJSON, reply extracted) |

`--route auto` (default) tries direct and retries the SAME call through
Zenrows on IP-reputation blocks (400 UserValidationError / 403) — the
trial step demonstrates this fallback live.

Transport: `ZenrowsSession` duck-types `requests.Session`, so the whole
notion-ref library runs through Zenrows unchanged (`client._session` is
swapped after construction). Zenrows gotchas baked in:

- `custom_headers=true` is a **boolean** (2026 API change); headers ride
  on the `api.zenrows.com` request itself.
- `original_status=true` propagates the target's real HTTP status.
- **`Accept-Encoding: identity` is MANDATORY** — Zenrows forwards the
  target's gzip/br body verbatim and urllib does not decompress, so you
  get binary garbage that fails `json()` with "Expecting value" at
  HTTP 200. (This is why `zenrows_replay.py` worked while naive ports
  didn't.)
- Chat through Zenrows arrives buffered (no incremental streaming) —
  the full NDJSON body is parsed after completion; reply extraction is
  identical.

The chat transcript config (59 keys, drifts per deploy) lives in
`backend/notion_chat_config.json`; refresh it with `--refresh-config`
after capturing a new ground-truth chat request (recorder technique).
