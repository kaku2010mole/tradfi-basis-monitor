import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TradFi Basis Monitor",
  description: "Live midpoint, anchor deviation and funding monitoring for Hyperliquid xyz and Binance TradFi contracts.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
  openGraph: {
    title: "TradFi Basis Monitor",
    description: "Real-time cross-venue pulse",
    type: "website",
    images: [{ url: "/og.png", width: 1731, height: 909, alt: "TradFi Basis Monitor" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "TradFi Basis Monitor",
    description: "Real-time cross-venue pulse",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
