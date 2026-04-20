import { Icon } from '../icons'

interface ErrorBannerProps {
  error: string | null
  onDismiss: () => void
  shrink?: boolean
}

export function ErrorBanner({ error, onDismiss, shrink = false }: ErrorBannerProps) {
  if (!error) return null

  return (
    <div className={`flex items-center justify-between bg-red-500/15 px-4 py-2.5 text-sm text-nexus-error border-b border-nexus-border ${shrink ? 'shrink-0' : ''}`}>
      {error}
      <button className="bg-transparent border-none text-nexus-error cursor-pointer p-0.5" onPointerDown={onDismiss}>
        <Icon name="x" size={14} />
      </button>
    </div>
  )
}
