import type { Metadata } from "next";
import { Space_Grotesk, Geist_Mono, Unbounded } from "next/font/google";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const brandFont = Unbounded({
  variable: "--font-brand",
  subsets: ["latin"],
  weight: ["600", "700"],
});

export const metadata: Metadata = {
  title: "PolymarketSpy",
  description: "Copy Polymarket trades in real-time.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${spaceGrotesk.variable} ${geistMono.variable} ${brandFont.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
