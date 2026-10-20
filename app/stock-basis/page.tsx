import type { Metadata } from "next";
import KoreanPerpMonitor from "../components/KoreanPerpMonitor";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Stock cross-venue basis · TradFi Monitor",
  description: "Korean and Japanese cash/ADR spreads, plus Taiwan perpetual deviations from previous-day oracle and TSM relative-return references.",
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
