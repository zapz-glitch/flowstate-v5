import { redirect } from 'next/navigation'

export default function ApiKeysRedirect() {
  redirect('/dashboard/api-hub')
}
