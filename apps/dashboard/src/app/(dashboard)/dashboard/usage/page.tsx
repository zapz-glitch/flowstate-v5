import { redirect } from 'next/navigation'

export default function UsageRedirect() {
  redirect('/dashboard/api-hub?tab=usage')
}
