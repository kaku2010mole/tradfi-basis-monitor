// Reuses the stock monitor's existing browser session and callback.
const CLIENT = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID ?? "5qup0una5tdma3l33pnn1gm87i";
const DOMAIN = process.env.NEXT_PUBLIC_COGNITO_DOMAIN ?? "posley.auth.us-east-1.amazoncognito.com";
export async function japanBrowserToken() {
  const token = localStorage.getItem("equity_monitor_id_token");
  if (token && Number(localStorage.getItem("equity_monitor_expires_at")) > Date.now() + 60_000) return token;
  const refresh = localStorage.getItem("equity_monitor_refresh_token");
  if (!refresh) return null;
  const response = await fetch(`https://${DOMAIN}/oauth2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT, refresh_token: refresh }), signal: AbortSignal.timeout(4000) });
  if (!response.ok) return null;
  const data = await response.json() as { id_token?: string; expires_in?: number };
  if (!data.id_token) return null;
  localStorage.setItem("equity_monitor_id_token", data.id_token);
  localStorage.setItem("equity_monitor_expires_at", String(Date.now() + (data.expires_in ?? 3600) * 1000));
  return data.id_token;
}
export async function connectJapanFeed() {
  const check = await fetch(`/api/posley-auth-check?origin=${encodeURIComponent(location.origin)}`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
  const data = await check.json() as { registered?: boolean };
  if (!check.ok || !data.registered) throw new Error("当前网址的 Posley 登录尚未配置；可继续使用办公室推送行情。");
  const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const verifier = encode(crypto.getRandomValues(new Uint8Array(48)));
  sessionStorage.setItem("equity_monitor_pkce", verifier);
  sessionStorage.setItem("equity_monitor_return_to", "/japan-estimate");
  const challenge = encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const params = new URLSearchParams({ client_id: CLIENT, response_type: "code", scope: "openid email profile", redirect_uri: `${location.origin}/`, identity_provider: "Google", code_challenge_method: "S256", code_challenge: challenge });
  location.assign(`https://${DOMAIN}/oauth2/authorize?${params}`);
}
