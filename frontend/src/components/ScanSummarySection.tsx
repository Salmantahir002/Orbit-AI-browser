import { useEffect, useState } from 'react'
import type { AnalysisDetails } from '../types/analysisDetailsTypes'
import type { ScanSummary, SecuritySource, WebpageContent } from '../types/securityTypes'
import { explainScan } from '../services/backendApiClient'

type Props = {
  source: SecuritySource
  details: AnalysisDetails
  page?: Pick<WebpageContent, 'url' | 'page_title'>
}

function ScanIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  )
}

/**
 * Plain-language explanation of a finished scan, written by the active provider
 * (or a built-in summary when none is available). Shared by the webpage and
 * direct-prompt reports. Fetched once per `details` object.
 */
export function ScanSummarySection({ source, details, page }: Props) {
  const [summary, setSummary] = useState<ScanSummary | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setSummary(null)
    setFailed(false)
    explainScan(source, details, page)
      .then((value) => { if (!cancelled) setSummary(value) })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
    // `page` is rebuilt by callers each render; the scan identity is `details`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, details])

  const paragraphs = summary?.summary.split(/\n{2,}/).filter(Boolean) ?? []

  return (
    <section className="drawer-section">
      <div className="drawer-section-header">
        <ScanIcon /> Scan summary
        {summary?.source === 'llm' ? (
          <span style={{ fontWeight: 400, color: 'rgba(255,255,255,0.38)', fontSize: 10, marginLeft: 4, textTransform: 'none', letterSpacing: 'normal' }}>
            explained by {summary.provider}{summary.model ? ` · ${summary.model}` : ''}
          </span>
        ) : null}
      </div>
      <div className="drawer-section-body" aria-live="polite">
        {failed ? <p className="webpage-scan-empty">The summary could not be loaded. The scan results below are still valid.</p> : null}
        {!summary && !failed ? <p className="webpage-scan-empty">Asking the selected provider to explain the scan…</p> : null}
        {paragraphs.map((paragraph) => {
          const [, label, rest] = /^([A-Za-z ]+:)\s*([\s\S]*)$/.exec(paragraph) ?? [null, '', paragraph]
          return (
            <p key={paragraph} style={{ whiteSpace: 'pre-wrap', margin: '0 0 10px', lineHeight: 1.5 }}>
              {label ? <strong>{label} </strong> : null}{rest}
            </p>
          )
        })}
        {summary?.note ? <p className="webpage-scan-empty" style={{ fontSize: 11 }}>{summary.note}</p> : null}
      </div>
    </section>
  )
}
