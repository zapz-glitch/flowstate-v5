import { redirect } from 'next/navigation'

export default async function LogDetailRedirect({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  redirect(`/dashboard/api-hub/logs/${id}`)
}
