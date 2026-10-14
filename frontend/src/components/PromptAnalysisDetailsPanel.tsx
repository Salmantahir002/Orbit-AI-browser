import { useState } from 'react'
import type { AnalysisDetails, ChunkResult } from '../types/analysisDetailsTypes'
import { ScanSummarySection } from './ScanSummarySection'

type Props = {
  details: AnalysisDetails | null
  isOpen: boolean
  onClose: () => void
}

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

// ── Chunk Card Sub-component ──────────────────────────────────────────────────

function ChunkCard({ chunk }: { chunk: ChunkResult }) {
  const isMalicious = chunk.label === 'malicious'

  return (
    <div className={`analysis-chunk-card ${isMalicious ? 'analysis-chunk-card--danger' : ''}`}>
      <div className="analysis-chunk-card__header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontFamily: 'var(--font-assistant-mono, monospace)', fontSize: 11, color: '#71717a' }}>
            {chunk.chunk_id}
          </span>
          <span className={`analysis-badge ${isMalicious ? 'analysis-badge--danger' : 'analysis-badge--safe'}`}>
            {isMalicious ? 'Flagged' : 'Safe'}
          </span>
          <span className="analysis-badge analysis-badge--secondary" style={{ textTransform: 'capitalize' }}>
            {chunk.risk_level} risk
          </span>
        </div>
        <span style={{ fontSize: 10.5, color: '#71717a', fontFamily: 'var(--font-assistant-mono, monospace)' }}>
          {Math.round(chunk.confidence * 100)}% confidence
        </span>
      </div>

      {/* Code excerpt preview */}
      {chunk.excerpt ? (
        <pre className="analysis-chunk-card__code">
          {chunk.excerpt}
        </pre>
      ) : null}

      {/* Reasoning and pattern tags for malicious chunks */}
      {isMalicious && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 }}>
          {chunk.reason && (
            <p style={{ margin: 0, fontSize: 11.5, color: '#fca5a5', lineHeight: 1.45 }}>
              {chunk.reason}
            </p>
          )}
          {chunk.matched_patterns.length > 0 && (
            <div className="feature-tags">
              {chunk.matched_patterns.map((p) => (
                <span key={p} className="feature-tag feature-tag--danger">
                  {p}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main Panel ────────────────────────────────────────────────────────────────

export function PromptAnalysisDetailsPanel({ details, isOpen, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<'overview' | 'chunks'>('overview')

  if (!details) return null

  const maliciousChunks = details.chunk_results.filter((c) => c.label === 'malicious')
  const safeChunks = details.chunk_results.filter((c) => c.label !== 'malicious')
  const isSafe = maliciousChunks.length === 0
  const fe = details.feature_evidence
  const hasThreatSignals = fe.role_override_count > 0 || fe.data_exfiltration_count > 0 || maliciousChunks.length > 0

  return (
    <>
      {/* Backdrop Overlay */}
      <div
        className={`analysis-drawer-overlay ${isOpen ? 'analysis-drawer-overlay--open' : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Slide-in Sheet Drawer */}
      <aside
        className={`analysis-drawer ${isOpen ? 'analysis-drawer--open' : ''}`}
        aria-label="Direct Prompt Analysis Report"
        aria-modal="true"
        role="dialog"
      >
        {/* Header */}
        <header className="drawer-header">
          <div className="drawer-header-left">
            <div className="drawer-header-title-row">
              <h3>Prompt Security Report</h3>
              <span className="drawer-badge">Direct Prompt</span>
            </div>
            <p className="drawer-subtitle">Dual-layer AI prompt-injection verification</p>
          </div>
          <button
            className="drawer-close-btn"
            type="button"
            onClick={onClose}
            aria-label="Close prompt analysis report"
          >
            <CloseIcon />
          </button>
        </header>

        {/* Content */}
        <div className="drawer-content">

          {/* 1. HERO VERDICT ALERT BANNER */}
          <div className={`analysis-verdict ${isSafe ? 'analysis-verdict--safe' : 'analysis-verdict--blocked'}`}>
            <div className="analysis-verdict__icon-wrap">
              {isSafe ? <ShieldCheckIcon /> : <ShieldAlertIcon />}
            </div>
            <div className="analysis-verdict__body">
              <div className="analysis-verdict__header-line">
                <span className="analysis-verdict__title">
                  {isSafe ? 'Prompt Verified Safe — Allowed' : 'Security Threat Blocked'}
                </span>
                <span className={`analysis-badge ${isSafe ? 'analysis-badge--safe' : 'analysis-badge--danger'}`}>
                  {isSafe ? 'CLEAN' : 'BLOCKED'}
                </span>
              </div>
              <p className="analysis-verdict__desc">
                {isSafe
                  ? details.final_rationale || 'No prompt injection, jailbreaks, or instruction overrides were detected in your input.'
                  : details.final_rationale || 'This prompt was blocked because it contained instructions designed to override AI security boundaries.'}
              </p>
            </div>
          </div>

          {/* 2. STATS OVERVIEW CARDS */}
          <div className="analysis-stats-grid">
            <div className="analysis-stat-card">
              <span className="analysis-stat-card__label">Security Status</span>
              <span className={`analysis-stat-card__val ${isSafe ? 'analysis-stat-card__val--safe' : 'analysis-stat-card__val--danger'}`}>
                {isSafe ? 'Allowed' : 'Blocked'}
              </span>
              <span className="analysis-stat-card__desc">Safety threshold met</span>
            </div>

            <div className="analysis-stat-card">
              <span className="analysis-stat-card__label">Overrides</span>
              <span className={`analysis-stat-card__val ${fe.role_override_count > 0 ? 'analysis-stat-card__val--danger' : ''}`}>
                {fe.role_override_count === 0 ? '0 found' : `${fe.role_override_count} flagged`}
              </span>
              <span className="analysis-stat-card__desc">System prompt hijack</span>
            </div>

            <div className="analysis-stat-card">
              <span className="analysis-stat-card__label">Data Leak Risk</span>
              <span className={`analysis-stat-card__val ${fe.data_exfiltration_count > 0 ? 'analysis-stat-card__val--danger' : ''}`}>
                {fe.data_exfiltration_count === 0 ? 'Clean' : `${fe.data_exfiltration_count} risk`}
              </span>
              <span className="analysis-stat-card__desc">Exfiltration patterns</span>
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
              className={`analysis-tab-btn ${activeTab === 'chunks' ? 'analysis-tab-btn--active' : ''}`}
              onClick={() => setActiveTab('chunks')}
              role="tab"
              aria-selected={activeTab === 'chunks'}
            >
              <LayersIcon />
              <span>Inspected Blocks</span>
              <span className="analysis-tab-count">{details.chunk_results.length}</span>
            </button>
          </div>

          {/* TAB 1: OVERVIEW & AI SUMMARY */}
          <div style={{ display: activeTab === 'overview' ? 'flex' : 'none', flexDirection: 'column', gap: 16 }}>
            {/* Plain-English AI Explanation */}
            <ScanSummarySection source="direct_prompt" details={details} />

            {/* Threat Signals / Flagged Items (if any) */}
            {hasThreatSignals && fe.top_terms.length > 0 && (
              <div className="analysis-card">
                <div className="analysis-card__header">
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: '#fde047', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    Flagged Terms Found
                  </span>
                </div>
                <div className="analysis-card__body">
                  <div className="feature-tags">
                    {fe.top_terms.map((term) => (
                      <span key={term} className="feature-tag feature-tag--danger">
                        {term}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* TAB 2: TECHNICAL INSPECTION / BLOCKS */}
          <div style={{ display: activeTab === 'chunks' ? 'flex' : 'none', flexDirection: 'column', gap: 16 }}>
            <div className="analysis-card">
              <div className="analysis-card__header">
                <div className="analysis-card__header-left">
                  <LayersIcon />
                  <span>Prompt Text Chunks</span>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <span className="analysis-badge analysis-badge--safe">{safeChunks.length} safe</span>
                  {maliciousChunks.length > 0 && (
                    <span className="analysis-badge analysis-badge--danger">{maliciousChunks.length} flagged</span>
                  )}
                </div>
              </div>
              <div className="analysis-card__body" style={{ gap: 8, maxHeight: 420, overflowY: 'auto' }}>
                {maliciousChunks.map((chunk) => (
                  <ChunkCard key={chunk.chunk_id} chunk={chunk} />
                ))}
                {safeChunks.map((chunk) => (
                  <ChunkCard key={chunk.chunk_id} chunk={chunk} />
                ))}
              </div>
            </div>
          </div>

        </div>
      </aside>
    </>
  )
}

