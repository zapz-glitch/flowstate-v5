// Server layout — caps ISR/shared-cache freshness for dashboard routes.
// Without this, prerendered shells get s-maxage=31536000 and stale HTML
// (with stale chunk URLs) can linger at edge PoPs after deploys.
export const revalidate = 300

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return children
}
