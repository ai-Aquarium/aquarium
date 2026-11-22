import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { BrandingProvider } from "@/components/brand/BrandingProvider";
import { ChunkErrorListener } from "@/components/ChunkErrorListener";
import { ServiceWorkerRegister } from "@/components/ServiceWorkerRegister";
import { ThemeScript } from "@/components/ThemeScript";
import { htmlLang, I18nProvider } from "@/i18n";
import { getLocale, loadMessages } from "@/i18n/server";
import { rootMetadata } from "@/lib/branding/metadata";
import { getBranding } from "@/lib/branding/server";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  return rootMetadata(await getBranding());
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#0b0d12",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [locale, branding] = await Promise.all([getLocale(), getBranding()]);
  return (
    <html lang={htmlLang(locale)} data-theme="dark" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body data-component="RootLayout">
        <I18nProvider locale={locale} messages={loadMessages(locale)}>
          <BrandingProvider initial={branding}>{children}</BrandingProvider>
        </I18nProvider>
        <ServiceWorkerRegister />
        <ChunkErrorListener />
      </body>
    </html>
  );
}
