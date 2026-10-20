"use client";

import { useEffect } from "react";

// OAuth codes are handled by the server before React renders. Remove obsolete
// browser credentials; never upload or reuse them.
export default function PosleyOAuthCallback() {
  useEffect(() => {
    for (const key of ["equity_monitor_id_token", "equity_monitor_refresh_token", "equity_monitor_expires_at"]) localStorage.removeItem(key);
    for (const key of ["equity_monitor_pkce", "equity_monitor_return_to"]) sessionStorage.removeItem(key);
  }, []);

  return null;
}
