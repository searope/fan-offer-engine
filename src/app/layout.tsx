import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Win-back offers",
  description: "Fan offer engine: review, edit, approve, or reject cart win-back offers before anything reaches a fan.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // Browser extensions (dark mode, translators, writing tools) often add classes or attributes to <html>
    // before React loads, which React reports as a hydration mismatch. This only relaxes <html>'s own
    // attributes; mismatches anywhere inside the page are still reported.
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`} suppressHydrationWarning>
      <body className="min-h-full bg-slate-50 text-slate-900">{children}</body>
    </html>
  );
}
