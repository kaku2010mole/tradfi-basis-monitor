"use client";

import Link from "next/link";
import styles from "./PageSwitcher.module.css";

type PageSwitcherProps = {
  active: "basis" | "pairs" | "oracle" | "taker" | "polymarket" | "auction";
};

export default function PageSwitcher({ active }: PageSwitcherProps) {
  return (
    <details className={styles.switcher}>
      <summary aria-label="Open dashboard settings">
        <span aria-hidden="true">⚙</span>
        <b>Settings</b>
      </summary>
      <nav aria-label="Dashboard pages">
        <p>Switch dashboard</p>
        <Link href="/" aria-current={active === "basis" ? "page" : undefined}>
          <span>Basis monitor</span>
          <small>Midpoint, anchor drift and funding</small>
        </Link>
        <Link href="/ewy-koru" aria-current={active === "pairs" ? "page" : undefined}>
          <span>Leveraged pairs</span>
          <small>Leveraged relationships and order books</small>
        </Link>
        <Link href="/oracle" aria-current={active === "oracle" ? "page" : undefined}>
          <span>Oracle monitor</span>
          <small>Live price, oracle drift and funding</small>
        </Link>
        <Link href="/taker" aria-current={active === "taker" ? "page" : undefined}>
          <span>Hyperliquid Taker–Taker</span>
          <small>Internal two-perp IOC spread execution</small>
        </Link>
        <Link href="/polymarket" aria-current={active === "polymarket" ? "page" : undefined}>
          <span>Polymarket Perps</span>
          <small>Live funding, history and Binance spreads</small>
        </Link>
        <Link href="/hk-auction" aria-current={active === "auction" ? "page" : undefined}>
          <span>HK auction basis</span>
          <small>Futu auction versus Binance perps and Posley ADRs</small>
        </Link>
      </nav>
    </details>
  );
}
