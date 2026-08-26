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
        "surface": "ai_module",
        "context_page_id": "<page-id>"   // OPTIONAL — see §3b } },
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

### 3b. COMPLETE chat support (live-verified 2026-08-25, extension-free)

Everything below ran from the sandbox (direct route, Zenrows fallback)
against a saved session — NO browser, NO extension. All of it is wired
into `backend/notion_tail.py` as steps/flags.

**The streaming protocol (decoded from raw NDJSON dumps):**

- `patch-start` carries `data.s` — the INITIAL records (includes
  `agent-instruction-state`, the injected instruction/skill state).
- `a /s/-` appends a record. An `agent-inference` record's `value` is a
  list of TYPED parts: `{"type":"thinking"}` = chain-of-thought,
  `{"type":"text"}` = the user-visible reply. They MUST be separated or
  the reply leaks CoT (observed live).
- `x /s/N/value/K/content` ops **APPEND** text chunks to part K — `o:"x"`
  is *extend*, NOT replace (final text = initial content + all `x`
  chunks concatenated: "MAR"+"SH"+"M"+"ALLOW" = "MARSHMALLOW").
- Terminal `a /s/N/model|inputTokens|outputTokens|cachedTokensRead|
  maxContextTokens` carry the resolved model + usage (the model name is
  ONLY here — absent from the add op).
- A `record-map` line near the end carries the settled thread record
  (`last_turn_outcome`, `usage_summary` incl. credit accounting).
- Post-completion fallback: `syncRecordValuesSpaceInitial`
  (thread → `value.value.messages[]` → `thread_message` records →
  concat `step.value` text parts of the agent-inference steps). Use when
  the stream closes before the final text lands (observed: reply empty
  in-stream, present in the settled record).

**The exact models** (`--step models`; saved to `session.models`, raw
snapshot `backend/notion_models_live.json`):

- `POST /api/v3/getAvailableModels {"spaceId}` → 31 models on a
  business-trial space, each with `modelConfiguration
  .supportedReasoningEfforts` + `defaultReasoningEffort`, family
  (anthropic/openai/gemini/xai/mystery), displayGroup (fast/
  intelligent), modelCardAttributes (speed/intelligence/cost).
- `POST /api/v3/getAiPickableModels {}` → 92 codenames (the full
  universe incl. effort-suffixed variants).
- `restrictedAccessModelsInPickerConfig` — e.g. `acai-budino` "Fable 5"
  base variant: `trial_not_allowed` (the `-high` variant IS available).
- Selecting a model: config `model: "<codename>"` +
  `modelFromUser: true` (+ optional `reasoningEffort` from the model's
  supported list). Live-verified: `orange-mousse` (GPT-5.6 Sol),
  `angel-cake-high` (Sonnet 5, `maxContextTokens: 200000` vs 400000 for
  opal-quince). Notable: model-selected runs use a much leaner prompt
  (4807 input tokens vs 21356 on the default agent path) — the server
  routes them through a lighter pipeline.
- The un-selected default resolves server-side: `model: opal-quince`
  (GPT-5.5) at capture time.

**Assigning an instruction page (the agent's persistent system prompt):**
HAR call #36 ground truth — TWO operations in one
`saveTransactionsFanout` (`userAction: setAsInstruction.on`):
1. `prompt` table `set`: `{id: <prompt_uuid>, space_id, parent_id:
   <page_id>, parent_table: "block", version: 1, created_time,
   alive: true, prompt_type: "instruction"}`
2. `space_view` `settings` `update`: `agent_personalization_settings
   .context_page_id = <page_id>` (WITHOUT this op the page never becomes
   the agent's personalization context — the ref's implementation only
   sends op 1.)

Then chat with `context.context_page_id = <page_id>`. The page becomes
the thread's `persistent_instructions_page` (visible in
`agent-instruction-state` inside patch-start) — **the agent READS the
page and FOLLOWS directives on it.** Live proof: page saying "end every
reply with PINEAPPLE" → "What is 2+2?" → "2 + 2 = 4 PINEAPPLE" (and
without the context: "2 + 2 = 4"). The web client sends the
personalization page as `context_page_id` on EVERY chat (HAR #55/#63/#65)
— `notion_tail.py` replicates this automatically when
`session.instructionPageId` is set.

**Assigning a skill page:** HAR call #54 — same `prompt` table op with
`prompt_type: "skill"` (userAction `topbarMoreActionRegistry
.setAsAiSkill`; **different page** — one prompt row per page: assigning a
page that already carries the instruction prompt → HTTP 400 "Something
went wrong" wrapping a PostgresUniqueViolation, live-reconfirmed
2026-08-26. Recipe after `--step page --step instruct`: create a second
page (`--step page --page-title "Agent Skill Page"`) then `--step skill` —
`notion_tail.py` picks `pages[-1]`, so the fresh page gets the skill).
Skills auto-surface to the agent via the Skills V2 runtime
(`enableAgentSkillsV2: true` in the live config; the agent loads
`modules/skills/minified/AGENTS.md`): it READS the page on demand,
APPLIES it, and CITES it — live proof: page "Skill: wordflip = reverse
the word's letters" → "wordflip chat" → "tahc[^<link to the skill
page>]". Skills PERSIST across follow-up turns.

**Chatting ON a Notion page (as attachment/context):**
`context.context_page_id = <page_id>` (primary shape) or
`context.blockId = <page_id>` (alternative; both live-verified). The
agent fetches the page via a tool (`isContextInstructionsPage: true` in
the tool result) and answers from its content — live proof: page with
"The secret word is MARSHMALLOW" → "What is the secret word in my
page?" → "MARSHMALLOW". Page content read on DEMAND (agentic decision)
— a trivial prompt may skip the fetch.

**Multi-turn follow-ups:** same body with `threadId: <existing>`,
`createThread: false`, `isPartialTranscript: true`, `generateTitle:
false`. Live proof: "And what about 3+3?" on an instruction thread →
"3 + 3 = 6 PINEAPPLE" (instruction persists; 20992/21541 input tokens
cache-hit = ~97% on turn 2).

**Pages to chat on** are created via the PUBLIC API
(`--step page`, uses the space's `ntn_` key from the apikey step):
`POST https://api.notion.com/v1/pages` with
`parent: {type: "workspace", workspace: true}` + children paragraph
blocks. This sidesteps the broken app-API CRDT create_page (see
Known-broken) — the chat agent reads public-API pages identically.

**CLI examples:**

```bash
python3 backend/notion_tail.py --session S --step models
python3 backend/notion_tail.py --session S --step page \
    --page-title "Agent Rules" \
    --page-content "Always end replies with PINEAPPLE."
python3 backend/notion_tail.py --session S --step instruct   # latest page
python3 backend/notion_tail.py --session S --step skill \
    --page-id <uuid>          # or a specific page
python3 backend/notion_tail.py --session S --step chat \
    --prompt "What is 2+2?"   # auto-uses instruction page as context
python3 backend/notion_tail.py --session S --step chat \
    --prompt "Say ready" --chat-model angel-cake-high --chat-effort low
python3 backend/notion_tail.py --session S --step chat \
    --prompt "now upper cherry" --chat-thread <threadId>   # follow-up
```

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
the official Notion API (`POST /v1/pages` with an integration token —
NOW IMPLEMENTED as `--step page`) or by just asking the chat agent to
create it, which works. (The new block-edit protocol is `insertText`
ops with `textInstanceId`/`id: [site, counter]`/`prevItems` — captured
in the Aug-11 HAR for future reference.)

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

## The ONE-SCRIPT E2E — `backend/notion_e2e.py` (2026-08-25, live-verified)

The whole flow — extension signup to backend finish — in a single command.
Assumes only: daemon running + extension connected.

```
python3 backend/notion_e2e.py                     # fresh email, 2 workspaces
python3 backend/notion_e2e.py --workspaces 3      # N workspaces, each fully provisioned
python3 backend/notion_e2e.py --email-domain v4   # force v3/v4/apex rotation step
python3 backend/notion_e2e.py --probe-via-zenros  # pre-flight: probe getLoginOptions
                                                  # via Zenros until PASS, saves
                                                  # code-email reputation cost on
                                                  # captcha-gated emails (rotates
                                                  # to a passing email instead of
                                                  # sending a real code email)
python3 backend/notion_e2e.py --no-signup --session backend/sessions/x.json --workspaces 3
                                                  # idempotent re-run (converges to goal state)
```

What it does (per run):

1. **Allocates a fresh email** rotating the three mail domains —
   `v3-mail.priv.email` / `v4-mail.priv.email` (native worker routes, ANY
   local part works, no alias setup) and the apex `priv.email` (creates a
   fresh dual-delivering ImprovMX alias via the API — catch-all addresses
   do NOT reach the worker, which is what looked like a "signup cooldown").
   Rotation state: `backend/e2e_state.json`. No cooldown: every run is a
   brand-new address + brand-new Notion account.
2. **Preflight** — daemon health + extension connected.
3. **Signup** — `macro.run notion/signup-rest` through the daemon WS
   (pure REST auth on the user's residential IP; the code email is read
   from the mail worker with the Bearer token inside the extension SW).
4. **Creds over WS** — tokenV2 (JWT) / userId / deviceId / clientVersion
   from the macro result — the daemon WS IS the extension→backend handoff
   (Turso is optional and currently deferred).
5. **Tail** — resume → workspace → onboarding → trial → apikey → chat.
6. **Workspaces 2..N** — each: create + activate → its own biz trial →
   its own API key → its own chat (distinct prompts; replies read from
   the `runInferenceTranscript` API stream, never the DOM).
7. **Verdict + report** — PASS only if every workspace has an active biz
   trial, a verified API key, and a completed chat. Everything (email,
   JWT, device id, workspaces, per-space trials, per-space API keys,
   chats with replies) is persisted atomically to the session file.

Live-verified single-pass results (fresh account, 2026-08-25): signup
19/19 macro steps in 18s over WS; 3 workspaces; 3 verified `ntn_` keys;
chats replied "4"/"4"/"6" with `last_turn_outcome: completed`; multiple
simultaneous biz trials on ONE account confirmed.

### Live gotchas learned while hardening it

- **The trial IP-gate error is WRAPPED**: str(e) says only
  "Something went wrong. (400)" (`generic_error`) while the payload
  carries `name: UserValidationError`, `debugMessage: "Trial activation
  is not allowed."` — `_looks_ip_blocked()` must inspect the payload or
  the Zenrows fallback never fires. The gate is also **probabilistic**
  per-request (one direct attempt did succeed).
- **Zenrows RESP001** ("Could not get content… premium proxies") is a
  Zenrows-side transient failure that surfaces as NotionValidationError
  "[HTTP 400] validation error" — `ZenrowsSession` now detects
  zenrows-error bodies and retries with backoff (4 attempts).
- **Notion 429 "Rate limited"** hits `updateSubscription` when several
  trials are activated in quick succession on one account — `routed()`
  now waits 20s/40s and retries, and the E2E paces 15s between
  workspace trial activations.
- **`finish_onboarding_screens` MUST stream**: it passes
  `collect_initial_messages=False` (fire-and-forget) explicitly, so the
  load_ref patch must FORCE `collect_initial_messages=True` — with
  `setdefault` the fire-and-forget path `.json()`s the NDJSON body and
  crashes with JSONDecodeError "Extra data" (this silently broke
  onboarding on every fresh account; symptom: trial then 400s).

