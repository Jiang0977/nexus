import { Icon } from '../icons'

interface WelcomeGuideOverlayProps {
  onClose: () => void
  visible: boolean
}

export function WelcomeGuideOverlay({ onClose, visible }: WelcomeGuideOverlayProps) {
  if (!visible) return null

  return (
    <div className="fixed inset-0 z-[500] flex items-center justify-center bg-black/70 p-5">
      <div className="max-w-[400px] rounded-xl border border-nexus-border bg-nexus-menu-bg p-6">
        <h3 className="mt-0 text-nexus-text">欢迎使用 Nexus</h3>
        <ul className="my-2 pl-5 text-sm leading-relaxed text-nexus-text-2">
          <li>黑色区域是终端，点击聚焦后可键盘输入</li>
          <li>底部工具栏提供 Esc/Tab/^C 等快捷键</li>
          <li className="flex items-center gap-1.5"><Icon name="paperclip" size={14} />上传图片或文件后，路径会自动插入当前终端</li>
          <li>📁 新建工作区：在选定目录打开一个新的工作区</li>
          <li>➕ 新建窗口：在当前工作区目录再开一个窗口</li>
        </ul>
        <p className="mt-2 text-[11px] text-nexus-muted">
          Telegram Bot: /api/telegram/setup 一键配置
        </p>
        <button
          onClick={onClose}
          className="mt-3 w-full rounded-md border-none bg-nexus-accent px-5 py-2.5 text-sm font-semibold text-white cursor-pointer"
        >
          开始使用
        </button>
      </div>
    </div>
  )
}
