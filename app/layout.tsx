import React from "react"
import type { Metadata } from "next"
import { GeistPixelLine } from "geist/font/pixel"
// Same faces as the reference layout (Inter, JetBrains Mono), but installed from
// npm instead of next/font/google, so neither the build nor the running app
// reaches fonts.googleapis.com. The reference's @vercel/analytics is omitted:
// it reports to an external service, which the no-hosted-dependency rule forbids.
import "@fontsource-variable/inter"
import "@fontsource-variable/jetbrains-mono"
import "./globals.css"

export const metadata: Metadata = {
  title: { default: "Forgeboard — From first commit to final verdict.", template: "%s · Forgeboard" },
  description: "An open-source platform for hackathon submissions, judging and results.",
  icons: { icon: "/icon.svg" },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${GeistPixelLine.variable} font-sans antialiased`}>
        {children}
      </body>
    </html>
  )
}
