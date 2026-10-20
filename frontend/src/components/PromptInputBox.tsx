import { useLiveTranscription } from './useLiveTranscription'
import { MicrophoneButton, MicrophoneStatus } from './MicrophoneButton'
import {
  useEffect,
  useState,
  useRef,
  useCallback,
  useId,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type ChangeEvent,
} from 'react'
import { LiquidGlass } from './LiquidGlass'
import { PromptModelPicker } from './PromptModelPicker'
import { PromptExpandButton } from './PromptExpandButton'

import { getModelCapabilities } from '../utils/modelCapabilities'
import { getAllStoredProviders } from '../services/providerApiClient'
import { extractDocxTextInBrowser } from '../utils/docxExtractor'
import type { ChatAttachment } from '../types/securityTypes'

type PromptInputBoxProps = {
  disabled: boolean
  onSubmit: (prompt: string, attachments?: ChatAttachment[]) => Promise<void>
  clearSignal: number
  contextBadge?: ReactNode
  placeholder?: string
  onOpenSettings?: () => void
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 16, height: 16 }}>
      <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
    </svg>
  )
}

function AttachmentIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 16, height: 16 }}>
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  )
}

function ImageIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 15, height: 15 }}>
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  )
}

function FileTextIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 15, height: 15 }}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: 12, height: 12 }}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

function AlertIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 14, height: 14 }}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

type ActiveModelInfo = { providerId: string; modelId: string; modelName: string }

/** The active provider's model, or empty strings when none is active; null if it can't be read. */
async function readActiveModelInfo(): Promise<ActiveModelInfo | null> {
  try {
    const stored = await getAllStoredProviders().catch(() => [])
    const active = stored.find((p) => p.is_active)
    if (!active) return { providerId: '', modelId: '', modelName: '' }
    const modelObj = active.models?.find((m) => m.id === active.selected_model)
    return {
      providerId: active.id || '',
      modelId: active.selected_model || '',
      modelName: modelObj?.name || active.selected_model || active.name || 'Active Model',
    }
  } catch {
    return null
  }
}

export function PromptInputBox({
  disabled,
  onSubmit,
  clearSignal,
  contextBadge,
  placeholder,
  onOpenSettings,
}: PromptInputBoxProps) {
  const [prompt, setPrompt] = useState('')
  const [isExpanded, setIsExpanded] = useState(false)
  const promptId = useId()
  const voice = useLiveTranscription(prompt, setPrompt, clearSignal)
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [isAttachMenuOpen, setIsAttachMenuOpen] = useState(false)
  const [incompatibilityWarning, setIncompatibilityWarning] = useState<string | null>(null)
  const [activeModelId, setActiveModelId] = useState<string>('')
  const [activeProviderId, setActiveProviderId] = useState<string>('')
  const [activeModelName, setActiveModelName] = useState<string>('')

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const attachMenuRef = useRef<HTMLDivElement>(null)

  // Load the active provider & model now and whenever the providers change.
  // State is set from the load's callback, never synchronously in the effect.
  useEffect(() => {
    let subscribed = true
    const refresh = () => {
      void readActiveModelInfo().then((info) => {
        if (!subscribed || !info) return
        setActiveProviderId(info.providerId)
        setActiveModelId(info.modelId)
        setActiveModelName(info.modelName)
      })
    }
    refresh()
    window.addEventListener('promptguard:providers-updated', refresh)
    return () => {
      subscribed = false
      window.removeEventListener('promptguard:providers-updated', refresh)
    }
  }, [])

  // Compute model capabilities
  const capabilities = getModelCapabilities(activeModelId, activeProviderId, activeModelName)

  // Helper to compute incompatibility error if attachments contain media not supported by active model
  const computeIncompatibilityError = useCallback((atts: ChatAttachment[]): string | null => {
    if (atts.length === 0) return null
    const hasImages = atts.some((a) => a.isImage)
    const hasFiles = atts.some((a) => !a.isImage)

    if (hasImages && !capabilities.supportsImages && hasFiles && !capabilities.supportsFiles) {
      return `Error: ${capabilities.modelName} does not support image or file attachments. Please switch to a multimodal model (such as Gemini, Claude, or GPT-4o) or remove the attachments.`
    }
    if (hasImages && !capabilities.supportsImages) {
      return `Error: ${capabilities.modelName} does not support image attachments. Please switch to a vision-capable model (such as Gemini, Claude, or GPT-4o) or remove the image.`
    }
    if (hasFiles && !capabilities.supportsFiles) {
      return `Error: ${capabilities.modelName} does not support file attachments. Please switch to a file-capable model (such as Gemini, Claude, or GPT-4o) or remove the file.`
    }
    return null
  }, [capabilities.supportsImages, capabilities.supportsFiles, capabilities.modelName])

  // Recompute the incompatibility error when the attachments or the model change.
  // Adjusted during render (React's pattern for state derived from changing
  // inputs), so a dismissed warning stays dismissed until either changes.
  const [warningInputs, setWarningInputs] = useState({ attachments, check: computeIncompatibilityError })
  if (warningInputs.attachments !== attachments || warningInputs.check !== computeIncompatibilityError) {
    setWarningInputs({ attachments, check: computeIncompatibilityError })
    setIncompatibilityWarning(computeIncompatibilityError(attachments))
  }

  // Close attachment dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (attachMenuRef.current && !attachMenuRef.current.contains(e.target as Node)) {
        setIsAttachMenuOpen(false)
      }
    }
    if (isAttachMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isAttachMenuOpen])

  // Clear inputs when clearSignal changes (adjusted during render, as above).
  const [seenClearSignal, setSeenClearSignal] = useState(clearSignal)
  if (clearSignal !== seenClearSignal) {
    setSeenClearSignal(clearSignal)
    setPrompt('')
    setAttachments([])
    setIncompatibilityWarning(null)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmedPrompt = prompt.trim()

    // Must have prompt or attachments
    if ((!trimmedPrompt && attachments.length === 0) || disabled || voice.busy) {
      return
    }

    // If active model is unsupported for staged attachments, show error and prevent send
    const incompErr = computeIncompatibilityError(attachments)
    if (incompErr) {
      setIncompatibilityWarning(incompErr)
      return
    }

    const outgoingPrompt = trimmedPrompt || (attachments.length > 0 ? `Analyze the attached ${attachments[0]?.name || 'file'}` : '')
    const outgoingAttachments = [...attachments]

    await onSubmit(outgoingPrompt, outgoingAttachments)
    setPrompt('')
    setAttachments([])
    setIncompatibilityWarning(null)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      const form = event.currentTarget.closest('form')
      form?.requestSubmit()
    }
  }

  // Handle clicking "Upload Image"
  const handleSelectUploadImage = () => {
    setIsAttachMenuOpen(false)
    imageInputRef.current?.click()
  }

  // Handle clicking "Upload File"
  const handleSelectUploadFile = () => {
    setIsAttachMenuOpen(false)
    fileInputRef.current?.click()
  }

  // Process chosen image file
  const handleImageFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    const file = files[0]
    // Reset file input value so re-selecting the same file fires change
    e.target.value = ''

    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      const newAtt: ChatAttachment = {
        id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: file.name,
        type: file.type || 'image/jpeg',
        size: file.size,
        data: dataUrl,
        isImage: true,
      }
      setAttachments((prev) => [...prev, newAtt])
    }
    reader.readAsDataURL(file)
  }

  // Process chosen document/file
  const handleDocFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    const file = files[0]
    e.target.value = ''

    const isDocx = /\.docx$/i.test(file.name)
    const isTextReadable =
      file.type.startsWith('text/') ||
      /\.(txt|md|csv|json|js|ts|tsx|jsx|py|html|css|yaml|yml|xml|env|log|rtf)$/i.test(file.name)

    if (isDocx) {
      // Word document: extract text in browser using native DecompressionStream
      const dataReader = new FileReader()
      dataReader.onload = async () => {
        const dataUrl = dataReader.result as string
        const extractedText = await extractDocxTextInBrowser(file)
        const newAtt: ChatAttachment = {
          id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: file.name,
          type: file.type || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          size: file.size,
          data: dataUrl,
          isImage: false,
          textContent: extractedText || undefined,
        }
        setAttachments((prev) => [...prev, newAtt])
      }
      dataReader.readAsDataURL(file)
    } else if (isTextReadable) {
      const textReader = new FileReader()
      textReader.onload = () => {
        const content = textReader.result as string
        const newAtt: ChatAttachment = {
          id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: file.name,
          type: file.type || 'text/plain',
          size: file.size,
          data: `data:${file.type || 'text/plain'};base64,${btoa(unescape(encodeURIComponent(content)))}`,
          isImage: false,
          textContent: content,
        }
        setAttachments((prev) => [...prev, newAtt])
      }
      textReader.readAsText(file)
    } else {
      // PDF or other binary document
      const dataReader = new FileReader()
      dataReader.onload = () => {
        const dataUrl = dataReader.result as string
        const newAtt: ChatAttachment = {
          id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: file.name,
          type: file.type || 'application/octet-stream',
          size: file.size,
          data: dataUrl,
          isImage: false,
        }
        setAttachments((prev) => [...prev, newAtt])
      }
      dataReader.readAsDataURL(file)
    }
  }

  const handleRemoveAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }

  const canSubmit = !disabled && !voice.busy && (Boolean(prompt.trim()) || attachments.length > 0)

  return (
    <form
      className={`prompt-form lg-host${isExpanded ? ' prompt-composer--expanded' : ''}`}
      onSubmit={handleSubmit}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && isExpanded && !event.defaultPrevented) {
          event.preventDefault()
          setIsExpanded(false)
        }
      }}
    >
      <LiquidGlass refraction={96} bezel={22} blur={6} elasticity={0.14} />
      {/* Hidden file inputs */}
      <input
        type="file"
        ref={imageInputRef}
        accept="image/png,image/jpeg,image/webp,image/gif"
        style={{ display: 'none' }}
        onChange={handleImageFileChange}
      />
      <input
        type="file"
        ref={fileInputRef}
        accept=".pdf,.txt,.md,.csv,.json,.js,.ts,.tsx,.jsx,.py,.html,.css,.doc,.docx"
        style={{ display: 'none' }}
        onChange={handleDocFileChange}
      />

      <div className="prompt-composer-header">
        {contextBadge ? <div className="prompt-context-container">{contextBadge}</div> : null}
        <PromptExpandButton expanded={isExpanded} controls={promptId} onToggle={() => setIsExpanded((value) => !value)} />
      </div>

      {/* Error banner when an incompatible attachment is inserted */}
      {incompatibilityWarning && (
        <div className="prompt-incompatibility-banner" role="alert">
          <span className="prompt-incompatibility-icon">
            <AlertIcon />
          </span>
          <span className="prompt-incompatibility-text">
            {incompatibilityWarning}
          </span>
          <button
            type="button"
            className="prompt-incompatibility-dismiss"
            onClick={() => setIncompatibilityWarning(null)}
            aria-label="Dismiss message"
          >
            <CloseIcon />
          </button>
        </div>
      )}

      {/* Staged attachments preview chips */}
      {attachments.length > 0 && (
        <div className="prompt-staged-attachments" aria-label="Attached files">
          {attachments.map((att) => {
            const isUnsupported =
              (att.isImage && !capabilities.supportsImages) || (!att.isImage && !capabilities.supportsFiles)
            return (
              <div
                key={att.id}
                className={`prompt-attachment-chip ${isUnsupported ? 'prompt-attachment-chip--unsupported' : ''}`}
              >
                {att.isImage ? (
                  <img src={att.data} alt={att.name} className="prompt-chip-thumbnail" />
                ) : (
                  <span className="prompt-chip-icon">
                    <FileTextIcon />
                  </span>
                )}
                <div className="prompt-chip-info">
                  <span className="prompt-chip-name" title={att.name}>
                    {att.name}
                  </span>
                  <span className="prompt-chip-size">
                    {formatBytes(att.size)}
                    {isUnsupported && <span className="prompt-chip-unsupported-tag"> • Unsupported</span>}
                  </span>
                </div>
                <button
                  type="button"
                  className="prompt-chip-remove"
                  title="Remove attachment"
                  aria-label={`Remove ${att.name}`}
                  onClick={() => handleRemoveAttachment(att.id)}
                >
                  <CloseIcon />
                </button>
              </div>
            )
          })}
        </div>
      )}

      <textarea
        id={promptId}
        ref={textareaRef}
        className="prompt-textarea"
        disabled={disabled}
        readOnly={voice.busy}
        aria-label="Chat prompt"
        placeholder={placeholder || 'Write a message or attach files...'}
        rows={1}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={handleKeyDown}
      />

      <div className="prompt-form-footer">
        <div className="prompt-form-actions">
          <MicrophoneButton state={voice.state} disabled={disabled} onClick={() => { void voice.toggle() }} />
          {/* File & Image Attachment Button (Chat mode only) */}
          <div className="prompt-attachment-picker-wrapper" ref={attachMenuRef}>
            <button
              type="button"
              className={`prompt-icon-btn lg-press ${isAttachMenuOpen ? 'prompt-icon-btn--active' : ''}`}
              title="Attach file or image"
              aria-label="Attach file or image"
              aria-expanded={isAttachMenuOpen}
              onClick={() => setIsAttachMenuOpen((prev) => !prev)}
            >
              <AttachmentIcon />
            </button>

            {isAttachMenuOpen && (
              <div className="prompt-attach-popover" role="menu">
                <div className="prompt-attach-header">Insert Media & Files</div>

                <button
                  type="button"
                  className="prompt-attach-item"
                  onClick={handleSelectUploadImage}
                  role="menuitem"
                >
                  <span className="prompt-attach-item-icon">
                    <ImageIcon />
                  </span>
                  <div className="prompt-attach-item-details">
                    <span className="prompt-attach-item-title">Upload Image</span>
                    <span className="prompt-attach-item-desc">PNG, JPEG, WebP, GIF</span>
                  </div>
                </button>

                <button
                  type="button"
                  className="prompt-attach-item"
                  onClick={handleSelectUploadFile}
                  role="menuitem"
                >
                  <span className="prompt-attach-item-icon">
                    <FileTextIcon />
                  </span>
                  <div className="prompt-attach-item-details">
                    <span className="prompt-attach-item-title">Upload File</span>
                    <span className="prompt-attach-item-desc">PDF, Code, Text, Documents</span>
                  </div>
                </button>
              </div>
            )}
          </div>

          {/* Model Picker */}
          <PromptModelPicker onOpenSettings={onOpenSettings} />
        </div>

        <button
          className="prompt-submit lg-press"
          type="submit"
          disabled={!canSubmit}
          aria-label="Send"
          title="Send message"
        >
          <SendIcon />
        </button>
      </div>
      <MicrophoneStatus state={voice.state} error={voice.error} />
    </form>
  )
}
