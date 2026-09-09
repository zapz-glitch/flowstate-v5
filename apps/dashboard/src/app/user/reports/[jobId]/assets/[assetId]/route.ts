import { cookies } from 'next/headers'

export async function GET(_request: Request, context: { params: Promise<{ jobId: string; assetId: string }> }) {
  const { jobId, assetId } = await context.params
  if (!/^[a-zA-Z0-9_-]{1,150}$/.test(jobId) || !/^[a-f0-9-]{36}$/.test(assetId)) return new Response(null, { status: 404 })
  const cookieStore = await cookies()
  const cookieHeader = cookieStore.getAll().map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
  if (!cookieHeader) return new Response(null, { status: 401 })
  try {
    const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/user/reports/${jobId}/assets/${assetId}`, {
      headers: { Cookie: cookieHeader }, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) return new Response(null, { status: [401,404].includes(response.status) ? response.status : 502 })
    return new Response(response.body, { headers: {
      'Content-Type': response.headers.get('Content-Type') ?? 'application/octet-stream',
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
    } })
  } catch { return new Response(null, { status: 502 }) }
}
