import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "SKHX Probability Desk",
  description: "Live xyz:SKHX probability for the next 14:30 Beijing close, with short-sample walk-forward evidence.",
};

export default function SkhxLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
