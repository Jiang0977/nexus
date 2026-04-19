import { type ReactNode } from 'react'
import DraggableFab from './DraggableFab'

interface Props {
  onClick: () => void
  windowCount?: number
  topInset?: number
  bottomInset?: number
}

export default function SessionFAB({ onClick, windowCount, topInset = 0, bottomInset = 0 }: Props) {
  let badge: ReactNode = null
  if (windowCount && windowCount > 0) {
    badge = (
      <span style={{
        position: 'absolute',
        top: -4,
        right: -4,
        background: 'var(--nexus-accent)',
        color: '#fff',
        borderRadius: '50%',
        width: 18,
        height: 18,
        fontSize: 11,
        fontWeight: 700,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
      }}>{windowCount}</span>
    )
  }

  return (
    <DraggableFab
      storageKey="nexus_fab_pos"
      onClick={onClick}
      badge={badge}
      size={52}
      topInset={topInset}
      bottomInset={bottomInset}
      style={{
        background: 'var(--nexus-bg2)',
        border: '1px solid var(--nexus-border)',
        boxShadow: '0 2px 12px rgba(0,0,0,0.18), 0 1px 3px rgba(0,0,0,0.12)',
      }}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="var(--nexus-accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="26" height="26">
        <rect x="4.5" y="8" width="15" height="11" rx="2.5" />
        <circle cx="9" cy="13" r="1.5" fill="var(--nexus-accent)" stroke="none" />
        <circle cx="15" cy="13" r="1.5" fill="var(--nexus-accent)" stroke="none" />
        <path d="M9.5 17h5" />
        <path d="M12 8V5" />
        <circle cx="12" cy="4.5" r="1" fill="var(--nexus-accent)" stroke="none" />
        <path d="M4.5 12.5H2.5M19.5 12.5H21.5" />
      </svg>
    </DraggableFab>
  )
}
