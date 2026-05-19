import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Fanwan 告警看板",
  description: "面向 Agent 的告警与备忘平台",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <div className="shell">
          <header className="topbar">
            <span className="logo">Fanwan</span>
            <span className="sub">面向 Agent 的告警与备忘平台</span>
          </header>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
