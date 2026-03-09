import { redirect } from 'next/navigation'

export default async function ReportDetailRedirect({
  params,
}: {
  params: Promise<{ jobId: string }>
}) {
  const { jobId } = await params
  redirect(`/report/${jobId}`)
}
