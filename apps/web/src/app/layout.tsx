import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Harness — Your money, in view",
  description:
    "A calmer view of spending, savings, and paper investing. Harness Finance Sandbox.",
  robots: { index: false, follow: false },
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
