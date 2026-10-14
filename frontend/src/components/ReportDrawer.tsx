import type { ReactNode } from 'react'
import { LiquidGlass } from './LiquidGlass'

type Props = {
  isOpen: boolean
  onClose: () => void
  /** Accessible name of the dialog. */
  label: string
  title: string
  badge: string
  subtitle: string
  closeLabel: string
  children: ReactNode
}

function CloseIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

/**
 * The slide-in sheet shared by the security reports, built as Liquid Glass
 * like the assistant panel. The sheet is a pane of frosted glass over the
 * page (the shell freezes a frame of the page in place of the hidden guest
 * view while a report is open), and its controls and cards are glass floating
 * on the pane, with LiquidGlass's spring physics.
 */
export function ReportDrawer({ isOpen, onClose, label, title, badge, subtitle, closeLabel, children }: Props) {
  return (
    <>
      <div
        className={`analysis-drawer-overlay ${isOpen ? 'analysis-drawer-overlay--open' : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className={`analysis-drawer ${isOpen ? 'analysis-drawer--open' : ''}`}
        aria-label={label}
        aria-modal="true"
        role="dialog"
      >
        {/* The pane itself. A sibling of the content, not its parent, so the
            cards' own glass still sees the page through it. */}
        <div className="analysis-drawer__glass" aria-hidden="true" />
        <header className="drawer-header">
          <div className="drawer-header-left">
            <div className="drawer-header-title-row">
              <h3>{title}</h3>
              <span className="drawer-badge">{badge}</span>
            </div>
            <p className="drawer-subtitle">{subtitle}</p>
          </div>
          <div className="drawer-header-actions lg-host">
            <LiquidGlass refraction={56} bezel={14} blur={6} elasticity={0.22} />
            <button className="drawer-close-btn lg-press" type="button" onClick={onClose} aria-label={closeLabel}>
              <CloseIcon />
            </button>
          </div>
        </header>
        <div className="drawer-content">{children}</div>
      </aside>
    </>
  )
}
