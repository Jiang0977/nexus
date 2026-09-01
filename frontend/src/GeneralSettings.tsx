import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import GhostShield from './GhostShield'
import { Icon } from './icons'

interface Props {
  token: string
  themeMode: 'dark' | 'light'
  onToggleTheme: () => void
  onClose: () => void
  onOpenApiConfig: () => void
}

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'zh-CN', label: '简体中文' },
]

const UPDATE_CMD = 'git pull && npm run deploy:service -- --frontend'

type UpdateStatus = 'idle' | 'checking' | 'upToDate' | 'available' | 'dirty' | 'error'
type SessionBackend = 'tmux' | 'native'

export default function GeneralSettings({ token, themeMode, onToggleTheme, onClose, onOpenApiConfig }: Props) {
  const { t, i18n } = useTranslation()
  const [currentVersion, setCurrentVersion] = useState<string>('')
  const [latestVersion, setLatestVersion] = useState<string>('')
  const [releaseUrl, setReleaseUrl] = useState<string>('')
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>('idle')
  const [copied, setCopied] = useState(false)
  const [syncingCodexHistory, setSyncingCodexHistory] = useState(false)
  const [codexHistoryNotice, setCodexHistoryNotice] = useState<string | null>(null)
  const [codexHistoryError, setCodexHistoryError] = useState<string | null>(null)
  const [sessionBackend, setSessionBackend] = useState<SessionBackend>('tmux')
  const [configuredSessionBackend, setConfiguredSessionBackend] = useState<SessionBackend>('tmux')
  const [savingSessionBackend, setSavingSessionBackend] = useState(false)
  const [sessionBackendNotice, setSessionBackendNotice] = useState<string | null>(null)
  const [sessionBackendError, setSessionBackendError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/version', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then(data => { if (data?.current) setCurrentVersion(data.current) })
      .catch((error: unknown) => {
        console.error('[GeneralSettings] Failed to load current version', error)
      })
  }, [token])

  useEffect(() => {
    fetch('/api/config', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((data) => {
        const current = data?.sessionBackend === 'native' ? 'native' : 'tmux'
        const configured = data?.configuredSessionBackend === 'native' ? 'native' : 'tmux'
        setSessionBackend(current)
        setConfiguredSessionBackend(configured)
      })
      .catch((error: unknown) => {
        console.error('[GeneralSettings] Failed to load config', error)
      })
  }, [token])

  async function handleCheckUpdate() {
    setUpdateStatus('checking')
    try {
      const lRes = await fetch('/api/version/latest', { headers: { Authorization: `Bearer ${token}` } })
      if (!lRes.ok) { setUpdateStatus('error'); return }
      const lData = await lRes.json()
      if (lData.error) { setUpdateStatus('error'); return }
      // Re-fetch current version to get fresh clean state at check time
      const vRes = await fetch('/api/version', { headers: { Authorization: `Bearer ${token}` } })
      if (!vRes.ok) { setUpdateStatus('error'); return }
      const vData = await vRes.json()
      setCurrentVersion(vData.current)
      setLatestVersion(lData.latest)
      setReleaseUrl(lData.url)
      if (vData.current === lData.latest) {
        setUpdateStatus('upToDate')
      } else if (!vData.clean) {
        setUpdateStatus('dirty')
      } else {
        setUpdateStatus('available')
      }
    } catch (error: unknown) {
      console.error('[GeneralSettings] Failed to check updates', error)
      setUpdateStatus('error')
    }
  }

  async function handleCopyCmd() {
    try {
      await navigator.clipboard.writeText(UPDATE_CMD)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (error: unknown) {
      console.error('[GeneralSettings] Failed to copy update command', error)
    }
  }

  async function handleSyncCodexHistory() {
    setSyncingCodexHistory(true)
    setCodexHistoryNotice(null)
    setCodexHistoryError(null)
    try {
      const response = await fetch('/api/cc-switch/codex/sync-history', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`)
      }
      const provider = String(data?.currentProviderCodex || data?.targetAccountId || 'current')
      const count = Number(data?.stateProjection?.writtenThreads || data?.indexProjection?.writtenEntries || 0)
      setCodexHistoryNotice(t('settings.codexHistorySyncSuccess', { provider, count }))
    } catch (error: unknown) {
      setCodexHistoryError(error instanceof Error ? error.message : t('settings.codexHistorySyncFailed'))
    } finally {
      setSyncingCodexHistory(false)
    }
  }

  function handleLanguageChange(e: React.ChangeEvent<HTMLSelectElement>) {
    i18n.changeLanguage(e.target.value)
  }

  async function handleSaveSessionBackend() {
    setSavingSessionBackend(true)
    setSessionBackendNotice(null)
    setSessionBackendError(null)
    try {
      const response = await fetch('/api/config', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ session_backend: configuredSessionBackend }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`)
      }
      setSessionBackendNotice(t('settings.sessionBackendSaved'))
      setSessionBackend(data?.sessionBackend === 'native' ? 'native' : 'tmux')
      setConfiguredSessionBackend(data?.configuredSessionBackend === 'native' ? 'native' : 'tmux')
    } catch (error: unknown) {
      setSessionBackendError(error instanceof Error ? error.message : t('settings.sessionBackendSaveFailed'))
    } finally {
      setSavingSessionBackend(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 z-[100] flex items-center justify-center p-3 sm:p-5">
      <GhostShield />
      <div className="bg-nexus-bg border border-nexus-border rounded-xl flex max-h-[calc(100dvh-24px)] min-h-0 flex-col text-nexus-text w-full max-w-[400px] shadow-[0_20px_60px_rgba(0,0,0,0.5)] overflow-hidden sm:max-h-[calc(100dvh-40px)]">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between px-4 py-3.5 border-b border-nexus-border">
          <span className="text-base font-semibold">{t('settings.title')}</span>
          <button
            className="bg-transparent border-none text-nexus-text-2 cursor-pointer flex items-center justify-center"
            aria-label={t('common.close')}
            onPointerDown={onClose}
          >
            <Icon name="x" size={20} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-5">
          {/* Appearance section */}
          <div>
            <div className="text-[11px] text-nexus-text-2 tracking-wider uppercase mb-3">
              {t('settings.appearance')}
            </div>

            {/* Language */}
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm text-nexus-text">{t('settings.language')}</span>
              <select
                className="bg-nexus-bg-2 border border-nexus-border rounded-md text-nexus-text text-sm px-2.5 py-1.5 outline-none cursor-pointer"
                value={i18n.language}
                onChange={handleLanguageChange}
              >
                {LANGUAGES.map(lang => (
                  <option key={lang.code} value={lang.code}>{lang.label}</option>
                ))}
              </select>
            </div>

            {/* Theme */}
            <div className="flex items-center justify-between">
              <span className="text-sm text-nexus-text">{t('settings.theme')}</span>
              <div className="flex gap-1">
                <button
                  className={`text-sm px-3 py-1.5 rounded-md border-none cursor-pointer transition-colors ${themeMode === 'dark' ? 'bg-nexus-accent text-white' : 'bg-nexus-bg-2 text-nexus-text-2'}`}
                  onPointerDown={themeMode !== 'dark' ? onToggleTheme : undefined}
                >
                  {t('settings.themeDark')}
                </button>
                <button
                  className={`text-sm px-3 py-1.5 rounded-md border-none cursor-pointer transition-colors ${themeMode === 'light' ? 'bg-nexus-accent text-white' : 'bg-nexus-bg-2 text-nexus-text-2'}`}
                  onPointerDown={themeMode !== 'light' ? onToggleTheme : undefined}
                >
                  {t('settings.themeLight')}
                </button>
              </div>
            </div>
          </div>

          <div className="border-t border-nexus-border pt-4">
            <div className="text-[11px] text-nexus-text-2 tracking-wider uppercase mb-3">
              {t('settings.terminalBackend')}
            </div>
            <p className="text-sm text-nexus-text-2 mb-3">
              {t('settings.terminalBackendDesc')}
            </p>
            <div className="flex items-center justify-between gap-3 mb-2">
              <span className="text-sm text-nexus-text">{t('settings.currentBackend')}</span>
              <span className="text-sm font-mono text-nexus-text-2">{sessionBackend}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-nexus-text">{t('settings.targetBackend')}</span>
              <select
                className="bg-nexus-bg-2 border border-nexus-border rounded-md text-nexus-text text-sm px-2.5 py-1.5 outline-none cursor-pointer"
                value={configuredSessionBackend}
                onChange={(e) => setConfiguredSessionBackend(e.target.value === 'native' ? 'native' : 'tmux')}
              >
                <option value="tmux">{t('settings.backendTmux')}</option>
                <option value="native">{t('settings.backendNative')}</option>
              </select>
            </div>
            <p className="text-xs text-nexus-text-2 mt-3">
              {t('settings.terminalBackendRestartHint')}
            </p>
            <button
              className="flex items-center gap-1.5 bg-transparent border border-nexus-border rounded-md text-nexus-text text-sm px-3 py-2 cursor-pointer disabled:opacity-50 mt-3"
              onPointerDown={savingSessionBackend ? undefined : handleSaveSessionBackend}
              disabled={savingSessionBackend}
            >
              <Icon name="save" size={14} />
              <span>{savingSessionBackend ? t('common.saving') : t('common.save')}</span>
            </button>
            {sessionBackendNotice && (
              <p className="text-sm text-nexus-accent mt-3">{sessionBackendNotice}</p>
            )}
            {sessionBackendError && (
              <p className="text-sm text-red-400 mt-3">{sessionBackendError}</p>
            )}
          </div>

          {/* API Config Profiles section */}
          <div className="border-t border-nexus-border pt-4">
            <div className="text-[11px] text-nexus-text-2 tracking-wider uppercase mb-3">
              {t('settings.apiProfiles')}
            </div>
            <p className="text-sm text-nexus-text-2 mb-3">
              {t('settings.apiProfilesDesc')}
            </p>
            <button
              className="flex items-center gap-1.5 bg-transparent border border-nexus-border rounded-md text-nexus-text text-sm px-3 py-2 cursor-pointer"
              onPointerDown={onOpenApiConfig}
            >
              <span>{t('settings.manageProfiles')}</span>
              <Icon name="arrowRight" size={14} />
            </button>
          </div>

          <div className="border-t border-nexus-border pt-4">
            <div className="text-[11px] text-nexus-text-2 tracking-wider uppercase mb-3">
              {t('settings.codexHistorySync')}
            </div>
            <p className="text-sm text-nexus-text-2 mb-3">
              {t('settings.codexHistorySyncDesc')}
            </p>
            <button
              className="flex items-center gap-2 bg-transparent border border-nexus-border rounded-md text-nexus-text text-sm px-3 py-2 cursor-pointer disabled:opacity-50"
              onPointerDown={syncingCodexHistory ? undefined : handleSyncCodexHistory}
              disabled={syncingCodexHistory}
            >
              <Icon name="refresh" size={14} />
              <span>{syncingCodexHistory ? t('settings.codexHistorySyncing') : t('settings.codexHistorySyncAction')}</span>
            </button>
            {codexHistoryNotice && (
              <p className="text-sm text-nexus-accent mt-3">{codexHistoryNotice}</p>
            )}
            {codexHistoryError && (
              <p className="text-sm text-red-400 mt-3">{codexHistoryError}</p>
            )}
          </div>

          {/* About section */}
          <div className="border-t border-nexus-border pt-4">
            <div className="text-[11px] text-nexus-text-2 tracking-wider uppercase mb-3">
              {t('settings.about')}
            </div>

            <div className="flex items-center justify-between mb-3">
              <span className="text-sm text-nexus-text">{t('settings.currentVersion')}</span>
              <span className="text-sm text-nexus-text-2 font-mono">
                {currentVersion || '—'}
              </span>
            </div>

            {updateStatus === 'idle' || updateStatus === 'checking' ? (
              <button
                className="flex items-center gap-1.5 bg-transparent border border-nexus-border rounded-md text-nexus-text text-sm px-3 py-2 cursor-pointer disabled:opacity-50"
                onPointerDown={updateStatus === 'idle' ? handleCheckUpdate : undefined}
                disabled={updateStatus === 'checking'}
              >
                <span>{updateStatus === 'checking' ? t('settings.checking') : t('settings.checkUpdate')}</span>
              </button>
            ) : updateStatus === 'upToDate' ? (
              <p className="text-sm text-green-500">{t('settings.upToDate')}</p>
            ) : updateStatus === 'error' ? (
              <p className="text-sm text-red-400">{t('settings.checkFailed')}</p>
            ) : updateStatus === 'dirty' ? (
              <div>
                <p className="text-sm text-nexus-accent mb-2">
                  {t('settings.updateAvailable', { version: latestVersion })}
                </p>
                <p className="text-sm text-yellow-400">{t('settings.dirtyWarning')}</p>
              </div>
            ) : updateStatus === 'available' ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-nexus-accent">
                  {t('settings.updateAvailable', { version: latestVersion })}
                </p>
                <div className="flex gap-2 flex-wrap">
                  <a
                    href={releaseUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-nexus-text-2 underline"
                  >
                    {t('settings.viewRelease')}
                  </a>
                  <button
                    className="flex items-center gap-1.5 bg-transparent border border-nexus-border rounded-md text-nexus-text text-sm px-3 py-1.5 cursor-pointer"
                    onPointerDown={handleCopyCmd}
                  >
                    <span>{copied ? '✓' : t('settings.copyUpdateCmd')}</span>
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
