/**
 * Better Auth Configuration for API
 *
 * Centralizes all authentication for the platform. The dashboard
 * calls these endpoints instead of managing its own auth.
 *
 * Uses Kysely + D1Dialect for runtime queries because drizzleAdapter
 * passes Date objects that D1 rejects (D1_TYPE_ERROR).
 */

import { betterAuth } from 'better-auth'
import { Kysely } from 'kysely'
import { D1Dialect } from 'kysely-d1'
import { stagingAuthProfile } from './staging-auth'
import { sendEmailViaJmap } from './jmap'

interface EmailConfig {
  token?: string
  from?: string
}

/**
 * Send email via Fastmail JMAP (RFC 8620/8621) — Cloudflare Workers compatible.
 * Never logs the message body (reset URLs contain bearer tokens).
 */
async function sendEmail(
  to: string,
  subject: string,
  html: string,
  email: EmailConfig
): Promise<boolean> {
  if (!email.token) {
    console.error('FASTMAIL_API_TOKEN not configured — password reset email NOT sent to', to)
    return false
  }

  try {
    await sendEmailViaJmap({
      token: email.token,
      from: email.from || 'hello@flowstate.homes',
      fromName: 'Flowstate',
      to,
      subject,
      html,
    })
    return true
  } catch (err) {
    console.error('Password reset email send failed:', err instanceof Error ? err.message : err)
    return false
  }
}

export function createAuth(
  d1: D1Database,
  secret: string,
  baseURL?: string,
  email?: EmailConfig,
  envDashboardUrl?: string
) {
  const db = new Kysely({
    dialect: new D1Dialect({ database: d1 }),
  })

  // Determine the dashboard URL for reset links
  const staging = stagingAuthProfile(baseURL)
  const dashboardUrl = envDashboardUrl || staging?.dashboardUrl || (baseURL?.includes('localhost')
    ? 'http://localhost:3000'
    : 'https://flowstate.homes')

  return betterAuth({
    secret,
    baseURL,
    database: {
      db,
      type: 'sqlite',
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      requireEmailVerification: false,
      sendResetPassword: async ({ user, url, token }) => {
        // Build reset URL pointing to dashboard
        const resetUrl = `${dashboardUrl}/reset-password?token=${token}`

        const html = `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
          </head>
          <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f4f4f5; padding: 40px 20px;">
            <div style="max-width: 480px; margin: 0 auto; background: white; border-radius: 12px; padding: 40px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
              <div style="text-align: center; margin-bottom: 32px;">
                <h1 style="color: #8b5cf6; font-size: 24px; margin: 0;">Flowstate</h1>
              </div>

              <h2 style="color: #18181b; font-size: 20px; margin-bottom: 16px;">Reset Your Password</h2>

              <p style="color: #52525b; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
                Hi${user.name ? ` ${user.name}` : ''},
              </p>

              <p style="color: #52525b; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
                We received a request to reset your password. Click the button below to create a new password:
              </p>

              <div style="text-align: center; margin-bottom: 24px;">
                <a href="${resetUrl}" style="display: inline-block; background: linear-gradient(to right, #8b5cf6, #7c3aed); color: white; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 16px;">
                  Reset Password
                </a>
              </div>

              <p style="color: #71717a; font-size: 14px; line-height: 1.6; margin-bottom: 16px;">
                This link will expire in 1 hour. If you didn't request this, you can safely ignore this email.
              </p>

              <hr style="border: none; border-top: 1px solid #e4e4e7; margin: 24px 0;">

              <p style="color: #a1a1aa; font-size: 12px; text-align: center;">
                If the button doesn't work, copy and paste this link:<br>
                <a href="${resetUrl}" style="color: #8b5cf6; word-break: break-all;">${resetUrl}</a>
              </p>
            </div>
          </body>
          </html>
        `

        await sendEmail(
          user.email,
          'Reset your Flowstate password',
          html,
          email || {}
        )
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // 1 day
      cookieCache: {
        enabled: true,
        maxAge: 60 * 5, // 5 minutes
      },
    },
    trustedOrigins: envDashboardUrl
      ? [envDashboardUrl]
      : [dashboardUrl],
    advanced: {
      ipAddress: {
        ipAddressHeaders: ['cf-connecting-ip', 'x-forwarded-for'],
      },
      // D1 rejects the Kysely pragma-table join used by runtime introspection.
      // Schema compatibility is checked by migrations and local auth probes.
      database: { validateSchema: false },
      ...(staging ? { cookiePrefix: staging.cookiePrefix } : {}),
      // In production, use cross-subdomain cookies for .flowstate.homes
      // In development, use standard cookies with SameSite=Lax
      ...(baseURL?.includes('localhost')
        ? {
            // For localhost development: allow cross-port cookies
            useSecureCookies: false,
            defaultCookieAttributes: {
              sameSite: 'lax' as const,
              secure: false,
            },
          }
        : {
            crossSubDomainCookies: {
              enabled: true,
              domain: staging?.cookieDomain ?? '.flowstate.homes',
            },
          }),
    },
  })
}

export type Auth = ReturnType<typeof createAuth>
