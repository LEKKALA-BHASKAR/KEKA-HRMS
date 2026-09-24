import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Keka — HR & Payroll",
  description: "Multi-tenant HR and payroll platform with Indian statutory compliance",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
