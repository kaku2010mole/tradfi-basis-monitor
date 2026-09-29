export const dynamic = "force-dynamic";

const CLIENT_ID = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID?.trim() || "5qup0una5tdma3l33pnn1gm87i";
const DOMAIN = process.env.NEXT_PUBLIC_COGNITO_DOMAIN?.trim() || "posley.auth.us-east-1.amazoncognito.com";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const suppliedOrigin = url.searchParams.get("origin");
  const origin = suppliedOrigin ? new URL(suppliedOrigin).origin : url.origin;
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    scope: "openid email profile",
    redirect_uri: `${origin}/`,
    identity_provider: "Google",
    code_challenge_method: "S256",
    code_challenge: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  });
  try {
    const response = await fetch(`https://${DOMAIN}/oauth2/authorize?${params}`, {
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    const location = response.headers.get("location") ?? "";
    const registered = !location.includes("redirect_mismatch") && response.status >= 300 && response.status < 400;
    return Response.json({ registered, callbackUrl: `${origin}/` }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ registered: false, callbackUrl: `${origin}/`, error: "Could not verify Posley login configuration." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
