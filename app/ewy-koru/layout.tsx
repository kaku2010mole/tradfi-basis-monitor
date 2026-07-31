import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Leveraged Pair Relative Value Monitor",
  description: "Live normalized-return, residual and order-book monitoring across five linked-product pairs.",
};

export default function EwyKoruLayout({ children }: { children: React.ReactNode }) {
  return children;
}
