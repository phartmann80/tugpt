import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TuGPT.ai",
  description: "Tu empleado con IA para WhatsApp, llamadas y clientes.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body className="min-h-screen flex flex-col antialiased">
        {children}
      </body>
    </html>
  );
}
