"use client";

import Link from "next/link";
import styles from "./PageSwitcher.module.css";

type PageSwitcherProps = {
  active: "basis" | "pairs";
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
      </nav>
    </details>
  );
}
