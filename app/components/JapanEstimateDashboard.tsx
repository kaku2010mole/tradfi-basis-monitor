"use client";
import { useEffect, useState } from "react";
import PageSwitcher from "./PageSwitcher";
import { visiblePolling } from "../lib/visiblePolling";
import { QUOTE_MAX_AGE } from "../lib/japanEstimate";
import { japanBrowserToken, connectJapanFeed } from "../lib/posleyBrowserSession";
import type { JapanEstimatePayload } from "../lib/japanEstimateMarket";
import styles from "./JapanEstimateDashboard.module.css";

const number = (v: number | null | undefined, digits = 2) => v !== null && v !== undefined && Number.isFinite(v) ? v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }) : "—";
const pct = (v: number | null | undefined) => v !== null && v !== undefined ? `${v >= 0 ? "+" : ""}${number(v)}%` : "—";
const stamp = (v: number | null | undefined) => v ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Hong_Kong", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(v) + " HKT" : "无报价";
export default function JapanEstimateDashboard() {
  const [data, setData] = useState<JapanEstimatePayload | null>(null), [error, setError] = useState(""), [clock, setClock] = useState(0), [busyLogin, setBusyLogin] = useState(false);
  useEffect(() => {
    let alive = true, busy = false;
    const controller = new AbortController();
    const stop = visiblePolling(async () => {
      setClock(Date.now()); if (busy) return; busy = true;
      try {
        const token = await japanBrowserToken().catch(() => null);
        if (!alive) return;
        const response = await fetch("/api/japan-estimate", { cache: "no-store", headers: token ? { Authorization: `Bearer ${token}` } : undefined, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
        if (!response.ok) throw new Error(response.status === 401 ? "登录已过期，请刷新页面重新登录。" : "数据暂未更新；下方保留上次估价及原报价时间。");
        const next = await response.json() as JapanEstimatePayload;
        if (alive) { setData(next); setError(""); setClock(Date.now()); }
      } catch (e) { if (alive) setError(e instanceof Error ? e.message : "行情暂未更新"); }
      finally { busy = false; }
    }, 2000);
    return () => { alive = false; stop(); controller.abort(); };
  }, []);
  const fresh = (t: number | null | undefined) => Boolean(t && clock - t <= QUOTE_MAX_AGE && t <= clock + 5000 && data && clock - data.timestamp <= 15_000);
  const liveK = fresh(data?.kioxia.quote?.timestamp) && !data?.kioxia.quote?.delayMinutes, liveFx = fresh(data?.fx.quote?.timestamp);
  const delayedK = Boolean(data?.kioxia.quote?.delayMinutes && clock - data.kioxia.quote.timestamp <= 35 * 60_000 && clock - data.timestamp <= 15_000);
  const status = !data ? "正在连接" : !data.anchorReady ? "等待收盘锚点" : liveK ? "真实现货驱动" : delayedK ? "延迟现货估价" : data.kioxia.quote ? "估价已冻结" : "等待收盘后现货报价";
  const connect = async () => { setBusyLogin(true); try { await connectJapanFeed(); } catch (e) { setError(e instanceof Error ? e.message : "连接失败"); setBusyLogin(false); } };
  return <main className={styles.page}>
    <header className={styles.topbar}><a href="/stock-basis" className={styles.brand}><b>↗</b><span>TRADFI MONITOR<small>JAPAN · CASH ESTIMATES</small></span></a><div className={styles.actions}><span className={liveK ? styles.live : styles.paused}><i />{status}</span><PageSwitcher active="japan-estimate" /></div></header>
    <div className={styles.content}>
      <section className={styles.heading}><div><p className={styles.eyebrow}>日本真实市场 · 以铠侠为参考</p><h1>日股估计价格</h1><p>以每天现货收盘为锚点，随铠侠真实股票报价更新。周末沿用最近交易日收盘。</p></div><a className={styles.back} href="/stock-basis?market=TSE">查看现货 / 合约面板 ↗</a></section>
      {error && <div className={styles.notice} role="status">{error}</div>}
      <section className={styles.summary} aria-label="估价输入与锚点">
        <article className={styles.anchor}><span>共同收盘锚点</span><strong>{data?.anchorDate ?? "读取交易日历…"}</strong><p>15:30 日本时间 · 14:30 香港时间</p><small>{data?.anchorReady ? "现货收盘已齐备" : data ? "新收盘价未齐备的股票暂停估价" : "正在读取真实现货收盘价"}</small></article>
        <article><span>铠侠 285A · 真实股票</span><strong>¥{number(data?.kioxia.price, 0)} <em className={styles.move}>{pct(data?.kioxia.changePct)}</em></strong><p>收盘锚点 ¥{number(data?.kioxia.anchor, 0)} · {data?.kioxia.quote ? data.kioxia.quote.kind === "mid" ? "买卖中价" : "最新成交价" : "收盘参考"}</p><small>{stamp(data?.kioxia.quote?.timestamp)}<br />{data?.kioxia.quote?.source ?? "等待收盘后的铠侠真实报价"}</small></article>
        <article><span>USD / JPY · 真实汇率</span><strong>{number(data?.fx.quote?.price, 4)} <em className={liveFx ? styles.tagLive : styles.tag}>{liveFx ? "更新中" : "参考 / 等待"}</em></strong><p>日元估价 ÷ USD/JPY = 美元估价</p><small>{stamp(data?.fx.quote?.timestamp)}<br />{data?.fx.quote?.source ?? "等待真实外汇行情"}</small></article>
      </section>
      <div className={styles.explanation}><span>收盘锚点外推 · 夜盘准确度尚未验证</span><p>模型只用真实股票收益。Bitget 报价仅在右侧比较，不参与估价。正偏离表示合约高于估计价。</p></div>
      <section className={styles.tableCard} aria-label="各股估计价格">
        <div className={styles.tableHeading}><h2>11 只日本股票</h2><span>{liveK ? "页面可见时每 2 秒刷新" : "报价停止时保留估价与原始时间"}</span></div>
        <div className={styles.tableWrap}><table><thead><tr><th>股票 / 状态</th><th>收盘锚点<br /><small>JPY</small></th><th>估计价格<br /><small>JPY / USD</small></th><th>较收盘</th><th>β / 相关性</th><th>历史日收益误差<br /><small>逐日验证 MAE</small></th><th>Bitget 买 / 卖<br /><small>USDT</small></th><th>合约较估价<br /><small>中价偏离</small></th></tr></thead><tbody>
          {data?.rows.map(row => {
            const comparable = liveK && liveFx && row.contract?.timestamp && clock - row.contract.timestamp <= 30_000;
            const deviation = comparable ? row.deviationPct : null;
            const rowStatus = row.status === "现货驱动外推" && !liveK || row.status === "延迟现货外推" && !delayedK ? "估价已冻结" : row.status;
            return <tr key={row.code}><td><a href={`https://finance.yahoo.com/quote/${row.code}.T/`} target="_blank" rel="noreferrer"><b>{row.name}</b><small>TSE {row.code}</small></a><span className={styles.rowStatus}>{rowStatus}{row.weak ? " · 联动较弱" : ""}</span></td><td>{number(row.close, 0)}</td><td className={styles.estimate}><b>¥{number(row.yen, 1)}</b><small>${number(row.usd, 3)}{row.usd !== null && !liveFx ? " · 参考汇率" : ""}</small></td><td className={(row.changePct ?? 0) < 0 ? styles.down : styles.up}>{pct(row.changePct)}</td><td><b>{number(row.model?.beta, 3)}</b><small>r {number(row.model?.correlation, 3)}</small></td><td>{number(row.model?.maePct)}<small>百分点 · {row.model?.testN ?? 0} 日{row.model?.improvementPct !== null && row.model?.improvementPct !== undefined ? ` · 改善 ${number(row.model.improvementPct, 0)}%` : ""}</small></td><td>{number(row.contract?.bid, 3)} / {number(row.contract?.ask, 3)}<small>{row.symbol}<br />{stamp(row.contract?.timestamp)}</small></td><td><b className={deviation !== null && deviation < 0 ? styles.down : deviation !== null ? styles.up : ""}>{pct(deviation)}</b><small>{deviation === null ? "等待有效行情" : "1 股口径 · 仅供比较"}</small></td></tr>;
          }) ?? <tr><td colSpan={8} className={styles.loading}>正在读取收盘锚点、真实股票模型和行情…</td></tr>}
        </tbody></table></div>
        <p className={styles.tableNote}>美元估价按 1 股换算，合约比较沿用 1 股 / 报价单位、1 USDT ≈ 1 USD 的假设；未独立核验合约乘数。偏离是模型比较值。任一输入过期时暂停显示偏离。</p>
      </section>
      <details className={styles.method}><summary>计算方法、历史检验与更新规则</summary><div>
        <p><b>估价：</b>个股收盘价 × (铠侠现价 / 铠侠同日收盘价)<sup>β</sup>。每天收盘时回到各自的真实收盘价；没有固定截距或不断累加的漂移。日元估价再除以真实 USD/JPY 汇率。</p>
        <p><b>校准：</b>最近 126 个有效交易日的真实股票收盘对数收益，用经过原点的回归计算 β；r 为同一窗口的皮尔逊相关性。各股校准截至 {data?.anchorDate ?? "—"}。历史收盘按拆股调整，不使用含分红的复权收益。</p>
        <p><b>误差：</b>最近 60 日逐日向前验证，每天只使用此前最多 126 日校准。MAE 为预测日涨幅与实际日涨幅的平均绝对差；“改善”相对始终预测股价不变。它衡量现金股票日收益估计误差，不能作为夜盘或周末的置信区间。联动较弱表示 |r| &lt; 0.4 或历史误差没有改善。</p>
        <p><b>锚点：</b>按 <a href="https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html" target="_blank" rel="noreferrer">JPX 2026–2027 交易日历</a>，每天 15:30 JST 切换。收盘数据尚未发布时暂停受影响股票；周末、节假日及次日收盘前沿用上次收盘。Yahoo 收盘数据可能延迟，拆股日先等待新锚点。</p>
        <p><b>真实行情：</b>优先使用 Posley 的铠侠股票及 USD/JPY 外汇报价。铠侠可补充 <a href="https://kabutan.jp/stock/?code=285A" target="_blank" rel="noreferrer">Japannext PTS 真实现货成交</a>；株探公开报价为 <a href="https://support.kabutan.jp/hc/ja/articles/36411519620889-PTS%E6%A0%AA%E4%BE%A1%E3%81%AB%E3%81%A4%E3%81%84%E3%81%A6" target="_blank" rel="noreferrer">15 分钟延迟</a>，单独标记，不用于实时偏离。汇率缺失时可用 Yahoo USD/JPY 现货参考。均保留原始市场时间，实时行情超过 90 秒即冻结；延迟源超过 35 分钟即冻结。没有真实新报价时只显示收盘参考，不以合约价格补齐。现货历史来源：<a href="https://finance.yahoo.com/quote/285A.T/history/" target="_blank" rel="noreferrer">Yahoo Finance · TSE 股票</a>。</p>
        {data?.rows.some(r => r.historyError) && <p className={styles.warning}>部分现货历史刷新失败，已保留带日期的缓存；若新交易日收盘缺失，该股票暂停估价。</p>}
      </div></details>
      <footer className={styles.footer}><span>行情时间均为香港时间 · 日元估价不依赖合约报价</span><button onClick={() => void connect()} disabled={busyLogin}>{busyLogin ? "连接中…" : "连接 Posley 真实行情"}</button><span>更新 {stamp(data?.timestamp)}</span></footer>
    </div>
  </main>;
}
