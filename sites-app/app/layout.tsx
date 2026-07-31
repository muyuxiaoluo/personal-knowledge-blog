import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "人生攻略库 · 私人思考花园",
  description: "一个本地优先的私人思考工作台，让灵感、经验与旧日判断重新发生联系。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
