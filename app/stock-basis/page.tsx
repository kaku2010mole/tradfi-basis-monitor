import type { Metadata } from "next";
import KoreanPerpMonitor from "../components/KoreanPerpMonitor";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Stock cross-venue basis · TradFi Monitor",
  description: "Korean and Japanese cash stocks, U.S. ADRs and perpetuals: live bid/ask spreads, FX and trade directions.",
};

export default function StockBasisPage() {
  return (
    <main className={styles.shell}>
      <div className={styles.frame}>
        <KoreanPerpMonitor />
      </div>
    </main>
  );
}
