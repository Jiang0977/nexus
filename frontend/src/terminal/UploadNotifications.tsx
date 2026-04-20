import { Icon } from '../icons'

export interface UploadNotification {
  id: string
  filename: string
  path: string
}

interface UploadNotificationsProps {
  bottomOffset: number
  copiedId: string | null
  notifications: UploadNotification[]
  onCopy: (id: string, path: string) => void
  onRemove: (id: string) => void
}

export function UploadNotifications({
  bottomOffset,
  copiedId,
  notifications,
  onCopy,
  onRemove,
}: UploadNotificationsProps) {
  if (notifications.length === 0) return null

  return (
    <div className="fixed left-1/2 z-[200] flex w-[480px] max-w-[90vw] -translate-x-1/2 flex-col gap-2" style={{ bottom: bottomOffset }}>
      {notifications.map((notification) => (
        <div
          key={notification.id}
          className="flex items-center gap-2.5 rounded-lg p-2.5 px-3 shadow-[0_4px_20px_rgba(0,0,0,0.25)] animate-slide-up"
          style={{
            background: 'color-mix(in srgb, var(--nexus-bg2) 85%, transparent)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            border: '1px solid color-mix(in srgb, var(--nexus-border) 50%, transparent)',
          }}
        >
          <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-sm text-nexus-text" title={notification.path}>
            {notification.filename}
          </span>
          <button
            onClick={() => onCopy(notification.id, notification.path)}
            className={`flex items-center gap-1 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs cursor-pointer transition-all duration-100 active:scale-95 ${
              copiedId === notification.id
                ? 'border-none bg-nexus-success text-white'
                : 'border border-nexus-border bg-nexus-bg-2 text-nexus-text-2 active:bg-nexus-bg active:text-nexus-text'
            }`}
            title="复制路径"
          >
            <Icon name={copiedId === notification.id ? 'check' : 'copy'} size={14} />
            <span>{copiedId === notification.id ? '已复制' : '复制'}</span>
          </button>
          <button
            onClick={() => onRemove(notification.id)}
            className="flex items-center justify-center border-none bg-transparent p-1 text-nexus-text-2 cursor-pointer transition-all duration-100 active:scale-90 active:text-nexus-text"
            title="关闭"
          >
            <Icon name="x" size={16} />
          </button>
        </div>
      ))}
    </div>
  )
}
