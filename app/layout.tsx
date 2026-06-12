import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Home Codex",
  description: "Private AI coding workspace"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
