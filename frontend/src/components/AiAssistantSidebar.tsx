import { memo, useRef, useState, useEffect } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { checkPrompt, chatWithLlm, type ChatPageContext } from '../services/backendApiClient'
import { extractPageContent } from '../services/pageContentExtractor'
import type { BrowserWebViewHandle } from './BrowserWebView'
import type { AnalysisDetails } from '../types/analysisDetailsTypes'
import type { ChatAttachment, ChatHistoryTurn, LlmResponse, SecurityCheckResponse } from '../types/securityTypes'
import { AgentModePanel } from './AgentModePanel'
import { KimoMascot } from './KimoMascot'
import { MarkdownMessage } from './MarkdownMessage'
import { PromptInputBox } from './PromptInputBox'

type SidebarMode = 'chat' | 'agent'

const CHAT_SESSIONS_STORAGE_KEY = 'promptguard.chat_sessions'

export type ChatSession = {
  id: string
  title: string
  updatedAt: number
  messages: ChatMessage[]
}

function readStoredSessions(): ChatSession[] {
  try {
    const raw = window.localStorage.getItem(CHAT_SESSIONS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

type ChatMessage = {
  id: string
  sender: 'user' | 'assistant'
  text?: string
  attachments?: ChatAttachment[]
  securityResult?: SecurityCheckResponse
  llmResponse?: LlmResponse
  errorMessage?: string
  isChecking?: boolean
  pageContextAttached?: boolean
  pageTitle?: string
}


type AiAssistantSidebarProps = {
  onViewDetails?: (details: AnalysisDetails) => void
  /** Browser Runtime target id for the active tab, for agent mode. */
  activeTargetId?: number | null
  currentUrl?: string
  activeTabTitle?: string
  activeWebviewHandle?: BrowserWebViewHandle | null
  /** Opens a tab for the agent's `open_tab` tool; resolves to its target id. */
  onOpenTab?: (url?: string) => Promise<number | null>
  /** Current panel width in px; owned by the shell, which sets the grid column. */
  width?: number
  onWidthChange?: (width: number) => void
  /** Raised while the edge is being dragged so the shell can shield the webview. */
  onResizingChange?: (isResizing: boolean) => void
  onOpenSettings?: () => void
}

/** Keyboard nudge per arrow press on the resize separator. */
const RESIZE_STEP = 24

function ShieldCheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 14, height: 14 }}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <polyline points="9 12 12 15 16 10" />
    </svg>
  )
}

function ShieldXIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 14, height: 14 }}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <line x1="9" y1="9" x2="15" y2="15" />
      <line x1="15" y1="9" x2="9" y2="15" />
    </svg>
  )
}

function SparkIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 13, height: 13 }}>
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
    </svg>
  )
}

function HistoryIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: 15, height: 15 }}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: 13, height: 13 }}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  )
}

function NewSessionIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" />
      <path d="M18.4 3.6a1.98 1.98 0 0 1 2.8 2.8L12.7 15l-3.5.7.7-3.5 8.5-8.6z" />
    </svg>
  )
}

// Memoized: the shell re-renders on every tab loading/favicon/title change, none of which
// concern the chat. Its props are stable across those updates, so it now skips them.
export const AiAssistantSidebar = memo(function AiAssistantSidebar({
  onViewDetails,
  activeTargetId = null,
  currentUrl = '',
  activeTabTitle = '',
  activeWebviewHandle = null,
  onOpenTab,
  width = 400,
  onWidthChange,
  onResizingChange,
  onOpenSettings,
}: AiAssistantSidebarProps) {
  const [mode, setMode] = useState<SidebarMode>('chat')
  const [sessions, setSessions] = useState<ChatSession[]>(readStoredSessions)
  const [activeSessionId, setActiveSessionId] = useState<string>(() => `session-${Date.now()}`)
  const [isHistoryOpen, setIsHistoryOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isChecking, setIsChecking] = useState(false)
  const [detachedUrl, setDetachedUrl] = useState<string | null>(null)
  // Bumped to remount the agent panel, which is how "new task" discards a
  // running task and its transcript in one step.
  const [agentSessionId, setAgentSessionId] = useState(0)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)

  const prevMsgCountRef = useRef<number>(0)
  const [clearSignal, setClearSignal] = useState(0)

  const hasActivePage = Boolean(currentUrl && currentUrl !== 'about:blank' && !currentUrl.startsWith('about:'))
  const isPageContextAttached = hasActivePage && detachedUrl !== currentUrl

  // Automatically sync active chat session to state and localStorage
  useEffect(() => {
    if (messages.length === 0) return
    setSessions((prev) => {
      const existingIndex = prev.findIndex((s) => s.id === activeSessionId)
      const firstUserMsg = messages.find((m) => m.sender === 'user')?.text || 'New Chat'
      const title = firstUserMsg.length > 40 ? `${firstUserMsg.slice(0, 40)}…` : firstUserMsg
      const updated: ChatSession = {
        id: activeSessionId,
        title: existingIndex >= 0 ? prev[existingIndex].title : title,
        updatedAt: Date.now(),
        messages,
      }
      const next = existingIndex >= 0
        ? prev.map((s, i) => (i === existingIndex ? updated : s))
        : [updated, ...prev]
      try {
        window.localStorage.setItem(CHAT_SESSIONS_STORAGE_KEY, JSON.stringify(next))
      } catch (e) {
        console.warn('Failed to save chat session', e)
      }
      return next
    })
  }, [messages, activeSessionId])

  useEffect(() => {
    const nextCount = messages.length
    const prevCount = prevMsgCountRef.current
    prevMsgCountRef.current = nextCount

    // Only keep the view pinned when a new message is appended.
    // Avoid smooth scrolling on internal state transitions (checking -> result) which can cause input to jump.
    if (nextCount > prevCount) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' })
    }
  }, [messages])

  async function handlePromptSubmit(prompt: string, attachments?: ChatAttachment[]) {
    const userMsgId = `user-${Date.now()}`
    const assistantMsgId = `assistant-${Date.now()}`

    // Add user message
    setMessages((prev) => [
      ...prev,
      {
        id: userMsgId,
        sender: 'user',
        text: prompt,
        attachments: attachments && attachments.length > 0 ? attachments : undefined,
        pageContextAttached: isPageContextAttached,
        pageTitle: isPageContextAttached ? (activeTabTitle || 'Current Page') : undefined,
      },
      { id: assistantMsgId, sender: 'assistant', isChecking: true },
    ])

    setIsChecking(true)
    // Trigger PromptInputBox clear immediately when submit starts.
    setClearSignal((v) => v + 1)

    let pageContext: ChatPageContext | undefined = undefined
    if (isPageContextAttached && activeWebviewHandle) {
      try {
        const extracted = await extractPageContent(activeWebviewHandle)
        if (extracted) {
          pageContext = {
            page_url: extracted.url || currentUrl,
            page_title: extracted.page_title || activeTabTitle,
            page_content: extracted.visible_text,
          }
        }
      } catch {
        // Fallback gracefully without page content
      }
    }

    try {
      const result = await checkPrompt(prompt)

      let llmResp: LlmResponse | undefined
      if (result.allowed) {
        // Context window: extract prior completed turns from active session
        const historyTurns: ChatHistoryTurn[] = []
        for (const m of messages) {
          if (m.isChecking || m.errorMessage) continue
          if (m.sender === 'user' && m.text) {
            historyTurns.push({ role: 'user', content: m.text })
          } else if (m.sender === 'assistant' && m.llmResponse?.response) {
            historyTurns.push({ role: 'assistant', content: m.llmResponse.response })
          }
        }

        llmResp = await chatWithLlm(prompt, pageContext, historyTurns, attachments)
      }


      // Update assistant message with result
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMsgId
            ? { ...msg, isChecking: false, securityResult: result, llmResponse: llmResp }
            : msg,
        ),
      )
    } catch (error) {
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMsgId
            ? {
              ...msg,
              isChecking: false,
              errorMessage: error instanceof Error ? error.message : 'Security check failed',
            }
            : msg,
        ),
      )
    } finally {
      setIsChecking(false)
    }
  }

  /** Starts a fresh session in whichever surface is currently showing. */
  function handleNewSession() {
    if (mode === 'chat') {
      setActiveSessionId(`session-${Date.now()}`)
      setMessages([])
      setIsChecking(false)
      setDetachedUrl(null)
      setClearSignal((v) => v + 1)
      setIsHistoryOpen(false)
      return
    }
    setAgentSessionId((id) => id + 1)
  }

  function handleSelectSession(session: ChatSession) {
    setActiveSessionId(session.id)
    setMessages(session.messages)
    setIsChecking(false)
    setDetachedUrl(null)
    setIsHistoryOpen(false)
  }

  function handleDeleteSession(sessionId: string, e: React.MouseEvent) {
    e.stopPropagation()
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== sessionId)
      try {
        window.localStorage.setItem(CHAT_SESSIONS_STORAGE_KEY, JSON.stringify(next))
      } catch {}
      return next
    })
    if (activeSessionId === sessionId) {
      setActiveSessionId(`session-${Date.now()}`)
      setMessages([])
    }
  }

  function handleClearAllSessions() {
    setSessions([])
    try {
      window.localStorage.removeItem(CHAT_SESSIONS_STORAGE_KEY)
    } catch {}
    setActiveSessionId(`session-${Date.now()}`)
    setMessages([])
  }

  // The drag is tracked on the handle itself via pointer capture: without it
  // the pointer crosses into the guest's native view, whose process would
  // swallow the move events and strand the drag. isResizingAssistant also
  // zero-bounds the guest for the duration (see BrowserWebView's isObscured).
  function handleResizePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    event.preventDefault()

    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    onResizingChange?.(true)

    const handleMove = (moveEvent: PointerEvent) => {
      onWidthChange?.(window.innerWidth - moveEvent.clientX)
    }
    const handleEnd = () => {
      handle.removeEventListener('pointermove', handleMove)
      handle.removeEventListener('pointerup', handleEnd)
      handle.removeEventListener('pointercancel', handleEnd)
      onResizingChange?.(false)
    }

    handle.addEventListener('pointermove', handleMove)
    handle.addEventListener('pointerup', handleEnd)
    handle.addEventListener('pointercancel', handleEnd)
  }

  function handleResizeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      onWidthChange?.(width + RESIZE_STEP)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      onWidthChange?.(width - RESIZE_STEP)
    }
  }

  const hasMessages = messages.length > 0
  const canStartNewSession = mode === 'agent' || hasMessages || isChecking

  return (
    <aside className="assistant-panel" aria-label="Kimo panel">
      {/* Drag edge. `separator` + arrow keys keeps the panel resizable without
          a pointer. */}
      <div
        className="assistant-resize-handle"
        role="separator"
        aria-label="Resize assistant panel"
        aria-orientation="vertical"
        aria-valuenow={Math.round(width)}
        tabIndex={0}
        onPointerDown={handleResizePointerDown}
        onKeyDown={handleResizeKeyDown}
      />
      {/* Header */}
      <div className="assistant-header">
        <div className="assistant-header-left">
          <div className="assistant-logo">
            <KimoMascot compact />
          </div>
          <h2>Kimo</h2>
        </div>
        <div className="assistant-header-right">
          {/* Chat and agent mode are separate surfaces on purpose: one answers
              questions, the other operates the browser. */}
          <div className="assistant-mode-switch" role="tablist" aria-label="Assistant mode">
            <button
              className={`assistant-mode-tab ${mode === 'chat' ? 'assistant-mode-tab--active' : ''}`}
              type="button"
              role="tab"
              aria-selected={mode === 'chat'}
              onClick={() => setMode('chat')}
            >
              Chat
            </button>
            <button
              className={`assistant-mode-tab ${mode === 'agent' ? 'assistant-mode-tab--active' : ''}`}
              type="button"
              role="tab"
              aria-selected={mode === 'agent'}
              onClick={() => setMode('agent')}
            >
              Agent
            </button>
          </div>

          <span className="assistant-header-divider" aria-hidden="true" />

          {mode === 'chat' && (
            <button
              className={`assistant-new-button ${isHistoryOpen ? 'assistant-new-button--active' : ''}`}
              type="button"
              title={isHistoryOpen ? 'Back to chat' : 'Chat history'}
              aria-label={isHistoryOpen ? 'Back to chat' : 'Chat history'}
              onClick={() => setIsHistoryOpen((v) => !v)}
            >
              <HistoryIcon />
            </button>
          )}

          {/* One button, scoped to the visible surface: the other mode's session
              is left untouched behind it. */}
          <button
            className="assistant-new-button"
            type="button"
            disabled={!canStartNewSession}
            title={mode === 'chat' ? 'New chat' : 'New agent task'}
            aria-label={mode === 'chat' ? 'New chat' : 'New agent task'}
            onClick={handleNewSession}
          >
            <NewSessionIcon />
          </button>
        </div>
      </div>

      {/* Agent mode stays mounted while chat is shown. Unmounting it would
          abort a running task and discard a half-written goal simply because
          the user glanced at the chat tab. */}
      <div className="assistant-pane" hidden={mode !== 'agent'}>
        <AgentModePanel
          key={agentSessionId}
          targetId={activeTargetId}
          currentUrl={currentUrl}
          onOpenTab={onOpenTab}
          onOpenSettings={onOpenSettings}
        />
      </div>

      {mode === 'chat' ? (
        <div className="assistant-pane">
          {isHistoryOpen ? (
            <div className="assistant-history-view" role="region" aria-label="Chat history">
              <div className="assistant-history-header">
                <div className="assistant-history-header-title">
                  <HistoryIcon />
                  <span>Chat History</span>
                </div>
                <div className="assistant-history-header-actions">
                  {sessions.length > 0 && (
                    <button
                      type="button"
                      className="assistant-history-clear-btn"
                      onClick={handleClearAllSessions}
                      title="Clear all chat history"
                    >
                      Clear all
                    </button>
                  )}
                  <button
                    type="button"
                    className="assistant-history-close-btn"
                    onClick={() => setIsHistoryOpen(false)}
                    title="Close history"
                  >
                    ✕
                  </button>
                </div>
              </div>
              <div className="assistant-history-list">
                {sessions.length === 0 ? (
                  <div className="assistant-history-empty">
                    <p>No chat history yet</p>
                    <span>Conversations you have with Kimo will appear here.</span>
                  </div>
                ) : (
                  sessions.map((session) => (
                    <div
                      key={session.id}
                      className={`assistant-history-card ${session.id === activeSessionId ? 'assistant-history-card--active' : ''}`}
                      onClick={() => handleSelectSession(session)}
                    >
                      <div className="assistant-history-card-body">
                        <span className="assistant-history-card-title">{session.title}</span>
                        <div className="assistant-history-card-meta">
                          <span>{new Date(session.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                          <span>·</span>
                          <span>{session.messages.length} msg{session.messages.length !== 1 ? 's' : ''}</span>
                        </div>
                      </div>
                      <button
                        type="button"
                        className="assistant-history-delete-btn"
                        title="Delete chat"
                        onClick={(e) => handleDeleteSession(session.id, e)}
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : (
            <>
      {/* Welcome state or messages */}
      {!hasMessages ? (
        <div className="assistant-welcome">
          <div className="assistant-welcome-header">
            <div className="assistant-welcome-logo">
              <KimoMascot />
            </div>
            <h3>Kimo</h3>
          </div>
          <p>Your personal prompt-defense assistant. Every message is checked for injection before it reaches the model.</p>
        </div>
      ) : (
        <div className="chat-messages">
          {messages.map((msg) => (
            <div key={msg.id} className={`chat-message chat-message--${msg.sender}`}>
              {msg.sender === 'user' && (msg.text || (msg.attachments && msg.attachments.length > 0)) ? (
                <div className="chat-user-message-container">
                  {msg.pageContextAttached ? (
                    <div className="chat-message-context-badge">
                      <SparkIcon />
                      <span>{msg.pageTitle || 'Page Context'}</span>
                    </div>
                  ) : null}
                  {msg.attachments && msg.attachments.length > 0 ? (
                    <div className="chat-user-attachments-grid">
                      {msg.attachments.map((att) =>
                        att.isImage ? (
                          <div key={att.id} className="chat-user-image-card">
                            <img src={att.data} alt={att.name} className="chat-user-img-preview" />
                            <span className="chat-user-attachment-caption" title={att.name}>
                              {att.name}
                            </span>
                          </div>
                        ) : (
                          <div key={att.id} className="chat-user-file-card">
                            <span className="chat-user-file-icon">📄</span>
                            <div className="chat-user-file-info">
                              <span className="chat-user-file-name" title={att.name}>
                                {att.name}
                              </span>
                              <span className="chat-user-file-size">
                                {att.size ? `${Math.round(att.size / 1024)} KB` : 'File'}
                              </span>
                            </div>
                          </div>
                        ),
                      )}
                    </div>
                  ) : null}
                  {msg.text ? <div className="chat-bubble chat-bubble--user">{msg.text}</div> : null}
                </div>
              ) : null}


              {msg.sender === 'assistant' && msg.isChecking ? (
                <div className="chat-checking">
                  <span>Checking for injection</span>
                  <div className="dot-pulse">
                    <span />
                    <span />
                    <span />
                  </div>
                </div>
              ) : null}

              {msg.sender === 'assistant' && msg.errorMessage ? (
                <div className="assistant-error" role="alert">
                  {msg.errorMessage}
                </div>
              ) : null}

              {msg.sender === 'assistant' && msg.securityResult ? (
                <div
                  className={`security-card ${msg.securityResult.allowed ? 'security-card--safe' : 'security-card--blocked'
                    }`}
                >
                  <div className="security-card-header">
                    <span className="security-card-label">
                      {msg.securityResult.allowed ? <ShieldCheckIcon /> : <ShieldXIcon />}
                      {msg.securityResult.allowed ? 'Safe' : 'Blocked'}
                    </span>
                  </div>
                  <div className="security-card-body">
                    <div className="security-card-risk">
                      {msg.securityResult.risk_level} risk
                    </div>
                    <p className="security-card-reason">
                      {msg.securityResult.summary_reason}
                    </p>
                  </div>
                  <div className="security-card-footer">
                    <button
                      className="analysis-button"
                      type="button"
                      onClick={() => onViewDetails?.(msg.securityResult!.analysis_details)}
                    >
                      View Prompt Analysis
                    </button>
                  </div>
                </div>
              ) : null}

              {msg.sender === 'assistant' && msg.llmResponse ? (
                <div className="llm-answer">
                  <div className="llm-answer-byline">
                    <span className="llm-answer-avatar">
                      <KimoMascot compact />
                    </span>
                    Kimo
                  </div>
                  {/* The model replies in markdown; rendering it raw would leave
                      `**` and `###` in the transcript. */}
                  <MarkdownMessage text={msg.llmResponse.response} />
                </div>
              ) : null}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
      )}

      {/* Input Area */}
      <div className="chat-input-area">
        <PromptInputBox
          disabled={isChecking}
          onSubmit={handlePromptSubmit}
          clearSignal={clearSignal}
          placeholder={isPageContextAttached ? `Ask anything about this page...` : `Write a message...`}
          contextBadge={
            isPageContextAttached ? (
              <div className="chat-context-pill" title={`Kimo has context from ${activeTabTitle || 'this page'}`}>
                <span className="chat-context-icon">
                  <SparkIcon />
                </span>
                <span className="chat-context-text">
                  Sharing '{activeTabTitle || 'Current Page'}'
                </span>
                <button
                  type="button"
                  className="chat-context-dismiss"
                  title="Don't share page context with this message"
                  aria-label="Remove page context"
                  onClick={() => setDetachedUrl(currentUrl)}
                >
                  ✕
                </button>
              </div>
            ) : hasActivePage ? (
              <button
                type="button"
                className="chat-context-attach-btn"
                title="Attach current page context to chat"
                onClick={() => setDetachedUrl(null)}
              >
                <SparkIcon />
                <span>+ Share '{activeTabTitle || 'current page'}'</span>
              </button>
            ) : null
          }
          onOpenSettings={onOpenSettings}
        />
      </div>
            </>
          )}
        </div>
      ) : null}
    </aside>
  )
})
