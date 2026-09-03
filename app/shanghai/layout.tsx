import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Shanghai Composite Next-Close Probability",
  description: "Live Shanghai Composite next-close probability with an A50 futures proxy outside cash hours.",
};

export default function ShanghaiLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
