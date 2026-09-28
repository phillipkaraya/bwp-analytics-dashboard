import type { Metadata } from "next";
import "./globals.css";
import { AuthGate } from "@/components/layout/auth-gate";
import { AppShell } from "@/components/layout/app-shell";

export const metadata: Metadata = {
  title: "Build With Phil Analytics",
  description:
    "Phillip Karaya / Build With Phil: Social Media Analytics Dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full bg-background text-foreground">
        <AuthGate>
          <AppShell>{children}</AppShell>
        </AuthGate>
      </body>
    </html>
  );
}
