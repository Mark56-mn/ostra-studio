import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ostra Studio — Manhwa Production Control",
  description: "Mobile-first AI production control for original manhwa YouTube. Real workers, real state, human approval before publish.",
  openGraph: {
    title: "Ostra Studio",
    description: "Where manhwa becomes video — with a human in the director's chair.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#070A14",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
      </head>
      <body
        className="min-h-screen antialiased selection:bg-[#FF4D5A]/30"
        style={{ fontFamily: "'Space Grotesk', system-ui, sans-serif" }}
      >
        {children}
      </body>
    </html>
  );
}
