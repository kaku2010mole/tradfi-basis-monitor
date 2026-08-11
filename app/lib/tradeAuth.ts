export const TRADE_COOKIE = "relative_value_trade_access";
const SESSION_MS = 6 * 60 * 60 * 1000;

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

const constantTimeEqual = (left: string, right: string) => {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
};

const digest = async (value: string) => hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));

const sign = async (payload: string) => {
  const secret = process.env.TRADE_AUTH_SECRET;
  if (!secret) return null;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
};

export const tradeAuthConfigured = () => Boolean(process.env.TRADE_PANEL_PASSWORD && process.env.TRADE_AUTH_SECRET);

export const passwordMatches = async (candidate: string) => {
  const expected = process.env.TRADE_PANEL_PASSWORD;
  if (!expected || !candidate) return false;
  const [candidateHash, expectedHash] = await Promise.all([digest(candidate), digest(expected)]);
  return constantTimeEqual(candidateHash, expectedHash);
};

export const createTradeToken = async () => {
  const expiresAt = Date.now() + SESSION_MS;
  const signature = await sign(String(expiresAt));
  return signature ? `${expiresAt}.${signature}` : null;
};

export const verifyTradeToken = async (token: string | undefined | null) => {
  if (!token) return false;
  const [expiresAt, suppliedSignature, extra] = token.split(".");
  if (extra || !expiresAt || !suppliedSignature || Number(expiresAt) <= Date.now()) return false;
  const expectedSignature = await sign(expiresAt);
  return expectedSignature !== null && constantTimeEqual(suppliedSignature, expectedSignature);
};

export const tradeCookie = (token: string, secure: boolean) => [
  `${TRADE_COOKIE}=${token}`,
  "Path=/",
  "HttpOnly",
  "SameSite=Strict",
  `Max-Age=${Math.floor(SESSION_MS / 1000)}`,
  secure ? "Secure" : "",
].filter(Boolean).join("; ");
