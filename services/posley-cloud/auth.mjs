import { randomBytes, createHash, createPublicKey, verify } from "node:crypto";
import { mkdir, readFile, writeFile, rename, chmod } from "node:fs/promises";
import path from "node:path";

export const ORIGIN = "https://tradfi-basis-monitor.onrender.com";
export const DOMAIN = "https://posley.auth.us-east-1.amazoncognito.com";
export const CLIENT = "5qup0una5tdma3l33pnn1gm87i";
export const ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_OpRPQ7Mt7";
export const COOKIE = "__Host-posley_cloud_oauth";
const b64 = bytes => Buffer.from(bytes).toString("base64url");
const cookie = (value, age) => `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;

export function createAuth({ directory, fetcher = fetch, clock = Date.now }) {
  let credentials = null, idToken = null, expiresAt = 0, pendingRefresh = null, jwks = null;
  let error = "", authorizedAt = null, refreshedAt = null;
  const sessions = new Map();
  const file = path.join(directory, "credentials.json");
  async function initialize() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    try {
      const saved = JSON.parse(await readFile(file, "utf8"));
      if (typeof saved.refreshToken === "string" && saved.refreshToken.length >= 20 && saved.client === CLIENT) {
        credentials = saved; authorizedAt = saved.authorizedAt;
        await chmod(file, 0o600);
      }
    } catch (reason) { if (reason.code !== "ENOENT") error = "Saved cloud authorization could not be loaded. Reconnect Posley."; }
  }
  async function persist(refreshToken, firstAuthorizedAt = clock()) {
    const next = { refreshToken, client: CLIENT, authorizedAt: firstAuthorizedAt };
    const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(temp, JSON.stringify(next), { mode: 0o600, flag: "wx" });
    await rename(temp, file);
    credentials = next; authorizedAt = firstAuthorizedAt;
  }
  async function tokenRequest(body) {
    const response = await fetcher(`${DOMAIN}/oauth2/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CLIENT, ...body }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      throw new Error(failure.error === "invalid_grant" ? "Posley authorization expired or was revoked. Reconnect Posley." : `Posley token service HTTP ${response.status}.`);
    }
    return response.json();
  }
  async function validate(token, nonce) {
    if (typeof token !== "string" || token.length > 20_000) throw new Error("Invalid Posley ID token.");
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Invalid Posley ID token.");
    let head, claims;
    try { head = JSON.parse(Buffer.from(parts[0], "base64url")); claims = JSON.parse(Buffer.from(parts[1], "base64url")); }
    catch { throw new Error("Invalid Posley ID token."); }
    if (head.alg !== "RS256" || claims.iss !== ISSUER || claims.aud !== CLIENT || claims.token_use !== "id"
      || !Number.isFinite(claims.exp) || claims.exp * 1000 < clock() + 30_000
      || typeof claims.sub !== "string" || typeof claims.email !== "string" || !claims.email.toLowerCase().endsWith("@posley.capital")
      || claims.email_verified !== true && claims.email_verified !== "true"
      || nonce && claims.nonce !== nonce) throw new Error("Posley identity verification failed.");
    if (!jwks?.keys?.some(key => key.kid === head.kid)) {
      const response = await fetcher(`${ISSUER}/.well-known/jwks.json`, { signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error("Posley signing keys unavailable.");
      jwks = await response.json();
    }
    const key = jwks?.keys?.find(key => key.kid === head.kid);
    if (!key || !verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`),
      createPublicKey({ key, format: "jwk" }), Buffer.from(parts[2], "base64url"))) throw new Error("Posley token signature invalid.");
    return claims;
  }
  function begin() {
    for (const [state, session] of sessions) if (clock() > session.deadline) sessions.delete(state);
    if (sessions.size >= 8) throw new Error("Too many pending logins. Wait ten minutes and retry.");
    const state = `posley_cloud_${b64(randomBytes(32))}`, binding = b64(randomBytes(32)), verifier = b64(randomBytes(48)), nonce = b64(randomBytes(24));
    sessions.set(state, { binding, verifier, nonce, deadline: clock() + 600_000 });
    const params = new URLSearchParams({ client_id: CLIENT, response_type: "code", scope: "openid email profile",
      redirect_uri: `${ORIGIN}/`, identity_provider: "Google", state, nonce,
      code_challenge_method: "S256", code_challenge: b64(createHash("sha256").update(verifier).digest()) });
    return { url: `${DOMAIN}/oauth2/authorize?${params}`, cookie: cookie(binding, 600) };
  }
  async function complete({ code, state, cookies }) {
    const session = sessions.get(state);
    const binding = cookies?.split(";").map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!session || session.deadline < clock() || session.binding !== binding) throw new Error("Login state expired or did not match this browser. Please start again.");
    sessions.delete(state);
    if (!code || code.length > 4096) throw new Error("Authorization code missing.");
    const tokens = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: `${ORIGIN}/`, code_verifier: session.verifier });
    const claims = await validate(tokens.id_token, session.nonce);
    if (typeof tokens.refresh_token !== "string" || tokens.refresh_token.length < 20) throw new Error("Posley did not supply a renewable authorization.");
    await persist(tokens.refresh_token);
    idToken = tokens.id_token; expiresAt = claims.exp * 1000; refreshedAt = clock(); error = "";
    return cookie("", 0);
  }
  async function token() {
    if (idToken && expiresAt > clock() + 300_000) return idToken;
    if (!credentials) return null;
    if (!pendingRefresh) pendingRefresh = (async () => {
      const tokens = await tokenRequest({ grant_type: "refresh_token", refresh_token: credentials.refreshToken });
      const claims = await validate(tokens.id_token);
      if (tokens.refresh_token && tokens.refresh_token !== credentials.refreshToken) await persist(tokens.refresh_token, authorizedAt);
      idToken = tokens.id_token; expiresAt = claims.exp * 1000; refreshedAt = clock(); error = "";
      return idToken;
    })().catch(reason => {
      error = /^(Posley (authorization expired|token service HTTP|identity verification failed|signing keys unavailable|token signature invalid)|Invalid Posley ID token)/.test(reason.message)
        ? reason.message : "Posley authorization renewal failed. The server will retry.";
      throw new Error(error);
    }).finally(() => { pendingRefresh = null; });
    return pendingRefresh;
  }
  return { initialize, begin, complete, token,
    status: () => ({ authorized: Boolean(credentials), authorizedAt, refreshedAt, tokenExpiresAt: expiresAt || null, error }),
  };
}
