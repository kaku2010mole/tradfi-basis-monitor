// One shared server timer keeps a cache warm through brief tab switches. Stop
// after five idle minutes; never create a timer per browser or keep Node alive.
export function createMarketRefreshLease(run: () => Promise<unknown>, clock = Date.now, idleMs = 300_000) {
  let activeUntil = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { clearTimeout(timer); timer = undefined; };
  return {
    touch() { activeUntil = clock() + idleMs; },
    schedule(at: number) {
      stop();
      if (at >= activeUntil || clock() >= activeUntil) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (clock() < activeUntil) void run().catch(() => { /* loaders retain sanitized errors */ });
      }, Math.max(1, at - clock()));
      (timer as unknown as { unref?: () => void }).unref?.();
    },
    stop,
  };
}

export type MarketRefreshOptions = { waitForRefresh?: boolean };

// Only first entry / tab resume waits briefly for cold or expired caches. Normal
// two-second perp polling never waits for upstream cash or FX requests.
export async function waitForMarketRefresh(pending: Promise<unknown> | null, budgetMs = 1_200) {
  if (!pending) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([pending, new Promise<void>(resolve => { timer = setTimeout(resolve, budgetMs); })]);
  } finally { clearTimeout(timer); }
}
