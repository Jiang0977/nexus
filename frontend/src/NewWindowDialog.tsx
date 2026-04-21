import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import GhostShield from './GhostShield'
import { Icon } from './icons'
import {
  CLAUDE_SHELL_TYPE,
  CODEX_SHELL_TYPE,
  DEFAULT_SHELL_TYPE,
  ZSH_SHELL_TYPE,
  usesCodexProfile,
  usesShellProfile,
  type ShellType,
} from './shellType'
import {
  fetchProfilesForShell,
  fetchProjectShellDefault,
  getStoredProfileForShell,
  getStoredShellType,
  pickProfileForShell,
  storeProfileForShell,
  storeShellType,
  type ShellProfileOption,
} from './shellProfiles'

interface Props {
  token: string
  projectPath?: string
  onClose: () => void
  onConfirm: (shellType: ShellType, profile?: string) => void
}

export default function NewWindowDialog({ token, projectPath = '', onClose, onConfirm }: Props) {
  const { t } = useTranslation()
  const [shellType, setShellType] = useState<ShellType>(() => getStoredShellType() || DEFAULT_SHELL_TYPE)
  const [profiles, setProfiles] = useState<ShellProfileOption[]>([])
  const [selectedProfile, setSelectedProfile] = useState<string>(() => getStoredProfileForShell(getStoredShellType()))

  useEffect(() => {
    if (!usesShellProfile(shellType)) {
      setProfiles([])
      setSelectedProfile('')
      return
    }

    let cancelled = false
    fetchProfilesForShell(token, shellType)
      .then((data) => {
        if (cancelled) return
        setProfiles(data)
        setSelectedProfile((current) => pickProfileForShell(shellType, data, current))
      })
      .catch((error: unknown) => {
        if (cancelled) return
        console.error('[NewWindowDialog] Failed to load shell profiles', error)
        setProfiles([])
      })

    return () => { cancelled = true }
  }, [token, shellType])

  useEffect(() => {
    fetchProjectShellDefault(token, projectPath)
      .then((defaults) => {
        const nextShellType = defaults?.shell_type || getStoredShellType()
        setShellType(nextShellType)
        if (usesShellProfile(nextShellType)) {
          setSelectedProfile(defaults?.profile || getStoredProfileForShell(nextShellType))
        } else {
          setSelectedProfile('')
        }
      })
      .catch((error: unknown) => {
        console.error('[NewWindowDialog] Failed to load project shell defaults', {
          error,
          path: projectPath,
        })
      })
  }, [token, projectPath])

  function handleConfirm() {
    const profile = usesShellProfile(shellType) && selectedProfile ? selectedProfile : undefined
    storeShellType(shellType)
    if (profile) storeProfileForShell(shellType, profile)
    onConfirm(shellType, profile)
  }

  function handleShellChange(nextShellType: ShellType) {
    setShellType(nextShellType)
    storeShellType(nextShellType)
    if (usesShellProfile(nextShellType)) {
      setSelectedProfile(getStoredProfileForShell(nextShellType))
    } else {
      setSelectedProfile('')
    }
  }

  function handleProfileChange(id: string) {
    setSelectedProfile(id)
    if (id) storeProfileForShell(shellType, id)
  }

  const profileLabelKey = usesCodexProfile(shellType) ? 'newChannel.profileCodex' : 'newChannel.profileClaude'
  const profileDefaultKey = usesCodexProfile(shellType) ? 'newChannel.profileDefaultCodex' : 'newChannel.profileDefaultClaude'

  return (
    <div className="fixed inset-0 bg-black/70 z-[100] flex items-center justify-center p-5">
      <GhostShield />
      <div className="bg-nexus-bg border border-nexus-border rounded-xl flex flex-col text-nexus-text w-full max-w-[360px] shadow-[0_20px_60px_rgba(0,0,0,0.5)] overflow-hidden">
        {/* 标题 */}
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-nexus-border">
          <span className="text-base font-semibold">{t('newChannel.title')}</span>
          <button
            className="bg-transparent border-none text-nexus-text-2 cursor-pointer flex items-center justify-center"
            onPointerDown={onClose}
          >
            <Icon name="x" size={20} />
          </button>
        </div>

        <div className="px-4 py-4 flex flex-col gap-4">
          {/* Shell 类型 */}
          <div>
            <div className="text-[11px] text-nexus-text-2 tracking-wider uppercase mb-2">{t('newChannel.shellType')}</div>
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-nexus-text text-sm cursor-pointer">
                <input
                  type="radio"
                  name="shellType"
                  value={CLAUDE_SHELL_TYPE}
                  checked={shellType === CLAUDE_SHELL_TYPE}
                  onChange={() => handleShellChange(CLAUDE_SHELL_TYPE)}
                />
                <span>{t('workspace.shellClaude')}</span>
              </label>
              <label className="flex items-center gap-2 text-nexus-text text-sm cursor-pointer">
                <input
                  type="radio"
                  name="shellType"
                  value={CODEX_SHELL_TYPE}
                  checked={shellType === CODEX_SHELL_TYPE}
                  onChange={() => handleShellChange(CODEX_SHELL_TYPE)}
                />
                <span>{t('workspace.shellCodex')}</span>
              </label>
              <label className="flex items-center gap-2 text-nexus-text text-sm cursor-pointer">
                <input
                  type="radio"
                  name="shellType"
                  value={ZSH_SHELL_TYPE}
                  checked={shellType === ZSH_SHELL_TYPE}
                  onChange={() => handleShellChange(ZSH_SHELL_TYPE)}
                />
                <span>{t('workspace.shellZsh')}</span>
              </label>
            </div>
          </div>

          {/* Profile */}
          {usesShellProfile(shellType) && (
            <div>
              <div className="text-[11px] text-nexus-text-2 tracking-wider uppercase mb-2">{t(profileLabelKey)}</div>
              <select
                className="bg-nexus-bg-2 border border-nexus-border rounded-md text-nexus-text text-sm px-2.5 py-2 w-full outline-none"
                value={selectedProfile}
                onChange={e => handleProfileChange(e.target.value)}
              >
                <option value="">{t(profileDefaultKey)}</option>
                {profiles.map(cfg => (
                  <option key={cfg.id} value={cfg.id}>{cfg.label}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="flex gap-3 px-4 py-3 border-t border-nexus-border justify-end">
          <button
            className="bg-transparent border border-nexus-border rounded-md text-nexus-text-2 cursor-pointer text-sm px-4 py-2"
            onPointerDown={onClose}
          >
            {t('common.cancel')}
          </button>
          <button
            className="bg-nexus-accent border-none rounded-md text-white cursor-pointer text-sm font-semibold px-4 py-2"
            onClick={handleConfirm}
          >
            {t('common.create')}
          </button>
        </div>
      </div>
    </div>
  )
}
