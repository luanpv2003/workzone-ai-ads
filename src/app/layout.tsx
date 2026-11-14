import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { BRAND } from "@/lib/brand";
import { getLocale } from "@/i18n/server";
import { I18nProvider } from "@/i18n/client";

const geist = Geist({ variable: "--font-geist", subsets: ["latin", "vietnamese"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin", "vietnamese"] });

export const metadata: Metadata = {
  title: BRAND.app,
  description: "AI-assisted Meta ads management for agencies and shop owners",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale} className={`${geist.variable} ${geistMono.variable} h-full antialiased`} data-theme="light" suppressHydrationWarning>
      <head>
        {/* Apply the chosen light / dark mode before painting the page (no flash). */}
        <script dangerouslySetInnerHTML={{ __html: `try{if(localStorage.getItem("wz-theme")==="dark")document.documentElement.dataset.theme="dark"}catch(e){}` }} />
      </head>
      {/* Browser extensions (e.g. ColorZilla) inject attributes into <body> → suppress attribute-mismatch warnings on this element only. */}
      <body className="h-full font-sans" suppressHydrationWarning>
        <I18nProvider locale={locale}>{children}</I18nProvider>
      </body>
    </html>
  );
}
