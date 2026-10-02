// Signs in once per run; tests declare { session: 'local' } to restore it.
import { test } from '@e2e-dev/web'
import { expect, credentials } from 'e2e'

test.setup('sign in as the local test user', { sessions: ['local'], platforms: ['web'] }, async ({ app, screen, session, browser }) => {
  const user = credentials.user('local')
  await app.open('/?signin=true')
  // The modal labels read "Liquidity."/"Profitable Investments." — the
  // placeholders are the stable locators.
  await screen.getByPlaceholder('you@example.com').fill(user.username)
  await screen.getByPlaceholder('••••••••').fill(user.password)
  await screen.getByRole('button', 'Sign In').tap()
  await expect(browser).toHaveURL(/\/dashboard\/analyze$/, { timeout: 30_000 })
  await session.save('local')
})
