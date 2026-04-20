import { Icon } from '../icons'

interface ProfileGuideOverlayProps {
  onDetected: () => void
  onDismiss: () => void
  token: string
  visible: boolean
}

export function ProfileGuideOverlay({ onDetected, onDismiss, token, visible }: ProfileGuideOverlayProps) {
  if (!visible) return null

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-nexus-bg/95 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border border-nexus-border bg-nexus-bg-2 p-8 shadow-[0_8px_32px_rgba(0,0,0,0.4)]">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-nexus-accent/10">
            <Icon name="settings" size={32} className="text-nexus-accent" />
          </div>
          <h2 className="mb-2 text-xl font-bold text-nexus-text">需要创建会话 Profile</h2>
          <p className="text-sm text-nexus-text-2">
            检测到还没有可用的会话 Profile。你可以先在设置里创建，或者按下面的示例手动写入一个 Claude 配置。
          </p>
        </div>

        <div className="mb-6 rounded-lg border border-nexus-border bg-nexus-bg p-4">
          <p className="mb-2 text-sm font-medium text-nexus-text">在服务器上执行以下命令：</p>
          <code className="block overflow-x-auto whitespace-pre rounded bg-nexus-bg-2 p-3 text-xs font-mono text-nexus-muted">
{`mkdir -p data/configs
cat > data/configs/anthropic.json << 'EOF'
{
  "label": "Anthropic Claude",
  "BASE_URL": "",
  "AUTH_TOKEN": "",
  "API_KEY": "",
  "DEFAULT_MODEL": "claude-sonnet-4-6",
  "THINK_MODEL": "claude-opus-4-6",
  "LONG_CONTEXT_MODEL": "claude-opus-4-6",
  "DEFAULT_HAIKU_MODEL": "claude-haiku-4-5-20251001",
  "API_TIMEOUT_MS": "3000000"
}
EOF`}
          </code>
        </div>

        <div className="flex flex-col gap-3">
          <button
            onClick={() => {
              Promise.all([
                fetch('/api/configs', { headers: { Authorization: `Bearer ${token}` } }).then((response) => response.ok ? response.json() : []),
                fetch('/api/codex-configs', { headers: { Authorization: `Bearer ${token}` } }).then((response) => response.ok ? response.json() : []),
              ]).then(([claudeConfigs, codexConfigs]) => {
                const hasAny =
                  (Array.isArray(claudeConfigs) && claudeConfigs.length > 0) ||
                  (Array.isArray(codexConfigs) && codexConfigs.length > 0)
                if (hasAny) {
                  onDetected()
                  return
                }
                alert('仍未检测到可用的会话 Profile，请先在设置中创建，或执行上方命令写入配置')
              })
            }}
            className="w-full rounded-lg border-none bg-nexus-accent py-3 text-base font-semibold text-white transition-colors hover:bg-nexus-accent/90"
          >
            我已创建，重新检测
          </button>
          <button
            onClick={onDismiss}
            className="w-full rounded-lg border border-nexus-border bg-transparent py-3 text-base text-nexus-text-2 transition-colors hover:bg-nexus-bg"
          >
            稍后设置
          </button>
        </div>

        <p className="mt-4 text-center text-xs text-nexus-muted">
          详细说明请参考{' '}
          <a
            href="https://github.com/Jiang0977/nexus/blob/master/docs/QUICKSTART.md"
            target="_blank"
            rel="noopener noreferrer"
            className="text-nexus-accent hover:underline"
          >
            QUICKSTART.md
          </a>
        </p>
      </div>
    </div>
  )
}
