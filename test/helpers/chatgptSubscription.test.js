const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CHATGPT_CLIENT_ID,
  CHATGPT_FALLBACK_MODELS,
  decodeJwtClaims,
  jwtExpiryMs,
  accountIdFromClaims,
  profileFromTokens,
  buildAuthorizeUrl,
  parseResponsesSse,
  filterModelList,
  pickReasoningEffort,
  createChatGptSubscription,
} = require("../../src/helpers/chatgptSubscription.js");

const AUTH = "https://api.openai.com/auth";

function jwt(claims) {
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc(claims)}.sig`;
}

function sse(events) {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function response(status, { json, text } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(),
    json: async () => json,
    text: async () => (text !== undefined ? text : JSON.stringify(json ?? {})),
  };
}

function memoryStore(initial = null) {
  let value = initial;
  const writes = [];
  return {
    writes,
    read: () => value,
    write: (next) => {
      value = next;
      writes.push(next);
    },
    clear: () => {
      value = null;
    },
  };
}

const NOW = 1_800_000_000_000;
const accessToken = (expSeconds, accountId = "acct-1") =>
  jwt({ exp: expSeconds, [AUTH]: { chatgpt_account_id: accountId } });

// ── JWT helpers ────────────────────────────────────────────────────────────

test("jwtExpiryMs reads exp in milliseconds; malformed tokens give null", () => {
  assert.equal(jwtExpiryMs(jwt({ exp: 1_700_000_000 })), 1_700_000_000_000);
  assert.equal(jwtExpiryMs(jwt({})), null);
  assert.equal(jwtExpiryMs("not-a-jwt"), null);
  assert.equal(jwtExpiryMs("a.%%%.c"), null);
  assert.equal(decodeJwtClaims(undefined), null);
});

test("accountIdFromClaims reads the chatgpt_account_id auth claim", () => {
  assert.equal(accountIdFromClaims({ [AUTH]: { chatgpt_account_id: "acct-9" } }), "acct-9");
  assert.equal(accountIdFromClaims({ [AUTH]: {} }), null);
  assert.equal(accountIdFromClaims(null), null);
});

test("profileFromTokens prefers id_token claims and falls back to the access token", () => {
  const idToken = jwt({
    email: "me@example.com",
    [AUTH]: { chatgpt_account_id: "acct-id", chatgpt_plan_type: "plus" },
  });
  const access = jwt({ [AUTH]: { chatgpt_account_id: "acct-access", chatgpt_plan_type: "pro" } });
  assert.deepEqual(profileFromTokens({ idToken, accessToken: access }), {
    accountId: "acct-id",
    email: "me@example.com",
    plan: "plus",
  });
  assert.deepEqual(profileFromTokens({ idToken: null, accessToken: access }), {
    accountId: "acct-access",
    email: null,
    plan: "pro",
  });
});

test("buildAuthorizeUrl carries the Codex public client parameters", () => {
  const url = new URL(
    buildAuthorizeUrl({
      redirectUri: "http://localhost:1455/auth/callback",
      state: "s1",
      codeChallenge: "cc",
    })
  );
  assert.equal(url.origin + url.pathname, "https://auth.openai.com/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), CHATGPT_CLIENT_ID);
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:1455/auth/callback");
  assert.equal(url.searchParams.get("scope"), "openid profile email offline_access");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "s1");
  assert.equal(url.searchParams.get("codex_cli_simplified_flow"), "true");
  assert.equal(url.searchParams.get("originator"), "codex_cli_rs");
  assert.ok(!url.search.includes("+"), "spaces are %20-encoded");
});

// ── SSE parsing ────────────────────────────────────────────────────────────

test("parseResponsesSse accumulates output_text deltas until response.completed", () => {
  const body = sse([
    { type: "response.created" },
    { type: "response.output_text.delta", delta: "Hello" },
    { type: "response.reasoning_summary_text.delta", delta: "(thinking)" },
    { type: "response.output_text.delta", delta: ", world." },
    { type: "response.completed", response: {} },
  ]);
  assert.equal(parseResponsesSse(body), "Hello, world.");
});

test("parseResponsesSse handles CRLF framing and ignores non-JSON data lines", () => {
  const body =
    'data: {"type":"response.output_text.delta","delta":"A"}\r\n\r\n' +
    "data: not json\r\n\r\n" +
    'data: {"type":"response.output_text.delta","delta":"B"}\r\n\r\n' +
    'data: {"type":"response.completed"}\r\n\r\n';
  assert.equal(parseResponsesSse(body), "AB");
});

test("parseResponsesSse turns response.failed into a coded error", () => {
  const body = sse([
    { type: "response.output_text.delta", delta: "partial" },
    {
      type: "response.failed",
      response: { error: { code: "server_error", message: "Something broke" } },
    },
  ]);
  assert.throws(
    () => parseResponsesSse(body),
    (error) =>
      error.code === "chatgpt_response_failed" &&
      error.message === "Something broke" &&
      error.providerCode === "server_error"
  );
});

test("parseResponsesSse turns an error event into a coded error", () => {
  const body = sse([{ type: "error", message: "Rate limit reached", code: "rate_limit" }]);
  assert.throws(() => parseResponsesSse(body), { code: "chatgpt_response_failed" });
});

test("parseResponsesSse rejects a stream that never completes", () => {
  const body = sse([{ type: "response.output_text.delta", delta: "cut" }]);
  assert.throws(() => parseResponsesSse(body), { code: "chatgpt_response_incomplete" });
});

// ── Model list ─────────────────────────────────────────────────────────────

test("filterModelList keeps listed models and maps their reasoning levels", () => {
  const models = filterModelList({
    models: [
      {
        slug: "gpt-5.6-luna",
        display_name: "GPT-5.6 Luna",
        visibility: "list",
        supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }],
        default_reasoning_level: "medium",
      },
      { slug: "codex-internal", display_name: "Hidden", visibility: "hide" },
      { slug: "gpt-6-sol", visibility: "list" },
      { display_name: "No slug", visibility: "list" },
      null,
    ],
  });
  assert.deepEqual(models, [
    {
      id: "gpt-5.6-luna",
      name: "GPT-5.6 Luna",
      efforts: ["low", "medium"],
      defaultEffort: "medium",
    },
    { id: "gpt-6-sol", name: "gpt-6-sol", efforts: [] },
  ]);
  assert.deepEqual(filterModelList({}), []);
  assert.deepEqual(filterModelList(null), []);
});

test("pickReasoningEffort prefers low, else the model's default", () => {
  assert.equal(pickReasoningEffort(undefined), "low");
  assert.equal(pickReasoningEffort({ efforts: ["low", "high"], defaultEffort: "high" }), "low");
  assert.equal(pickReasoningEffort({ efforts: ["medium", "high"], defaultEffort: "high" }), "high");
  assert.equal(pickReasoningEffort({ efforts: ["medium", "high"] }), "medium");
});

test("listModels returns the filtered live list, and the fallback when signed out or failing", async () => {
  const signedOut = createChatGptSubscription({
    store: memoryStore(),
    fetchImpl: async () => assert.fail("must not fetch while signed out"),
  });
  assert.deepEqual(await signedOut.listModels(), {
    models: [...CHATGPT_FALLBACK_MODELS],
    fallback: true,
  });

  const credential = {
    accessToken: accessToken(NOW / 1000 + 3600),
    refreshToken: "rt",
    accountId: "acct-1",
    expiresAt: NOW + 3600_000,
  };
  const calls = [];
  const live = createChatGptSubscription({
    store: memoryStore(credential),
    now: () => NOW,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response(200, {
        json: {
          models: [
            { slug: "gpt-5.6-luna", display_name: "GPT-5.6 Luna", visibility: "list" },
            { slug: "hidden", visibility: "hide" },
          ],
        },
      });
    },
  });
  const result = await live.listModels();
  assert.deepEqual(result, {
    models: [{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna", efforts: [] }],
    fallback: false,
  });
  assert.match(calls[0].url, /\/backend-api\/codex\/models\?client_version=/);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${credential.accessToken}`);
  assert.equal(calls[0].init.headers["chatgpt-account-id"], "acct-1");

  const failing = createChatGptSubscription({
    store: memoryStore(credential),
    now: () => NOW,
    fetchImpl: async () => response(500, { text: "boom" }),
  });
  assert.equal((await failing.listModels()).fallback, true);
});

// ── Refresh ────────────────────────────────────────────────────────────────

test("refresh is single-flight and persists the rotated refresh token before use", async () => {
  const store = memoryStore({
    accessToken: accessToken(NOW / 1000 + 60),
    refreshToken: "rt-old",
    idToken: null,
    accountId: "acct-1",
    expiresAt: NOW + 60_000,
  });
  const newAccess = accessToken(NOW / 1000 + 3600);
  let tokenCalls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const responsesSeenToken = [];

  const subscription = createChatGptSubscription({
    store,
    now: () => NOW,
    randomUUID: () => "uuid",
    fetchImpl: async (url, init) => {
      if (url === "https://auth.openai.com/oauth/token") {
        tokenCalls += 1;
        const body = JSON.parse(init.body);
        assert.equal(body.grant_type, "refresh_token");
        assert.equal(body.refresh_token, "rt-old");
        assert.equal(body.client_id, CHATGPT_CLIENT_ID);
        await gate;
        return response(200, { json: { access_token: newAccess, refresh_token: "rt-new" } });
      }
      // The rotated token must already be on disk when it is first used.
      assert.equal(store.read().refreshToken, "rt-new");
      responsesSeenToken.push(init.headers.Authorization);
      return response(200, {
        text: sse([
          { type: "response.output_text.delta", delta: "ok" },
          { type: "response.completed" },
        ]),
      });
    },
  });

  // Access token expires within the 5-minute margin, so both calls refresh.
  const both = Promise.all([
    subscription.complete({ model: "gpt-5.6-luna", instructions: "sys", input: "a" }),
    subscription.complete({ model: "gpt-5.6-luna", instructions: "sys", input: "b" }),
  ]);
  release();
  assert.deepEqual(await both, ["ok", "ok"]);
  assert.equal(tokenCalls, 1, "concurrent callers share one refresh");
  assert.equal(store.writes.length, 1);
  assert.equal(store.read().refreshToken, "rt-new");
  assert.equal(store.read().accessToken, newAccess);
  assert.deepEqual(responsesSeenToken, [`Bearer ${newAccess}`, `Bearer ${newAccess}`]);
});

test("a token response without refresh_token keeps the previous one", async () => {
  const store = memoryStore({
    accessToken: accessToken(NOW / 1000 - 10),
    refreshToken: "rt-keep",
    accountId: "acct-1",
    expiresAt: NOW - 10_000,
  });
  const subscription = createChatGptSubscription({
    store,
    now: () => NOW,
    fetchImpl: async () =>
      response(200, { json: { access_token: accessToken(NOW / 1000 + 3600) } }),
  });
  await subscription.refresh();
  assert.equal(store.read().refreshToken, "rt-keep");
});

test("a 401 refreshes once and retries with the new token", async () => {
  const oldAccess = accessToken(NOW / 1000 + 3600);
  const newAccess = accessToken(NOW / 1000 + 7200);
  const store = memoryStore({
    accessToken: oldAccess,
    refreshToken: "rt-1",
    accountId: "acct-1",
    expiresAt: NOW + 3600_000,
  });
  const seen = [];
  const subscription = createChatGptSubscription({
    store,
    now: () => NOW,
    fetchImpl: async (url, init) => {
      if (url.endsWith("/oauth/token")) {
        return response(200, { json: { access_token: newAccess, refresh_token: "rt-2" } });
      }
      seen.push(init.headers.Authorization);
      if (init.headers.Authorization === `Bearer ${oldAccess}`) return response(401, { text: "" });
      return response(200, {
        text: sse([
          { type: "response.output_text.delta", delta: "fixed" },
          { type: "response.completed" },
        ]),
      });
    },
  });
  const text = await subscription.complete({ model: "gpt-5.6-luna", input: "x" });
  assert.equal(text, "fixed");
  assert.deepEqual(seen, [`Bearer ${oldAccess}`, `Bearer ${newAccess}`]);
  assert.equal(store.read().refreshToken, "rt-2");
});

test("a rejected refresh signs out and reports the session as expired", async () => {
  const store = memoryStore({
    accessToken: accessToken(NOW / 1000 - 1),
    refreshToken: "rt-spent",
    accountId: "acct-1",
    expiresAt: NOW - 1000,
  });
  const subscription = createChatGptSubscription({
    store,
    now: () => NOW,
    fetchImpl: async () => response(400, { text: '{"error":"invalid_grant"}' }),
  });
  await assert.rejects(subscription.complete({ model: "m", input: "x" }), {
    code: "chatgpt_session_expired",
  });
  assert.equal(store.read(), null);
  assert.deepEqual(subscription.getStatus(), { signedIn: false });
});

test("complete sends the Codex Responses body and surfaces HTTP failures with status", async () => {
  const store = memoryStore({
    accessToken: accessToken(NOW / 1000 + 3600),
    refreshToken: "rt",
    accountId: "acct-1",
    expiresAt: NOW + 3600_000,
  });
  let sent;
  const subscription = createChatGptSubscription({
    store,
    now: () => NOW,
    randomUUID: () => "session-uuid",
    fetchImpl: async (url, init) => {
      sent = { url, init };
      return response(400, {
        text: '{"detail":"The \'gpt-5.5\' model is not supported when using Codex with a ChatGPT account."}',
      });
    },
  });
  await assert.rejects(
    subscription.complete({ model: "gpt-5.5", instructions: "Clean up", input: "hello" }),
    (error) => error.status === 400 && /not supported/.test(error.body)
  );
  assert.equal(sent.url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(sent.init.headers.Accept, "text/event-stream");
  assert.equal(sent.init.headers["OpenAI-Beta"], "responses=experimental");
  assert.equal(sent.init.headers.originator, "codex_cli_rs");
  assert.equal(sent.init.headers.session_id, "session-uuid");
  assert.deepEqual(JSON.parse(sent.init.body), {
    model: "gpt-5.5",
    instructions: "Clean up",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    stream: true,
    store: false,
    reasoning: { effort: "low" },
  });
});

test("complete without a login fails as not signed in", async () => {
  const subscription = createChatGptSubscription({
    store: memoryStore(),
    fetchImpl: async () => assert.fail("must not fetch"),
  });
  await assert.rejects(subscription.complete({ model: "m", input: "x" }), {
    code: "chatgpt_not_signed_in",
  });
});

// ── Sign-in ────────────────────────────────────────────────────────────────

test("signIn exchanges the code on the fixed redirect and stores the login", async () => {
  const store = memoryStore();
  const idToken = jwt({
    email: "me@example.com",
    [AUTH]: { chatgpt_account_id: "acct-7", chatgpt_plan_type: "pro" },
  });
  let flowOptions;
  const subscription = createChatGptSubscription({
    store,
    now: () => NOW,
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://auth.openai.com/oauth/token");
      assert.equal(init.headers["Content-Type"], "application/x-www-form-urlencoded");
      const form = new URLSearchParams(init.body);
      assert.equal(form.get("grant_type"), "authorization_code");
      assert.equal(form.get("code"), "the-code");
      assert.equal(form.get("redirect_uri"), "http://localhost:1455/auth/callback");
      assert.equal(form.get("code_verifier"), "verifier");
      return response(200, {
        json: {
          id_token: idToken,
          access_token: accessToken(NOW / 1000 + 3600, "acct-7"),
          refresh_token: "rt-first",
        },
      });
    },
    runLoopbackFlow: async (options) => {
      flowOptions = options;
      return options.handleCallback("the-code", "http://localhost:1455/auth/callback", "verifier");
    },
  });
  const status = await subscription.signIn();
  assert.deepEqual(status, { signedIn: true, email: "me@example.com", plan: "pro" });
  assert.deepEqual(flowOptions.ports, [1455]);
  assert.equal(flowOptions.redirectHost, "localhost");
  assert.equal(flowOptions.callbackPath, "/auth/callback");
  assert.equal(flowOptions.timeoutMs, 5 * 60 * 1000);
  assert.equal(store.read().accountId, "acct-7");
  assert.equal(store.read().refreshToken, "rt-first");

  subscription.signOut();
  assert.equal(store.read(), null);
});

test("signIn reports a busy callback port clearly", async () => {
  const subscription = createChatGptSubscription({
    store: memoryStore(),
    fetchImpl: async () => assert.fail("must not fetch"),
    runLoopbackFlow: async () => {
      throw Object.assign(new Error("No loopback port was free"), { code: "ports_busy" });
    },
  });
  await assert.rejects(subscription.signIn(), (error) => {
    return error.code === "chatgpt_port_busy" && /1455/.test(error.message);
  });
});
