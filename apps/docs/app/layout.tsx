import type { Metadata, Viewport } from "next";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { site } from "@/content/site";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: { default: "Köni — graph-compiled agent work", template: "%s · Köni" },
  description: site.description,
  applicationName: "Köni Docs",
  keywords: ["Köni", "koni", "Codex", "agent orchestration", "graph planning", "developer tools"],
  authors: [{ name: "Köni contributors" }],
  creator: "Köni contributors",
  openGraph: {
    type: "website",
    siteName: "Köni",
    title: "Köni — make agent work traversable",
    description: site.description,
    url: site.url,
  },
  twitter: {
    card: "summary_large_image",
    title: "Köni — make agent work traversable",
    description: site.description,
  },
  alternates: { canonical: "/" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f2ea" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0d0c" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">Skip to content</a>
        <SiteHeader />
        <main id="main-content">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
