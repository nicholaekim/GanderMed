import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GanderMed — take a gander at your meds",
  description:
    "Canadian medication safety: log what you take, catch combinations that don't mix, and share safely with your care team. Powered by Health Canada's Drug Product Database.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-100 font-sans text-slate-900 antialiased">
        {children}
      </body>
    </html>
  );
}
