import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { parseTheme, THEME_COOKIE } from "@/lib/ui-prefs";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "UlixOPS",
  description: "Ulix Digital's secure WordPress operations hub.",
  robots: { index: false, follow: false },
  icons: {
    icon: [{ url: "/brand/ulixops-mark.png", type: "image/png" }],
    apple: [{ url: "/apple-icon.png", type: "image/png" }],
  },
};

// Every page renders per request so the CSP nonce from src/proxy.ts reaches every script.
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html
      lang="en"
      className={cn(inter.variable, theme !== "system" && theme)}
      suppressHydrationWarning
    >
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
