type StatusItem = {
  name?: string;
  status?: string;
  impact?: string;
};

type StatusSummary = {
  page?: { status?: string };
  activeIncidents?: StatusItem[];
  activeMaintenances?: StatusItem[];
};

const headers = { "Cache-Control": "no-store, max-age=0", "Access-Control-Allow-Origin": "*" };

export async function GET() {
  try {
    const response = await fetch("https://status.polymarket.com/v3/summary.json", {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new Error(`Status HTTP ${response.status}`);
    const summary = await response.json() as StatusSummary;
    const active = [...(summary.activeIncidents ?? []), ...(summary.activeMaintenances ?? [])];
    const major = active.find((item) => item.impact === "MAJOROUTAGE");
    const scheduledClobMaintenance = (summary.activeMaintenances ?? []).find((item) => item.status === "INPROGRESS" && /clob|api/i.test(item.name ?? ""));
    const impact = major?.impact ?? (scheduledClobMaintenance ? "MAJOROUTAGE" : null);
    const status = summary.page?.status ?? "UNKNOWN";
    const maintenance = status === "HASISSUES" && impact === "MAJOROUTAGE";

    return Response.json({
      maintenance,
      status,
      impact,
      notice: major?.name ?? scheduledClobMaintenance?.name ?? null,
      timestamp: Date.now(),
    }, { headers });
  } catch (error) {
    return Response.json({
      maintenance: false,
      status: "UNKNOWN",
      impact: null,
      notice: error instanceof Error ? error.message : "Status unavailable",
      timestamp: Date.now(),
    }, { status: 503, headers });
  }
}
