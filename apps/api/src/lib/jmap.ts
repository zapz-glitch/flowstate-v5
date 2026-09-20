/**
 * Fastmail JMAP email sender (RFC 8620/8621).
 *
 * flowstate.homes mail is hosted on Fastmail, so messages sent through the
 * account's own JMAP API get native SPF/DKIM alignment. The draft is created
 * in the Sent mailbox so outbound mail leaves an audit trail in Sent.
 */

const JMAP_SESSION_URL = 'https://api.fastmail.com/jmap/session'
const JMAP_USING = [
  'urn:ietf:params:jmap:core',
  'urn:ietf:params:jmap:mail',
  'urn:ietf:params:jmap:submission',
]

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
  const data = (await res.json()) as {
    methodResponses: [string, Record<string, any>, string][]
  }
  const methodError = data.methodResponses?.find(([m]) => m === 'error')
  if (methodError) {
    throw new Error(`JMAP ${methodError[1]?.type ?? 'error'}: ${methodError[1]?.description ?? ''}`.slice(0, 200))
  }
  return data
}

export interface JmapSendOptions {
  token: string
  /** Preferred From identity email; falls back to the account's first identity */
  from?: string
  fromName?: string
  to: string
  subject: string
  html: string
  replyTo?: { email: string; name?: string }
}

/** Sends an email via the account's JMAP submission endpoint. */
export async function sendEmailViaJmap(opts: JmapSendOptions): Promise<void> {
  const sessionRes = await fetch(JMAP_SESSION_URL, {
    headers: { Authorization: `Bearer ${opts.token}` },
    signal: AbortSignal.timeout(5000),
  })
  if (!sessionRes.ok) throw new Error(`JMAP session ${sessionRes.status}`)
  const session = (await sessionRes.json()) as JmapSession
  const mailAccount = session.primaryAccounts['urn:ietf:params:jmap:mail']
  const subAccount = session.primaryAccounts['urn:ietf:params:jmap:submission']
  if (!mailAccount || !subAccount) throw new Error('JMAP accounts missing from session')

  const lookup = await jmapCall(session.apiUrl, opts.token, [
    ['Identity/get', { accountId: mailAccount }, 'ids'],
    ['Mailbox/query', { accountId: mailAccount, filter: { role: 'sent' }, limit: 1 }, 'mbox'],
  ])
  const identities: { id: string; email: string }[] =
    lookup.methodResponses.find(([m]) => m === 'Identity/get')?.[1]?.list ?? []
  const sentIds: string[] =
    lookup.methodResponses.find(([m]) => m === 'Mailbox/query')?.[1]?.ids ?? []
  const identity =
    identities.find((i) => i.email.toLowerCase() === opts.from?.toLowerCase()) ?? identities[0]
  const sentMailbox = sentIds[0]
  if (!identity || !sentMailbox) throw new Error('No identity or Sent mailbox on account')

  const submit = await jmapCall(session.apiUrl, opts.token, [
    ['Email/set', {
      accountId: mailAccount,
      create: {
        draft: {
          mailboxIds: { [sentMailbox]: true },
          from: [{ name: opts.fromName || 'Flowstate', email: identity.email }],
          to: [{ email: opts.to }],
          ...(opts.replyTo ? { replyTo: [{ name: opts.replyTo.name ?? '', email: opts.replyTo.email }] } : {}),
          subject: opts.subject,
          htmlBody: [{ partId: 'html', type: 'text/html' }],
          bodyValues: { html: { value: opts.html } },
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
}
