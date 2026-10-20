// UI polling only: server-side recorders and alert delivery are independent.
// No timer wakes while the document is hidden; returning refreshes immediately.
export function visiblePolling(run: (resumed: boolean) => void, interval: number, page: Pick<Document, "hidden" | "addEventListener" | "removeEventListener"> = document) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let first: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const clear = () => { clearInterval(timer); clearTimeout(first); timer = undefined; first = undefined; };
  const tick = (resumed = false) => { if (!stopped && !page.hidden) run(resumed); };
  const resume = () => {
    clear();
    if (stopped || page.hidden) return;
    first = setTimeout(() => tick(true), 0);
    timer = setInterval(tick, interval);
  };
  page.addEventListener("visibilitychange", resume);
  resume();
  return () => { stopped = true; clear(); page.removeEventListener("visibilitychange", resume); };
}
