// ChatGPT subscription access (Plus/Pro) for transcript cleanup: the public
// PKCE sign-in the Codex CLI uses, OpenWhispr's own token store, and calls to
// the ChatGPT Codex backend (Responses API shape, SSE only). Main process only:
// tokens never reach the renderer. Electron-free so it is unit-testable; the
// IPC layer injects storage, fetch and the loopback flow.
const crypto = require("crypto");

const CHATGPT_ISSUER = "https://auth.openai.com";
const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
// The client is registered for exactly this redirect; the port is not negotiable.
const CHATGPT_CALLBACK_PORT = 1455;
const CHATGPT_CALLBACK_PATH = "/auth/callback";
const CHATGPT_REDIRECT_URI = `http://localhost:${CHATGPT_CALLBACK_PORT}${CHATGPT_CALLBACK_PATH}`;
const CHATGPT_TOKEN_URL = `${CHATGPT_ISSUER}/oauth/token`;
const CHATGPT_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const CHATGPT_MODELS_URL = "https://chatgpt.com/backend-api/codex/models?client_version=0.160.0";
const CHATGPT_ORIGINATOR = "codex_cli_rs";
const CHATGPT_DEFAULT_MODEL = "gpt-5.6-luna";
const CHATGPT_DEFAULT_REASONING_EFFORT = "low";
const AUTH_CLAIMS = "https://api.openai.com/auth";
const PROFILE_CLAIMS = "https://api.openai.com/profile";
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

// Shown when the live list can't be fetched (offline, signed out).
const CHATGPT_FALLBACK_MODELS = Object.freeze([
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", efforts: ["low", "medium", "high"] },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", efforts: ["low", "medium", "high"] },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", efforts: ["low", "medium", "high"] },
  { id: "gpt-6-astra", name: "GPT-6 Astra", efforts: ["low", "medium", "high"] },
]);

function codedError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function decodeJwtClaims(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return claims && typeof claims === "object" ? claims : null;
  } catch {
    return null;
  }
}

function jwtExpiryMs(token) {
  const exp = decodeJwtClaims(token)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
}

function accountIdFromClaims(claims) {
  const id = claims?.[AUTH_CLAIMS]?.chatgpt_account_id;
  return typeof id === "string" && id ? id : null;
}

// Email and plan come from the id_token when it carries them, else the access token.
function profileFromTokens({ idToken, accessToken }) {
  const idClaims = decodeJwtClaims(idToken) || {};
  const accessClaims = decodeJwtClaims(accessToken) || {};
  const pick = (read) => read(idClaims) ?? read(accessClaims) ?? null;
  return {
    accountId: pick(accountIdFromClaims),
    email: pick((c) =>
      typeof c.email === "string"
        ? c.email
        : typeof c[PROFILE_CLAIMS]?.email === "string"
          ? c[PROFILE_CLAIMS].email
          : undefined
    ),
    plan: pick((c) =>
      typeof c[AUTH_CLAIMS]?.chatgpt_plan_type === "string"
        ? c[AUTH_CLAIMS].chatgpt_plan_type
        : undefined
    ),
  };
}

function buildAuthorizeUrl({ redirectUri = CHATGPT_REDIRECT_URI, state, codeChallenge }) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CHATGPT_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: CHATGPT_ORIGINATOR,
  });
  // URLSearchParams encodes spaces as "+"; the authorize endpoint expects %20.
  return `${CHATGPT_ISSUER}/oauth/authorize?${params.toString().replace(/\+/g, "%20")}`;
}

// Collects the output text of a streamed Responses call. Throws a coded error
// on response.failed / error events, or when the stream ends without completing.
function parseResponsesSse(body) {
  let text = "";
  let completed = false;
  for (const rawLine of String(body || "").split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      text += event.delta;
    } else if (event.type === "response.completed") {
      completed = true;
    } else if (event.type === "response.failed" || event.type === "error") {
      const detail = event.response?.error || event.error || event;
      const message =
        (typeof detail?.message === "string" && detail.message) || "ChatGPT response failed";
      throw codedError("chatgpt_response_failed", message, {
        providerCode: detail?.code,
      });
    }
  }
  if (!completed) {
    throw codedError("chatgpt_response_incomplete", "ChatGPT stream ended before completing");
  }
  return text;
}

// Keeps only models ChatGPT lists for pickers; drops malformed rows.
function filterModelList(json) {
  const rows = Array.isArray(json?.models) ? json.models : [];
  return rows
    .filter((m) => m && typeof m.slug === "string" && m.slug && m.visibility === "list")
    .map((m) => ({
      id: m.slug,
      name: typeof m.display_name === "string" && m.display_name ? m.display_name : m.slug,
      efforts: Array.isArray(m.supported_reasoning_levels)
        ? m.supported_reasoning_levels
            .map((level) => level?.effort)
            .filter((effort) => typeof effort === "string")
        : [],
      ...(typeof m.default_reasoning_level === "string"
        ? { defaultEffort: m.default_reasoning_level }
        : {}),
    }));
}

// "low" for speed when the model takes it; otherwise the model's own default.
function pickReasoningEffort(model) {
  if (!model || !model.efforts?.length) return CHATGPT_DEFAULT_REASONING_EFFORT;
  if (model.efforts.includes(CHATGPT_DEFAULT_REASONING_EFFORT)) {
    return CHATGPT_DEFAULT_REASONING_EFFORT;
  }
  return model.defaultEffort || model.efforts[0];
}

function credentialFromTokenResponse(data, previous, now) {
  const accessToken = data?.access_token;
  if (typeof accessToken !== "string" || !accessToken) {
    throw codedError("chatgpt_token_invalid", "ChatGPT token response had no access token");
  }
  // Refresh tokens rotate: a response without one keeps the previous token.
  const refreshToken =
    typeof data.refresh_token === "string" && data.refresh_token
      ? data.refresh_token
      : previous?.refreshToken;
  if (!refreshToken) {
    throw codedError("chatgpt_token_invalid", "ChatGPT token response had no refresh token");
  }
  const idToken =
    typeof data.id_token === "string" && data.id_token ? data.id_token : previous?.idToken || null;
  const profile = profileFromTokens({ idToken, accessToken });
  const expiresAt =
    jwtExpiryMs(accessToken) ??
    (typeof data.expires_in === "number" ? now + data.expires_in * 1000 : null);
  return {
    accessToken,
    refreshToken,
    idToken,
    accountId: profile.accountId || previous?.accountId || null,
    email: profile.email || previous?.email || null,
    plan: profile.plan || previous?.plan || null,
    expiresAt,
    updatedAt: now,
  };
}

async function readErrorBody(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function httpError(code, response, body) {
  return codedError(code, `ChatGPT request failed with status ${response.status}`, {
    status: response.status,
    body,
    headers: response.headers,
  });
}

/**
 * @param {object} deps
 * @param {{ read(): object|null, write(c: object): void, clear(): void }} deps.store
 * @param {(url: string, init?: object) => Promise<Response>} deps.fetchImpl
 * @param {Function} [deps.runLoopbackFlow] runOAuthLoopbackFlow-compatible
 * @param {(result: { ok: boolean }) => string} [deps.renderResultPage]
 * @param {() => number} [deps.now]
 * @param {{ warn?: Function, info?: Function }} [deps.logger]
 */
function createChatGptSubscription({
  store,
  fetchImpl,
  runLoopbackFlow,
  renderResultPage,
  now = Date.now,
  logger = null,
  randomUUID = () => crypto.randomUUID(),
}) {
  let refreshInFlight = null;
  let signInController = null;
  let cachedModels = null;

  const log = (level, message, meta) => logger?.[level]?.(message, meta, "chatgpt");

  function readCredential() {
    const credential = store.read();
    return credential?.accessToken && credential?.refreshToken ? credential : null;
  }

  function getStatus() {
    const credential = readCredential();
    if (!credential) return { signedIn: false };
    return {
      signedIn: true,
      email: credential.email || null,
      plan: credential.plan || null,
    };
  }

  async function exchangeCode(code, redirectUri, codeVerifier) {
    const response = await fetchImpl(CHATGPT_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: CHATGPT_CLIENT_ID,
        code_verifier: codeVerifier,
      }).toString(),
    });
    if (!response.ok) {
      throw httpError("chatgpt_token_exchange_failed", response, await readErrorBody(response));
    }
    const credential = credentialFromTokenResponse(await response.json(), null, now());
    if (!credential.accountId) {
      throw codedError("chatgpt_no_account", "The ChatGPT login has no ChatGPT account id");
    }
    store.write(credential);
    cachedModels = null;
    return credential;
  }

  async function signIn() {
    if (!runLoopbackFlow) throw new Error("Sign-in is not available");
    signInController?.abort();
    const controller = new AbortController();
    signInController = controller;
    try {
      await runLoopbackFlow({
        buildAuthUrl: (redirectUri, state, codeChallenge) =>
          buildAuthorizeUrl({ redirectUri, state, codeChallenge }),
        handleCallback: exchangeCode,
        errorParam: "chatgpt_error",
        redirectHost: "localhost",
        ports: [CHATGPT_CALLBACK_PORT],
        callbackPath: CHATGPT_CALLBACK_PATH,
        renderResultPage: renderResultPage || null,
        timeoutMs: SIGN_IN_TIMEOUT_MS,
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.code === "ports_busy") {
        throw codedError(
          "chatgpt_port_busy",
          `Port ${CHATGPT_CALLBACK_PORT} is in use (is a Codex CLI login running?). Close it and try again.`
        );
      }
      throw error;
    } finally {
      if (signInController === controller) signInController = null;
    }
    return getStatus();
  }

  function cancelSignIn() {
    signInController?.abort();
    signInController = null;
  }

  function signOut() {
    cancelSignIn();
    store.clear();
    cachedModels = null;
    return { signedIn: false };
  }

  // Single-flight: concurrent callers share one refresh, since the refresh
  // token rotates and a second use of the old one would be rejected.
  // `failedAccessToken` skips the refresh when another caller already did it.
  function refresh(failedAccessToken = null) {
    if (refreshInFlight) return refreshInFlight;
    const current = readCredential();
    if (!current) {
      return Promise.reject(codedError("chatgpt_not_signed_in", "Not signed in to ChatGPT"));
    }
    if (failedAccessToken && current.accessToken !== failedAccessToken) {
      return Promise.resolve(current);
    }
    refreshInFlight = (async () => {
      const response = await fetchImpl(CHATGPT_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: CHATGPT_CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: current.refreshToken,
          scope: "openid profile email",
        }),
      });
      if (!response.ok) {
        const body = await readErrorBody(response);
        if (response.status === 400 || response.status === 401) {
          // The refresh token is spent or revoked: only a new sign-in helps.
          log("warn", "ChatGPT refresh rejected; signing out", { status: response.status });
          store.clear();
          throw codedError("chatgpt_session_expired", "ChatGPT session expired", {
            status: response.status,
            body,
          });
        }
        throw httpError("chatgpt_refresh_failed", response, body);
      }
      const next = credentialFromTokenResponse(await response.json(), current, now());
      // Persist before use: the old refresh token is already spent.
      store.write(next);
      return next;
    })().finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  }

  async function getValidCredential() {
    const credential = readCredential();
    if (!credential) throw codedError("chatgpt_not_signed_in", "Not signed in to ChatGPT");
    if (refreshInFlight) return refreshInFlight;
    const expiresAt = credential.expiresAt ?? jwtExpiryMs(credential.accessToken);
    if (expiresAt !== null && expiresAt !== undefined && expiresAt - now() <= REFRESH_MARGIN_MS) {
      return refresh(credential.accessToken);
    }
    return credential;
  }

  function authHeaders(credential, extra = {}) {
    return {
      Authorization: `Bearer ${credential.accessToken}`,
      "chatgpt-account-id": credential.accountId || "",
      originator: CHATGPT_ORIGINATOR,
      ...extra,
    };
  }

  // One retry after a 401, with a refreshed token.
  async function authorizedFetch(url, { headers = {}, ...init } = {}) {
    let credential = await getValidCredential();
    let response = await fetchImpl(url, { ...init, headers: authHeaders(credential, headers) });
    if (response.status === 401) {
      await readErrorBody(response);
      credential = await refresh(credential.accessToken);
      response = await fetchImpl(url, { ...init, headers: authHeaders(credential, headers) });
    }
    return response;
  }

  async function listModels() {
    if (!readCredential()) return { models: [...CHATGPT_FALLBACK_MODELS], fallback: true };
    try {
      const response = await authorizedFetch(CHATGPT_MODELS_URL, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        throw httpError("chatgpt_models_failed", response, await readErrorBody(response));
      }
      const models = filterModelList(await response.json());
      if (models.length === 0) throw codedError("chatgpt_models_empty", "No models listed");
      cachedModels = models;
      return { models, fallback: false };
    } catch (error) {
      log("warn", "ChatGPT model list unavailable; using fallback", {
        code: error?.code,
        status: error?.status,
      });
      return { models: [...CHATGPT_FALLBACK_MODELS], fallback: true };
    }
  }

  function effortFor(modelId) {
    const known =
      cachedModels?.find((m) => m.id === modelId) ||
      CHATGPT_FALLBACK_MODELS.find((m) => m.id === modelId);
    return pickReasoningEffort(known);
  }

  /**
   * Runs one non-tool completion and returns its text. HTTP failures throw with
   * { status, body, headers } for the caller to classify.
   */
  async function complete({ model, instructions, input, signal }) {
    const modelId = model || CHATGPT_DEFAULT_MODEL;
    const response = await authorizedFetch(CHATGPT_RESPONSES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "OpenAI-Beta": "responses=experimental",
        session_id: randomUUID(),
      },
      body: JSON.stringify({
        model: modelId,
        instructions: instructions || "",
        input: [{ role: "user", content: [{ type: "input_text", text: input }] }],
        stream: true,
        store: false,
        reasoning: { effort: effortFor(modelId) },
      }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw httpError("chatgpt_request_failed", response, await readErrorBody(response));
    }
    return parseResponsesSse(await response.text());
  }

  return {
    getStatus,
    signIn,
    cancelSignIn,
    signOut,
    refresh,
    getValidCredential,
    listModels,
    complete,
  };
}

module.exports = {
  CHATGPT_CLIENT_ID,
  CHATGPT_REDIRECT_URI,
  CHATGPT_CALLBACK_PORT,
  CHATGPT_CALLBACK_PATH,
  CHATGPT_DEFAULT_MODEL,
  CHATGPT_FALLBACK_MODELS,
  REFRESH_MARGIN_MS,
  SIGN_IN_TIMEOUT_MS,
  decodeJwtClaims,
  jwtExpiryMs,
  accountIdFromClaims,
  profileFromTokens,
  buildAuthorizeUrl,
  parseResponsesSse,
  filterModelList,
  pickReasoningEffort,
  createChatGptSubscription,
};
