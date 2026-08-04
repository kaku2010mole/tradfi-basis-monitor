"use client";

import Link from "next/link";
import styles from "./PageSwitcher.module.css";

type PageSwitcherProps = {
  active: "basis" | "pairs" | "oracle" | "trade";
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
        <Link href="/trade" aria-current={active === "trade" ? "page" : undefined}>
          <span>Order desk</span>
          <small>Protected Binance oracle-limit execution</small>
        </Link>
      </nav>
    </details>
  );
}
