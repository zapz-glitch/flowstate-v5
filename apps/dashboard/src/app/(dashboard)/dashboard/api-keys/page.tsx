import { getApiKeys, getUser } from '@/lib/api'
import { PLAN_LIMITS } from '@flowstate-api/db'
import ApiKeysList from './ApiKeysList'

async function getApiKeysData() {
  try {
    const [keys, user] = await Promise.all([getApiKeys(), getUser()])
    if (!user) return null

    const plan = (user.plan || 'free') as keyof typeof PLAN_LIMITS
    const limits = PLAN_LIMITS[plan]

    return {
      keys,
      plan,
      limits,
      canCreateMore: limits.maxApiKeys === -1 || keys.length < limits.maxApiKeys,
    }
  } catch {
    return null
  }
}

export default async function ApiKeysPage() {
  const data = await getApiKeysData()

  if (!data) {
    return <div>Loading...</div>
  }

  return (
    <div className="space-y-10 animate-in fade-in duration-500">
      <div className="space-y-1">
        <h1 className="text-heading-lg text-foreground tracking-tight">API Keys</h1>
        <p className="text-body text-foreground-tertiary">
          Manage your API keys for authentication
        </p>
      </div>

      <ApiKeysList
        keys={data.keys}
        plan={data.plan}
        limits={data.limits}
        canCreateMore={data.canCreateMore}
      />
    </div>
  )
}
