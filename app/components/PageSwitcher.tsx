"use client";

import Link from "next/link";
import styles from "./PageSwitcher.module.css";

type PageSwitcherProps = {
  active: "basis" | "pairs" | "oracle" | "blog" | "trade" | "polymarket" | "auction";
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
          <small>Relative value and order books</small>
        </Link>
        <Link href="/oracle" aria-current={active === "oracle" ? "page" : undefined}>
          <span>Oracle monitor</span>
          <small>Live price, oracle drift and funding</small>
        </Link>
        <Link href="/blog" aria-current={active === "blog" ? "page" : undefined}>
          <span>Relative value monitor</span>
          <small>Live 10-second relationships and dislocations</small>
        </Link>
        <Link href="/trade" aria-current={active === "trade" ? "page" : undefined}>
          <span>Relative value execution</span>
          <small>Password-protected Binance pair orders</small>
        </Link>
        <Link href="/polymarket" aria-current={active === "polymarket" ? "page" : undefined}>
          <span>Polymarket Perps</span>
          <small>Live funding, history and Binance spreads</small>
        </Link>
        <Link href="/hk-auction" aria-current={active === "auction" ? "page" : undefined}>
          <span>HK auction basis</span>
          <small>Futu pre-open auction versus Binance perps</small>
        </Link>
      </nav>
    </details>
  );
}
