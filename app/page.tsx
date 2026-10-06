import type { Metadata } from "next";
import PageSwitcher from "./components/PageSwitcher";
import JlpFrame from "./components/JlpFrame";

export const metadata: Metadata = {
  title: "JLP Research · Live Monitor",
  description: "JLP price, yield, hedge ratios, financing and funding in one live dashboard.",
};

export default function Home() {
  return (
    <main style={{ background: "#0b1117", color: "#eaf2f6", paddingBottom: 0 }}>
      <nav aria-label="Dashboard navigation" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px clamp(20px, 3vw, 40px)", borderBottom: "1px solid #24323d" }}>
        <span style={{ font: "700 12px/1.5 monospace", letterSpacing: ".08em" }}>TRADFI MONITOR / JLP RESEARCH</span>
        <PageSwitcher active="jlp" />
      </nav>
      <JlpFrame />
    </main>
  );
}
