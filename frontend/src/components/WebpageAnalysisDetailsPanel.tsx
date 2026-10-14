import { useEffect, useState } from 'react'
import type { ChunkResult } from '../types/analysisDetailsTypes'
import type { SecurityCheckResponse, WebpageContent } from '../types/securityTypes'
import { ScanSummarySection } from './ScanSummarySection'

type Props = {
  content: WebpageContent | null
  isOpen: boolean
  isScanning: boolean
  result: SecurityCheckResponse | null
  onClose: () => void
}

const MINIMUM_SCAN_DURATION_MS = 10_000

// ── Icons (Lucide style) ──────────────────────────────────────────────────────

function ShieldCheckIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  )
}

function ShieldAlertIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

function GlobeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </svg>
  )
}

function InfoIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  )
}

function LayersIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
      <path d="m22 12.5-8.58 3.91a2 2 0 0 1-1.66 0L2 12.5" />
      <path d="m22 17.5-8.58 3.91a2 2 0 0 1-1.66 0L2 17.5" />
    </svg>
  )
}

function FileTextIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M10 9H8" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
    </svg>
  )
}

const CONTENT_CHANNELS: Array<{ key: keyof WebpageContent; label: string }> = [
  { key: 'visible_text', label: 'Visible page text' },
  { key: 'hidden_text', label: 'Hidden content' },
  { key: 'html_comments', label: 'HTML comments' },
  { key: 'meta_tags', label: 'Metadata' },
  { key: 'input_values', label: 'Input fields' },
  { key: 'aria_text', label: 'Accessibility text' },
  { key: 'iframe_content', label: 'Nested frames' },
  { key: 'shadow_dom_content', label: 'Shadow DOM' },
  { key: 'inline_javascript', label: 'Inline JavaScript' },
  { key: 'css_content', label: 'CSS content' },
  { key: 'css_generated_content', label: 'CSS-generated content' },
]

// ── Fluid Scanning Progress Sub-component ─────────────────────────────────────

function ScanProgress({ content }: { content: WebpageContent }) {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const startedAt = performance.now()
    const timer = window.setInterval(() => {
      setElapsed(performance.now() - startedAt)
    }, 100)

    return () => window.clearInterval(timer)
  }, [])

  const progress = Math.min(96, Math.max(8, Math.round((elapsed / MINIMUM_SCAN_DURATION_MS) * 100)))
  const phase = progress < 30
    ? 'Capturing rendered frames and DOM snapshots'
    : progress < 58
      ? 'Inspecting shadow DOM, hidden CSS, and accessibility text'
      : progress < 82
        ? 'Reviewing scripts, metadata, and stylesheets'
        : 'Classifying content for prompt-injection patterns'

  return (
    <div className="webpage-scan-progress" aria-live="polite">
      <div className="webpage-scan-progress__icon-ring" aria-hidden="true">
        <ShieldCheckIcon />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center' }}>
        <p className="webpage-scan-progress__eyebrow">Real-Time Security Inspection</p>
        <h4>Analyzing Webpage Content</h4>
        <p className="webpage-scan-progress__phase">{phase}</p>
      </div>

      <div className="webpage-scan-progress__card">
        {/* Progress Bar (shadcn Progress) */}
        <div
          className="webpage-scan-progress__track"
          aria-label={`${progress}% scan progress`}
          role="progressbar"
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={progress}
        >
          <span style={{ width: `${progress}%` }} />
        </div>

        <div className="webpage-scan-progress__meta">
          <span>{progress}% completed</span>
          <strong>{content.visible_text.length.toLocaleString()} characters</strong>
        </div>

        {/* Milestone Steps */}
        <div className="webpage-scan-progress__steps">
          <div className={`webpage-scan-progress__step-item ${progress >= 30 ? 'webpage-scan-progress__step-item--done' : 'webpage-scan-progress__step-item--active'}`}>
            <span className="webpage-scan-progress__step-dot" />
            <span>Rendered page structure & visible text</span>
          </div>
          <div className={`webpage-scan-progress__step-item ${progress >= 58 ? 'webpage-scan-progress__step-item--done' : progress >= 30 ? 'webpage-scan-progress__step-item--active' : ''}`}>
            <span className="webpage-scan-progress__step-dot" />
            <span>Hidden elements, metadata, and accessibility text</span>
          </div>
          <div className={`webpage-scan-progress__step-item ${progress >= 82 ? 'webpage-scan-progress__step-item--done' : progress >= 58 ? 'webpage-scan-progress__step-item--active' : ''}`}>
            <span className="webpage-scan-progress__step-dot" />
            <span>Dual-layer AI prompt injection classification</span>
          </div>
        </div>
      </div>

      <p className="webpage-scan-progress__scope">
        Analyzing page content loaded in this browser tab. External accounts, cookies, and private user credentials are never inspected.
      </p>
    </div>
  )
}

// ── Suspicious Chunk Card Sub-component ───────────────────────────────────────

function SuspiciousChunk({ chunk }: { chunk: ChunkResult }) {
  return (
    <div className="analysis-chunk-card analysis-chunk-card--danger">
      <div className="analysis-chunk-card__header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: '#fca5a5', textTransform: 'capitalize' }}>
            {chunk.source.replaceAll('_', ' ')}
          </span>
          <span className="analysis-badge analysis-badge--danger">Flagged</span>
        </div>
        <span style={{ fontSize: 10.5, color: '#71717a', fontFamily: 'var(--font-assistant-mono, monospace)' }}>
          {Math.round(chunk.confidence * 100)}% match
        </span>
      </div>

      {chunk.reason ? (
        <p style={{ margin: 0, fontSize: 11.5, color: '#fca5a5', lineHeight: 1.45 }}>
          {chunk.reason}
        </p>
      ) : null}

      {chunk.excerpt ? (
        <pre className="analysis-chunk-card__code">
          {chunk.excerpt}
        </pre>
      ) : null}

      {chunk.matched_patterns.length > 0 ? (
        <div className="feature-tags">
          {chunk.matched_patterns.map((pattern) => (
            <span className="feature-tag feature-tag--danger" key={pattern}>
              {pattern}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

// ── Main Panel ────────────────────────────────────────────────────────────────

export function WebpageAnalysisDetailsPanel({ content, isOpen, isScanning, result, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<'overview' | 'channels'>('overview')

  if (!content || (!isScanning && !result)) return null

  // 1. Scanning In Progress
  if (isScanning) {
    return (
      <>
        <div
          className={`analysis-drawer-overlay ${isOpen ? 'analysis-drawer-overlay--open' : ''}`}
          onClick={onClose}
          aria-hidden="true"
        />
        <aside
          className={`analysis-drawer ${isOpen ? 'analysis-drawer--open' : ''}`}
          aria-label="Webpage scan in progress"
          aria-modal="true"
          role="dialog"
        >
          <header className="drawer-header">
            <div className="drawer-header-left">
              <div className="drawer-header-title-row">
                <h3>Webpage Security Scan</h3>
                <span className="drawer-badge">Scanning…</span>
              </div>
              <p className="drawer-subtitle">Inspecting page content for indirect prompt injections</p>
            </div>
            <button
              className="drawer-close-btn"
              type="button"
              onClick={onClose}
              aria-label="Close webpage scan report"
            >
              <CloseIcon />
            </button>
          </header>
          <div className="drawer-content">
            <ScanProgress content={content} />
          </div>
        </aside>
      </>
    )
  }

  // 2. Scan Completed
  if (!result) return null
  const details = result.analysis_details
  const suspiciousChunks = details.chunk_results.filter((chunk) => chunk.label === 'malicious')
  const maliciousSources = new Set(suspiciousChunks.map((chunk) => chunk.source))
  const isBlocked = !result.allowed

  const channelRows = CONTENT_CHANNELS
    .filter(({ key }) => content[key].trim().length > 0)
    .map(({ key, label }) => ({ key, label, chars: content[key].length, flagged: maliciousSources.has(key) }))
    .sort((a, b) => Number(b.flagged) - Number(a.flagged))

  return (
    <>
      <div
        className={`analysis-drawer-overlay ${isOpen ? 'analysis-drawer-overlay--open' : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className={`analysis-drawer ${isOpen ? 'analysis-drawer--open' : ''}`}
        aria-label="Webpage Scan Report"
        aria-modal="true"
        role="dialog"
      >
        {/* Header */}
        <header className="drawer-header">
          <div className="drawer-header-left">
            <div className="drawer-header-title-row">
              <h3>Webpage Security Report</h3>
              <span className="drawer-badge">Indirect Analysis</span>
            </div>
            <p className="drawer-subtitle">Verification of web content loaded into this tab</p>
          </div>
          <button
            className="drawer-close-btn"
            type="button"
            onClick={onClose}
            aria-label="Close webpage scan report"
          >
            <CloseIcon />
          </button>
        </header>

        <div className="drawer-content">

          {/* Page Target URL Info */}
          <div className="webpage-page-meta">
            <div className="webpage-page-meta__icon">
              <GlobeIcon />
            </div>
            <div className="webpage-page-meta__info">
              <span className="webpage-page-meta__title" title={content.page_title || 'Untitled page'}>
                {content.page_title || 'Untitled page'}
              </span>
              <span className="webpage-page-meta__url" title={content.url}>
                {content.url}
              </span>
            </div>
          </div>

          {/* 1. HERO VERDICT ALERT BANNER */}
          <div className={`analysis-verdict ${isBlocked ? 'analysis-verdict--blocked' : 'analysis-verdict--safe'}`}>
            <div className="analysis-verdict__icon-wrap">
              {isBlocked ? <ShieldAlertIcon /> : <ShieldCheckIcon />}
            </div>
            <div className="analysis-verdict__body">
              <div className="analysis-verdict__header-line">
                <span className="analysis-verdict__title">
                  {isBlocked ? 'Security Threat Detected on Page' : 'Webpage Verified Clean'}
                </span>
                <span className={`analysis-badge ${isBlocked ? 'analysis-badge--danger' : 'analysis-badge--safe'}`}>
                  {isBlocked ? 'THREAT FOUND' : 'CLEAN'}
                </span>
              </div>
              <p className="analysis-verdict__desc">
                {result.summary_reason || (isBlocked
                  ? 'Suspicious instruction-like text was found in this webpage that could hijack AI assistance.'
                  : 'No prompt-injection directives or malicious instructions were detected in this page.')}
              </p>
            </div>
          </div>

          {/* 2. STATS OVERVIEW CARDS */}
          <div className="analysis-stats-grid">
            <div className="analysis-stat-card">
              <span className="analysis-stat-card__label">Page Safety</span>
              <span className={`analysis-stat-card__val ${isBlocked ? 'analysis-stat-card__val--danger' : 'analysis-stat-card__val--safe'}`}>
                {isBlocked ? 'Threat' : 'Clean'}
              </span>
              <span className="analysis-stat-card__desc">Indirect injection test</span>
            </div>

            <div className="analysis-stat-card">
              <span className="analysis-stat-card__label">Channels</span>
              <span className="analysis-stat-card__val">
                {channelRows.length} active
              </span>
              <span className="analysis-stat-card__desc">DOM & text sources</span>
            </div>

            <div className="analysis-stat-card">
              <span className="analysis-stat-card__label">Engine</span>
              <span className="analysis-stat-card__val" style={{ fontSize: 14 }}>
                {details.classifier_mode === 'dl_model' ? 'DL + Rules' : 'Rule-Based'}
              </span>
              <span className="analysis-stat-card__desc">Dual-layer detector</span>
            </div>
          </div>

          {/* 3. SEGMENTED NAVIGATION TABS */}
          <div className="analysis-tabs" role="tablist">
            <button
              type="button"
              className={`analysis-tab-btn ${activeTab === 'overview' ? 'analysis-tab-btn--active' : ''}`}
              onClick={() => setActiveTab('overview')}
              role="tab"
              aria-selected={activeTab === 'overview'}
            >
              <FileTextIcon />
              <span>Summary & Insights</span>
            </button>
            <button
              type="button"
              className={`analysis-tab-btn ${activeTab === 'channels' ? 'analysis-tab-btn--active' : ''}`}
              onClick={() => setActiveTab('channels')}
              role="tab"
              aria-selected={activeTab === 'channels'}
            >
              <LayersIcon />
              <span>Scanned Channels</span>
              <span className="analysis-tab-count">{channelRows.length}</span>
            </button>
          </div>

          {/* TAB 1: OVERVIEW & AI SUMMARY */}
          <div style={{ display: activeTab === 'overview' ? 'flex' : 'none', flexDirection: 'column', gap: 16 }}>
            {/* Plain-English AI Explanation */}
            <ScanSummarySection source="webpage_content" details={details} page={content} />

            {/* Credential Warning Advisory Notice (shadcn Alert) */}
            <div className={`analysis-notice ${isBlocked ? 'analysis-notice--danger' : 'analysis-notice--warning'}`}>
              <InfoIcon />
              <div className="analysis-notice__content">
                <strong>{isBlocked ? 'Do not interact with this page' : 'A passed scan is not credential clearance'}</strong>
                <p>
                  {isBlocked
                    ? 'Do not enter passwords, payment details, or other sensitive information while this page is flagged.'
                    : 'This scan checks page content for indirect prompt injections. It does not verify that external websites, login portals, or payment requests are legitimate.'}
                </p>
              </div>
            </div>

            {/* Threat Signals / Flagged Patterns (if any) */}
            {(result.matched_patterns.length > 0 || suspiciousChunks.length > 0) && (
              <div className="analysis-card">
                <div className="analysis-card__header">
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: '#f87171', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    Detected Threat Signals ({suspiciousChunks.length})
                  </span>
                </div>
                <div className="analysis-card__body">
                  {result.matched_patterns.length > 0 && (
                    <div className="feature-tags">
                      {result.matched_patterns.map((pattern) => (
                        <span className="feature-tag feature-tag--danger" key={pattern}>
                          {pattern}
                        </span>
                      ))}
                    </div>
                  )}
                  {suspiciousChunks.map((chunk) => (
                    <SuspiciousChunk chunk={chunk} key={chunk.chunk_id} />
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* TAB 2: SCANNED CHANNELS TABLE */}
          <div style={{ display: activeTab === 'channels' ? 'flex' : 'none', flexDirection: 'column', gap: 16 }}>
            <div className="analysis-card">
              <div className="analysis-card__header">
                <div className="analysis-card__header-left">
                  <LayersIcon />
                  <span>Content Channels Scanned</span>
                </div>
                <span className="analysis-badge analysis-badge--secondary">
                  {details.chunking.chunk_count} chunks analyzed
                </span>
              </div>
              <div className="analysis-card__body" style={{ padding: 0 }}>
                {channelRows.length > 0 ? (
                  <table className="analysis-table">
                    <thead>
                      <tr>
                        <th>Channel</th>
                        <th>Characters</th>
                        <th style={{ textAlign: 'right' }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {channelRows.map((row) => (
                        <tr key={row.key}>
                          <td style={{ fontWeight: 500 }}>{row.label}</td>
                          <td style={{ fontFamily: 'var(--font-assistant-mono, monospace)', color: '#a1a1aa' }}>
                            {row.chars.toLocaleString()}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <span className={`analysis-badge ${row.flagged ? 'analysis-badge--danger' : 'analysis-badge--safe'}`}>
                              {row.flagged ? 'Flagged' : 'Clean'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p style={{ margin: 0, padding: '14px 16px', color: '#71717a', fontSize: 12 }}>
                    No page content was available to scan.
                  </p>
                )}
              </div>
            </div>
          </div>

        </div>
      </aside>
    </>
  )
}

