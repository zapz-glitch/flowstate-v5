export const metadata = {
  title: 'Offline - Flowstate',
}

export default function OfflinePage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="text-center max-w-md">
        <div className="flex justify-center mb-6">
          <div className="w-16 h-16 rounded-xl bg-gradient-to-br from-purple-500 to-violet-600 flex items-center justify-center">
            <svg className="w-9 h-9 text-white" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <polygon points="12,2 2,7 12,12 22,7" fill="white" stroke="white" />
              <polyline points="2,12 12,17 22,12" />
              <polyline points="2,17 12,22 22,17" />
            </svg>
          </div>
        </div>
        <h1 className="text-2xl font-bold text-foreground mb-3">You are offline</h1>
        <p className="text-foreground-tertiary mb-6">
          It looks like you have lost your internet connection. Please check your network and try again.
        </p>
        <a
          href="/"
          className="inline-block px-6 py-2.5 bg-gradient-to-r from-purple-500 to-violet-600 text-white font-medium rounded-xl hover:opacity-90 transition-all shadow-lg shadow-purple-500/25"
        >
          Try Again
        </a>
      </div>
    </div>
  )
}
