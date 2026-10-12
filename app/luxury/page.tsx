import type { Metadata } from "next";
import PageSwitcher from "../components/PageSwitcher";

export const metadata: Metadata = {
  title: "寻价 Atelier Index · 全球奢侈品比价",
  description: "同款手袋的全球官方价格、人民币汇率与退税后参考价格。",
};

export default function LuxuryPage() {
  return (
    <div style={{ background: "#f8f7f3", minHeight: "100dvh" }}>
      <div style={{ height: 38, display: "flex", justifyContent: "flex-end", alignItems: "center", padding: "0 20px", borderBottom: "1px solid #e0e0d7" }}>
        <PageSwitcher active="luxury" />
      </div>
      <iframe src="/luxury-app/index.html" title="寻价 · 全球奢侈品包款官价与退税比较" style={{ width: "100%", height: "calc(100dvh - 38px)", minHeight: 480, border: 0, display: "block", background: "#f8f7f3" }} />
    </div>
  );
}
