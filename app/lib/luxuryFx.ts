import snapshotRows from '../../public/luxury-app/data/fx-snapshot.json';
import { normalizeRates } from '../../public/luxury-app/core.mjs';

const sourceUrl = 'https://api.frankfurter.dev/v2/rates?base=CNY&quotes=USD,EUR,GBP,HKD,JPY,SGD,KRW,AUD,CAD,CHF&providers=ecb';
const provider = 'Frankfurter / European Central Bank';
type RatesResult = ReturnType<typeof normalizeRates> & { status: string; fetchedAt: string | null; sourceUrl: string; provider: string; message?: string; attemptedAt?: string };
let cached: RatesResult = { ...normalizeRates(snapshotRows), fetchedAt: null, status: 'snapshot', sourceUrl, provider };
let fetchedTime = 0;
let retryAfter = 0;
let inFlight: Promise<RatesResult> | null = null;

export async function getLuxuryRates(force = false): Promise<RatesResult> {
  const now = Date.now();
  if (now < retryAfter || (fetchedTime && now - fetchedTime < (force ? 15_000 : 3_600_000))) return cached;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!response.ok) throw new Error('Reference rates unavailable');
      const normalized = normalizeRates(await response.json());
      const today = new Date().toISOString().slice(0, 10);
      if (Object.values(normalized.dates).some(date => date && String(date) > today)) throw new Error('Invalid publication date');
      cached = { ...normalized, fetchedAt: new Date().toISOString(), status: 'live', sourceUrl, provider };
      fetchedTime = Date.now();
      retryAfter = 0;
    } catch {
      retryAfter = Date.now() + 30_000;
      cached = { ...cached, status: cached.fetchedAt ? 'cached' : 'snapshot', message: '暂时无法连接汇率服务，使用最近核实的汇率。', attemptedAt: new Date().toISOString() };
    } finally { inFlight = null; }
    return cached;
  })();
  return inFlight;
}
