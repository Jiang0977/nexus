import { useEffect, useState } from 'react'
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
  fetchCurrentCcSwitchProfileForShell,
  fetchProfilesForShell,
  fetchProjectShellDefault,
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
  lockedShellType?: ShellType
  title?: string
  description?: string
  confirmLabel?: string
  preserveEmptyProfile?: boolean
  zIndexClassName?: string
}

export default function NewWindowDialog({
  token,
  projectPath = '',
  onClose,
  onConfirm,
  lockedShellType,
  title,
  description,
  confirmLabel,
  preserveEmptyProfile = false,
  zIndexClassName = 'z-[100]',
}: Props) {
  const { t } = useTranslation()
  const isShellLocked = Boolean(lockedShellType)
  const initialShellType = lockedShellType || getStoredShellType() || DEFAULT_SHELL_TYPE
  const [shellType, setShellType] = useState<ShellType>(initialShellType)
  const [profiles, setProfiles] = useState<ShellProfileOption[]>([])
  const [preferredProfile, setPreferredProfile] = useState('')
  const [selectedProfile, setSelectedProfile] = useState('')

  useEffect(() => {
    if (!lockedShellType) return
    setShellType(lockedShellType)
    setPreferredProfile('')
  }, [lockedShellType])

  useEffect(() => {
    if (!usesShellProfile(shellType)) {
      setProfiles([])
      setSelectedProfile('')
      return
    }

    let cancelled = false
    Promise.all([
      fetchProfilesForShell(token, shellType),
      fetchCurrentCcSwitchProfileForShell(token, shellType).catch((error: unknown) => {
        console.error('[NewWindowDialog] Failed to load current cc-switch profile', error)
        return ''
      }),
    ])
      .then(([data, currentCcSwitchProfile]) => {
        if (cancelled) return
        setProfiles(data)
        setSelectedProfile((current) => pickProfileForShell(
          shellType,
          data,
          preferredProfile || current,
          [currentCcSwitchProfile],
        ))
      })
      .catch((error: unknown) => {
        if (cancelled) return
        console.error('[NewWindowDialog] Failed to load shell profiles', error)
        setProfiles([])
      })

    return () => { cancelled = true }
  }, [preferredProfile, token, shellType])

  useEffect(() => {
    fetchProjectShellDefault(token, projectPath)
      .then((defaults) => {
        const nextShellType = lockedShellType || defaults?.shell_type || getStoredShellType()
        setShellType(nextShellType)
        if (usesShellProfile(nextShellType)) {
          const nextPreferredProfile = defaults?.shell_type === nextShellType
            ? (defaults?.profile || '')
            : ''
          setPreferredProfile(nextPreferredProfile)
        } else {
          setPreferredProfile('')
          setSelectedProfile('')
        }
      })
      .catch((error: unknown) => {
        console.error('[NewWindowDialog] Failed to load project shell defaults', {
          error,
          path: projectPath,
        })
      })
  }, [lockedShellType, token, projectPath])

  function handleConfirm() {
    let profile: string | undefined
    if (usesShellProfile(shellType)) {
      if (selectedProfile) {
        profile = selectedProfile
      } else if (preserveEmptyProfile) {
        profile = ''
      }
    }
    storeShellType(shellType)
    if (profile) storeProfileForShell(shellType, profile)
    onConfirm(shellType, profile)
  }

  function handleShellChange(nextShellType: ShellType) {
    setShellType(nextShellType)
    storeShellType(nextShellType)
    setPreferredProfile('')
    if (usesShellProfile(nextShellType)) {
      setSelectedProfile('')
    } else {
      setSelectedProfile('')
    }
  }

  function handleProfileChange(id: string) {
    setPreferredProfile(id)
    setSelectedProfile(id)
    if (id) storeProfileForShell(shellType, id)
  }

  const profileLabelKey = usesCodexProfile(shellType) ? 'newChannel.profileCodex' : 'newChannel.profileClaude'
  const profileDefaultKey = usesCodexProfile(shellType) ? 'newChannel.profileDefaultCodex' : 'newChannel.profileDefaultClaude'

  return (
    <div className={`fixed inset-0 bg-black/70 ${zIndexClassName} flex items-center justify-center p-5`}>
      <GhostShield />
      <div className="bg-nexus-bg border border-nexus-border rounded-xl flex flex-col text-nexus-text w-full max-w-[360px] shadow-[0_20px_60px_rgba(0,0,0,0.5)] overflow-hidden">
        <div className="flex items-start justify-between gap-3 px-4 py-3.5 border-b border-nexus-border">
          <div className="min-w-0">
            <span className="text-base font-semibold">{title || t('newChannel.title')}</span>
            {description && (
              <div className="mt-1 text-sm text-nexus-text-2 leading-5">
                {description}
              </div>
            )}
          </div>
          <button
            className="bg-transparent border-none text-nexus-text-2 cursor-pointer flex items-center justify-center"
            onPointerDown={onClose}
          >
            <Icon name="x" size={20} />
          </button>
        </div>

        <div className="px-4 py-4 flex flex-col gap-4">
          {!isShellLocked && (
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
          )}

          {usesShellProfile(shellType) && (
            <div>
              <div className="text-[11px] text-nexus-text-2 tracking-wider uppercase mb-2">{t(profileLabelKey)}</div>
              <select
                aria-label={t(profileLabelKey)}
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
            {confirmLabel || t('common.create')}
          </button>
        </div>
      </div>
    </div>
  )
}
