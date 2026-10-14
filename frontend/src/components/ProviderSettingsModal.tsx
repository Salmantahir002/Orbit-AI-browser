import { useState, useEffect, type FormEvent } from 'react'
import type {
  ClientProviderConfig,
  ModelInfo,
  ProviderApiType,
  TestConnectionResult,
} from '../types/providerTypes'
import {
  deleteStoredProvider,
  fetchProviderModels,
  getAllStoredProviders,
  saveStoredProvider,
  setActiveStoredProvider,
  testProviderConnection,
} from '../services/providerApiClient'
import { LiquidGlass } from './LiquidGlass'
import { ProviderLogo } from './ProviderIcons'

/**
 * Liquid Glass, as in the assistant panel and the report drawers: the dialog
 * is a pane of frosted glass over the page (the shell freezes a frame of the
 * page in place of the hidden guest view while it is open), and its controls
 * and cards are LiquidGlass surfaces floating on the pane. Buttons and cards
 * inside the scrolling body are frosted (refraction 0): their backdrop is the
 * blurred pane, which refraction would barely bend, and every refracting
 * surface re-runs its filter on each scrolled frame.
 */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function PillGlass() {
  return <LiquidGlass refraction={0} blur={5} elasticity={0.16} />
}

function CardGlass() {
  return <LiquidGlass refraction={0} blur={8} elasticity={0.05} />
}

interface ProviderSettingsModalProps {
  isOpen: boolean
  onClose: () => void
  onProviderChanged?: () => void
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

function RefreshIcon({ spinning = false }: { spinning?: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={spinning ? 'oc-spin' : ''}
      aria-hidden="true"
    >
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  )
}

function ArrowLeftIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  )
}

interface ProviderCatalogItem {
  id: string
  name: string
  recommended?: boolean
  description: string
  defaultBaseUrl?: string
  providerType: ProviderApiType
  isCustom?: boolean
}

const SUPPORTED_CATALOG: ProviderCatalogItem[] = [
  {
    id: 'opencode',
    name: 'OpenCode Zen',
    recommended: true,
    description: 'Curated models including Claude, GPT, Gemini and more',
    defaultBaseUrl: 'https://opencode.ai/zen/v1',
    providerType: 'openai_compatible',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    recommended: true,
    description: 'Gemini models via Google AI Studio',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    providerType: 'gemini',
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    description: 'Direct access to Claude models, including Sonnet and Opus',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    providerType: 'anthropic',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'GPT models for fast, capable general AI tasks',
    defaultBaseUrl: 'https://api.openai.com/v1',
    providerType: 'openai_compatible',
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    description: 'High throughput accelerated NIM microservices',
    defaultBaseUrl: 'https://integrate.api.nvidia.com/v1',
    providerType: 'openai_compatible',
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare Workers AI',
    description: 'Serverless GPU models (Llama 3.3, DeepSeek, Qwen) on Cloudflare',
    defaultBaseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1',
    providerType: 'openai_compatible',
  },
  {
    id: 'agentrouter',
    name: 'AgentRouter',
    description: 'Unified routing proxy for multi-provider routing',
    defaultBaseUrl: 'https://agentrouter.org/v1',
    providerType: 'openai_compatible',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    recommended: true,
    description: 'Unified gateway for hundreds of AI models with smart auto-routing',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    providerType: 'openai_compatible',
  },
  {
    id: 'tokenrouter',
    name: 'TokenRouter',
    description: 'Unified multi-model routing gateway with dynamic global paths',
    defaultBaseUrl: 'https://api.tokenrouter.com/v1',
    providerType: 'openai_compatible',
  },
  {
    id: 'nararouter',
    name: 'NaraRouter',
    description: 'Unified OpenAI-compatible gateway for coding agents and models',
    defaultBaseUrl: 'https://router.bynara.id/v1',
    providerType: 'openai_compatible',
  },
  {
    id: 'openadapter',
    name: 'OpenAdapter',
    description: 'Multi-provider AI gateway with drop-in OpenAI-compatible endpoint',
    defaultBaseUrl: 'https://api.openadapter.in/v1',
    providerType: 'openai_compatible',
  },
  {
    id: 'custom',
    name: 'Custom Provider',
    description: 'OpenAI-compatible gateway, vLLM, Ollama, Groq, or custom proxy',
    defaultBaseUrl: 'http://localhost:11434/v1',
    providerType: 'openai_compatible',
    isCustom: true,
  },
]

export function ProviderSettingsModal({ isOpen, onClose, onProviderChanged }: ProviderSettingsModalProps) {
  // Navigation / View State
  const [connectingPreset, setConnectingPreset] = useState<ProviderCatalogItem | null>(null)

  // Stored providers
  const [savedProviders, setSavedProviders] = useState<ClientProviderConfig[]>([])

  // Form State
  const [connectId, setConnectId] = useState('')
  const [connectName, setConnectName] = useState('')
  const [connectBaseUrl, setConnectBaseUrl] = useState('')
  const [cloudflareAccountId, setCloudflareAccountId] = useState('')
  const [connectProtocol, setConnectProtocol] = useState<ProviderApiType>('openai_compatible')
  const [connectApiKey, setConnectApiKey] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [connectVerifySsl, setConnectVerifySsl] = useState(true)
  const [connectModel, setConnectModel] = useState('')
  const [fetchedModels, setFetchedModels] = useState<ModelInfo[]>([])

  // Telemetry & Test State
  const [isFetchingModels, setIsFetchingModels] = useState(false)
  const [isTesting, setIsTesting] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null)
  const [formError, setFormError] = useState('')

  // Filter popular catalog to only show providers that are NOT already connected
  const availablePopularPresets = SUPPORTED_CATALOG.filter((preset) => {
    if (preset.isCustom) return true
    return !savedProviders.some((p) => p.id === preset.id)
  })

  // Load Saved Providers
  const refreshData = async () => {
    try {
      const stored = await getAllStoredProviders()
      setSavedProviders(stored)
      return stored
    } catch {
      return []
    }
  }

  // Each opening starts on the providers list with a clean form. The dialog
  // stays mounted while closed, so this is adjusted during render when isOpen
  // changes (React's pattern for state derived from changing props).
  const [wasOpen, setWasOpen] = useState(isOpen)
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen)
    if (isOpen) {
      setConnectingPreset(null)
      setFormError('')
      setTestResult(null)
    }
  }

  // Reload the saved providers on each opening; set from the load's callback.
  useEffect(() => {
    if (!isOpen) return undefined
    let subscribed = true
    getAllStoredProviders().then(
      (stored) => { if (subscribed) setSavedProviders(stored) },
      () => undefined,
    )
    return () => { subscribed = false }
  }, [isOpen])

  // Open Connect Form
  const handleOpenConnect = (preset: ProviderCatalogItem) => {
    const existing = savedProviders.find((p) => p.id === preset.id)
    setConnectingPreset(preset)
    setConnectId(preset.id)
    setConnectName(existing ? existing.name : preset.name)
    if (preset.id === 'cloudflare') {
      const match = (existing?.base_url || '').match(/accounts\/([^/]+)\/ai/)
      const accId = match ? match[1] : ''
      setCloudflareAccountId(accId)
      setConnectBaseUrl(existing?.base_url || (accId ? `https://api.cloudflare.com/client/v4/accounts/${accId}/ai/v1` : 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1'))
    } else {
      setCloudflareAccountId('')
      setConnectBaseUrl(existing ? (existing.base_url || '') : (preset.defaultBaseUrl || ''))
    }
    setConnectProtocol(existing ? existing.provider_type : preset.providerType)
    setConnectApiKey('')
    setConnectVerifySsl(existing?.verify_ssl ?? true)
    const isOpenRouter = preset.id === 'openrouter'
    const isTokenRouter = preset.id === 'tokenrouter'
    setConnectModel(
      existing?.selected_model ||
        (isOpenRouter ? 'openrouter/auto' : isTokenRouter ? 'z-ai/glm-5.3-free' : '')
    )
    setFetchedModels(
      existing?.models && existing.models.length > 0
        ? existing.models
        : isOpenRouter
          ? [{ id: 'openrouter/auto', name: 'Auto (Best for prompt / routes automatically)' }]
          : isTokenRouter
            ? [{ id: 'z-ai/glm-5.3-free', name: 'GLM 5.3 Free (z-ai)' }]
            : existing?.selected_model
              ? [{ id: existing.selected_model, name: existing.selected_model }]
              : []
    )
    setTestResult(null)
    setFormError('')
  }

  // Disconnect Provider
  const handleDisconnect = async (id: string) => {
    if (confirm(`Disconnect and remove configuration for "${id}"?`)) {
      await deleteStoredProvider(id)
      await refreshData()
      onProviderChanged?.()
      window.dispatchEvent(new CustomEvent('promptguard:providers-updated'))
    }
  }

  // Set Active Provider
  const handleSetActive = async (id: string, model?: string) => {
    await setActiveStoredProvider(id, model)
    await refreshData()
    onProviderChanged?.()
    window.dispatchEvent(new CustomEvent('promptguard:providers-updated'))
  }

  // Live Fetch Models
  const handleFetchModels = async () => {
    const existing = savedProviders.find((p) => p.id === connectId)
    if (!connectApiKey.trim() && !existing?.has_key) {
      setFormError('Please enter an API key or token to fetch models')
      return
    }

    if (connectId === 'cloudflare' && (connectBaseUrl.includes('{account_id}') || !cloudflareAccountId.trim())) {
      setFormError('Please enter your Cloudflare Account ID from dash.cloudflare.com')
      return
    }

    setIsFetchingModels(true)
    setFormError('')
    setTestResult(null)

    const candidate: ClientProviderConfig = {
      id: connectId.trim(),
      name: connectName.trim() || connectId.trim(),
      provider_type: connectProtocol,
      base_url: connectBaseUrl.trim() || undefined,
      api_key: connectApiKey.trim() || undefined,
      verify_ssl: connectVerifySsl,
    }

    try {
      let models = await fetchProviderModels(candidate)
      if (connectId === 'openrouter') {
        const filtered = models.filter((m) => m.id !== 'openrouter/auto' && m.id !== 'auto')
        models = [
          { id: 'openrouter/auto', name: 'Auto (Best for prompt / routes automatically)' },
          ...filtered,
        ]
      } else if (connectId === 'tokenrouter') {
        const glmFree = models.find((m) => m.id === 'z-ai/glm-5.3-free')
        if (glmFree) {
          const filtered = models.filter((m) => m.id !== 'z-ai/glm-5.3-free')
          models = [
            { id: 'z-ai/glm-5.3-free', name: glmFree.name || 'GLM 5.3 Free (z-ai)' },
            ...filtered,
          ]
        }
      }
      if (!models || models.length === 0) {
        throw new Error('No models found at this endpoint.')
      }
      setFetchedModels(models)
      if (!connectModel || !models.some((m) => m.id === connectModel)) {
        setConnectModel(
          connectId === 'openrouter'
            ? 'openrouter/auto'
            : connectId === 'tokenrouter' && models.some((m) => m.id === 'z-ai/glm-5.3-free')
              ? 'z-ai/glm-5.3-free'
              : models[0].id,
        )
      }
      setTestResult({
        success: true,
        latency_ms: 0,
        models_count: models.length,
        message: `Successfully fetched ${models.length} model${models.length === 1 ? '' : 's'}. Ready to connect.`,
        models,
      })
    } catch (err) {
      setFormError(errorMessage(err) || 'Failed to fetch models')
      setFetchedModels([])
    } finally {
      setIsFetchingModels(false)
    }
  }

  // Test Connection
  const handleTestConnection = async () => {
    const existing = savedProviders.find((p) => p.id === connectId)
    if (!connectApiKey.trim() && !existing?.has_key) {
      setFormError('Please enter an API key to test connection')
      return
    }

    if (connectId === 'cloudflare' && (connectBaseUrl.includes('{account_id}') || !cloudflareAccountId.trim())) {
      setFormError('Please enter your Cloudflare Account ID from dash.cloudflare.com')
      return
    }

    setIsTesting(true)
    setFormError('')
    setTestResult(null)

    const candidate: ClientProviderConfig = {
      id: connectId.trim(),
      name: connectName.trim() || connectId.trim(),
      provider_type: connectProtocol,
      base_url: connectBaseUrl.trim() || undefined,
      api_key: connectApiKey.trim() || undefined,
      verify_ssl: connectVerifySsl,
      selected_model: connectModel || undefined,
    }

    try {
      const res = await testProviderConnection(candidate)
      setTestResult(res)
      if (res.success && res.models && res.models.length > 0) {
        let models = res.models
        if (connectId === 'openrouter') {
          const filtered = models.filter((m) => m.id !== 'openrouter/auto' && m.id !== 'auto')
          models = [
            { id: 'openrouter/auto', name: 'Auto (Best for prompt / routes automatically)' },
            ...filtered,
          ]
        } else if (connectId === 'tokenrouter') {
          const glmFree = models.find((m) => m.id === 'z-ai/glm-5.3-free')
          if (glmFree) {
            const filtered = models.filter((m) => m.id !== 'z-ai/glm-5.3-free')
            models = [
              { id: 'z-ai/glm-5.3-free', name: glmFree.name || 'GLM 5.3 Free (z-ai)' },
              ...filtered,
            ]
          }
        }
        setFetchedModels(models)
        if (!connectModel) {
          setConnectModel(
            connectId === 'openrouter'
              ? 'openrouter/auto'
              : connectId === 'tokenrouter' && models.some((m) => m.id === 'z-ai/glm-5.3-free')
                ? 'z-ai/glm-5.3-free'
                : models[0].id,
          )
        }
      }
    } catch (err) {
      setTestResult({
        success: false,
        latency_ms: 0,
        models_count: 0,
        message: errorMessage(err) || 'Connection test failed',
        models: [],
      })
    } finally {
      setIsTesting(false)
    }
  }

  // Save & Connect Provider
  const handleSaveConnect = async (e: FormEvent) => {
    e.preventDefault()
    const existing = savedProviders.find((p) => p.id === connectId)
    if (!connectApiKey.trim() && !existing?.has_key) {
      setFormError('API Key is required to connect.')
      return
    }

    if (connectId === 'cloudflare' && (connectBaseUrl.includes('{account_id}') || !cloudflareAccountId.trim())) {
      setFormError('Please enter your Cloudflare Account ID from dash.cloudflare.com')
      return
    }

    setIsSaving(true)
    try {
      let modelsToSave = fetchedModels
      if (modelsToSave.length === 0 && (connectApiKey.trim() || existing?.has_key)) {
        try {
          const candidate: ClientProviderConfig = {
            id: connectId.trim(),
            name: connectName.trim() || connectId.trim(),
            provider_type: connectProtocol,
            base_url: connectBaseUrl.trim() || undefined,
            api_key: connectApiKey.trim() || undefined,
            verify_ssl: connectVerifySsl,
          }
          const fetched = await fetchProviderModels(candidate)
          if (fetched && fetched.length > 0) {
            modelsToSave = fetched
          }
        } catch {
          // If quick fetch fails, proceed with existing
        }
      }

      if (connectId === 'openrouter') {
        const filtered = modelsToSave.filter((m) => m.id !== 'openrouter/auto' && m.id !== 'auto')
        modelsToSave = [
          { id: 'openrouter/auto', name: 'Auto (Best for prompt / routes automatically)' },
          ...filtered,
        ]
      } else if (connectId === 'tokenrouter') {
        const glmFree = modelsToSave.find((m) => m.id === 'z-ai/glm-5.3-free')
        if (glmFree) {
          const filtered = modelsToSave.filter((m) => m.id !== 'z-ai/glm-5.3-free')
          modelsToSave = [
            { id: 'z-ai/glm-5.3-free', name: glmFree.name || 'GLM 5.3 Free (z-ai)' },
            ...filtered,
          ]
        }
      }

      const chosenModel =
        connectModel.trim() ||
        (connectId === 'openrouter'
          ? 'openrouter/auto'
          : connectId === 'tokenrouter' && modelsToSave.some((m) => m.id === 'z-ai/glm-5.3-free')
            ? 'z-ai/glm-5.3-free'
            : modelsToSave.length > 0
              ? modelsToSave[0].id
              : existing?.selected_model || 'default')
      const configToSave: ClientProviderConfig & { set_active?: boolean } = {
        id: connectId.trim(),
        name: connectName.trim() || connectId.trim(),
        provider_type: connectProtocol,
        base_url: connectBaseUrl.trim() || undefined,
        api_key: connectApiKey.trim() || undefined,
        verify_ssl: connectVerifySsl,
        selected_model: chosenModel,
        models: modelsToSave.length > 0 ? modelsToSave : (existing?.models || []),
        set_active: true,
      }

      await saveStoredProvider(configToSave)
      await refreshData()
      setConnectingPreset(null)
      onProviderChanged?.()
      window.dispatchEvent(new CustomEvent('promptguard:providers-updated'))
      onClose()
    } catch (err) {
      setFormError(`Connection failed: ${errorMessage(err) || err}`)
    } finally {
      setIsSaving(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="oc-modal">
      {/* A sibling of the dialog, not its parent: its blur would otherwise
          stand between the dialog's glass and the page. */}
      <div className="oc-modal-overlay" onClick={onClose} aria-hidden="true" />
      <div
        className="oc-modal-container"
        role="dialog"
        aria-modal="true"
        aria-labelledby="oc-dialog-title"
      >
        <div className="oc-modal__glass" aria-hidden="true" />
        {/* Top Header Bar */}
        <div className="oc-header-bar">
          {connectingPreset ? (
            <button
              type="button"
              className="oc-btn-back lg-host"
              onClick={() => setConnectingPreset(null)}
              aria-label="Back to providers"
            >
              <LiquidGlass refraction={44} bezel={12} blur={5} aberration={0} elasticity={0.16} />
              <ArrowLeftIcon />
              <span>Back to Providers</span>
            </button>
          ) : (
            <h1 id="oc-dialog-title" className="oc-page-title">
              Providers
            </h1>
          )}

          <div className="oc-header-actions lg-host">
            <LiquidGlass refraction={56} bezel={14} blur={6} elasticity={0.22} />
            <button
              type="button"
              className="oc-close-btn lg-press"
              onClick={onClose}
              aria-label="Close dialog"
              title="Close"
            >
              <CloseIcon />
            </button>
          </div>
        </div>

        {/* Scrollable Content Body */}
        <div className="oc-body-content">
          {connectingPreset ? (
            /* CONFIGURE / CONNECT FORM VIEW */
            <div className="oc-connect-view">
              <div className="oc-connect-header">
                <span className="oc-provider-logo"><ProviderLogo id={connectingPreset.id} size={28} /></span>
                <div>
                  <h2 className="oc-connect-title">{connectingPreset.name}</h2>
                  <p className="oc-connect-desc">{connectingPreset.description}</p>
                </div>
              </div>

              <form className="oc-form" onSubmit={handleSaveConnect}>
                {connectingPreset.isCustom ? (
                  <div className="oc-custom-fields lg-host">
                    <CardGlass />
                    <div className="oc-form-row">
                      <div className="oc-form-group">
                        <label className="oc-label">Provider ID</label>
                        <input
                          type="text"
                          className="oc-input"
                          value={connectId}
                          onChange={(e) => setConnectId(e.target.value)}
                          placeholder="e.g. ollama-local"
                          required
                        />
                      </div>
                      <div className="oc-form-group">
                        <label className="oc-label">Display Name</label>
                        <input
                          type="text"
                          className="oc-input"
                          value={connectName}
                          onChange={(e) => setConnectName(e.target.value)}
                          placeholder="e.g. Local Ollama"
                          required
                        />
                      </div>
                    </div>

                    <div className="oc-form-row">
                      <div className="oc-form-group">
                        <label className="oc-label">Protocol</label>
                        <select
                          className="oc-select"
                          value={connectProtocol}
                          onChange={(e) => setConnectProtocol(e.target.value as ProviderApiType)}
                        >
                          <option value="openai_compatible">OpenAI Compatible (Bearer Auth)</option>
                          <option value="anthropic">Anthropic Messages API</option>
                          <option value="gemini">Google Gemini API</option>
                        </select>
                      </div>
                      <div className="oc-form-group">
                        <label className="oc-label">Endpoint URL</label>
                        <input
                          type="url"
                          className="oc-input oc-input--mono"
                          value={connectBaseUrl}
                          onChange={(e) => setConnectBaseUrl(e.target.value)}
                          placeholder="http://localhost:11434/v1"
                          required
                        />
                      </div>
                    </div>
                  </div>
                ) : null}

                {/* Cloudflare Account ID Input */}
                {connectingPreset.id === 'cloudflare' ? (
                  <div className="oc-form-group">
                    <div className="oc-label-row">
                      <label className="oc-label">Cloudflare Account ID</label>
                      <a
                        href="https://dash.cloudflare.com/"
                        target="_blank"
                        rel="noreferrer"
                        className="oc-link-btn"
                        title="Open Cloudflare Dashboard"
                      >
                        Find on dash.cloudflare.com ↗
                      </a>
                    </div>
                    <input
                      type="text"
                      className="oc-input oc-input--mono"
                      placeholder="e.g. 8f9e7d6c5b4a3210987654321fedcba0"
                      value={cloudflareAccountId}
                      onChange={(e) => {
                        const val = e.target.value.trim()
                        setCloudflareAccountId(e.target.value)
                        setConnectBaseUrl(
                          val
                            ? `https://api.cloudflare.com/client/v4/accounts/${val}/ai/v1`
                            : 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1',
                        )
                      }}
                      spellCheck={false}
                      autoFocus
                    />
                    <span className="oc-hint-text" style={{ fontSize: '11px', color: 'rgba(255, 255, 255, 0.45)', marginTop: '4px', display: 'block' }}>
                      Found in your browser URL on <a href="https://dash.cloudflare.com/" target="_blank" rel="noreferrer" style={{ color: '#38bdf8' }}>dash.cloudflare.com/</a> or in the Workers & AI section right sidebar.
                    </span>
                  </div>
                ) : null}

                {/* API Key / Token */}
                <div className="oc-form-group">
                  <div className="oc-label-row">
                    <label className="oc-label">{connectingPreset.id === 'cloudflare' ? 'API Token' : 'API Key'}</label>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      {connectingPreset.id === 'cloudflare' ? (
                        <a
                          href="https://dash.cloudflare.com/profile/api-tokens"
                          target="_blank"
                          rel="noreferrer"
                          className="oc-link-btn"
                          title="Generate a Workers AI API Token"
                        >
                          Create API Token ↗
                        </a>
                      ) : null}
                      <button
                        type="button"
                        className="oc-link-btn"
                        onClick={() => setShowApiKey(!showApiKey)}
                      >
                        {showApiKey ? 'Hide' : 'Show'}
                      </button>
                    </div>
                  </div>
                  <input
                    type={showApiKey ? 'text' : 'password'}
                    className="oc-input oc-input--mono"
                    placeholder={
                      connectingPreset.id === 'opencode'
                        ? 'Paste OpenCode Zen API Key (opencode_zen_...)'
                        : connectingPreset.id === 'gemini'
                        ? 'AIzaSy...'
                        : connectingPreset.id === 'anthropic'
                        ? 'sk-ant-api03-...'
                        : connectingPreset.id === 'nvidia'
                        ? 'nvapi-...'
                        : connectingPreset.id === 'cloudflare'
                        ? 'Paste Cloudflare Workers AI API Token'
                        : 'Paste API Key...'
                    }
                    value={connectApiKey}
                    onChange={(e) => setConnectApiKey(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>

                {/* SSL Checkbox */}
                <div className="oc-checkbox-group">
                  <label className="oc-checkbox-label">
                    <input
                      type="checkbox"
                      checked={connectVerifySsl}
                      onChange={(e) => setConnectVerifySsl(e.target.checked)}
                    />
                    <span>Verify SSL / TLS Certificate</span>
                  </label>
                </div>

                {/* Action Buttons: Fetch & Test */}
                <div className="oc-action-row">
                  <button
                    type="button"
                    className="oc-btn-secondary lg-host"
                    onClick={handleFetchModels}
                    disabled={isFetchingModels || isTesting}
                  >
                    <PillGlass />
                    <RefreshIcon spinning={isFetchingModels} />
                    <span>{isFetchingModels ? 'Fetching Models...' : 'Fetch Models'}</span>
                  </button>
                  <button
                    type="button"
                    className="oc-btn-secondary lg-host"
                    onClick={handleTestConnection}
                    disabled={isTesting || isFetchingModels}
                  >
                    <PillGlass />
                    <span>{isTesting ? 'Testing...' : 'Test Connection'}</span>
                  </button>
                </div>

                {/* Status Feedback */}
                {formError ? (
                  <div className="oc-alert oc-alert--error">{formError}</div>
                ) : null}

                {testResult ? (
                  <div className={`oc-alert ${testResult.success ? 'oc-alert--success' : 'oc-alert--error'}`}>
                    {testResult.success ? '✓ Connected successfully' : `✕ ${testResult.message}`}
                    {testResult.latency_ms > 0 ? ` (${testResult.latency_ms}ms latency)` : ''}
                  </div>
                ) : null}

                {/* Default Model Selection if models available */}
                {fetchedModels.length > 0 ? (
                  <div className="oc-form-group">
                    <div className="oc-label-row">
                      <label className="oc-label">Default Model</label>
                      {connectId === 'openrouter' ? (
                        <span className="oc-hint-text" style={{ fontSize: '11px', color: '#818cf8' }}>
                          ⚡ Auto-routing active
                        </span>
                      ) : null}
                    </div>
                    <select
                      className="oc-select"
                      value={connectModel}
                      onChange={(e) => setConnectModel(e.target.value)}
                    >
                      {fetchedModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name || m.id}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}

                {/* Model count badge indicator if fetched */}
                {fetchedModels.length > 0 ? (
                  <div className="oc-fetched-summary">
                    <span className="oc-badge oc-badge--active">✓ {fetchedModels.length} model{fetchedModels.length === 1 ? '' : 's'} available</span>
                    <span className="oc-hint-text">All models will be instantly selectable directly inside the prompt box.</span>
                  </div>
                ) : null}

                {/* Form Footer Actions */}
                <div className="oc-form-footer">
                  <button
                    type="button"
                    className="oc-btn-cancel lg-host"
                    onClick={() => setConnectingPreset(null)}
                  >
                    <PillGlass />
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="oc-btn-submit lg-host"
                    disabled={isSaving}
                  >
                    <PillGlass />
                    {isSaving ? 'Connecting...' : 'Save & Activate'}
                  </button>
                </div>
              </form>
            </div>
          ) : (
            /* MAIN PROVIDERS LIST VIEW (MATCHING SCREENSHOT 1 & 4) */
            <div className="oc-providers-view">
              {/* Connected Providers */}
              {savedProviders.length > 0 ? (
                <div className="oc-section">
                  <h2 className="oc-section-title">Connected providers</h2>
                  <div className="oc-card-group lg-host">
                    <CardGlass />
                    {savedProviders.map((provider) => {
                      const isActive = Boolean(provider.is_active)
                      const modelCount = provider.models?.length || 0
                      return (
                        <div key={provider.id} className="oc-provider-row">
                          <div className="oc-provider-info">
                            <span className="oc-provider-logo"><ProviderLogo id={provider.id} size={20} /></span>
                            <div className="oc-provider-details">
                              <div className="oc-provider-name-row">
                                <span className="oc-provider-name">{provider.name}</span>
                                <span className="oc-badge">API key</span>
                                {isActive ? (
                                  <span className="oc-badge oc-badge--active">Active</span>
                                ) : null}
                              </div>
                              <span className="oc-provider-desc">
                                {modelCount > 0
                                  ? `${modelCount} models ready (Active: ${provider.selected_model || 'auto'})`
                                  : provider.selected_model
                                  ? `Model: ${provider.selected_model}`
                                  : provider.base_url || 'Connected'}
                              </span>
                            </div>
                          </div>
                          <div className="oc-row-actions">
                            {!isActive ? (
                              <button
                                type="button"
                                className="oc-btn-connect lg-host"
                                onClick={() => handleSetActive(provider.id, provider.selected_model)}
                              >
                                <PillGlass />
                                Set Active
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className="oc-btn-disconnect lg-host"
                              onClick={() => handleDisconnect(provider.id)}
                            >
                              <PillGlass />
                              Disconnect
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ) : null}

              {/* Popular Providers (Only shows un-connected providers) */}
              {availablePopularPresets.length > 0 ? (
                <div className="oc-section">
                  <h2 className="oc-section-title">Popular providers</h2>
                  <div className="oc-card-group lg-host">
                    <CardGlass />
                    {availablePopularPresets.map((preset) => (
                      <div key={preset.id} className="oc-provider-row">
                        <div className="oc-provider-info">
                          <span className="oc-provider-logo"><ProviderLogo id={preset.id} size={20} /></span>
                          <div className="oc-provider-details">
                            <div className="oc-provider-name-row">
                              <span className="oc-provider-name">{preset.name}</span>
                              {preset.recommended ? (
                                <span className="oc-badge">Recommended</span>
                              ) : null}
                            </div>
                            <span className="oc-provider-desc">{preset.description}</span>
                          </div>
                        </div>
                        <div className="oc-row-actions">
                          <button
                            type="button"
                            className="oc-btn-connect lg-host"
                            onClick={() => handleOpenConnect(preset)}
                          >
                            <PillGlass />
                            <PlusIcon />
                            <span>Connect</span>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
