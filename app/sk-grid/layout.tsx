import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pair Grid Lab · TradFi Basis Monitor",
  description: "Interactive SK and gold relative-value grid research with live spreads, configurable costs, funding, and holdout backtests.",
  openGraph: {
    title: "Pair Grid Lab",
    description: "SK, gold and equity spreads with live research and holdout backtests.",
    type: "website",
    images: [{ url: "/og-grid.png", width: 1731, height: 909, alt: "Pair Grid Lab" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Pair Grid Lab",
    description: "SK, gold and equity spreads with live research and holdout backtests.",
    images: ["/og-grid.png"],
  },
};

export default function GridLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
