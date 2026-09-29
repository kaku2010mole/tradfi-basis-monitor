"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Symbol = "ZT" | "ZF" | "ZN" | "ZB";
type Contract = { symbol: Symbol; tenor: string; referencePrice: number | null; referenceYield: number; pointValue: number; dv01: number };
type Baseline = { ok: boolean; asOf: string; curveSource: string; settlementSource: string; missing: Symbol[]; contracts: Contract[] };

const STORAGE_KEY = "tradfi-treasury-yield-prices-v2";
const EMPTY_PRICES: Record<Symbol, string> = { ZT: "", ZF: "", ZN: "", ZB: "" };

function parseTreasuryPrice(raw: string) {
  const value = raw.trim();
  if (!value) return null;
  const decimal = Number(value.replaceAll(",", ""));
  if (Number.isFinite(decimal) && decimal > 0) return decimal;
  const quoted = value.match(/^(\d+)[-' ](\d{1,2})(\+|[0-7])?$/);
  if (!quoted) return null;
  const thirtySeconds = Number(quoted[2]);
  if (thirtySeconds > 31) return null;
  return Number(quoted[1]) + thirtySeconds / 32 + (quoted[3] === "+" ? 4 : Number(quoted[3] ?? 0)) / 256;
}

function estimateYield(contract: Contract, price: number) {
  if (contract.referencePrice === null) return null;
  const yieldChangeBp = -((price - contract.referencePrice) * contract.pointValue) / contract.dv01;
  return { yieldPct: contract.referenceYield + yieldChangeBp / 100, yieldChangeBp };
}

export default function TreasuryYieldEstimator() {
  const [prices, setPrices] = useState(EMPTY_PRICES);
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const storageLoaded = useRef(false);

  const applySettlementPrices = useCallback((contracts: Contract[]) => {
    setPrices(Object.fromEntries(contracts.map((contract) => [contract.symbol, contract.referencePrice?.toString() ?? ""])) as Record<Symbol, string>);
  }, []);

  const loadBaseline = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/treasury-yields", { cache: "no-store" });
      const payload = await response.json() as Baseline & { error?: string };
      if (!response.ok) throw new Error(payload.error || "每日基准暂时不可用");
      setBaseline(payload);
      setError(payload.ok ? null : `等待 OpenD 提供 ${payload.missing.join(" / ")} 最近结算价`);
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (!storageLoaded.current && saved) setPrices((current) => ({ ...current, ...JSON.parse(saved) }));
      else if (!storageLoaded.current) applySettlementPrices(payload.contracts);
      storageLoaded.current = true;
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "每日基准暂时不可用");
    } finally {
      setLoading(false);
    }
  }, [applySettlementPrices]);

  useEffect(() => {
    const initial = window.setTimeout(() => void loadBaseline(), 0);
    const timer = window.setInterval(() => void loadBaseline(), 30 * 60_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [loadBaseline]);

  useEffect(() => {
    if (storageLoaded.current) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prices));
  }, [prices]);

  const estimates = useMemo(() => Object.fromEntries((baseline?.contracts ?? []).map((contract) => {
    const price = parseTreasuryPrice(prices[contract.symbol]);
    return [contract.symbol, price === null ? null : estimateYield(contract, price)];
  })), [baseline, prices]);

  const contracts = baseline?.contracts ?? (["ZT", "ZF", "ZN", "ZB"] as Symbol[]).map((symbol) => ({ symbol, tenor: "—", referencePrice: null, referenceYield: 0, pointValue: 0, dv01: 0 }));

  return (
    <section className="yield-estimator" aria-labelledby="yield-estimator-title">
      <header className="yield-estimator-head">
        <div>
          <span className="yield-kicker">DAILY TREASURY BASELINE · MANUAL PRICE INPUT</span>
          <h2 id="yield-estimator-title">美债期货收益率估算</h2>
          <p>输入价格即刻更新。美债曲线与 OpenD 期货结算基准每日自动更新；支持十进制及 <code>104-14+</code> 报价。</p>
        </div>
        <div className="yield-actions">
          <button type="button" disabled={loading} onClick={() => void loadBaseline()}>{loading ? "更新中…" : "刷新基准"}</button>
          <button type="button" disabled={!baseline} onClick={() => baseline && applySettlementPrices(baseline.contracts)}>填入结算价</button>
        </div>
      </header>

      {error && <div className="yield-notice">{error}</div>}
      <div className="yield-contract-grid">
        {contracts.map((contract) => {
          const estimate = estimates[contract.symbol] as ReturnType<typeof estimateYield> | null | undefined;
          const invalid = prices[contract.symbol].trim() !== "" && parseTreasuryPrice(prices[contract.symbol]) === null;
          return (
            <article className="yield-contract" key={contract.symbol}>
              <div className="yield-contract-name"><strong>{contract.symbol}</strong><span>{contract.tenor} Treasury</span></div>
              <label htmlFor={`yield-price-${contract.symbol}`}>期货价格<input id={`yield-price-${contract.symbol}`} inputMode="decimal" spellCheck={false} value={prices[contract.symbol]} aria-invalid={invalid} placeholder={contract.referencePrice?.toString() ?? "等待结算价"} onChange={(event) => setPrices((current) => ({ ...current, [contract.symbol]: event.target.value }))} /></label>
              <div className="yield-result">
                <span>估算收益率</span><strong>{estimate ? `${estimate.yieldPct.toFixed(2)}%` : "—"}</strong>
                <small className={!estimate ? "" : estimate.yieldChangeBp > 0 ? "negative" : estimate.yieldChangeBp < 0 ? "positive" : ""}>{estimate ? `${estimate.yieldChangeBp >= 0 ? "+" : ""}${estimate.yieldChangeBp.toFixed(1)} bp vs 基准` : invalid ? "价格格式无法识别" : contract.referencePrice === null ? "等待 OpenD 结算价" : "等待输入"}</small>
              </div>
            </article>
          );
        })}
      </div>

      <footer><span>基准日 {baseline?.asOf ?? "—"} · U.S. Treasury par curve + Futu OpenD previous close</span><span>每 30 分钟检查新基准 · DV01 线性近似，通常误差约 ±1–2 bp</span></footer>
    </section>
  );
}
