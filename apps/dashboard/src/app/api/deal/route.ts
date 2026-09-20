import { NextResponse } from 'next/server'

const DEAL_INBOX = 'hello@flowstate.homes'
const JMAP_SESSION_URL = 'https://api.fastmail.com/jmap/session'
const JMAP_USING = [
  'urn:ietf:params:jmap:core',
  'urn:ietf:params:jmap:mail',
  'urn:ietf:params:jmap:submission',
]

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

interface JmapSession {
  apiUrl: string
  primaryAccounts: Record<string, string>
}

async function jmapCall(
  apiUrl: string,
  token: string,
  methodCalls: [string, Record<string, unknown>, string][],
): Promise<{ methodResponses: [string, Record<string, any>, string][] }> {
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ using: JMAP_USING, methodCalls }),
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`JMAP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  // Method-level failures come back as ["error", {type, description}, tag]
  const methodError = data.methodResponses?.find(([m]: [string]) => m === 'error')
  if (methodError) {
    throw new Error(`JMAP ${methodError[1]?.type ?? 'error'}: ${methodError[1]?.description ?? ''}`.slice(0, 200))
  }
  return data
}

/**
 * Sends the deal notification via Fastmail's JMAP API (RFC 8620/8621).
 * hello@flowstate.homes is hosted on Fastmail, so the message is sent by the
 * same provider that owns the inbox — SPF/DKIM are inherently aligned.
 * The draft is created in the Sent mailbox so submissions leave an audit
 * trail in the account's Sent folder.
 */
async function sendDealEmail(payload: {
  name: string
  email: string
  address: string
  notes: string
}): Promise<boolean> {
  const token = process.env.FASTMAIL_API_TOKEN
  if (!token) {
    console.error('FASTMAIL_API_TOKEN not configured — deal email skipped')
    return false
  }
  const { name, email, address, notes } = payload
  const submittedAt = new Date().toISOString()
  const preferredFrom = process.env.DEAL_FROM_EMAIL || DEAL_INBOX

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
    const sessionRes = await fetch(JMAP_SESSION_URL, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    })
    if (!sessionRes.ok) throw new Error(`JMAP session ${sessionRes.status}`)
    const session = (await sessionRes.json()) as JmapSession
    const mailAccount = session.primaryAccounts['urn:ietf:params:jmap:mail']
    const subAccount = session.primaryAccounts['urn:ietf:params:jmap:submission']
    if (!mailAccount || !subAccount) throw new Error('JMAP accounts missing from session')

    const lookup = await jmapCall(session.apiUrl, token, [
      ['Identity/get', { accountId: mailAccount }, 'ids'],
      ['Mailbox/query', { accountId: mailAccount, filter: { role: 'sent' }, limit: 1 }, 'mbox'],
    ])
    const identities: { id: string; email: string }[] =
      lookup.methodResponses.find(([m]) => m === 'Identity/get')?.[1]?.list ?? []
    const sentIds: string[] =
      lookup.methodResponses.find(([m]) => m === 'Mailbox/query')?.[1]?.ids ?? []
    const identity =
      identities.find((i) => i.email.toLowerCase() === preferredFrom.toLowerCase()) ?? identities[0]
    const sentMailbox = sentIds[0]
    if (!identity || !sentMailbox) throw new Error('No identity or Sent mailbox on account')

    const submit = await jmapCall(session.apiUrl, token, [
      ['Email/set', {
        accountId: mailAccount,
        create: {
          draft: {
            mailboxIds: { [sentMailbox]: true },
            from: [{ name: 'Flowstate Website', email: identity.email }],
            to: [{ email: DEAL_INBOX }],
            replyTo: [{ name, email }],
            subject: `Deal submission: ${address}`,
            htmlBody: [{ partId: 'html', type: 'text/html' }],
            bodyValues: { html: { value: html } },
          },
        },
      }, 'draft'],
      ['EmailSubmission/set', {
        accountId: subAccount,
        create: { sub: { emailId: '#draft', identityId: identity.id } },
      }, 'sub'],
    ])
    const emailSet = submit.methodResponses.find(([, , tag]) => tag === 'draft')?.[1]
    const subSet = submit.methodResponses.find(([, , tag]) => tag === 'sub')?.[1]
    if (emailSet?.notCreated?.draft) throw new Error(`Email/set rejected: ${JSON.stringify(emailSet.notCreated.draft).slice(0, 200)}`)
    if (subSet?.notCreated?.sub) throw new Error(`EmailSubmission rejected: ${JSON.stringify(subSet.notCreated.sub).slice(0, 200)}`)
    if (!subSet?.created?.sub) throw new Error('EmailSubmission returned no created result')
    return true
  } catch (err) {
    console.error('JMAP send error:', err instanceof Error ? err.message : err)
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

  // Capture every submission in worker logs (observability is enabled on
  // this worker), independent of downstream delivery
  console.log('DEAL_SUBMISSION', JSON.stringify({
    name, email, address, notes, submittedAt: new Date().toISOString(),
  }))

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

  // Backstop: if neither email nor webhook delivered, park the lead in the
  // API waitlist so it is never lost
  if (!emailed && !webhookUrl) {
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL
      if (apiUrl) {
        const [firstName, ...rest] = name.split(' ')
        await fetch(`${apiUrl}/waitlist`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email,
            firstName: firstName || name,
            lastName: rest.join(' ') || '-',
          }),
          signal: AbortSignal.timeout(5000),
        })
      }
    } catch {
      console.error('Waitlist backstop failed for', email)
    }
  }

  // Never surface delivery plumbing problems to the visitor: the lead is
  // captured in worker logs at minimum
  return NextResponse.json({ ok: true })
}
