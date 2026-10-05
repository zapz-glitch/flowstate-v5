import { NextRequest, NextResponse } from 'next/server'

// Local-dev shortcut — signs in as the local test user and redirects to the
// dashboard. Guarded to localhost API targets so it can never fire in prod.
export async function GET(req: NextRequest) {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL
  if (!apiUrl?.includes('localhost')) {
    return NextResponse.json({ error: 'dev-login is localhost-only' }, { status: 403 })
  }
  const res = await fetch(`${apiUrl}/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: new URL(req.url).origin },
    body: JSON.stringify({ email: 'local@flowstate.test', password: 'V4-Test-7mQ9-rP2x!' }),
  })
  if (!res.ok) {
    return NextResponse.json({ error: 'sign-in failed', status: res.status, body: await res.text() }, { status: 502 })
  }
  const dest = NextResponse.redirect(new URL('/dashboard/analyze', req.url))
  // Forward the API's own session cookie — signed form, same attributes.
  const setCookies = res.headers.getSetCookie?.() ?? []
  for (const cookie of setCookies) {
    const [pair, ...attrs] = cookie.split(';')
    const eq = pair.indexOf('=')
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (!name.toLowerCase().includes('session')) continue
    dest.cookies.set(name, value, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 7,
    })
  }
  return dest
}
