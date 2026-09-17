import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare'

initOpenNextCloudflareForDev()

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
  // Inline env vars at build time
  // NODE_ENV=production in deploy script will use .env.production values
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  },
  async headers() {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'https://api.flowstate.homes'
    const securityHeaders = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self)' },
    ]
    // CSP is production-only: dev tooling (turbopack/react-refresh) needs
    // unsafe-eval, and CSP breakage in dev costs more than it protects.
    if (process.env.NODE_ENV === 'production') {
      securityHeaders.push({
        key: 'Content-Security-Policy',
        value: [
          "default-src 'self'",
          // Next hydrates inline scripts; the on-demand PDF layout engine uses
          // WebAssembly. Allow WASM compilation without enabling JavaScript eval.
          `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://maps.googleapis.com`,
          // MapLibre and component libs inject inline styles
          "style-src 'self' 'unsafe-inline'",
          // Property photos, map tiles, streetview, data/blob images
          "img-src 'self' data: blob: https:",
          "font-src 'self' data:",
          `connect-src 'self' ${apiUrl} https://maps.googleapis.com data: blob:`,
          // MapLibre renders in workers from blob: URLs
          "worker-src 'self' blob:",
          // SEO engine console embeds at /dashboard/seo
          "frame-src 'self' https://insights.flowstate.homes",
          "frame-ancestors 'none'",
          "base-uri 'self'",
          "form-action 'self'",
        ].join('; '),
      })
    }
    return [{ source: '/:path*', headers: securityHeaders }]
  },
}

export default nextConfig
