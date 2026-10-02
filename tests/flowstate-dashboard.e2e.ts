import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// Golden-path smoke suite for the flowstate.homes dashboard.
// Runs against APP_URL (defaults to production). Read-only except for one
// intentionally-invalid sign-in submission.

test('landing page loads with hero and nav', async ({ app, agent }) => {
  await app.open('/');
  await agent.assert(
    'the landing page shows the Flowstate hero section and site navigation'
  );
});

test('sign-in modal opens and shows the credential form', async ({ app, agent, browser }) => {
  await app.open('/');
  await agent.act('open the sign-in form');
  await expect(browser.locator('input[placeholder="you@example.com"]')).toBeVisible();
  await expect(browser.locator('input[placeholder="••••••••"]')).toBeVisible();
});

test('invalid credentials surface an error, not a crash', async ({ app, agent, browser }) => {
  await app.open('/');
  await agent.act('open the sign-in form');
  await browser.locator('input[placeholder="you@example.com"]').fill('e2e-invalid@flowstate.homes');
  await browser.locator('input[placeholder="••••••••"]').fill('not-a-real-password');
  await browser.locator('button[type="submit"]:has-text("Sign In")').click();
  await expect(browser.locator('text=Invalid email or password')).toBeVisible();
});
