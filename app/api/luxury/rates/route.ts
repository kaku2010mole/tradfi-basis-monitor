import { getLuxuryRates } from '../../../lib/luxuryFx';

export async function GET(request: Request) {
  const url = new URL(request.url);
  return Response.json(await getLuxuryRates(url.searchParams.get('refresh') === '1'), {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}
