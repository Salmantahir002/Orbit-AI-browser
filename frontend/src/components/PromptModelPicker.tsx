import { useEffect, useState, useRef, useMemo } from 'react'
import type { ActiveProviderInfo, ClientProviderConfig, ModelInfo } from '../types/providerTypes'
import {
  fetchProviderModels,
  getAllStoredProviders,
  setActiveStoredProvider,
} from '../services/providerApiClient'
import { ProviderLogo } from './ProviderIcons'

interface PromptModelPickerProps {
  onOpenSettings?: () => void
  className?: string
}

// Preset model list for OpenCode Zen when selected
const OPENCODE_ZEN_MODELS: ModelInfo[] = [
  { id: 'nemotron-3-ultra-free', name: 'Nemotron 3 Ultra Free' },
  { id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash Free' },
  { id: 'mimo-v2.5-free', name: 'MiMo V2.5 Free' },
  { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning Free' },
  { id: 'hy3-free', name: 'Hy3 Free' },
  { id: 'laguna-s-2.1-free', name: 'Laguna S 2.1 Free' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
  { id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet' },
  { id: 'gpt-5.6-sol', name: 'GPT 5.6 Sol' },
]

function formatModelName(modelId: string, modelName?: string): { title: string; isFree: boolean } {
  const raw = modelName && modelName.trim() ? modelName : modelId
  const isFree = raw.toLowerCase().includes('free') || modelId.toLowerCase().includes('free')

  let title = raw
  if (modelId === 'openrouter/auto' || title === 'openrouter/auto' || modelId === 'auto') {
    return { title: 'Auto (Best for prompt)', isFree: false }
  }
  if (modelId === 'z-ai/glm-5.3-free' || title === 'z-ai/glm-5.3-free') {
    return { title: 'GLM 5.3 Free', isFree: true }
  }
  if (title === 'mimo-v2.5-free') title = 'MiMo V2.5 Free'
  else if (title === 'deepseek-v4-flash-free') title = 'DeepSeek V4 Flash Free'
  else if (title === 'hy3-free') title = 'Hy3 Free'
  else if (title === 'laguna-s-2.1-free') title = 'Laguna S 2.1 Free'
  else if (title === 'nemotron-3.5-lightning-free') title = 'Nemotron 3.5 Lightning Free'
  else if (title === 'nemotron-3-ultra-free') title = 'Nemotron 3 Ultra Free'
  else if (title === 'gemini-2.5-flash') title = 'Gemini 2.5 Flash'
  else if (title === 'gemini-2.5-flash-lite') title = 'Gemini 2.5 Flash Lite'
  else if (title === 'gemini-2.5-pro') title = 'Gemini 2.5 Pro'
  else if (title === 'gemini-2.0-flash') title = 'Gemini 2.0 Flash'
  else if (title === 'gemini-1.5-flash') title = 'Gemini 1.5 Flash'
  else if (title === 'gemini-1.5-pro') title = 'Gemini 1.5 Pro'
  else if (title.startsWith('@cf/')) {
    if (modelName && modelName !== modelId) {
      title = modelName
    } else {
      const parts = title.replace('@cf/', '').split('/')
      title = parts[parts.length - 1]
        .replace(/-/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase())
    }
  }

  return { title, isFree }
}

/** `stored` is null when the stored providers could not be read; `active` then falls back to none. */
type ProviderState = { stored: ClientProviderConfig[] | null; active: ActiveProviderInfo | null }

async function loadProviderState(): Promise<ProviderState> {
  try {
    const stored = await getAllStoredProviders().catch(() => [])
    const activeStored = stored.find((p) => p.is_active)
    return {
      stored,
      active: activeStored
        ? {
          id: activeStored.id,
          name: activeStored.name,
          provider_type: activeStored.provider_type,
          base_url: activeStored.base_url,
          is_active: true,
          is_fallback: false,
          selected_model: activeStored.selected_model,
          models: activeStored.models,
          masked_key: activeStored.masked_key || '',
        }
        : null,
    }
  } catch {
    return { stored: null, active: null }
  }
}

export function PromptModelPicker({ onOpenSettings, className = '' }: PromptModelPickerProps) {
  const [activeInfo, setActiveInfo] = useState<ActiveProviderInfo | null>(null)
  const [savedProviders, setSavedProviders] = useState<ClientProviderConfig[]>([])
  const [isOpen, setIsOpen] = useState(false)
  const [isLoadingModels, setIsLoadingModels] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const pickerRef = useRef<HTMLDivElement>(null)

  const applyProviderState = ({ stored, active }: ProviderState) => {
    if (stored) setSavedProviders(stored)
    setActiveInfo(active)
  }

  const refreshActiveInfo = async () => applyProviderState(await loadProviderState())

  // Loads now and whenever the providers change; state is set from the load's
  // callback, never synchronously in the effect.
  useEffect(() => {
    let subscribed = true
    const handleUpdated = () => {
      void loadProviderState().then((state) => {
        if (subscribed) applyProviderState(state)
      })
    }
    handleUpdated()
    window.addEventListener('promptguard:providers-updated', handleUpdated)
    return () => {
      subscribed = false
      window.removeEventListener('promptguard:providers-updated', handleUpdated)
    }
  }, [])

  // Close dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  // Get current active provider
  const currentProvider = savedProviders.find((p) => p.id === activeInfo?.id)

  // Compute model list to display
  const modelList: ModelInfo[] = useMemo(() => {
    if (!activeInfo || !activeInfo.is_active) {
      return []
    }
    const id = (activeInfo.id || currentProvider?.id || '').toLowerCase()
    let rawList: ModelInfo[] = []

    if (currentProvider?.models && currentProvider.models.length > 0) {
      rawList = currentProvider.models
    } else if (activeInfo.models && activeInfo.models.length > 0) {
      rawList = activeInfo.models
    } else if (id.includes('openrouter')) {
      rawList = [
        { id: 'openrouter/auto', name: 'Auto (Best for prompt / routes automatically)' },
        { id: 'anthropic/claude-3.7-sonnet', name: 'Claude 3.7 Sonnet' },
        { id: 'openai/gpt-4o', name: 'GPT-4o' },
        { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1' },
        { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
      ]
    } else if (id.includes('tokenrouter')) {
      rawList = [
        { id: 'z-ai/glm-5.3-free', name: 'GLM 5.3 Free (z-ai)' },
        { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
        { id: 'deepseek/deepseek-v3.2', name: 'DeepSeek V3.2' },
        { id: 'google/gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
        { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5' },
      ]
    } else if (id.includes('nara')) {
      rawList = [
        { id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet' },
        { id: 'gpt-4o', name: 'GPT-4o' },
        { id: 'deepseek-r1', name: 'DeepSeek R1' },
        { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
      ]
    } else if (id.includes('openadapter') || id.includes('adapter')) {
      rawList = [
        { id: 'gpt-4o', name: 'GPT-4o' },
        { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet' },
        { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro' },
      ]
    } else if (id.includes('gemini') || id.includes('google')) {
      rawList = [
        { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
        { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite' },
        { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
        { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
        { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro' },
        { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash' },
      ]
    } else if (id.includes('cloudflare') || id.includes('workers') || id.includes('cf')) {
      rawList = [
        { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', name: 'Llama 3.3 70B Instruct' },
        { id: '@cf/meta/llama-3.1-8b-instruct', name: 'Llama 3.1 8B Instruct' },
        { id: '@cf/meta/llama-3.1-70b-instruct', name: 'Llama 3.1 70B Instruct' },
        { id: '@cf/meta/llama-3.2-3b-instruct', name: 'Llama 3.2 3B Instruct' },
        { id: '@cf/meta/llama-3.2-1b-instruct', name: 'Llama 3.2 1B Instruct' },
        { id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', name: 'DeepSeek R1 Distill Qwen 32B' },
        { id: '@cf/qwen/qwen2.5-72b-instruct', name: 'Qwen 2.5 72B Instruct' },
        { id: '@cf/qwen/qwen2.5-coder-32b-instruct', name: 'Qwen 2.5 Coder 32B Instruct' },
        { id: '@cf/mistral/mistral-7b-instruct-v0.1', name: 'Mistral 7B Instruct' },
        { id: '@cf/google/gemma-2-27b-it', name: 'Gemma 2 27B IT' },
      ]
    } else if (id.includes('anthropic') || id.includes('claude')) {
      rawList = [
        { id: 'claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet' },
        { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
        { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' },
        { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus' },
      ]
    } else if (id.includes('openai') || id.includes('gpt')) {
      rawList = [
        { id: 'gpt-4o', name: 'GPT-4o' },
        { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
        { id: 'gpt-4.5-preview', name: 'GPT-4.5 Preview' },
        { id: 'o3-mini', name: 'o3-mini' },
        { id: 'o1', name: 'o1' },
      ]
    } else if (id === 'opencode' || id === 'opencode_zen') {
      rawList = OPENCODE_ZEN_MODELS
    } else if (activeInfo.selected_model) {
      rawList = [{ id: activeInfo.selected_model, name: activeInfo.selected_model }]
    }

    if (id.includes('openrouter')) {
      const filtered = rawList.filter((m) => m.id !== 'openrouter/auto' && m.id !== 'auto')
      return [
        { id: 'openrouter/auto', name: 'Auto (Best for prompt / routes automatically)' },
        ...filtered,
      ]
    }

    if (id.includes('tokenrouter')) {
      const glmFree = rawList.find((m) => m.id === 'z-ai/glm-5.3-free')
      if (glmFree) {
        const filtered = rawList.filter((m) => m.id !== 'z-ai/glm-5.3-free')
        return [
          { id: 'z-ai/glm-5.3-free', name: glmFree.name || 'GLM 5.3 Free (z-ai)' },
          ...filtered,
        ]
      }
    }

    return rawList
  }, [currentProvider, activeInfo])

  const handleToggle = async () => {
    if (!activeInfo && savedProviders.length === 0) {
      // If no providers are saved, clicking directly opens settings
      if (onOpenSettings) {
        onOpenSettings()
        return
      }
    }

    const nextState = !isOpen
    setIsOpen(nextState)
    setSearchTerm('')

    // If opening and provider has credentials but no models yet, live-fetch
    if (nextState && currentProvider && (!currentProvider.models || currentProvider.models.length === 0) && currentProvider.has_key) {
      setIsLoadingModels(true)
      try {
        const fetched = await fetchProviderModels(currentProvider)
        if (fetched && fetched.length > 0) {
          const models: ModelInfo[] = currentProvider.id.includes('openrouter')
            ? [
              { id: 'openrouter/auto', name: 'Auto (Best for prompt / routes automatically)' },
              ...fetched.filter((m) => m.id !== 'openrouter/auto' && m.id !== 'auto'),
            ]
            : fetched
          const providerId = currentProvider.id
          setSavedProviders((providers) => providers.map((p) => (p.id === providerId ? { ...p, models } : p)))
        }
      } catch {
        // Silently handle
      } finally {
        setIsLoadingModels(false)
      }
    }
  }

  const handleSelectModel = async (modelId: string) => {
    if (!activeInfo) return
    setActiveInfo((prev) => (prev ? { ...prev, selected_model: modelId } : null))
    setIsOpen(false)

    await setActiveStoredProvider(activeInfo.id, modelId)
    window.dispatchEvent(new CustomEvent('promptguard:providers-updated'))
  }

  const handleSelectProvider = async (providerId: string, defaultModel?: string) => {
    await setActiveStoredProvider(providerId, defaultModel)
    setIsOpen(false)
    await refreshActiveInfo()
    window.dispatchEvent(new CustomEvent('promptguard:providers-updated'))
  }

  // Determine display text for active provider & model
  const hasActiveProvider = Boolean(activeInfo && activeInfo.is_active)
  const providerId = activeInfo?.id || ''
  const providerName = activeInfo?.name || 'AI Provider'
  const currentModelId = activeInfo?.selected_model || (modelList.length > 0 ? modelList[0].id : '')
  const currentModelObj = modelList.find((m) => m.id === currentModelId)
  const formattedCurrent = currentModelId ? formatModelName(currentModelId, currentModelObj?.name) : null

  const filteredModels = searchTerm.trim()
    ? modelList.filter(
        (m) =>
          m.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          m.id.toLowerCase().includes(searchTerm.toLowerCase()),
      )
    : modelList

  return (
    <div className={`prompt-model-picker-wrapper ${className}`} ref={pickerRef}>
      {/* Trigger Button */}
      <button
        type="button"
        className={`prompt-model-btn ${!hasActiveProvider ? 'prompt-model-btn--unconfigured' : ''}`}
        onClick={handleToggle}
        title={
          hasActiveProvider
            ? `Active Model: ${providerName} - ${formattedCurrent?.title || currentModelId}`
            : 'Click to select or connect an AI Provider'
        }
        aria-expanded={isOpen}
      >
        {hasActiveProvider ? (
          <>
            <span className="prompt-model-btn-logo">
              <ProviderLogo id={providerId} size={16} />
            </span>
            <span className="prompt-model-btn-name">
              {formattedCurrent?.title || currentModelId}
            </span>
          </>
        ) : (
          <>
            <span className="prompt-model-btn-logo">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="16" />
                <line x1="8" y1="12" x2="16" y2="12" />
              </svg>
            </span>
            <span className="prompt-model-btn-name">
              {savedProviders.length > 0 ? 'Select Model' : 'Connect Provider'}
            </span>
          </>
        )}

        <svg
          className={`prompt-model-btn-chevron ${isOpen ? 'open' : ''}`}
          viewBox="0 0 24 24"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {/* Popover Dropdown */}
      {isOpen && (
        <div className="prompt-model-menu" role="menu">
          {hasActiveProvider ? (
            <>
              {/* Header with Provider Name */}
              <div className="prompt-model-menu-header">
                <div className="prompt-model-provider-title">
                  <span className="prompt-model-header-logo"><ProviderLogo id={providerId} size={15} /></span>
                  <span className="prompt-model-header-text">{providerName}</span>
                </div>
              </div>

              {/* Quick Search if model count is high */}
              {modelList.length > 7 ? (
                <div className="prompt-model-search-box">
                  <input
                    type="text"
                    className="prompt-model-search-input"
                    placeholder="Search models..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    autoFocus
                  />
                </div>
              ) : null}

              {/* Models List for the Active Provider */}
              <div className="prompt-model-list">
                {isLoadingModels ? (
                  <div className="prompt-model-loading">
                    <span className="dot-pulse"><span /><span /><span /></span>
                    <span>Fetching live models...</span>
                  </div>
                ) : null}

                {filteredModels.map((model) => {
                  const isSelected = currentModelId === model.id
                  const { title, isFree } = formatModelName(model.id, model.name)
                  return (
                    <button
                      key={model.id}
                      type="button"
                      className={`prompt-model-item ${isSelected ? 'prompt-model-item--active' : ''}`}
                      onClick={() => handleSelectModel(model.id)}
                      role="menuitem"
                    >
                      <div className="prompt-model-item-left">
                        <span className="prompt-model-item-title">{title}</span>
                        {isFree ? (
                          <span className="prompt-model-free-badge">Free</span>
                        ) : null}
                      </div>
                      {isSelected && (
                        <span className="prompt-model-checkmark">
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        </span>
                      )}
                    </button>
                  )
                })}

                {filteredModels.length === 0 && !isLoadingModels ? (
                  <div className="prompt-model-empty">No models available</div>
                ) : null}
              </div>

              {/* Other connected providers list (hidden while actively searching models) */}
              {savedProviders.filter((p) => p.id !== activeInfo?.id).length > 0 && !searchTerm.trim() && (
                <div className="prompt-model-providers-section">
                  <div className="prompt-model-section-label">Other Connected Providers</div>
                  {savedProviders
                    .filter((p) => p.id !== activeInfo?.id)
                    .map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className="prompt-model-provider-switch-item"
                        onClick={() => handleSelectProvider(p.id, p.selected_model)}
                      >
                        <span className="prompt-model-switch-logo"><ProviderLogo id={p.id} size={14} /></span>
                        <span className="prompt-model-switch-name">{p.name}</span>
                        <span className="prompt-model-switch-count">
                          {p.models?.length ? `${p.models.length} models` : 'Ready'}
                        </span>
                      </button>
                    ))}
                </div>
              )}
            </>
          ) : (
            /* No Active Provider State */
            <div className="prompt-model-list">
              <div className="prompt-model-menu-header">
                <div className="prompt-model-provider-title">
                  <span className="prompt-model-header-text">Select AI Provider</span>
                </div>
              </div>

              {savedProviders.length > 0 ? (
                savedProviders.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="prompt-model-provider-switch-item"
                    onClick={() => handleSelectProvider(p.id, p.selected_model)}
                  >
                    <span className="prompt-model-switch-logo"><ProviderLogo id={p.id} size={16} /></span>
                    <span className="prompt-model-switch-name">{p.name}</span>
                    <span className="prompt-model-switch-count">
                      {p.selected_model || (p.models?.length ? `${p.models.length} models` : 'Activate')}
                    </span>
                  </button>
                ))
              ) : (
                <div className="prompt-model-empty" style={{ padding: '16px 12px', textAlign: 'center' }}>
                  <div style={{ marginBottom: '6px', fontWeight: 500, color: 'var(--text-primary, #f0f0f0)' }}>
                    No Providers Connected
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted, #888)' }}>
                    Connect Google Gemini, Anthropic, OpenAI, OpenCode Zen, or Custom in Settings to start.
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Footer with Manage Providers */}
          {onOpenSettings && (
            <div className="prompt-model-footer">
              <button
                type="button"
                className="prompt-model-manage-btn"
                onClick={() => {
                  setIsOpen(false)
                  onOpenSettings()
                }}
              >
                <span>{savedProviders.length > 0 ? 'Manage Providers & Keys' : '+ Connect New Provider'}</span>
                <span className="prompt-model-manage-arrow">→</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
