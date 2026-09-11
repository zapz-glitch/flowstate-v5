import type { Metadata, Viewport } from 'next'
import localFont from 'next/font/local'

// Self-hosted variable fonts (same Inter + Source Serif 4 faces previously
// served by next/font/google). Vendored woff2 files so `next dev` and
// production builds work fully offline with zero Google Fonts fetches.
const inter = localFont({
  src: './fonts/inter-latin-wght-normal.woff2',
  variable: '--font-inter',
  display: 'swap',
})

const sourceSerif = localFont({
  src: [
    { path: './fonts/source-serif-4-latin-wght-normal.woff2', style: 'normal' },
    { path: './fonts/source-serif-4-latin-wght-italic.woff2', style: 'italic' },
  ],
  variable: '--font-serif',
  display: 'swap',
})
import { ThemeProvider } from '@/components/theme-provider'
import { ServiceWorkerRegistrar } from '@/components/ServiceWorkerRegistrar'
import './globals.css'

export const viewport: Viewport = {
  themeColor: '#0a0a0a',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
}

export const metadata: Metadata = {
  title: 'Flowstate',
  description: 'Property valuation and underwriting platform for real estate investors',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Flowstate',
  },
  icons: {
    icon: [
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
    ],
    apple: [
      { url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className={`${inter.variable} ${sourceSerif.variable} font-sans antialiased`}>
        <ThemeProvider>
          {children}
        </ThemeProvider>
        <ServiceWorkerRegistrar />
      </body>
    </html>
  )
}
