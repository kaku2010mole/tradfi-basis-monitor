import type { Metadata } from "next";
import "./hsi.css";

export const metadata: Metadata = {
  title: "HSI Probability Desk",
  description: "Live Hang Seng next-close probability with index and active-futures switching plus walk-forward evidence by time to close.",
};

export default function HsiLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
