"use client";

import { useEffect } from "react";

const COGNITO_CLIENT_ID = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID ?? "5qup0una5tdma3l33pnn1gm87i";
const COGNITO_DOMAIN = process.env.NEXT_PUBLIC_COGNITO_DOMAIN ?? "posley.auth.us-east-1.amazoncognito.com";

export default function PosleyOAuthCallback() {
  useEffect(() => {
    const url = new URL(location.href);
    const code = url.searchParams.get("code");
    const verifier = sessionStorage.getItem("equity_monitor_pkce");
    if (!code || !verifier) return;

    const exchange = async () => {
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: COGNITO_CLIENT_ID,
        code,
        redirect_uri: `${location.origin}/`,
        code_verifier: verifier,
      });
      const response = await fetch(`https://${COGNITO_DOMAIN}/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!response.ok) return;
      const tokens = await response.json() as { id_token: string; refresh_token?: string; expires_in?: number };
      localStorage.setItem("equity_monitor_id_token", tokens.id_token);
      if (tokens.refresh_token) localStorage.setItem("equity_monitor_refresh_token", tokens.refresh_token);
      localStorage.setItem("equity_monitor_expires_at", String(Date.now() + (tokens.expires_in ?? 3600) * 1000));
      sessionStorage.removeItem("equity_monitor_pkce");
      const returnTo = sessionStorage.getItem("equity_monitor_return_to");
      sessionStorage.removeItem("equity_monitor_return_to");
      location.replace(returnTo?.startsWith("/") ? returnTo : "/ewy-koru");
    };

    void exchange();
  }, []);

  return null;
}
