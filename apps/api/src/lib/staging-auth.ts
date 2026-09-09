export function stagingAuthProfile(baseURL?: string) {
  if (!baseURL) return null
  const url = new URL(baseURL)
  if (url.origin !== 'https://api.staging.flowstate.homes') return null
  return {
    dashboardUrl: 'https://staging.flowstate.homes',
    cookiePrefix: 'flowstate-v4-staging',
    cookieDomain: '.staging.flowstate.homes',
  }
}
