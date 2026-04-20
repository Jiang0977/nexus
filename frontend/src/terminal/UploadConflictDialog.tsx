interface UploadConflictDialogProps {
  filename: string
  onCancel: () => void
  onConfirm: () => void
  visible: boolean
}

export function UploadConflictDialog({ filename, onCancel, onConfirm, visible }: UploadConflictDialogProps) {
  if (!visible) return null

  return (
    <div className="fixed inset-0 z-[500] flex items-center justify-center bg-black/70 p-5">
      <div className="max-w-[400px] rounded-xl border border-nexus-border bg-nexus-menu-bg p-6">
        <h3 className="mt-0 mb-2 text-nexus-text">文件已存在</h3>
        <p className="mb-4 text-sm text-nexus-text-2">
          文件 "<span className="font-mono text-nexus-text">{filename}</span>" 已存在。
          <br />是否覆盖？
        </p>
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 rounded-md border border-nexus-border bg-nexus-bg-2 py-2.5 text-sm font-semibold text-nexus-text cursor-pointer"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 rounded-md border-none bg-nexus-accent py-2.5 text-sm font-semibold text-white cursor-pointer"
          >
            覆盖
          </button>
        </div>
      </div>
    </div>
  )
}
