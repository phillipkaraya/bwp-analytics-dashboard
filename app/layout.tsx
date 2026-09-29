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
      {process.env.NODE_ENV === "production" ? (
        <head>
          <meta
            httpEquiv="Content-Security-Policy"
            content="connect-src 'self' https://api.anthropic.com http://localhost:5556 http://127.0.0.1:5556"
          />
        </head>
      ) : null}
      <body className="min-h-full bg-background text-foreground">
        <AuthGate>
          <AppShell>{children}</AppShell>
        </AuthGate>
      </body>
    </html>
  );
}
