import { useCallback, useEffect, useRef, useState, useId, type FormEvent } from 'react'
import { AgentTask } from '../services/agentRuntimeCore'
import { setAgentInputLock } from '../services/browserRuntime'
import type { ApprovalRequest } from '../services/agentApprovalPolicy'
import type { AgentTaskResult } from '../types/agentTypes'
import { PromptModelPicker } from './PromptModelPicker'
import { AgentResultMessage } from './AgentResultMessage'
import { describeAgentActivity } from '../services/agentActivity'
import './AgentActivity.css'

type StepEntry = {
  id: string
  step: number
  tool: string
  detail: string
}

type AgentModePanelProps = {
  /** Browser Runtime target id for the active tab; null before it attaches. */
  targetId: number | null
  currentUrl: string
  /**
   * Opens a new tab for the agent's `open_tab` tool and resolves to its target
   * id. Omitted means the app cannot open tabs, and the tool is refused.
   */
  onOpenTab?: (url?: string) => Promise<number | null>
  onOpenSettings?: () => void
}

export function AgentModePanel({ targetId, currentUrl, onOpenTab, onOpenSettings }: AgentModePanelProps) {
  const [goal, setGoal] = useState('')
  const [activeGoal, setActiveGoal] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [steps, setSteps] = useState<StepEntry[]>([])
  const [status, setStatus] = useState('')
  const [isPlanning, setIsPlanning] = useState(false)
  const [planSummary, setPlanSummary] = useState('')
  const [showPlan, setShowPlan] = useState(false)
  const planDetailsId = useId()
  const [result, setResult] = useState<AgentTaskResult | null>(null)
  const [approval, setApproval] = useState<ApprovalRequest | null>(null)
  const [showResultPopup, setShowResultPopup] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const approvalResolverRef = useRef<((granted: boolean) => void) | null>(null)
  const stepsEndRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    stepsEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' })
  }, [steps, approval, result])

  useEffect(() => {
    if (!showResultPopup) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowResultPopup(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [showResultPopup])

  // A pending approval must not outlive the panel, or the task would wait for
  // an answer that can no longer be given.
  useEffect(() => () => {
    approvalResolverRef.current?.(false)
    abortRef.current?.abort()
  }, [])

  const handleApprovalRequest = useCallback((request: ApprovalRequest) => {
    setApproval(request)
    return new Promise<boolean>((resolve) => {
      approvalResolverRef.current = (granted: boolean) => {
        approvalResolverRef.current = null
        setApproval(null)
        resolve(granted)
      }
    })
  }, [])

  const answerApproval = useCallback((granted: boolean) => {
    approvalResolverRef.current?.(granted)
  }, [])

  const stopTask = useCallback(() => {
    abortRef.current?.abort()
    approvalResolverRef.current?.(false)
    setIsPlanning(false)
    setStatus('Stopping…')
  }, [])

  // Stop pressed in a locked tab's "agent mode is active" toast. With no task
  // running there is nothing to stop, so the stale lock is simply released.
  useEffect(() => {
    return window.electronAPI?.browser.onAgentStopRequested((tabId) => {
      if (abortRef.current) stopTask()
      else void setAgentInputLock(tabId, false)
    })
  }, [stopTask])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmedGoal = goal.trim()
    if (!trimmedGoal || isRunning) return

    if (targetId === null) {
      setStatus('The browser view is not ready yet. Open a page first.')
      return
    }

    const controller = new AbortController()
    abortRef.current = controller

    setIsRunning(true)
    setIsPlanning(true)
    setPlanSummary('')
    setShowPlan(false)
    setSteps([])
    setResult(null)
    setShowResultPopup(false)
    setActiveGoal(trimmedGoal)
    setGoal('')
    setStatus('Planning the first action…')

    const task = new AgentTask({
      taskId: `task-${Date.now()}`,
      goal: trimmedGoal,
      targetId,
      visualFeedback: true,
      signal: controller.signal,
      onApprovalRequest: handleApprovalRequest,
      onOpenTab,
      events: {
        onPlanning: () => setIsPlanning(true),
        onPlan: (summary) => { setPlanSummary(summary); setIsPlanning(false) },
        onAction: (toolCall) => { setIsPlanning(false); setStatus(describeAgentActivity(toolCall)) },
        onStatus: (message) => setStatus(message),
        onStep: (step, toolCall, activity) => {
          setSteps((previous) => [...previous, {
            id: `${step}-${toolCall.tool}-${previous.length}`,
            step,
            tool: activity.summary,
            detail: activity.detail === activity.summary ? '' : activity.detail,
          }])
        },
      },
    })

    try {
      setResult(await task.run())
    } catch (error) {
      setResult({
        taskId: 'unknown',
        status: 'failed',
        message: error instanceof Error ? error.message : 'The agent stopped unexpectedly.',
        steps: 0,
      })
    } finally {
      setIsRunning(false)
      setIsPlanning(false)
      setStatus('')
      abortRef.current = null
    }
  }

  const handleStop = stopTask

  const hasPage = Boolean(currentUrl) && currentUrl !== 'about:blank'

  const resultTone = result?.status === 'completed'
    ? 'agent-result--ok'
    : 'agent-result--failed'

  return (
    <div className="agent-mode" aria-label="Agent mode">
      {steps.length === 0 && !result && !isRunning ? (
        <div className="agent-intro">
          <h3>Agent mode</h3>
          <p>
            Give the agent a goal and it will operate this tab for you.
            Use the toolbar Scan Page button to check any page for hidden instructions.
          </p>
          {status ? <p className="agent-intro-hint">{status}</p> : hasPage ? null : <p className="agent-intro-hint">Open a page to begin.</p>}
        </div>
      ) : (
        <div className="agent-timeline">
          {activeGoal ? <div className="agent-goal-bubble">{activeGoal}</div> : null}

          {steps.map((entry) => (
            <div className="agent-step" key={entry.id}>
              <span className="agent-step-index">{entry.step}</span>
              <div className="agent-step-body">
                <span className="agent-step-tool">{entry.tool}</span>
                {entry.detail ? <span className="agent-step-detail">{entry.detail}</span> : null}
              </div>
            </div>
          ))}

          {result ? (
            <div
              className={`agent-result ${resultTone} agent-result--clickable`}
              role="button"
              tabIndex={0}
              onClick={() => setShowResultPopup(true)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setShowResultPopup(true)
                }
              }}
              title="Click to view full message in popup"
              aria-label="Agent result message. Click to view popup."
            >
              <div className="agent-result-header">
                <strong>
                  {result.status === 'completed' ? 'Done' : 'Stopped'}
                </strong>
                <span className="agent-result-expand-icon" aria-hidden="true" title="Expand message">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 3 21 3 21 9" />
                    <polyline points="9 21 3 21 3 15" />
                    <line x1="21" y1="3" x2="14" y2="10" />
                    <line x1="3" y1="21" x2="10" y2="14" />
                  </svg>
                </span>
              </div>
              <AgentResultMessage text={result.message} />
              <span className="agent-result-steps">
                {result.steps} step{result.steps === 1 ? '' : 's'} · Tap to expand
              </span>
            </div>
          ) : null}

          <div ref={stepsEndRef} />
        </div>
      )}

      {/* Outside the scrolling history: activity must remain visible during long tasks. */}
      {isRunning || planSummary ? (
        <div className={`agent-activity${isRunning && !approval && status !== 'Stopping…' ? ' agent-activity--active' : ''}`}>
          <button
            type="button"
            className="agent-activity-toggle"
            aria-expanded={showPlan}
            aria-controls={planDetailsId}
            onClick={() => setShowPlan(previous => !previous)}
          >
            <span className="agent-activity-orbit" aria-hidden="true"><span /><span /><span /></span>
            <span className="agent-activity-copy">
              <span className="agent-activity-label">{!isRunning ? 'Planning summary' : approval ? 'Waiting for approval' : status === 'Stopping…' ? 'Stopping' : isPlanning ? 'Thinking' : 'Working'}</span>
              <span className="agent-activity-status" role="status" aria-live="polite">
                {isRunning ? (approval ? approval.summary : status) : 'View the latest action plan'}
              </span>
            </span>
            <svg className="agent-activity-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="m9 5 7 7-7 7" />
            </svg>
          </button>
          <div id={planDetailsId} className="agent-activity-detail" hidden={!showPlan}>
            <span className="agent-activity-caption">{isPlanning ? 'Latest plan · updating' : 'Action summary'}</span>
            <p>{planSummary || 'Reviewing the current page. The next-action summary will appear here when the plan is ready.'}</p>
          </div>
        </div>
      ) : null}


      {approval ? (
        <div className="agent-approval" role="alertdialog" aria-label="Approval required">
          <strong>Approve this action?</strong>
          <p className="agent-approval-summary">{approval.summary}</p>
          <p className="agent-approval-reason">{approval.reason}</p>
          <div className="agent-approval-actions">
            <button type="button" className="agent-approve" onClick={() => answerApproval(true)}>
              Allow
            </button>
            <button type="button" className="agent-decline" onClick={() => answerApproval(false)}>
              Don't allow
            </button>
          </div>
        </div>
      ) : null}

      {/* The goal box and its button share one framed composer so the button
          can never drift out of alignment as the textarea grows. */}
      <form className="agent-goal-form" onSubmit={handleSubmit}>
        <textarea
          className="agent-goal-input"
          aria-label="Agent goal"
          placeholder="What should the agent do on this page?"
          rows={2}
          value={goal}
          disabled={isRunning}
          onChange={(event) => setGoal(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }}
        />
        <div className="agent-goal-footer">
          <div className="agent-goal-footer-left">
            <PromptModelPicker onOpenSettings={onOpenSettings} />
            <span className="agent-goal-hint">{isRunning ? 'Running…' : 'Enter to run'}</span>
          </div>
          {isRunning ? (
            <button type="button" className="agent-stop-button" onClick={handleStop}>Stop</button>
          ) : (
            <button type="submit" className="agent-run-button" disabled={!goal.trim()}>Run</button>
          )}
        </div>
      </form>

      {showResultPopup && result ? (
        <div
          className="agent-result-modal-overlay"
          onClick={() => setShowResultPopup(false)}
          role="presentation"
        >
          {/* ponytail: in-panel modal avoids colliding with Electron native WebContentsView; upgrade to global obscured portal if full-window modal is ever explicitly required. */}
          <div
            className="agent-result-modal-container"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="agent-result-modal-heading"
          >
            <div className="agent-result-modal-header">
              <div className="agent-result-modal-badge-row">
                <div
                  className={`agent-result-modal-badge ${
                    result.status === 'completed'
                      ? 'agent-result-modal-badge--ok'
                      : 'agent-result-modal-badge--failed'
                  }`}
                >
                  {result.status === 'completed' ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="15" y1="9" x2="9" y2="15" />
                      <line x1="9" y1="9" x2="15" y2="15" />
                    </svg>
                  )}
                </div>
                <div>
                  <h3 id="agent-result-modal-heading" className="agent-result-modal-title">
                    {result.status === 'completed' ? 'Done' : 'Stopped'}
                  </h3>
                  <span className="agent-result-modal-meta">
                    {result.steps} step{result.steps === 1 ? '' : 's'}
                  </span>
                </div>
              </div>
              <button
                type="button"
                className="agent-result-modal-close-btn"
                onClick={() => setShowResultPopup(false)}
                aria-label="Close message popup"
                title="Close (Esc)"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="agent-result-modal-body">
              <AgentResultMessage text={result.message} expanded />
            </div>
            <div className="agent-result-modal-footer">
              <span className="agent-result-modal-hint">Tap anywhere outside to close</span>
              <button
                type="button"
                className="agent-result-modal-action-btn"
                onClick={() => setShowResultPopup(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
