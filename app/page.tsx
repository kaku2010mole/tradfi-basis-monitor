import type { Metadata } from "next";
import PageSwitcher from "./components/PageSwitcher";
import JlpFrame from "./components/JlpFrame";

export const metadata: Metadata = {
  title: "JLP Research · Live Monitor",
  description: "JLP price, yield, hedge ratios, financing and funding in one live dashboard.",
};

export default function Home() {
  return (
    <main className="jlp-shell">
      <nav aria-label="Dashboard navigation" className="jlp-navigation">
        <span style={{ font: "700 12px/1.5 monospace", letterSpacing: ".08em" }}>TRADFI MONITOR / JLP RESEARCH</span>
        <PageSwitcher active="jlp" />
      </nav>
      <JlpFrame />
    </main>
  );
}
