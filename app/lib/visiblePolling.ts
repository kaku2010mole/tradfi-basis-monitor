// UI polling only: server-side recorders and alert delivery are independent.
// No timer wakes while the document is hidden; returning refreshes immediately.
export function visiblePolling(run: () => void, interval: number, page: Pick<Document, "hidden" | "addEventListener" | "removeEventListener"> = document) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let first: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const clear = () => { clearInterval(timer); clearTimeout(first); timer = undefined; first = undefined; };
  const tick = () => { if (!stopped && !page.hidden) run(); };
  const resume = () => {
    clear();
    if (stopped || page.hidden) return;
    first = setTimeout(tick, 0);
    timer = setInterval(tick, interval);
  };
  page.addEventListener("visibilitychange", resume);
  resume();
  return () => { stopped = true; clear(); page.removeEventListener("visibilitychange", resume); };
}
