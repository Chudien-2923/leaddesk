import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./tokens.css";
import "./prototype.css";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "LeadDesk — Ad management consultation", template: "%s — LeadDesk" },
  description: "Ask about Meta Ads and Google Ads management, pricing and minimum budgets, and book a 30-minute consultation.",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", interactiveWidget: "resizes-content", themeColor: "#FFFFFF" };
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
