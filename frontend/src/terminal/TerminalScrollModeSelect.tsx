import type { TerminalScrollMode } from './terminalApplicationScroll'

interface Props {
  value: TerminalScrollMode
  onChange: (mode: TerminalScrollMode) => void
}

export function TerminalScrollModeSelect({ value, onChange }: Props) {
  return (
    <select
      aria-label="终端滚动模式"
      title="标准鼠标模式始终优先；无标准模式的 TUI 可临时选择应用滚动。切换通道或刷新后恢复自动。"
      className="h-7 max-w-[7rem] shrink-0 rounded border border-nexus-border bg-nexus-bg px-1 text-xs text-nexus-text-2 focus:border-nexus-accent"
      value={value}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => onChange(event.target.value === 'application-sgr' ? 'application-sgr' : 'auto')}
    >
      <option value="auto">自动滚动</option>
      <option value="application-sgr">应用滚动 (SGR)</option>
    </select>
  )
}
