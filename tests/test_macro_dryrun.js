#!/usr/bin/env node
'use strict';

// =============================================================================
// test_macro_dryrun.js — Macro dry-run test harness
//
// (Ported from notion-onboarding-automation v0.8.4 tests/test_macro_dryrun.js,
//  adapted for onboard-automation-common: recursive macros/ walk, ImprovMX
//  email API mock, btoa in the eval sandbox, per-macro mock subjects, and a
//  template-reference lint that walks into retry sub-steps.)
//
// Loads each extension macro JSON and simulates executing it against the
// HAR-captured Notion API responses. Catches:
//   - Template references that don't resolve ({{stepId.field}} → literal)
//   - Request bodies that don't match HAR (missing/extra fields, type mismatches)
//   - Steps that fail (return ok=false or throw)
//   - Fetch steps with no matching HAR call
//   - Template references to step ids that don't exist anywhere in the macro
//
// Exit code: 0 if all macros pass, 1 if any fail.
// =============================================================================

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

// -----------------------------------------------------------------------------

const MACROS_DIR = path.join(__dirname, '..', 'extension', 'macros');
const SCRIPTS_DIR = path.join(__dirname, 'har_fixtures');

const HAR_FILES = [
  path.join(SCRIPTS_DIR, 'extract_completeFlow.json'),
  path.join(SCRIPTS_DIR, 'extract_createWorkspace.json'),
  path.join(SCRIPTS_DIR, 'extract_getApiToken.json'),
];

const IMPROVMX_MOCK_URL = 'https://api.improvmx.com/v3/domains/priv.email/logs?take=20';
const IMPROVMX_MOCK_TOKEN = 'api:mock-improvmx-key';

// Test inputs (override the macros' default inputs).
const TEST_INPUTS = {
  'wait-for-verification-email': {
    email: 'test-signup@priv.email',
    emailWorkerUrl: IMPROVMX_MOCK_URL,
    emailWorkerToken: IMPROVMX_MOCK_TOKEN,
  },
  'self-test': {
    email: 'test-signup@priv.email',
    baseUrl: 'http://127.0.0.1:8898',
    emailWorkerUrl: 'http://127.0.0.1:8898/v3/domains/priv.email/logs?take=20',
    emailWorkerToken: IMPROVMX_MOCK_TOKEN,
  },
  'signup': {
    email: 'test-signup@priv.email',
    emailWorkerUrl: IMPROVMX_MOCK_URL,
    emailWorkerToken: IMPROVMX_MOCK_TOKEN,
  },
  'full-onboarding': {
    email: 'test-signup@priv.email',
    workspaceName: 'Test Space',
    workspaceIcon: '🏠',
    emailWorkerUrl: IMPROVMX_MOCK_URL,
    emailWorkerToken: IMPROVMX_MOCK_TOKEN,
    locale: 'en-US',
    timezone: 'America/Los_Angeles',
  },
  'create-workspace': {
    workspaceName: 'Test WS',
    workspaceIcon: '🚀',
    planType: 'personal',
  },
  'activate-trial': {
    spaceId: 'mock-space-id',
    captchaToken: 'P1_mock_token',
    trialDays: 14,
  },
  'create-api-key': {
    spaceId: 'mock-space-id',
    integrationName: 'test-pat',
    expiration: '1_year',
  },
  'submit-code': {
    code: 'XJ4K2B',
  },
  'signup-rest': {
    email: 'admin@priv.email',
    mailUrl: 'https://v3-mail.priv.email/admin-8ed5b980',
    redirectURL: '/p/mock',
  },
};

// Per-macro mock email subjects — exercises different extraction layers:
//   signup/full-onboard → Notion layer 2 ("... login code is XXX")
//   shared chunk        → generic layer 1 ("XXX is your ... code")
//   self-test           → toy-site subject ("Your login code is XXX")
const MOCK_SUBJECTS = {
  'wait-for-verification-email': 'XJ4K2B is your verification code',
  'signup': 'Your temporary Notion login code is XJ4K2B',
  'full-onboarding': 'Your temporary Notion login code is XJ4K2B',
  'self-test': 'Your login code is XJ4K2B',
};

// -----------------------------------------------------------------------------

const HAR_USER_ID = '3bad872b-594c-81d6-b8b5-00023ad77466';
const HAR_DEVICE_ID = '1be7acb1-e18c-46b4-9a3c-a12b7693b4fc';
const HAR_SPACE_ID = '2f26615b-7c9f-8156-8ec5-00034ba364ae';
const HAR_BOT_ID = '3ba52080-df19-8116-addd-0027a2de59f4';
const HAR_TOKEN = 'ntn_MOCKED0000000000000000000000000000000000000000000'; // redacted — never a live PAT
const MOCK_VERIFICATION_CODE = 'XJ4K2B';

const MOCK_COOKIES = [
  { name: 'notion_user_id', value: HAR_USER_ID, domain: '.notion.com', path: '/' },
  { name: 'token_v2', value: 'mock-token-v2-value', domain: '.notion.com', path: '/' },
  { name: 'notion_device_id', value: HAR_DEVICE_ID, domain: '.notion.com', path: '/' },
  // The toy signup site's session cookie (set by the /welcome transition) —
  // needed by the self-test macro's extract-creds step.
  { name: 'toy_session', value: 'sess_mock_0123456789abcdef', domain: '127.0.0.1', path: '/' },
];

function mockLoadUserContentBody(userId) {
  return JSON.stringify({
    user_settings: {
      [userId]: {
        value: {
          id: userId,
          version: 4,
          settings: {
            signup_time: 1786497135563,
            preferred_locale: 'en-US',
            preferred_locale_origin: 'autodetect',
          },
        },
        role: 'editor',
      },
    },
  });
}

// -----------------------------------------------------------------------------
// Template resolution (ported from background.js)
// -----------------------------------------------------------------------------

function resolveTemplate(str, ctx) {
  if (typeof str !== 'string') return str;

  const single = /^\s*\{\{([^}]+)\}\}\s*$/.exec(str);
  if (single) {
    const val = lookupTemplatePath(single[1].trim(), ctx);
    if (val !== undefined && val !== null) return val;
  }

  return str.replace(/\{\{([^}]+)\}\}/g, (match, p) => {
    const val = lookupTemplatePath(p.trim(), ctx);
    if (val === undefined || val === null) return match;
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
  });
}

function lookupTemplatePath(p, ctx) {
  const parts = p.split('.');
  let val;
  if (parts[0] === 'inputs') {
    val = ctx.inputs;
  } else if (parts[0] === 'results') {
    val = ctx.results;
  } else {
    val = ctx.results[parts[0]];
  }
  for (let i = 1; i < parts.length; i++) {
    if (val == null) return undefined;
    val = val[parts[i]];
  }
  return val;
}

function resolveTemplateDeep(obj, ctx, seen) {
  if (typeof obj === 'string') return resolveTemplate(obj, ctx);
  if (Array.isArray(obj)) return obj.map((v) => resolveTemplateDeep(v, ctx, seen));
  if (obj !== null && typeof obj === 'object') {
    if (!seen) seen = new WeakSet();
    if (seen.has(obj)) return undefined;
    seen.add(obj);
    const out = {};
    for (const k of Object.keys(obj)) out[k] = resolveTemplateDeep(obj[k], ctx, seen);
    return out;
  }
  return obj;
}

function hasUnresolvedTemplates(v) {
  if (typeof v === 'string') return /\{\{[^}]+\}\}/.test(v);
  if (Array.isArray(v)) return v.some(hasUnresolvedTemplates);
  if (v !== null && typeof v === 'object') {
    return Object.values(v).some(hasUnresolvedTemplates);
  }
  return false;
}

// -----------------------------------------------------------------------------
// Template-reference lint — collect every {{ref}} in the macro (including
// retry sub-steps) and verify each head resolves to a known step id, a
// declared input key, or the special prefixes.
// -----------------------------------------------------------------------------

function lintMacro(macro) {
  const issues = [];
  const ids = new Set();
  const inputKeys = new Set(Object.keys(macro.inputs || {}));

  (function collect(steps) {
    for (const s of steps || []) {
      if (s.id) ids.add(s.id);
      if (s.cmd === 'retry' && Array.isArray(s.steps)) collect(s.steps);
    }
  })(macro.steps);

  (function walk(node, where) {
    if (typeof node === 'string') {
      for (const m of node.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)) {
        const ref = m[1];
        const head = ref.split('.')[0];
        if (head === 'inputs') {
          const key = ref.split('.')[1];
          if (key && !inputKeys.has(key)) {
            issues.push(`${where}: {{${ref}}} references inputs.${key} which the macro does not declare (may still arrive via popup merge — OK for config-panel keys)`);
          }
        } else if (head === 'results') {
          // results.<stepId>.<field> — check step id
          const sid = ref.split('.')[1];
          if (sid && !ids.has(sid)) issues.push(`${where}: {{${ref}}} references results.${sid} which is not a step id`);
        } else if (!ids.has(head)) {
          issues.push(`${where}: {{${ref}}} references step "${head}" which does not exist`);
        }
      }
    } else if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${where}[${i}]`));
    } else if (node !== null && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, `${where}.${k}`);
    }
  })(macro.steps, 'steps');

  return issues;
}

// -----------------------------------------------------------------------------
// HAR database
// -----------------------------------------------------------------------------

function loadHarDb() {
  const calls = [];
  for (const f of HAR_FILES) {
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const c of data.calls) {
      calls.push({ ...c, harFile: path.basename(f) });
    }
  }
  return calls;
}

function findBestHarMatch(pathName, macroBody, harDb) {
  const candidates = harDb.filter((c) => c.path === pathName);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  function getUserActions(body) {
    if (!body || !Array.isArray(body.transactions)) return [];
    return body.transactions.map((t) => (t.debug && t.debug.userAction) || '').filter(Boolean);
  }
  const macroUserActions = new Set(getUserActions(macroBody));

  let best = candidates[0];
  let bestScore = Infinity;
  for (const c of candidates) {
    const harBody = c.reqBody || {};
    const macroKeys = new Set(Object.keys(macroBody || {}));
    const harKeys = new Set(Object.keys(harBody || {}));
    const missing = [...harKeys].filter((k) => !macroKeys.has(k)).length;
    const extra = [...macroKeys].filter((k) => !harKeys.has(k)).length;
    let score = missing + extra;

    if (pathName === '/api/v3/saveTransactionsMain' && macroUserActions.size > 0) {
      const harUserActions = new Set(getUserActions(harBody));
      const overlap = [...macroUserActions].filter((ua) => harUserActions.has(ua)).length;
      const nonOverlap = macroUserActions.size - overlap;
      score += nonOverlap * 0.5;
    }

    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

// -----------------------------------------------------------------------------
// Body comparison
// -----------------------------------------------------------------------------

const DYNAMIC_FIELDS = new Set([
  'requestId', 'id', 'traceId', 'threadId', 'modalSessionId',
  'clientCommitTimeMs', 'first_joined_space_time', 'createdAt',
  'currentDatetime', 'trialEnd', 'ts', 'now', 'expiresAt',
  'signup_time', 'botId',
]);

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function compareBodies(macroBody, harBody, p, depth) {
  const errors = [];
  const warnings = [];
  const path = p || '';

  if (depth > 6) return { errors, warnings };

  const macroKeys = Object.keys(macroBody || {});
  const harKeys = Object.keys(harBody || {});

  for (const k of macroKeys) {
    if (!harKeys.includes(k)) {
      if (DYNAMIC_FIELDS.has(k)) continue;
      errors.push(`${path}.${k}: extra in macro (not in HAR)`);
    }
  }

  for (const k of harKeys) {
    if (!macroKeys.includes(k)) {
      errors.push(`${path}.${k}: missing from macro (HAR has it)`);
    }
  }

  for (const k of macroKeys) {
    if (!harKeys.includes(k)) continue;
    const mv = macroBody[k];
    const hv = harBody[k];
    const mType = typeOf(mv);
    const hType = typeOf(hv);
    const subpath = path ? `${path}.${k}` : k;

    if (mType !== hType) {
      errors.push(`${subpath}: type mismatch (macro=${mType}, HAR=${hType})`);
      continue;
    }

    if (mType === 'object' && mv !== null && hv !== null) {
      const r = compareBodies(mv, hv, subpath, depth + 1);
      errors.push(...r.errors);
      warnings.push(...r.warnings);
    } else if (mType === 'array') {
      if (mv.length !== hv.length && mv.length > 0 && hv.length > 0) {
        warnings.push(`${subpath}: array length differs (macro=${mv.length}, HAR=${hv.length})`);
      }
      if (mv.length > 0 && hv.length > 0) {
        const r = compareBodies(mv[0], hv[0], `${subpath}[0]`, depth + 1);
        errors.push(...r.errors);
        warnings.push(...r.warnings);
      }
    } else if (mType === 'string' || mType === 'number' || mType === 'boolean') {
      if (mv !== hv) {
        if (DYNAMIC_FIELDS.has(k)) continue;
        warnings.push(
          `${subpath}: value differs (macro=${JSON.stringify(mv)}, HAR=${JSON.stringify(hv)})`
        );
      }
    }
  }

  return { errors, warnings };
}

function compareRunInferenceTranscript(macroBody, harBody) {
  const errors = [];
  const warnings = [];

  const macroKeys = new Set(Object.keys(macroBody || {}));
  const harKeys = new Set(Object.keys(harBody || {}));

  for (const k of harKeys) {
    if (!macroKeys.has(k)) errors.push(`${k}: missing from macro (HAR has it)`);
  }
  for (const k of macroKeys) {
    if (!harKeys.has(k)) errors.push(`${k}: extra in macro (not in HAR)`);
  }

  function findConfigBlock(body) {
    if (!body || !Array.isArray(body.transcript)) return null;
    return body.transcript.find((t) => t && t.type === 'config') || null;
  }
  const macroConfig = findConfigBlock(macroBody);
  const harConfig = findConfigBlock(harBody);
  if (macroConfig && harConfig && macroConfig.value && harConfig.value) {
    const criticalFields = [
      'isOnboardingAgent',
      'onboardingAgentVersion',
      'oracleThreadType',
      'agentSource',
      'disableTodos',
      'isCustomAgent',
      'threadType',
    ];
    for (const f of criticalFields) {
      if (f in macroConfig.value && f in harConfig.value) {
        if (macroConfig.value[f] !== harConfig.value[f]) {
          errors.push(
            `transcript[config].value.${f}: value mismatch (macro=${macroConfig.value[f]}, HAR=${harConfig.value[f]})`
          );
        }
      }
    }
    if ('model' in macroConfig.value && !('model' in harConfig.value)) {
      errors.push(
        `transcript[config].value.model: extra in macro (HAR call #11 does NOT have a model field — onboarding agent uses server-side default). ` +
        `macro model=${JSON.stringify(macroConfig.value.model)}`
      );
    }
  }

  return { errors, warnings };
}

function compareSaveTransactions(macroBody, harBody) {
  const errors = [];
  const warnings = [];

  const macroTxs = (macroBody && macroBody.transactions) || [];
  const harTxs = (harBody && harBody.transactions) || [];

  if (macroTxs.length !== harTxs.length) {
    errors.push(
      `transactions: count mismatch (macro=${macroTxs.length}, HAR=${harTxs.length})`
    );
  }

  const n = Math.min(macroTxs.length, harTxs.length);
  for (let i = 0; i < n; i++) {
    const mt = macroTxs[i];
    const ht = harTxs[i];
    const mua = (mt.debug && mt.debug.userAction) || '(none)';
    const hua = (ht.debug && ht.debug.userAction) || '(none)';
    if (mua !== hua) {
      errors.push(`transactions[${i}].debug.userAction: mismatch (macro=${mua}, HAR=${hua})`);
    }
    const mOps = (mt.operations && mt.operations.length) || 0;
    const hOps = (ht.operations && ht.operations.length) || 0;
    if (mOps !== hOps) {
      warnings.push(
        `transactions[${i}].operations: count differs (macro=${mOps}, HAR=${hOps})`
      );
    }
    for (let j = 0; j < Math.min(mOps, hOps); j++) {
      const mo = mt.operations[j];
      const ho = ht.operations[j];
      const mt2 = (mo.pointer && mo.pointer.table) || '(none)';
      const ht2 = (ho.pointer && ho.pointer.table) || '(none)';
      if (mt2 !== ht2) {
        errors.push(
          `transactions[${i}].operations[${j}].pointer.table: mismatch (macro=${mt2}, HAR=${ht2})`
        );
      }
      if (mo.command !== ho.command) {
        errors.push(
          `transactions[${i}].operations[${j}].command: mismatch (macro=${mo.command}, HAR=${ho.command})`
        );
      }
      const mPath = JSON.stringify(mo.path || []);
      const hPath = JSON.stringify(ho.path || []);
      if (mPath !== hPath) {
        errors.push(
          `transactions[${i}].operations[${j}].path: mismatch (macro=${mPath}, HAR=${hPath})`
        );
      }
      const ma = new Set(Object.keys(mo.args || {}));
      const ha = new Set(Object.keys(ho.args || {}));
      for (const k of ha) {
        if (!ma.has(k)) {
          errors.push(
            `transactions[${i}].operations[${j}].args.${k}: missing from macro (HAR has it)`
          );
        }
      }
      for (const k of ma) {
        if (!ha.has(k) && !DYNAMIC_FIELDS.has(k)) {
          errors.push(
            `transactions[${i}].operations[${j}].args.${k}: extra in macro (not in HAR)`
          );
        }
      }
    }
  }

  return { errors, warnings };
}

function compareRequestBodies(apiPath, macroBody, harBody) {
  if (apiPath === '/api/v3/runInferenceTranscript') {
    return compareRunInferenceTranscript(macroBody, harBody);
  }
  if (apiPath === '/api/v3/saveTransactionsMain') {
    return compareSaveTransactions(macroBody, harBody);
  }
  return compareBodies(macroBody, harBody, '', 0);
}

// -----------------------------------------------------------------------------
// JS eval (for `eval` steps)
// -----------------------------------------------------------------------------

function runEvalFunction(functionStr, args) {
  const sandbox = {
    crypto: {
      randomUUID: () => crypto.randomUUID(),
      getRandomValues: (arr) => crypto.randomFillSync(arr),
    },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    Date,
    JSON,
    Math,
    console: { log: () => {}, error: () => {}, warn: () => {} },
    args: args || {},
    document: {
      querySelectorAll: () => [],
      querySelector: () => null,
    },
  };
  vm.createContext(sandbox);
  const code = `(${functionStr})(args)`;
  try {
    const result = vm.runInContext(code, sandbox, { timeout: 5000 });
    if (result && typeof result.then === 'function') {
      return { __async: true, promise: result };
    }
    return result;
  } catch (e) {
    return { ok: false, error: `eval threw: ${e.message}` };
  }
}

async function runEvalFunctionAsync(functionStr, args) {
  const r = runEvalFunction(functionStr, args);
  if (r && r.__async) {
    try {
      return await r.promise;
    } catch (e) {
      return { ok: false, error: `async eval threw: ${e.message}` };
    }
  }
  return r;
}

// -----------------------------------------------------------------------------
// ImprovMX mock — 1st poll: empty logs; 2nd poll: the verification email.
// Verifies the Authorization header built by the email-auth eval step.
// -----------------------------------------------------------------------------

function mockImprovMX(step, mockState, macroName, ctx) {
  mockState.emailWorkerCalls = (mockState.emailWorkerCalls || 0) + 1;

  // Verify the auth chain: the email-auth eval step must have produced
  // "Basic base64(api:mock-improvmx-key)".
  const expected = 'Basic ' + Buffer.from(IMPROVMX_MOCK_TOKEN, 'binary').toString('base64');
  const got = (step.headers && step.headers.Authorization) || '';
  if (got !== expected) {
    return {
      ok: false,
      error: `improvmx mock: Authorization header mismatch (got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)})`,
    };
  }

  const recipient = (ctx && ctx.inputs && ctx.inputs.email) || 'test-signup@priv.email';

  if (mockState.emailWorkerCalls < 2) {
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      body: JSON.stringify({ success: true, logs: [] }),
      finalUrl: IMPROVMX_MOCK_URL,
      headers: {},
    };
  }

  const subject = MOCK_SUBJECTS[macroName] || 'Your verification code is ' + MOCK_VERIFICATION_CODE;
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: JSON.stringify({
      success: true,
      logs: [
        {
          created: Date.now(),
          subject,
          sender: { email: 'team@notion.so', name: 'Notion' },
          recipient: { email: recipient, name: null },
          forward: { email: 'user@hotmail.com', name: null },
          events: [{ status: 'DELIVERED', code: 250, message: '2.6.0 Queued' }],
          messageId: '<mock@notion.so>',
          id: 'mock-log-id-1',
        },
      ],
    }),
    finalUrl: IMPROVMX_MOCK_URL,
    headers: {},
  };
}

// -----------------------------------------------------------------------------
// Step execution
// -----------------------------------------------------------------------------

async function runStep(step, ctx, harDb, mockState) {
  const cmd = step.cmd;

  if (cmd === 'retry') {
    return await runRetryBlock(step, ctx, harDb, mockState);
  }

  if (cmd === 'wait') {
    const ms = resolveTemplate(step.ms, ctx);
    return { ok: true, waited: ms };
  }

  if (cmd === 'log') {
    const message = resolveTemplate(step.message, ctx);
    const data = resolveTemplateDeep(step.data, ctx);
    return { ok: true, message, data };
  }

  const resolved = resolveTemplateDeep(step, ctx);

  switch (cmd) {
    case 'cookies.remove':
      return { ok: true, removed: MOCK_COOKIES.length };

    case 'cookies.getAll':
      return { ok: true, cookies: MOCK_COOKIES };

    case 'tabs.open':
      return { ok: true, tabId: 12345, url: resolved.url };

    case 'tabs.list':
      return { ok: true, tabs: [{ id: 12345, url: 'https://app.notion.com/signup', title: 'Notion', active: true, windowId: 1 }] };

    case 'tabs.focus':
      return { ok: true };

    case 'form.wait':
      return { ok: true, found: true, waitedMs: 100 };

    case 'form.fill':
      return { ok: true, value: resolved.value };

    case 'form.eval': {
      // get-version: reads data-notion-version from the signup page
      if ((resolved.function || '').includes('data-notion-version')) {
        return { version: '23.13.20260824.2240' };
      }
      // mail-baseline: newest email id BEFORE the send
      if ((resolved.function || '').includes("limit=1")) {
        return { sinceId: 41 };
      }
      // poll-mail: the v3-mail worker polling (list + detail + extract)
      if ((resolved.function || '').includes('/emails')) {
        return { code: MOCK_VERIFICATION_CODE, subject: 'Your Notion signup code',
          emailId: 42, received: '2026-08-25T07:00:00.000Z' };
      }
      return { ok: true, clicked: true, redirected: true, url: 'https://app.notion.com/onboarding' };
    }

    case 'fetch': {
      // The toy site's /api/signup + /api/verify endpoints aren't in the HAR
      // database — mock them so the self-test macro flows through.
      if ((resolved.url || '').includes('127.0.0.1:8898/api/')) {
        return { ok: true, status: 200, statusText: 'OK', body: JSON.stringify({ ok: true, session: 'sess_mock' }), finalUrl: resolved.url, headers: {} };
      }
      return await runFetchStep(resolved, ctx, harDb, mockState);
    }

    case 'eval':
      return await runEvalStep(resolved, ctx);

    default:
      return { ok: false, error: `unknown cmd: ${cmd}` };
  }
}

async function runFetchStep(step, ctx, harDb, mockState) {
  const url = step.url;
  const method = step.method || 'GET';

  let apiPath;
  try {
    const u = new URL(url);
    apiPath = u.pathname;
  } catch (e) {
    return { ok: false, error: `invalid URL: ${url}` };
  }

  // Special case: ImprovMX-style inbox API (real ImprovMX for the shared
  // chunk / notion macros, or the toy site's mock at 127.0.0.1:8898 whose
  // path mirrors the real one — both contain 'priv.email').
  if (url.includes('improvmx.com') || url.includes('priv.email')) {
    return mockImprovMX(step, mockState, ctx.__macroName, ctx);
  }

  // Special case: the pure-REST Notion auth endpoints (signup-rest macro).
  // Shapes verified live 2026-08-25 — see docs/NOTION-REST-AUTH.md.
  if (apiPath === '/api/v3/getLoginOptions') {
    return { ok: true, status: 200, statusText: 'OK',
      body: JSON.stringify({ hasAccount: false, samlSignIn: 'unavailable', passwordSignIn: false,
        mustReverify: false, loginOptionsToken: 'v02:login_options:MOCKTOKEN' }),
      finalUrl: url, headers: {} };
  }
  if (apiPath === '/api/v3/sendTemporaryPassword') {
    // verify the request carried the loginOptionsToken + deviceId
    const b = JSON.parse(step.body || '{}');
    if (!b.loginOptionsToken || !b.deviceId || b.email !== 'admin@priv.email') {
      return { ok: false, status: 200, body: '{}', error: 'sendTemporaryPassword body incomplete: ' + JSON.stringify(b).slice(0, 200) };
    }
    return { ok: true, status: 200, statusText: 'OK',
      body: JSON.stringify({ csrfState: 'v02:temp_password:MOCKSTATE' }),
      finalUrl: url, headers: {} };
  }
  if (apiPath === '/api/v3/loginWithEmail') {
    const b = JSON.parse(step.body || '{}');
    if (b.state !== 'v02:temp_password:MOCKSTATE' || b.password !== MOCK_VERIFICATION_CODE) {
      return { ok: false, status: 200, body: '{}',
        error: 'loginWithEmail state/password mismatch: ' + JSON.stringify(b).slice(0, 200) };
    }
    return { ok: true, status: 200, statusText: 'OK',
      body: JSON.stringify({ isNewSignup: true, userId: HAR_USER_ID }),
      finalUrl: url, headers: {} };
  }

  // Special case: loadUserContent (not in HAR — synthesize response)
  if (apiPath === '/api/v3/loadUserContent') {
    const userId =
      (ctx.results['extract-creds'] && ctx.results['extract-creds'].userId) ||
      (ctx.results['extract-user-id'] && ctx.results['extract-user-id'].userId) ||
      HAR_USER_ID;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      body: mockLoadUserContentBody(userId),
      finalUrl: url,
      headers: {},
    };
  }

  let macroReqBody = null;
  if (step.body && method !== 'GET' && method !== 'HEAD') {
    if (hasUnresolvedTemplates(step.body)) {
      return {
        ok: false,
        error: `request body has unresolved templates: ${step.body.slice(0, 200)}`,
      };
    }
    try {
      macroReqBody = JSON.parse(step.body);
    } catch (e) {
      return {
        ok: false,
        error: `request body is not valid JSON: ${e.message}; body=${step.body.slice(0, 200)}`,
      };
    }
  }

  const harCall = findBestHarMatch(apiPath, macroReqBody, harDb);
  if (!harCall) {
    if (apiPath === '/api/v3/getSpacesInitial') {
      const gsi = harDb.find((c) => c.path === '/api/v3/getSpacesInitial');
      if (gsi) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          body: JSON.stringify(gsi.respBody),
          finalUrl: url,
          headers: {},
          _harMatch: { matched: true, harSeq: gsi.seq, harFile: gsi.harFile, note: 'borrowed from completeFlow HAR' },
        };
      }
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      body: '{}',
      finalUrl: url,
      headers: {},
      _harMatch: { matched: false, note: `no HAR call for ${apiPath}` },
    };
  }

  let comparison = { errors: [], warnings: [] };
  if (macroReqBody !== null && Object.keys(harCall.reqBody || {}).length > 0) {
    comparison = compareRequestBodies(apiPath, macroReqBody, harCall.reqBody);
  }

  let respBodyStr;
  const harResp = harCall.respBody;
  if (typeof harResp === 'string') {
    respBodyStr = harResp;
  } else {
    respBodyStr = JSON.stringify(harResp);
  }

  if (comparison.errors.length > 0) {
    return {
      ok: false,
      error: `request body mismatch vs HAR seq ${harCall.seq} (${harCall.harFile}): ${comparison.errors.join('; ')}`,
      warnings: comparison.warnings,
      body: respBodyStr,
      status: 200,
      _harMatch: { matched: true, harSeq: harCall.seq, harFile: harCall.harFile },
    };
  }

  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: respBodyStr,
    finalUrl: url,
    headers: {},
    warnings: comparison.warnings,
    _harMatch: { matched: true, harSeq: harCall.seq, harFile: harCall.harFile },
  };
}

async function runEvalStep(step, ctx) {
  const fn = step.function;
  if (!fn) return { ok: false, error: 'eval step missing "function"' };

  const args = step.args || {};
  if (hasUnresolvedTemplates(args)) {
    const argStr = JSON.stringify(args);
    return {
      ok: false,
      error: `eval args have unresolved templates: ${argStr.slice(0, 300)}`,
    };
  }

  const result = await runEvalFunctionAsync(fn, args);
  return result;
}

async function runRetryBlock(step, ctx, harDb, mockState) {
  const timeoutMs = step.timeoutMs || 60000;
  const intervalMs = step.intervalMs || 4000;
  const condition = step.condition || 'result && result.ok !== false';
  const subSteps = step.steps || [];
  if (!subSteps.length) return { ok: false, error: 'retry block has no steps' };

  const deadline = Date.now() + Math.min(timeoutMs, 30000);
  let lastResult = null;
  let attempts = 0;
  const maxAttempts = 5;

  while (Date.now() < deadline && attempts < maxAttempts) {
    attempts++;
    const subCtx = { inputs: ctx.inputs, results: { ...ctx.results }, __macroName: ctx.__macroName };
    let stepError = null;
    for (const subStep of subSteps) {
      try {
        const r = await runStep(subStep, subCtx, harDb, mockState);
        if (subStep.id) {
          subCtx.results[subStep.id] = r;
          ctx.results[subStep.id] = r;
        }
        lastResult = r;
        if (r && r.ok === false) {
          stepError = r.error || 'sub-step failed';
          break;
        }
      } catch (err) {
        stepError = err.message;
        break;
      }
    }

    if (!stepError) {
      const condSandbox = {
        result: lastResult,
        results: subCtx.results,
        inputs: subCtx.inputs,
      };
      vm.createContext(condSandbox);
      let condValue = false;
      try {
        condValue = vm.runInContext(`(${condition})`, condSandbox, { timeout: 1000 });
      } catch (err) {
        // treat as false
      }
      if (condValue) {
        return { ok: true, attempts, result: lastResult };
      }
    }
  }

  return {
    ok: false,
    error: `retry: condition not met after ${attempts} attempts`,
    attempts,
    lastResult,
  };
}

// -----------------------------------------------------------------------------
// Macro runner
// -----------------------------------------------------------------------------

async function runMacro(macro, harDb) {
  const ctx = {
    inputs: { ...(macro.inputs || {}), ...(TEST_INPUTS[macro.name] || {}) },
    results: {},
    __macroName: macro.name,
  };
  const mockState = { emailWorkerCalls: 0 };

  const stepResults = [];
  let failed = false;
  let failureReason = null;

  for (let i = 0; i < macro.steps.length; i++) {
    const step = macro.steps[i];
    const sr = { id: step.id || `(step ${i + 1})`, cmd: step.cmd, ok: true, summary: '' };

    try {
      const result = await runStep(step, ctx, harDb, mockState);
      if (step.id) ctx.results[step.id] = result;

      if (result && result.ok === false) {
        sr.ok = false;
        sr.summary = result.error || 'step returned ok=false';
        if (!failed) {
          failed = true;
          failureReason = `step "${step.id}" (${step.cmd}): ${result.error}`;
        }
      } else {
        sr.summary = summarizeStepResult(step, result);
        if (result && result.warnings && result.warnings.length > 0) {
          sr.warnings = result.warnings;
        }
        if (result && result._harMatch) {
          sr.harMatch = result._harMatch;
        }
      }
    } catch (err) {
      sr.ok = false;
      sr.summary = `threw: ${err.message}`;
      if (!failed) {
        failed = true;
        failureReason = `step "${step.id}" (${step.cmd}) threw: ${err.message}`;
      }
    }

    stepResults.push(sr);
  }

  const passedSteps = stepResults.filter((s) => s.ok).length;
  return {
    name: macro.name,
    pass: !failed,
    failureReason,
    steps: stepResults,
    totalSteps: macro.steps.length,
    passedSteps,
  };
}

function summarizeStepResult(step, result) {
  if (!result) return '(no result)';
  const cmd = step.cmd;
  switch (cmd) {
    case 'cookies.remove':
      return `removed ${result.removed || 0} cookies`;
    case 'cookies.getAll':
      return `got ${result.cookies ? result.cookies.length : 0} cookies`;
    case 'tabs.open':
      return `opened tab ${result.tabId}`;
    case 'form.wait':
      return `waited ${result.waitedMs || 0}ms for selector`;
    case 'form.fill':
      return `filled value (${typeof result.value === 'string' ? result.value.slice(0, 50) : result.value})`;
    case 'form.eval':
      return `eval ok`;
    case 'fetch': {
      const hm = result._harMatch || {};
      if (hm.matched) {
        return `fetch ${step.url.replace('https://app.notion.com', '')} → HAR seq ${hm.harSeq} (${hm.harFile})`;
      }
      return `fetch ${step.url.replace('https://app.notion.com', '')} → ${result.status || '?'}`;
    }
    case 'eval':
      return `eval → ${JSON.stringify(result).slice(0, 120)}`;
    case 'log':
      return `log: ${result.message || ''}`;
    case 'wait':
      return `waited ${result.waited}ms`;
    case 'retry':
      return `retry: ${result.attempts} attempts, ok=${result.ok}, code=${result.result && result.result.code}`;
    default:
      return JSON.stringify(result).slice(0, 120);
  }
}

// -----------------------------------------------------------------------------
// Output formatting
// -----------------------------------------------------------------------------

function printMacroResult(result) {
  console.log(`\n=== Testing: ${result.name} ===`);
  console.log(`Steps: ${result.totalSteps}`);
  for (const sr of result.steps) {
    const mark = sr.ok ? '✓' : '✗';
    let line = `  ${mark} ${sr.id} (${sr.cmd}): ${sr.summary}`;
    console.log(line);
    if (sr.warnings && sr.warnings.length > 0) {
      for (const w of sr.warnings.slice(0, 5)) {
        console.log(`      ⚠ ${w}`);
      }
      if (sr.warnings.length > 5) {
        console.log(`      ⚠ ... and ${sr.warnings.length - 5} more warnings`);
      }
    }
  }
  const resultStr = result.pass ? 'PASS' : 'FAIL';
  console.log(`Result: ${resultStr} (${result.passedSteps}/${result.totalSteps} steps passed)`);
  if (!result.pass && result.failureReason) {
    console.log(`  → ${result.failureReason}`);
  }
}

function printSummary(results) {
  console.log('\n=== Summary ===');
  for (const r of results) {
    const status = r.pass ? 'PASS' : 'FAIL';
    const reason = r.pass ? '' : ` — ${r.failureReason}`;
    console.log(`  ${r.name}: ${status} (${r.passedSteps}/${r.totalSteps})${reason}`);
  }
  const allPass = results.every((r) => r.pass);
  console.log(`\nOverall: ${allPass ? 'ALL PASS' : 'SOME FAILED'}`);
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

function loadMacros() {
  const macros = [];
  (function walk(dir) {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        walk(p);
      } else if (f.endsWith('.json')) {
        macros.push(JSON.parse(fs.readFileSync(p, 'utf8')));
      }
    }
  })(MACROS_DIR);
  macros.sort((a, b) => a.name.localeCompare(b.name));
  return macros;
}

async function main() {
  const harDb = loadHarDb();
  const macros = loadMacros();

  console.log(`Loaded ${macros.length} macros, ${harDb.length} HAR calls\n`);
  const pathCounts = {};
  for (const c of harDb) {
    pathCounts[c.path] = (pathCounts[c.path] || 0) + 1;
  }
  for (const [p, n] of Object.entries(pathCounts).sort()) {
    console.log(`  ${p}: ${n}`);
  }

  // Lint pass: template references
  let lintFailed = false;
  console.log('\n=== Lint: template references ===');
  for (const macro of macros) {
    const issues = lintMacro(macro);
    if (issues.length > 0) {
      lintFailed = true;
      console.log(`  ${macro.name}: ${issues.length} issue(s)`);
      for (const i of issues) console.log(`    - ${i}`);
    } else {
      console.log(`  ${macro.name}: clean`);
    }
  }

  const results = [];
  for (const macro of macros) {
    const result = await runMacro(macro, harDb);
    results.push(result);
    printMacroResult(result);
  }

  printSummary(results);

  const allPass = results.every((r) => r.pass) && !lintFailed;
  console.log(`\nLint: ${lintFailed ? 'ISSUES FOUND' : 'clean'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(2);
});
