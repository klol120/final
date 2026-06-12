import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Project 2",
  description: "Project 2 final"
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
