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
        ? 'Reviewing scripts and stylesheets'
        : 'Classifying captured content for injection patterns'

  return (
    <div className="webpage-scan-progress" aria-live="polite">
      <div className="webpage-scan-progress__radar" aria-hidden="true"><span /></div>
      <p className="webpage-scan-progress__eyebrow">Live webpage content review</p>
      <h4>Scanning the open page</h4>
      <p className="webpage-scan-progress__phase">{phase}</p>
      <div className="webpage-scan-progress__track" aria-label={`${progress}% scan progress`} role="progressbar" aria-valuemax={100} aria-valuemin={0} aria-valuenow={progress}>
        <span style={{ width: `${progress}%` }} />
      </div>
      <div className="webpage-scan-progress__meta"><span>{progress}% reviewed</span><span>{content.visible_text.length.toLocaleString()} visible characters captured</span></div>
      <p className="webpage-scan-progress__scope">Reviewing the rendered page content available to this browser tab. Server-side systems and private APIs are not accessed.</p>
    </div>
  )
}

function ShieldIcon({ blocked = false }: { blocked?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 20, height: 20 }}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      {blocked ? <><line x1="9" y1="9" x2="15" y2="15" /><line x1="15" y1="9" x2="9" y2="15" /></> : <polyline points="9 12 12 15 16 10" />}
    </svg>
  )
}

function ScanIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  )
}

function WarningIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h16.9a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
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

function SuspiciousChunk({ chunk }: { chunk: ChunkResult }) {
  return (
    <article className="webpage-scan-chunk">
      <div className="webpage-scan-chunk__header">
        <span>{chunk.source.replaceAll('_', ' ')}</span>
        <strong>{Math.round(chunk.confidence * 100)}%</strong>
      </div>
      <p>{chunk.reason}</p>
      <p className="webpage-scan-chunk__excerpt">{chunk.excerpt}</p>
      {chunk.matched_evidence.length > 0 ? <p className="webpage-scan-chunk__evidence">Matched text: {chunk.matched_evidence.map((term) => `“${term}”`).join(', ')}</p> : null}
      {chunk.matched_patterns.length > 0 ? (
        <div className="feature-tags">
          {chunk.matched_patterns.map((pattern) => <span className="feature-tag feature-tag--danger" key={pattern}>{pattern}</span>)}
        </div>
      ) : null}
    </article>
  )
}


export function WebpageAnalysisDetailsPanel({ content, isOpen, isScanning, result, onClose }: Props) {
  if (!content || (!isScanning && !result)) return null

  if (isScanning) {
    return (
      <>
        <div className={`analysis-drawer-overlay ${isOpen ? 'analysis-drawer-overlay--open' : ''}`} onClick={onClose} />
        <section className={`analysis-drawer webpage-analysis-drawer ${isOpen ? 'analysis-drawer--open' : ''}`} aria-label="Webpage scan in progress" aria-modal="true" role="dialog">
          <header className="drawer-header">
            <div>
              <h3>Webpage Scan Report</h3>
              <p className="drawer-subtitle">Indirect prompt-injection analysis</p>
            </div>
            <button className="drawer-close-btn" type="button" onClick={onClose} aria-label="Close webpage scan report">✕</button>
          </header>
          <div className="drawer-content"><ScanProgress content={content} /></div>
        </section>
      </>
    )
  }

  // The result is guaranteed when the scan is no longer in progress.
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
      <div className={`analysis-drawer-overlay ${isOpen ? 'analysis-drawer-overlay--open' : ''}`} onClick={onClose} />
      <section className={`analysis-drawer webpage-analysis-drawer ${isOpen ? 'analysis-drawer--open' : ''}`} aria-label="Webpage scan report" aria-modal="true" role="dialog">
        <header className="drawer-header">
          <div>
            <h3>Webpage Scan Report</h3>
            <p className="drawer-subtitle">Indirect prompt-injection analysis</p>
          </div>
          <button className="drawer-close-btn" type="button" onClick={onClose} aria-label="Close webpage scan report">✕</button>
        </header>

        <div className="drawer-content">
          <div className={`drawer-decision decision-compact ${isBlocked ? 'drawer-decision--blocked' : 'drawer-decision--safe'}`}>
            <div className="drawer-decision-label">
              <ShieldIcon blocked={isBlocked} />
              <div>
                <div>{isBlocked ? 'Page threat detected' : 'No page injection detected'}</div>
                <div className="webpage-decision-copy">{result.summary_reason}</div>
              </div>
            </div>
          </div>

          <div className="webpage-scan-page">
            <strong>{content.page_title || 'Untitled page'}</strong>
            <code>{content.url}</code>
          </div>

          <ScanSummarySection source="webpage_content" details={details} page={content} />

          <div className={`webpage-credential-notice ${isBlocked ? 'webpage-credential-notice--blocked' : ''}`}>
            <WarningIcon />
            <div>
              <strong>{isBlocked ? 'Do not interact with this page.' : 'A passed scan is not credential clearance.'}</strong>
              <p>{isBlocked
                ? 'Do not enter passwords, payment details, or other sensitive information while this page is flagged.'
                : 'This scan checks page content for indirect prompt injection. It does not verify that a site, login form, or payment request is legitimate.'}</p>
            </div>
          </div>

          <section className="drawer-section">
            <div className="drawer-section-header">
              <ScanIcon /> Content channels scanned
              <span style={{ fontWeight: 400, color: 'rgba(255,255,255,0.38)', fontSize: 10, marginLeft: 4, textTransform: 'none', letterSpacing: 'normal' }}>
                ({details.chunking.chunk_count} chunks · {details.classifier_mode === 'dl_model' ? 'DL model + rules' : 'rule based'})
              </span>
            </div>
            <div className="drawer-section-body" style={{ padding: 0 }}>
              {channelRows.length > 0 ? (
                <table className="chunk-table">
                  <thead>
                    <tr><th>Channel</th><th>Characters</th><th>Result</th></tr>
                  </thead>
                  <tbody>
                    {channelRows.map((row) => (
                      <tr key={row.key}>
                        <td>{row.label}</td>
                        <td style={{ fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.55)' }}>
                          {row.chars.toLocaleString()}
                        </td>
                        <td>
                          <span className={`chunk-label ${row.flagged ? 'chunk-label--malicious' : 'chunk-label--safe'}`}>
                            {row.flagged ? 'Flagged' : 'Clear'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <p className="webpage-scan-empty" style={{ padding: '14px 16px' }}>No page content was available to scan.</p>}
            </div>
          </section>

          <section className="drawer-section">
            <div className="drawer-section-header"><WarningIcon /> Page threat signals</div>
            <div className="drawer-section-body">
              {result.matched_patterns.length > 0 ? (
                <div className="feature-tags">
                  {result.matched_patterns.map((pattern) => <span className="feature-tag feature-tag--danger" key={pattern}>{pattern}</span>)}
                </div>
              ) : <p className="webpage-scan-empty">All scanned content channels were benign: no instruction-like prompt injection pattern was detected.</p>}
              {suspiciousChunks.length > 0 ? (
                <div className="webpage-scan-chunks">
                  {suspiciousChunks.map((chunk) => <SuspiciousChunk chunk={chunk} key={chunk.chunk_id} />)}
                </div>
              ) : null}
            </div>
          </section>
        </div>
      </section>
    </>
  )
}
