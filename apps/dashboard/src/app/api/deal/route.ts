import { NextResponse } from 'next/server'

interface DealPayload {
  name?: string
  email?: string
  address?: string
  notes?: string
  company?: string
}

export async function POST(request: Request) {
  let body: DealPayload
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
  }

  // Honeypot: silently accept bot submissions without forwarding
  if (body.company) {
    return NextResponse.json({ ok: true })
  }

  const name = body.name?.trim()
  const email = body.email?.trim()
  const address = body.address?.trim()
  const notes = body.notes?.trim() ?? ''

  if (!name || !email || !address) {
    return NextResponse.json({ error: 'Name, email, and property address are required' }, { status: 400 })
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: 'Invalid email address' }, { status: 400 })
  }

  const webhookUrl = process.env.CONTACT_WEBHOOK_URL
  if (!webhookUrl) {
    return NextResponse.json({ error: 'not_configured' }, { status: 501 })
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'flowstate.homes/deal',
        name,
        email,
        address,
        notes,
        submittedAt: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
      return NextResponse.json({ error: 'Delivery failed' }, { status: 502 })
    }
  } catch {
    return NextResponse.json({ error: 'Delivery failed' }, { status: 502 })
  }

  return NextResponse.json({ ok: true })
}
