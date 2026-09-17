'use client'

// SEO Engine console — the flowstate-seo-engine admin UI served from
// insights.flowstate.homes, embedded same-origin style inside the dashboard.
// Admin auth is the engine's own SEO_ADMIN_KEY cookie (SameSite=None;Secure),
// so the operator signs in once inside the frame.
const SEO_CONSOLE_URL =
  process.env.NEXT_PUBLIC_SEO_CONSOLE_URL ?? 'https://insights.flowstate.homes/admin/seo'

export default function SeoPage() {
  return (
    <div className="flex flex-col h-[calc(100dvh-4rem)] -m-4 sm:-m-6">
      <iframe
        src={SEO_CONSOLE_URL}
        title="SEO Engine"
        className="flex-1 w-full border-0 bg-white"
      />
    </div>
  )
}
