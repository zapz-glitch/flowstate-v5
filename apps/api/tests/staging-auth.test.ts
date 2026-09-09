import assert from 'node:assert/strict'
import { stagingAuthProfile } from '../src/lib/staging-auth'

assert.deepEqual(stagingAuthProfile('https://api.staging.flowstate.homes/auth'), {
  dashboardUrl: 'https://staging.flowstate.homes',
  cookiePrefix: 'flowstate-v4-staging',
  cookieDomain: '.staging.flowstate.homes',
})
for (const url of [undefined, 'http://localhost:8787/auth', 'https://api.flowstate.homes/auth', 'https://api.staging.flowstate.homes.evil.example/auth', 'http://api.staging.flowstate.homes/auth']) assert.equal(stagingAuthProfile(url), null)
console.log('Staging login uses its own cookie namespace and domain; production/local profiles unchanged')
