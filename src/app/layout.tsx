import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "SNAP Renewal Copilot",
  description: "A consent-first SNAP renewal assistant demo"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
