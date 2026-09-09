"use client";

import PageSwitcher from "../components/PageSwitcher";
import XstockPerpMonitor from "../components/XstockPerpMonitor";
import styles from "./page.module.css";

export default function XstockPerpPage() {
  return <main className={styles.shell}>
    <div className={styles.frame}>
      <header className={styles.topbar}>
        <div>
          <p className={styles.eyebrow}>CROSS-VENUE EXECUTION WATCH</p>
          <h1>xStock–Perp</h1>
          <p>OKX centralized-exchange xStock spot order books against matching Binance perpetuals. Both directions use tradeable best bid / ask, with configurable high-volume exclusion.</p>
        </div>
        <PageSwitcher active="onchain" />
      </header>
      <XstockPerpMonitor />
    </div>
  </main>;
}
