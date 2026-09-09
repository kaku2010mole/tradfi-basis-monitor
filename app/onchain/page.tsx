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
          <p>OKX X Layer xStocks against matching Binance perpetuals. Both directions use tradeable top-of-book prices and the scanner can exclude oversized-volume contracts.</p>
        </div>
        <PageSwitcher active="onchain" />
      </header>
      <XstockPerpMonitor />
    </div>
  </main>;
}
