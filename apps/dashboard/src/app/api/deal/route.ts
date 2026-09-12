import { NextResponse } from 'next/server'

const DEAL_INBOX = 'hello@flowstate.homes'

interface DealPayload {
  name?: string
  email?: string
  address?: string
  notes?: string
  company?: string
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

async function sendDealEmail(payload: {
  name: string
  email: string
  address: string
  notes: string
}): Promise<boolean> {
  const { name, email, address, notes } = payload
  const submittedAt = new Date().toISOString()

  const html = `
    <h2 style="margin:0 0 16px">New deal submission</h2>
    <table cellpadding="6" cellspacing="0" style="border-collapse:collapse">
      <tr><td style="color:#666">Name</td><td>${escapeHtml(name)}</td></tr>
      <tr><td style="color:#666">Email</td><td>${escapeHtml(email)}</td></tr>
      <tr><td style="color:#666">Property</td><td>${escapeHtml(address)}</td></tr>
      <tr><td style="color:#666">Notes</td><td>${escapeHtml(notes) || 'None'}</td></tr>
      <tr><td style="color:#666">Submitted</td><td>${submittedAt}</td></tr>
    </table>
  `

  try {
    const res = await fetch('https://api.mailchannels.net/tx/v1/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: DEAL_INBOX }] }],
        from: { email: 'noreply@flowstate.homes', name: 'Flowstate Website' },
        reply_to: { email, name },
        subject: `Deal submission: ${address}`,
        content: [{ type: 'text/html', value: html }],
      }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
      console.error('MailChannels send failed:', res.status, await res.text())
      return false
    }
    return true
  } catch (err) {
    console.error('MailChannels send error:', err)
    return false
  }
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

  const emailed = await sendDealEmail({ name, email, address, notes })

  const webhookUrl = process.env.CONTACT_WEBHOOK_URL
  if (webhookUrl) {
    try {
      await fetch(webhookUrl, {
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
    } catch {
      console.error('CONTACT_WEBHOOK_URL forward failed')
    }
  }

  if (!emailed && !webhookUrl) {
    return NextResponse.json({ error: 'Delivery failed' }, { status: 502 })
  }

  return NextResponse.json({ ok: true })
}
