import { useEffect, useState } from 'react'
import type { AnalysisDetails } from '../types/analysisDetailsTypes'
import type { ScanSummary, SecuritySource, WebpageContent } from '../types/securityTypes'
import { explainScan } from '../services/backendApiClient'
import { LiquidGlass } from './LiquidGlass'

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
    // 1. Already cached in memory: render reads it directly, no network request
    if (summaryDataCache.has(details)) return

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

  // A cached summary wins; otherwise only a result loaded for these details counts.
  const loadedHere = loadedDetails === details
  const activeSummary = summaryDataCache.get(details) ?? (loadedHere ? summary : null)
  const hasFailed = loadedHere && failed && !activeSummary
  const isLoading = !activeSummary && !hasFailed
  const parsed = activeSummary ? parseSummary(activeSummary.summary) : null

  // Prepare ordered list of sections to type sequentially. Untitled sections
  // are the model's paragraphs that matched no known heading.
  const sections: Array<{ key: string; title: string; text: string }> = []

  if (parsed) {
    if (parsed.verdict) {
      sections.push({ key: 'verdict', title: 'Verdict', text: parsed.verdict })
    }
    if (parsed.findings) {
      sections.push({ key: 'findings', title: 'What was checked', text: parsed.findings })
    }
    if (parsed.action) {
      sections.push({ key: 'action', title: 'Recommended action', text: parsed.action })
    }
    parsed.other.forEach((text, i) => {
      sections.push({ key: `other-${i}`, title: '', text })
    })
  }

  const totalChars = sections.reduce((acc, s) => acc + s.text.length, 0)

  // Restart or finish the typewriter when the scan or its text changes. Adjusted
  // during render (React's pattern for state derived from changing inputs).
  const [typingFor, setTypingFor] = useState({ details, totalChars })
  if (typingFor.details !== details || typingFor.totalChars !== totalChars) {
    setTypingFor({ details, totalChars })
    setCharIndex(typedScansCache.has(details) ? totalChars : 0)
  }

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
    <div className="analysis-card lg-host" onClick={isTyping ? handleSkipTyping : undefined} style={{ cursor: isTyping ? 'pointer' : 'default' }}>
      <LiquidGlass refraction={0} blur={8} elasticity={0.05} />
      <div className="analysis-card__header">
        <div className="analysis-card__header-left">
          <SparklesIcon />
          <span>Scan Summary & Insights</span>
        </div>
        {isTyping ? (
          <span className="drawer-badge">
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
              <div style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid rgba(255, 255, 255, 0.7)', borderTopColor: 'transparent', animation: 'spinSlow 0.8s linear infinite' }} />
              <span>Analyzing scan findings with AI security engine…</span>
            </div>
            <div style={{ height: 12, background: 'rgba(255,255,255,0.06)', borderRadius: 4, width: '92%' }} />
            <div style={{ height: 12, background: 'rgba(255,255,255,0.04)', borderRadius: 4, width: '78%' }} />
          </div>
        ) : null}

        {/* Failed notice */}
        {hasFailed ? (
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

              // Plain headed paragraphs, as the model wrote them: no colour coding.
              return (
                <section key={section.key} className="analysis-summary-section">
                  {section.title ? <h4 className="analysis-summary-section__title">{section.title}</h4> : null}
                  <p className="analysis-summary-section__text">
                    {visibleText}
                    {isCurrentlyTyping && <span className="analysis-typing-cursor">▌</span>}
                  </p>
                </section>
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
