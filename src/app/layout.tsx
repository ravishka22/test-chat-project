import type { Metadata } from "next";
import "@/app/globals.css";

export const metadata: Metadata = {
  title: "Atlas | Knowledge Assistant",
  description: "A grounded AI assistant powered by your knowledge base.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
