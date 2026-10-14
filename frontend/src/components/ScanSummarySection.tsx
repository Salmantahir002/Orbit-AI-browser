import { useEffect, useState } from 'react'
import type { AnalysisDetails } from '../types/analysisDetailsTypes'
import type { ScanSummary, SecuritySource, WebpageContent } from '../types/securityTypes'
import { explainScan } from '../services/backendApiClient'

type Props = {
  source: SecuritySource
  details: AnalysisDetails
  page?: Pick<WebpageContent, 'url' | 'page_title'>
}

function SparklesIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
      <path d="M20 3v4" />
      <path d="M22 5h-4" />
    </svg>
  )
}

function CheckCircle2Icon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  )
}

function AlertTriangleIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  )
}

function LightbulbIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
      <path d="M9 18h6" />
      <path d="M10 22h4" />
    </svg>
  )
}

function parseSummary(raw: string) {
  const paragraphs = raw.split(/\n{2,}/).filter(Boolean)
  let verdict = ''
  let findings = ''
  let action = ''
  const other: string[] = []

  for (const p of paragraphs) {
    const trimmed = p.trim()
    const lower = trimmed.toLowerCase()
    if (lower.startsWith('verdict:')) {
      verdict = trimmed.replace(/^verdict:\s*/i, '')
    } else if (lower.startsWith('what was found:') || lower.startsWith('findings:')) {
      findings = trimmed.replace(/^(what was found|findings):\s*/i, '')
    } else if (lower.startsWith('what to do:') || lower.startsWith('action:') || lower.startsWith('recommendation:')) {
      action = trimmed.replace(/^(what to do|action|recommendation):\s*/i, '')
    } else {
      other.push(trimmed)
    }
  }

  return { verdict, findings, action, other }
}

// ── In-memory caches to prevent duplicate API hits on tab switches ─────────
const summaryDataCache = new WeakMap<AnalysisDetails, ScanSummary>()
const summaryPromiseCache = new WeakMap<AnalysisDetails, Promise<ScanSummary>>()
const typedScansCache = new WeakSet<AnalysisDetails>()

/**
 * Plain-language explanation of a finished scan, written by the active provider
 * (or a built-in summary when none is available). Formatted as a modern shadcn/ui Card
 * with real-time typewriter streaming animation.
 */
export function ScanSummarySection({ source, details, page }: Props) {
  const cachedData = summaryDataCache.get(details) ?? null
  const [loadedDetails, setLoadedDetails] = useState<AnalysisDetails | null>(cachedData ? details : null)
  const [summary, setSummary] = useState<ScanSummary | null>(cachedData)
  const [failed, setFailed] = useState(false)

  // Typing animation state
  const isAlreadyTyped = typedScansCache.has(details)
  const [charIndex, setCharIndex] = useState<number>(isAlreadyTyped ? 999999 : 0)

  useEffect(() => {
    // 1. If already cached in memory, use it immediately with zero network requests
    if (summaryDataCache.has(details)) {
      setSummary(summaryDataCache.get(details)!)
      setLoadedDetails(details)
      setFailed(false)
      return
    }

    let cancelled = false

    // 2. Reuse in-flight promise if one is already pending
    let promise = summaryPromiseCache.get(details)
    if (!promise) {
      promise = explainScan(source, details, page)
      summaryPromiseCache.set(details, promise)
    }

    promise
      .then((value) => {
        summaryDataCache.set(details, value)
        if (!cancelled) {
          setSummary(value)
          setLoadedDetails(details)
          setFailed(false)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoadedDetails(details)
          setFailed(true)
        }
      })

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, details])

  const isLoading = loadedDetails !== details && !failed && !summary
  const activeSummary = loadedDetails === details ? summary : summaryDataCache.get(details) ?? null
  const parsed = activeSummary ? parseSummary(activeSummary.summary) : null
  const isMaliciousVerdict = parsed?.verdict.toLowerCase().includes('blocked') || parsed?.verdict.toLowerCase().includes('flagged')

  // Prepare ordered list of sections to type sequentially
  const sections: Array<{
    key: string
    title: string
    text: string
    type: 'verdict' | 'findings' | 'action' | 'other'
  }> = []

  if (parsed) {
    if (parsed.verdict) {
      sections.push({ key: 'verdict', title: 'Verdict', text: parsed.verdict, type: 'verdict' })
    }
    if (parsed.findings) {
      sections.push({ key: 'findings', title: 'What Was Checked', text: parsed.findings, type: 'findings' })
    }
    if (parsed.action) {
      sections.push({ key: 'action', title: 'Recommended Action', text: parsed.action, type: 'action' })
    }
    parsed.other.forEach((text, i) => {
      sections.push({ key: `other-${i}`, title: '', text, type: 'other' })
    })
  }

  const totalChars = sections.reduce((acc, s) => acc + s.text.length, 0)

  // Initialize or resume typewriter state
  useEffect(() => {
    if (typedScansCache.has(details)) {
      setCharIndex(totalChars)
      return
    }
    setCharIndex(0)
  }, [details, totalChars])

  // Typewriter stepping timer
  useEffect(() => {
    if (!parsed || totalChars === 0) return
    if (typedScansCache.has(details)) return
    if (charIndex >= totalChars) {
      typedScansCache.add(details)
      return
    }

    // Smooth, deliberate single-character typewriter pacing (1 char every 22ms)
    const timer = window.setInterval(() => {
      setCharIndex((current) => {
        const next = current + 1
        if (next >= totalChars) {
          clearInterval(timer)
          typedScansCache.add(details)
          return totalChars
        }
        return next
      })
    }, 22)

    return () => clearInterval(timer)
  }, [parsed, totalChars, charIndex, details])

  const handleSkipTyping = () => {
    setCharIndex(totalChars)
    typedScansCache.add(details)
  }

  const isTyping = !typedScansCache.has(details) && charIndex < totalChars && !isLoading && parsed !== null

  let accumulatedChars = 0

  return (
    <div className="analysis-card" onClick={isTyping ? handleSkipTyping : undefined} style={{ cursor: isTyping ? 'pointer' : 'default' }}>
      <div className="analysis-card__header">
        <div className="analysis-card__header-left">
          <SparklesIcon />
          <span>Scan Summary & Insights</span>
        </div>
        {isTyping ? (
          <span className="drawer-badge" style={{ color: '#34d399', borderColor: 'rgba(52, 211, 153, 0.3)' }}>
            Streaming analysis…
          </span>
        ) : activeSummary?.source === 'llm' ? (
          <span className="drawer-badge" title={`Model: ${activeSummary.model || 'default'}`}>
            Explained by {activeSummary.provider || 'AI'}{activeSummary.model ? ` · ${activeSummary.model}` : ''}
          </span>
        ) : activeSummary ? (
          <span className="drawer-badge">
            Built-in Analysis Engine
          </span>
        ) : null}
      </div>

      <div className="analysis-card__body" aria-live="polite">
        {/* Loading Skeleton */}
        {isLoading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#a1a1aa', fontSize: 12 }}>
              <div style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid #34d399', borderTopColor: 'transparent', animation: 'spinSlow 0.8s linear infinite' }} />
              <span>Analyzing scan findings with AI security engine…</span>
            </div>
            <div style={{ height: 12, background: 'rgba(255,255,255,0.06)', borderRadius: 4, width: '92%' }} />
            <div style={{ height: 12, background: 'rgba(255,255,255,0.04)', borderRadius: 4, width: '78%' }} />
          </div>
        ) : null}

        {/* Failed notice */}
        {failed && loadedDetails === details ? (
          <p style={{ margin: 0, fontSize: 12, color: '#a1a1aa', lineHeight: 1.5 }}>
            Automated explanation could not be generated. Technical scan evidence below remains complete and verified.
          </p>
        ) : null}

        {/* Typewriter Streamed Insights */}
        {parsed ? (
          <>
            {sections.map((section) => {
              const start = accumulatedChars
              const end = start + section.text.length
              accumulatedChars = end

              const isVisible = charIndex >= start || typedScansCache.has(details)
              if (!isVisible) return null

              const typedLength = Math.max(0, Math.min(charIndex - start, section.text.length))
              const visibleText = typedScansCache.has(details) || charIndex >= end ? section.text : section.text.slice(0, typedLength)
              const isCurrentlyTyping = !typedScansCache.has(details) && charIndex >= start && charIndex < end

              if (section.type === 'verdict') {
                return (
                  <div
                    key={section.key}
                    className={`analysis-summary-block analysis-summary-block--typing ${isMaliciousVerdict ? 'analysis-summary-block--verdict-danger' : 'analysis-summary-block--verdict'}`}
                  >
                    <div className="analysis-summary-block__icon">
                      {isMaliciousVerdict ? <AlertTriangleIcon /> : <CheckCircle2Icon />}
                    </div>
                    <div className="analysis-summary-block__content">
                      <div className="analysis-summary-block__title">Verdict</div>
                      <p className="analysis-summary-block__text">
                        {visibleText}
                        {isCurrentlyTyping && <span className="analysis-typing-cursor">▌</span>}
                      </p>
                    </div>
                  </div>
                )
              }

              if (section.type === 'findings') {
                return (
                  <div key={section.key} className="analysis-summary-block analysis-summary-block--findings analysis-summary-block--typing">
                    <div className="analysis-summary-block__icon">
                      <SearchIcon />
                    </div>
                    <div className="analysis-summary-block__content">
                      <div className="analysis-summary-block__title">What Was Checked</div>
                      <p className="analysis-summary-block__text">
                        {visibleText}
                        {isCurrentlyTyping && <span className="analysis-typing-cursor">▌</span>}
                      </p>
                    </div>
                  </div>
                )
              }

              if (section.type === 'action') {
                return (
                  <div key={section.key} className="analysis-summary-block analysis-summary-block--action analysis-summary-block--typing">
                    <div className="analysis-summary-block__icon">
                      <LightbulbIcon />
                    </div>
                    <div className="analysis-summary-block__content">
                      <div className="analysis-summary-block__title">Recommended Action</div>
                      <p className="analysis-summary-block__text">
                        {visibleText}
                        {isCurrentlyTyping && <span className="analysis-typing-cursor">▌</span>}
                      </p>
                    </div>
                  </div>
                )
              }

              return (
                <p key={section.key} style={{ margin: 0, fontSize: 12, color: '#d4d4d8', lineHeight: 1.55 }}>
                  {visibleText}
                  {isCurrentlyTyping && <span className="analysis-typing-cursor">▌</span>}
                </p>
              )
            })}

            {activeSummary?.note && (!isTyping || charIndex >= totalChars) ? (
              <p style={{ margin: '2px 0 0', fontSize: 11, color: '#71717a', lineHeight: 1.4 }}>
                {activeSummary.note}
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  )
}
