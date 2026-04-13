import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import GhostShield from './GhostShield'
import { Icon } from './icons'
import { CLAUDE_SHELL_TYPE, CODEX_SHELL_TYPE } from './shellType'
import { storeProfileForShell } from './shellProfiles'

function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 768)
  useEffect(() => {
    const onResize = () => setIsDesktop(window.innerWidth >= 768)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return isDesktop
}

type ConfigKind = 'claude' | 'codex'

interface CcSwitchProvider {
  provider_id: string
  kind: ConfigKind
  name: string
  is_current: boolean
  model?: string
  base_url?: string
  auth_mode?: string
  existing_profile_id?: string | null
  target_profile_id: string
}

interface ClaudeConfig {
  id: string
  label: string
  BASE_URL?: string
  AUTH_TOKEN?: string
  API_KEY?: string
  DEFAULT_MODEL?: string
  THINK_MODEL?: string
  LONG_CONTEXT_MODEL?: string
  DEFAULT_HAIKU_MODEL?: string
  API_TIMEOUT_MS?: string
}

interface CodexConfig {
  id: string
  label: string
  OPENAI_API_KEY?: string
  BASE_URL?: string
  MODEL?: string
  REASONING_EFFORT?: string
  CONFIG_TOML?: string
  AUTH_JSON?: string
}

type AnyConfig = ClaudeConfig | CodexConfig
type EditingConfig =
  | (ClaudeConfig & { kind: 'claude'; isNew: boolean })
  | (CodexConfig & { kind: 'codex'; isNew: boolean })

interface Props {
  token: string
  onClose: () => void
}

const EMPTY_CLAUDE_CONFIG: Omit<ClaudeConfig, 'id'> = {
  label: '',
  BASE_URL: '',
  AUTH_TOKEN: '',
  API_KEY: '',
  DEFAULT_MODEL: '',
  THINK_MODEL: '',
  LONG_CONTEXT_MODEL: '',
  DEFAULT_HAIKU_MODEL: '',
  API_TIMEOUT_MS: '3000000',
}

const EMPTY_CODEX_CONFIG: Omit<CodexConfig, 'id'> = {
  label: '',
  OPENAI_API_KEY: '',
  BASE_URL: '',
  MODEL: '',
  REASONING_EFFORT: '',
  CONFIG_TOML: '',
  AUTH_JSON: '',
}

type FieldSpec = {
  key: string
  labelKey: string
  placeholder: string
  secret?: boolean
}

const FIELD_SPECS: Record<ConfigKind, FieldSpec[]> = {
  claude: [
    { key: 'label', labelKey: 'apiConfig.labelName', placeholder: 'Kimi (kimi-for-coding)' },
    { key: 'BASE_URL', labelKey: 'apiConfig.apiBaseUrl', placeholder: 'https://api.kimi.com/coding' },
    { key: 'AUTH_TOKEN', labelKey: 'apiConfig.authToken', placeholder: 'sk-...', secret: true },
    { key: 'API_KEY', labelKey: 'apiConfig.apiKey', placeholder: '（通常留空，用 Auth Token）', secret: true },
    { key: 'DEFAULT_MODEL', labelKey: 'apiConfig.defaultModel', placeholder: 'kimi-for-coding' },
    { key: 'THINK_MODEL', labelKey: 'apiConfig.thinkingModel', placeholder: 'kimi-for-coding' },
    { key: 'LONG_CONTEXT_MODEL', labelKey: 'apiConfig.longContextModel', placeholder: 'kimi-for-coding' },
    { key: 'DEFAULT_HAIKU_MODEL', labelKey: 'apiConfig.haikuModel', placeholder: 'kimi-for-coding' },
    { key: 'API_TIMEOUT_MS', labelKey: 'apiConfig.timeout', placeholder: '3000000' },
  ],
  codex: [
    { key: 'label', labelKey: 'apiConfig.labelName', placeholder: 'OpenAI / xMAPI' },
    { key: 'OPENAI_API_KEY', labelKey: 'apiConfig.codexApiKey', placeholder: 'sk-...', secret: true },
    { key: 'BASE_URL', labelKey: 'apiConfig.codexBaseUrl', placeholder: 'https://api.openai.com/v1' },
    { key: 'MODEL', labelKey: 'apiConfig.codexModel', placeholder: 'gpt-5.4' },
    { key: 'REASONING_EFFORT', labelKey: 'apiConfig.codexReasoningEffort', placeholder: 'high / medium / low' },
  ],
}

const ENDPOINTS: Record<ConfigKind, string> = {
  claude: '/api/configs',
  codex: '/api/codex-configs',
}

export default function SessionManager({ token, onClose }: Props) {
  const { t } = useTranslation()
  const isDesktop = useIsDesktop()

  const [activeKind, setActiveKind] = useState<ConfigKind>('claude')
  const [configs, setConfigs] = useState<{ claude: ClaudeConfig[]; codex: CodexConfig[] }>({
    claude: [],
    codex: [],
  })
  const [loading, setLoading] = useState<{ claude: boolean; codex: boolean }>({
    claude: false,
    codex: false,
  })
  const [editingConfig, setEditingConfig] = useState<EditingConfig | null>(null)
  const [savingCfg, setSavingCfg] = useState(false)
  const [syncingId, setSyncingId] = useState<string | null>(null)
  const [validatingId, setValidatingId] = useState<string | null>(null)
  const [showCcSwitchProviders, setShowCcSwitchProviders] = useState(false)
  const [ccSwitchProviders, setCcSwitchProviders] = useState<{ claude: CcSwitchProvider[]; codex: CcSwitchProvider[] }>({
    claude: [],
    codex: [],
  })
  const [ccSwitchLoading, setCcSwitchLoading] = useState<{ claude: boolean; codex: boolean }>({
    claude: false,
    codex: false,
  })
  const [importingCcSwitchId, setImportingCcSwitchId] = useState<string | null>(null)
  const [cfgError, setCfgError] = useState<string | null>(null)
  const [cfgNotice, setCfgNotice] = useState<string | null>(null)

  const headers = { Authorization: `Bearer ${token}` }
  const activeConfigs = configs[activeKind]
  const activeLoading = loading[activeKind]
  const activeCcSwitchProviders = ccSwitchProviders[activeKind]
  const activeCcSwitchLoading = ccSwitchLoading[activeKind]

  async function fetchConfigs(kind: ConfigKind) {
    setLoading(current => ({ ...current, [kind]: true }))
    try {
      const response = await fetch(ENDPOINTS[kind], { headers })
      const data = response.ok ? await response.json() : []
      setConfigs(current => ({ ...current, [kind]: Array.isArray(data) ? data : [] }))
    } catch {
      setConfigs(current => ({ ...current, [kind]: [] }))
    } finally {
      setLoading(current => ({ ...current, [kind]: false }))
    }
  }

  useEffect(() => {
    fetchConfigs('claude')
    fetchConfigs('codex')
  }, [])

  useEffect(() => {
    if (!showCcSwitchProviders) return
    fetchCcSwitchProviders(activeKind)
  }, [activeKind, showCcSwitchProviders])

  async function saveConfig() {
    if (!editingConfig) return
    const { id, isNew, kind, ...data } = editingConfig
    if (!id.trim() || !data.label?.trim()) {
      setCfgError(t('apiConfig.idAndLabelRequired'))
      return
    }

    setSavingCfg(true)
    setCfgError(null)
    setCfgNotice(null)
    try {
      const response = await fetch(`${ENDPOINTS[kind]}/${id.trim()}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      setEditingConfig(null)
      storeProfileForShell(kind === 'codex' ? CODEX_SHELL_TYPE : CLAUDE_SHELL_TYPE, id.trim())
      setCfgNotice(isNew ? t('apiConfig.createdNotice') : t('apiConfig.updatedNotice'))
      await fetchConfigs(kind)
    } catch (error: unknown) {
      setCfgError(error instanceof Error ? error.message : t('apiConfig.saveFailed'))
    } finally {
      setSavingCfg(false)
    }
  }

  async function deleteConfig(kind: ConfigKind, id: string) {
    setCfgError(null)
    setCfgNotice(null)
    try {
      await fetch(`${ENDPOINTS[kind]}/${id}`, { method: 'DELETE', headers })
      if (editingConfig?.id === id && editingConfig.kind === kind) {
        setEditingConfig(null)
      }
      setCfgNotice(t('apiConfig.deletedNotice'))
      await fetchConfigs(kind)
    } catch {
      setCfgError(t('apiConfig.deleteFailed'))
    }
  }

  async function importGlobalCodexConfig() {
    setCfgError(null)
    setCfgNotice(null)
    try {
      const response = await fetch('/api/codex-configs/import-global', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`)
      }
      if (data?.id) storeProfileForShell(CODEX_SHELL_TYPE, data.id)
      setActiveKind('codex')
      setCfgNotice(t('apiConfig.importedNotice', { id: data?.id || 'imported' }))
      await fetchConfigs('codex')
    } catch (error: unknown) {
      setCfgError(error instanceof Error ? error.message : t('apiConfig.importFailed'))
    }
  }

  async function validateCodexConfig(id: string) {
    setCfgError(null)
    setCfgNotice(null)
    setValidatingId(id)
    try {
      const response = await fetch(`/api/codex-configs/${id}/validate`, {
        method: 'POST',
        headers,
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`)
      }
      setCfgNotice(t('apiConfig.validateSuccess', { message: data.message || 'OK' }))
    } catch (error: unknown) {
      setCfgError(error instanceof Error ? error.message : t('apiConfig.validateFailed'))
    } finally {
      setValidatingId(null)
    }
  }

  async function fetchCcSwitchProviders(kind: ConfigKind) {
    setCcSwitchLoading(current => ({ ...current, [kind]: true }))
    try {
      const response = await fetch(`/api/cc-switch/providers?kind=${kind}`, { headers })
      const data = response.ok ? await response.json() : []
      setCcSwitchProviders(current => ({ ...current, [kind]: Array.isArray(data) ? data : [] }))
      return Array.isArray(data) ? data as CcSwitchProvider[] : []
    } catch {
      setCcSwitchProviders(current => ({ ...current, [kind]: [] }))
      return []
    } finally {
      setCcSwitchLoading(current => ({ ...current, [kind]: false }))
    }
  }

  async function syncCurrentConfig(kind: ConfigKind, id: string) {
    setCfgError(null)
    setCfgNotice(null)
    setSyncingId(`${kind}:${id}`)
    try {
      const response = await fetch(`${ENDPOINTS[kind]}/${id}/sync-current`, {
        method: 'POST',
        headers,
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`)
      }
      storeProfileForShell(kind === 'codex' ? CODEX_SHELL_TYPE : CLAUDE_SHELL_TYPE, id)
      setCfgNotice(t('apiConfig.syncedNotice', { id }))
      await fetchConfigs(kind)
    } catch (error: unknown) {
      setCfgError(error instanceof Error ? error.message : t('apiConfig.syncFailed'))
    } finally {
      setSyncingId(null)
    }
  }

  async function importCcSwitchProviderConfig(kind: ConfigKind, providerId: string) {
    setCfgError(null)
    setCfgNotice(null)
    setImportingCcSwitchId(`${kind}:${providerId}`)
    try {
      const response = await fetch(`/api/cc-switch/providers/${kind}/${encodeURIComponent(providerId)}/import`, {
        method: 'POST',
        headers,
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`)
      }
      if (data?.id) {
        storeProfileForShell(kind === 'codex' ? CODEX_SHELL_TYPE : CLAUDE_SHELL_TYPE, data.id)
      }
      setCfgNotice(t('apiConfig.ccSwitchImportedNotice', { id: data?.id || providerId }))
      await fetchConfigs(kind)
      await fetchCcSwitchProviders(kind)
    } catch (error: unknown) {
      setCfgError(error instanceof Error ? error.message : t('apiConfig.ccSwitchImportFailed'))
    } finally {
      setImportingCcSwitchId(null)
    }
  }

  async function importAllCcSwitchProviders(kind: ConfigKind) {
    setCfgError(null)
    setCfgNotice(null)
    setImportingCcSwitchId(`all:${kind}`)
    try {
      const providers = activeCcSwitchProviders.length > 0 ? activeCcSwitchProviders : await fetchCcSwitchProviders(kind)
      let importedCount = 0
      for (const provider of providers) {
        const response = await fetch(`/api/cc-switch/providers/${kind}/${encodeURIComponent(provider.provider_id)}/import`, {
          method: 'POST',
          headers,
        })
        const data = await response.json().catch(() => null)
        if (!response.ok) {
          throw new Error(data?.error || `HTTP ${response.status}`)
        }
        importedCount += 1
      }
      setCfgNotice(t('apiConfig.ccSwitchImportedAllNotice', { count: importedCount }))
      await fetchConfigs(kind)
      await fetchCcSwitchProviders(kind)
    } catch (error: unknown) {
      setCfgError(error instanceof Error ? error.message : t('apiConfig.ccSwitchImportFailed'))
    } finally {
      setImportingCcSwitchId(null)
    }
  }

  function toggleCcSwitchProviders() {
    setCfgError(null)
    setCfgNotice(null)
    setShowCcSwitchProviders(current => !current)
  }

  function openNewConfig(kind: ConfigKind) {
    setActiveKind(kind)
    setCfgError(null)
    setCfgNotice(null)
    if (kind === 'claude') {
      setEditingConfig({ kind, id: '', isNew: true, ...EMPTY_CLAUDE_CONFIG })
    } else {
      setEditingConfig({ kind, id: '', isNew: true, ...EMPTY_CODEX_CONFIG })
    }
  }

  function openEditConfig(kind: ConfigKind, config: AnyConfig) {
    setActiveKind(kind)
    setCfgError(null)
    setCfgNotice(null)
    if (kind === 'claude') {
      const typed = config as ClaudeConfig
      setEditingConfig({
        kind,
        id: typed.id,
        isNew: false,
        label: typed.label,
        BASE_URL: typed.BASE_URL,
        AUTH_TOKEN: typed.AUTH_TOKEN,
        API_KEY: typed.API_KEY,
        DEFAULT_MODEL: typed.DEFAULT_MODEL,
        THINK_MODEL: typed.THINK_MODEL,
        LONG_CONTEXT_MODEL: typed.LONG_CONTEXT_MODEL,
        DEFAULT_HAIKU_MODEL: typed.DEFAULT_HAIKU_MODEL,
        API_TIMEOUT_MS: typed.API_TIMEOUT_MS,
      })
      return
    }

    const typed = config as CodexConfig
    setEditingConfig({
      kind,
      id: typed.id,
      isNew: false,
      label: typed.label,
      OPENAI_API_KEY: typed.OPENAI_API_KEY,
      BASE_URL: typed.BASE_URL,
      MODEL: typed.MODEL,
      REASONING_EFFORT: typed.REASONING_EFFORT,
      CONFIG_TOML: typed.CONFIG_TOML,
      AUTH_JSON: typed.AUTH_JSON,
    })
  }

  function updateEditingField(key: string, value: string) {
    setEditingConfig(current => {
      if (!current) return current

      const next = { ...current, [key]: value } as EditingConfig
      if (current.kind !== 'codex' || key === 'label') {
        return next
      }

      const codexNext = next as CodexConfig & { kind: 'codex'; isNew: boolean }

      if (key === 'OPENAI_API_KEY' || key === 'BASE_URL') {
        codexNext.AUTH_JSON = ''
      }
      if (key === 'BASE_URL' || key === 'MODEL' || key === 'REASONING_EFFORT') {
        codexNext.CONFIG_TOML = ''
      }
      return codexNext
    })
  }

  if (editingConfig) {
    const fields = FIELD_SPECS[editingConfig.kind]
    const editingValues = editingConfig as unknown as Record<string, string | undefined>
    return (
      <div className={isDesktop ? 'fixed inset-0 bg-black/70 z-[100] flex items-center justify-center p-5' : 'fixed inset-0 bg-black/60 z-[100]'}>
        <div className={isDesktop ? 'bg-nexus-bg border border-nexus-border rounded-xl flex flex-col text-nexus-text w-full max-w-[800px] max-h-[85vh] shadow-[0_20px_60px_rgba(0,0,0,0.5)] overflow-hidden' : 'fixed inset-0 bg-nexus-bg flex flex-col text-nexus-text'}>
          <div className="flex items-center justify-between px-4 py-3.5 border-b border-nexus-border shrink-0">
            <span className="text-base font-semibold">
              {editingConfig.isNew ? t('apiConfig.newConfig') : t('apiConfig.editConfig')}
            </span>
            <button
              className="bg-transparent border-none text-nexus-text-2 cursor-pointer text-2xl leading-none px-1 flex items-center justify-center"
              onPointerDown={() => { setEditingConfig(null); setCfgError(null) }}
            >
              <Icon name="x" size={20} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto py-2">
            <div className="px-4 py-3 border-b border-nexus-border">
              {cfgError && <div className="text-nexus-error text-xs mb-2">{cfgError}</div>}
              <div className={isDesktop ? 'flex flex-row items-center gap-4 mb-3' : 'flex flex-col gap-1 mb-2.5'}>
                <label className={isDesktop ? 'text-nexus-text-2 text-sm w-[140px] shrink-0 text-right' : 'text-nexus-text-2 text-xs'}>
                  {t('apiConfig.idLabel')}
                </label>
                <input
                  className={isDesktop ? 'bg-nexus-bg-2 border border-nexus-border rounded-md text-nexus-text text-sm px-3 py-2.5 outline-none flex-1 box-border' : 'bg-nexus-bg-2 border border-nexus-border rounded-md text-nexus-text text-sm px-2.5 py-2 outline-none w-full box-border'}
                  value={editingConfig.id}
                  readOnly={!editingConfig.isNew}
                  onChange={e => setEditingConfig(current => current && {
                    ...current,
                    id: e.target.value.replace(/[^a-z0-9_-]/gi, '-').toLowerCase(),
                  })}
                  placeholder={editingConfig.kind === 'codex' ? 'codex' : 'kimi'}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </div>

              {fields.map(field => (
                <div key={field.key} className={isDesktop ? 'flex flex-row items-center gap-4 mb-3' : 'flex flex-col gap-1 mb-2.5'}>
                  <label className={isDesktop ? 'text-nexus-text-2 text-sm w-[140px] shrink-0 text-right' : 'text-nexus-text-2 text-xs'}>
                    {t(field.labelKey)}
                  </label>
                  <input
                    className={isDesktop ? 'bg-nexus-bg-2 border border-nexus-border rounded-md text-nexus-text text-sm px-3 py-2.5 outline-none flex-1 box-border' : 'bg-nexus-bg-2 border border-nexus-border rounded-md text-nexus-text text-sm px-2.5 py-2 outline-none w-full box-border'}
                    type={field.secret ? 'password' : 'text'}
                    value={String(editingValues[field.key] || '')}
                    onChange={e => updateEditingField(field.key, e.target.value)}
                    placeholder={field.placeholder}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </div>
              ))}

              <button
                className={`bg-nexus-accent border-none rounded-md text-white cursor-pointer text-sm font-semibold px-5 py-2.5 w-full ${savingCfg ? 'opacity-50 cursor-not-allowed' : ''}`}
                onPointerDown={() => { if (!savingCfg) saveConfig() }}
                disabled={savingCfg}
              >
                {savingCfg ? t('common.saving') : t('common.save')}
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={isDesktop ? 'fixed inset-0 bg-black/70 z-[100] flex items-center justify-center p-5' : 'fixed inset-0 bg-black/60 z-[100]'}>
      <GhostShield />
      <div className={isDesktop ? 'bg-nexus-bg border border-nexus-border rounded-xl flex flex-col text-nexus-text w-full max-w-[860px] max-h-[85vh] shadow-[0_20px_60px_rgba(0,0,0,0.5)] overflow-hidden' : 'fixed inset-0 bg-nexus-bg flex flex-col text-nexus-text'}>
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-nexus-border shrink-0">
          <span className="text-base font-semibold">{t('apiConfig.title')}</span>
          <button className="bg-transparent border-none text-nexus-text-2 cursor-pointer text-2xl leading-none px-1 flex items-center justify-center" onPointerDown={onClose}>
            <Icon name="x" size={20} />
          </button>
        </div>

        <div className="px-4 pt-3 pb-1 border-b border-nexus-border">
          <div className="inline-flex rounded-lg bg-nexus-bg-2 p-1 gap-1">
            <button
              className={`border-none rounded-md text-sm px-3 py-1.5 cursor-pointer ${activeKind === 'claude' ? 'bg-nexus-accent text-white' : 'bg-transparent text-nexus-text-2'}`}
              onPointerDown={() => { setActiveKind('claude'); setCfgError(null); setCfgNotice(null) }}
            >
              {t('workspace.shellClaude')}
            </button>
            <button
              className={`border-none rounded-md text-sm px-3 py-1.5 cursor-pointer ${activeKind === 'codex' ? 'bg-nexus-accent text-white' : 'bg-transparent text-nexus-text-2'}`}
              onPointerDown={() => { setActiveKind('codex'); setCfgError(null); setCfgNotice(null) }}
            >
              {t('workspace.shellCodex')}
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          <div className="px-4 py-3 border-b border-nexus-border">
            <div className="flex items-center justify-between mb-2 gap-2">
              <span className="text-[11px] text-nexus-text-2 tracking-wider uppercase mb-2">{t('apiConfig.profiles')}</span>
              <div className="flex items-center gap-2">
                <button
                  className="bg-transparent border border-nexus-border rounded text-nexus-text-2 cursor-pointer text-[11px] px-2 py-0.5"
                  onPointerDown={toggleCcSwitchProviders}
                >
                  {t('apiConfig.ccSwitchList')}
                </button>
                {activeKind === 'codex' && (
                  <button
                    className="bg-transparent border border-nexus-border rounded text-nexus-text-2 cursor-pointer text-[11px] px-2 py-0.5"
                    onPointerDown={importGlobalCodexConfig}
                  >
                    {t('apiConfig.importGlobal')}
                  </button>
                )}
                <button
                  className="bg-transparent border border-nexus-border rounded text-nexus-text-2 cursor-pointer text-[11px] px-2 py-0.5"
                  onPointerDown={() => openNewConfig(activeKind)}
                >
                  {t('apiConfig.addNew')}
                </button>
              </div>
            </div>

            {cfgError && <div className="text-nexus-error text-xs mb-2">{cfgError}</div>}
            {cfgNotice && <div className="text-nexus-accent text-xs mb-2">{cfgNotice}</div>}
            {showCcSwitchProviders && (
              <div className="mb-3 rounded-lg border border-nexus-border bg-nexus-bg-2/40 p-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="text-[11px] text-nexus-text-2 tracking-wider uppercase">
                    {t('apiConfig.ccSwitchProviders')}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      className="bg-transparent border border-nexus-border rounded text-nexus-text-2 cursor-pointer text-[11px] px-2 py-0.5"
                      onPointerDown={() => fetchCcSwitchProviders(activeKind)}
                      disabled={activeCcSwitchLoading}
                    >
                      {t('apiConfig.refresh')}
                    </button>
                    <button
                      className="bg-transparent border border-nexus-border rounded text-nexus-accent cursor-pointer text-[11px] px-2 py-0.5"
                      onPointerDown={() => importAllCcSwitchProviders(activeKind)}
                      disabled={activeCcSwitchLoading || importingCcSwitchId === `all:${activeKind}` || activeCcSwitchProviders.length === 0}
                    >
                      {importingCcSwitchId === `all:${activeKind}` ? t('apiConfig.syncing') : t('apiConfig.ccSwitchImportAll')}
                    </button>
                  </div>
                </div>

                {activeCcSwitchLoading && <div className="text-nexus-muted text-sm py-2">{t('common.loading')}</div>}
                {!activeCcSwitchLoading && activeCcSwitchProviders.length === 0 && (
                  <div className="text-nexus-muted text-sm py-2">{t('apiConfig.ccSwitchEmpty')}</div>
                )}

                {!activeCcSwitchLoading && activeCcSwitchProviders.map((provider) => {
                  const metaText = [
                    provider.model || '—',
                    provider.base_url || '—',
                    provider.auth_mode || '—',
                  ].join(' · ')
                  const targetText = provider.existing_profile_id || provider.target_profile_id
                  const rowImporting = importingCcSwitchId === `${activeKind}:${provider.provider_id}`
                  return (
                    <div key={provider.provider_id} className="flex items-center gap-2.5 py-2.5 border-t border-nexus-border first:border-t-0">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="text-nexus-text text-sm truncate">{provider.name}</div>
                          {provider.is_current && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-nexus-accent/20 text-nexus-accent shrink-0">
                              {t('apiConfig.ccSwitchCurrent')}
                            </span>
                          )}
                        </div>
                        <div className="text-nexus-muted text-[11px] mt-0.5 font-mono truncate" title={metaText}>
                          {metaText}
                        </div>
                        <div className="text-nexus-muted text-[11px] mt-0.5 truncate">
                          {t('apiConfig.ccSwitchTarget', { id: targetText })}
                        </div>
                      </div>
                      <div className="flex gap-1.5 shrink-0">
                        <button
                          className="bg-transparent border border-nexus-border rounded text-nexus-accent cursor-pointer text-[11px] px-2 py-[3px]"
                          onPointerDown={() => importCcSwitchProviderConfig(activeKind, provider.provider_id)}
                          disabled={rowImporting}
                        >
                          {rowImporting
                            ? t('apiConfig.syncing')
                            : (provider.existing_profile_id ? t('apiConfig.ccSwitchOverwrite') : t('apiConfig.ccSwitchImport'))}
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
            {activeLoading && <div className="text-nexus-muted text-sm py-2">{t('common.loading')}</div>}
            {!activeLoading && activeConfigs.length === 0 && (
              <div className="text-nexus-muted text-sm py-2">{t('apiConfig.noConfigs')}</div>
            )}

            {activeConfigs.map((config) => {
              const configValues = config as unknown as Record<string, string | undefined>
              const modelText = String(configValues.MODEL || configValues.DEFAULT_MODEL || '—')
              return (
                <div key={config.id} className="flex items-center gap-2.5 py-2.5">
                  <div className="flex-1 min-w-0">
                    <div className="text-nexus-text text-sm truncate">{config.label}</div>
                    <div className="text-nexus-muted text-[11px] mt-0.5 font-mono truncate" title={`${config.id} · ${modelText}`}>
                      {config.id} · {modelText}
                    </div>
                  </div>
                  <div className="flex gap-1.5 shrink-0">
                    <button
                      className="bg-transparent border border-nexus-border rounded text-nexus-text-2 cursor-pointer text-[11px] px-2 py-[3px]"
                      onPointerDown={() => syncCurrentConfig(activeKind, config.id)}
                      disabled={syncingId === `${activeKind}:${config.id}`}
                    >
                      {syncingId === `${activeKind}:${config.id}` ? t('apiConfig.syncing') : t('apiConfig.syncCurrent')}
                    </button>
                    {activeKind === 'codex' && (
                      <button
                        className="bg-transparent border border-nexus-border rounded text-nexus-success cursor-pointer text-[11px] px-2 py-[3px]"
                        onPointerDown={() => validateCodexConfig(config.id)}
                        disabled={validatingId === config.id}
                      >
                        {validatingId === config.id ? t('apiConfig.validating') : t('apiConfig.validate')}
                      </button>
                    )}
                    <button
                      className="bg-transparent border border-nexus-border rounded text-nexus-accent cursor-pointer text-[11px] px-2 py-[3px]"
                      onPointerDown={() => openEditConfig(activeKind, config)}
                    >
                      {t('common.edit')}
                    </button>
                    <button
                      className="bg-transparent border border-nexus-border rounded text-nexus-error cursor-pointer text-[11px] px-2 py-[3px]"
                      onPointerDown={() => deleteConfig(activeKind, config.id)}
                    >
                      {t('common.delete')}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>

          <div className="px-4 py-3 text-nexus-text-2 text-[11px] leading-relaxed">
            <div className="text-[11px] text-nexus-text-2 tracking-wider uppercase mb-2">{t('apiConfig.notes')}</div>
            {activeKind === 'claude' ? (
              <p>{t('apiConfig.notesClaude')}</p>
            ) : (
              <p>{t('apiConfig.notesCodex')}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
