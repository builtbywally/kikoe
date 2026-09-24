import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Instrument_Sans, Instrument_Serif } from "next/font/google";
import "./globals.css";

// The app's three faces, self-hosted by next/font: no request to Google at
// view time and no layout shift while they load.
const serif = Instrument_Serif({
  weight: "400",
  style: ["normal", "italic"],
  subsets: ["latin"],
  variable: "--font-serif",
  display: "swap",
});
const sans = Instrument_Sans({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = IBM_Plex_Mono({
  weight: ["400", "500"],
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

const url = process.env.KIKOE_SITE_URL ?? "https://builtbywally.github.io/kikoe";
const description =
  "Kikoe is an open-source desktop app for running Claude Code by voice. Talk to Kik; the agents do the work; the canvas shows what words can't carry.";

export const metadata: Metadata = {
  metadataBase: new URL(url),
  title: "Kikoe · talk to your coding agents",
  description,
  applicationName: "Kikoe",
  keywords: ["Claude Code", "voice", "coding agents", "Whisper", "open source", "desktop app"],
  openGraph: {
    title: "Kikoe",
    description,
    url,
    siteName: "Kikoe",
    images: [{ url: "og.jpg", width: 1200, height: 630, alt: "The Room: Kikoe's canvas" }],
    type: "website",
  },
  twitter: { card: "summary_large_image", title: "Kikoe", description, images: ["og.jpg"] },
};

export const viewport: Viewport = {
  themeColor: "#14100e",
  colorScheme: "dark",
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
