/** Provider metadata and encrypted credentials on disk; temporary keys stay in main-process memory. */
import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { TranscribeModel } from './aiAudioTypes.js'

export type ProviderType = 'openai_compatible' | 'anthropic' | 'gemini'
type ModelInfo = { id: string; name: string; description?: string }
export interface ProviderConnectionResult {
  success: boolean
  latency_ms: number
  models_count: number
  models: ModelInfo[]
  message: string
}
export interface StoredProviderConfig {
  transcribe_model?: string
  transcribe_models?: TranscribeModel[]
  id: string
  name: string
  provider_type: ProviderType
  base_url?: string
  encrypted_api_key?: string
  verify_ssl: boolean
  selected_model?: string
  models?: ModelInfo[]
  updated_at: string
}
export interface ClientProviderView {
  transcribe_model?: string
  transcribe_models?: TranscribeModel[]
  is_audio_provider?: boolean
  id: string
  name: string
  provider_type: ProviderType
  base_url?: string
  masked_key: string
  has_key: boolean
  key_storage: 'encrypted' | 'session' | 'unavailable' | 'none'
  storage_message?: string
  verify_ssl: boolean
  selected_model?: string
  models?: ModelInfo[]
  is_active: boolean
}
export interface ProviderSaveRequest {
  transcribe_model?: string
  transcribe_models?: TranscribeModel[]
  id: string
  name: string
  provider_type: ProviderType
  base_url?: string
  api_key?: string
  verify_ssl?: boolean
  selected_model?: string
  models?: ModelInfo[]
  set_active?: boolean
}
export interface StoredSettingsFile {
  audio_provider_id?: string
  active_provider_id: string | null
  active_model?: string | null
  providers: Record<string, StoredProviderConfig>
}

const SESSION_MESSAGE = 'Your API key is available for this session only because secure storage is unavailable. You will need to enter it again after restarting Orbit.'
const UNAVAILABLE_MESSAGE = 'Your saved API key is currently unavailable. It has been kept safely. Try again later or enter a key for this session.'
const WRITE_ERROR = 'Orbit could not save provider settings. Please try again.'

export class ProviderSecureStore {
  private cache: StoredSettingsFile | null = null
  // Never include this map in a settings object or serialize it.
  private readonly sessionKeys = new Map<string, string>()
  private migrationWarning = ''

  private getStorePath(): string {
    return path.join(app.getPath('userData'), 'provider_settings.json')
  }

  private encryptionAvailable(): boolean {
    try {
      return app.isReady() && safeStorage.isEncryptionAvailable()
        && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text')
    } catch {
      return false
    }
  }

  private encryptApiKey(key: string): string | undefined {
    if (!this.encryptionAvailable()) return undefined
    try {
      const encrypted = safeStorage.encryptString(key)
      return encrypted.length ? 'enc:' + encrypted.toString('base64') : undefined
    } catch {
      // Native errors can contain the input. Never log or forward them.
      return undefined
    }
  }

  private decryptApiKey(value?: string): string {
    if (!value?.startsWith('enc:') || !this.encryptionAvailable()) return ''
    try {
      return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'))
    } catch {
      return ''
    }
  }

  /** Recover only canonical base64 containing valid text, never reinterpret opaque ciphertext. */
  private decodeLegacyText(value: string): string | undefined {
    const bytes = Buffer.from(value, 'base64')
    if (bytes.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) return undefined
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      return text && !Array.from(text).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ? text : undefined
    } catch {
      return undefined
    }
  }

  private load(): StoredSettingsFile {
    if (this.cache) return this.cache
    const storePath = this.getStorePath()
    if (!fs.existsSync(storePath)) {
      this.cache = { active_provider_id: null, active_model: null, providers: {} }
      return this.cache
    }
    let parsed: StoredSettingsFile
    try {
      parsed = JSON.parse(fs.readFileSync(storePath, 'utf-8')) as StoredSettingsFile
      if (!parsed || !parsed.providers || typeof parsed.providers !== 'object' || Array.isArray(parsed.providers)) throw new Error()
    } catch {
      // A malformed file must not be replaced with an empty store, or quoted in an error.
      throw new Error('Orbit could not read provider settings. Your saved settings have been kept.')
    }
    const data: StoredSettingsFile = {
      audio_provider_id: parsed.audio_provider_id,
      active_provider_id: parsed.active_provider_id,
      active_model: parsed.active_model,
      providers: {},
    }
    let migrated = false
    for (const [id, source] of Object.entries(parsed.providers)) {
      const { encrypted_api_key: value } = source
      const legacyPlain = (source as StoredProviderConfig & { api_key?: unknown }).api_key
      let encryptedKey = value
      let recovered: string | undefined
      if (value && !value.startsWith('enc:')) {
        if (value.startsWith('b64:')) {
          recovered = this.decodeLegacyText(value.slice(4))
          encryptedKey = undefined
        } else {
          // Older versions stored both encrypted bytes and fallback text without a prefix.
          const candidate = 'enc:' + value
          if (this.decryptApiKey(candidate)) encryptedKey = candidate
          else {
            recovered = this.decodeLegacyText(value)
            encryptedKey = recovered ? undefined : candidate
          }
        }
        migrated = true
      } else if (!value && typeof legacyPlain === 'string' && legacyPlain) {
        recovered = legacyPlain
        migrated = true
      }
      if (legacyPlain !== undefined) {
        migrated = true
        // Some legacy files contain both fields. Keep ciphertext and recover the
        // plaintext copy for this session if the saved key cannot be opened.
        if (!recovered && encryptedKey && typeof legacyPlain === 'string' && legacyPlain && !this.decryptApiKey(encryptedKey)) {
          this.sessionKeys.set(id, legacyPlain)
        }
      }
      if (recovered) {
        encryptedKey = this.encryptApiKey(recovered)
        // Recover before removing the legacy disk value, even if the write later fails.
        if (!encryptedKey) this.sessionKeys.set(id, recovered)
      }
      // Explicit projection prevents old plaintext fields from being written back.
      data.providers[id] = {
        transcribe_model: source.transcribe_model, transcribe_models: source.transcribe_models,
        id, name: source.name, provider_type: source.provider_type,
        base_url: source.base_url, encrypted_api_key: encryptedKey,
        verify_ssl: source.verify_ssl ?? true, selected_model: source.selected_model,
        models: source.models || [], updated_at: source.updated_at,
      }
    }
    this.cache = data
    if (migrated) {
      try {
        this.write(data)
      } catch {
        this.migrationWarning = 'Orbit could not remove an old API key from disk. Your key is available for this session. Save your provider settings again to retry.'
      }
    }
    return data
  }

  /** Replace the file only after the complete encrypted/metadata-only payload is flushed. */
  private write(data: StoredSettingsFile): void {
    const storePath = this.getStorePath()
    const temporaryPath = storePath + '.' + randomUUID() + '.tmp'
    let descriptor: number | undefined
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true })
      descriptor = fs.openSync(temporaryPath, 'wx', 0o600)
      fs.writeFileSync(descriptor, JSON.stringify(data, null, 2), 'utf-8')
      fs.fsyncSync(descriptor)
      fs.closeSync(descriptor)
      descriptor = undefined
      fs.renameSync(temporaryPath, storePath)
    } catch {
      throw new Error(WRITE_ERROR)
    } finally {
      if (descriptor !== undefined) { try { fs.closeSync(descriptor) } catch { /* Best effort. */ } }
      try { fs.unlinkSync(temporaryPath) } catch { /* Renamed or never created. */ }
    }
  }

  private commit(data: StoredSettingsFile): void {
    this.write(data)
    this.cache = data
    this.migrationWarning = ''
  }

  private keyFor(provider: StoredProviderConfig): string {
    return this.sessionKeys.get(provider.id) ?? this.decryptApiKey(provider.encrypted_api_key)
  }

  private clientView(provider: StoredProviderConfig, data: StoredSettingsFile): ClientProviderView {
    const key = this.keyFor(provider)
    const keyStorage = this.sessionKeys.has(provider.id) ? 'session'
      : provider.encrypted_api_key ? (key ? 'encrypted' : 'unavailable') : 'none'
    return {
      transcribe_model: provider.transcribe_model, transcribe_models: provider.transcribe_models,
      is_audio_provider: data.audio_provider_id === provider.id,
      id: provider.id, name: provider.name, provider_type: provider.provider_type,
      base_url: provider.base_url,
      masked_key: key.length > 8 ? key.slice(0, 4) + '••••' + key.slice(-4) : key || provider.encrypted_api_key ? '••••••••' : '',
      has_key: Boolean(key || provider.encrypted_api_key),
      key_storage: keyStorage,
      storage_message: [
        keyStorage === 'session' ? SESSION_MESSAGE : keyStorage === 'unavailable' ? UNAVAILABLE_MESSAGE : '',
        keyStorage === 'session' && provider.encrypted_api_key ? 'Your previously saved key has been kept and will be used after restarting Orbit.' : '',
        this.migrationWarning,
      ].filter(Boolean).join(' ') || undefined,
      verify_ssl: provider.verify_ssl, selected_model: provider.selected_model,
      models: provider.models || [], is_active: data.active_provider_id === provider.id,
    }
  }

  getAllProviders(): ClientProviderView[] {
    const data = this.load()
    return Object.values(data.providers).map((provider) => this.clientView(provider, data))
  }

  saveProvider(config: ProviderSaveRequest): ClientProviderView {
    const data = this.load()
    const id = config.id.trim()
    const existing = data.providers[id]
    let encryptedKey = existing?.encrypted_api_key
    let sessionKey = this.sessionKeys.get(id)
    if (config.api_key !== undefined) {
      const key = config.api_key.trim()
      if (!key) {
        encryptedKey = undefined
        sessionKey = undefined
      } else {
        const encrypted = this.encryptApiKey(key)
        // Keep a previous encrypted value when the replacement can only be used temporarily.
        encryptedKey = encrypted ?? encryptedKey
        sessionKey = encrypted ? undefined : key
      }
    }
    const stored: StoredProviderConfig = {
      transcribe_model: config.transcribe_model ?? existing?.transcribe_model,
      transcribe_models: config.transcribe_models ?? existing?.transcribe_models,
      id, name: config.name.trim(), provider_type: config.provider_type,
      base_url: config.base_url?.trim() || undefined, encrypted_api_key: encryptedKey,
      verify_ssl: config.verify_ssl ?? existing?.verify_ssl ?? true,
      selected_model: config.selected_model?.trim() || existing?.selected_model,
      models: config.models || existing?.models || [], updated_at: new Date().toISOString(),
    }
    const next = { ...data, providers: { ...data.providers, [id]: stored } }
    if (stored.provider_type === 'gemini' && stored.transcribe_model) next.audio_provider_id = id
    if (config.set_active) {
      next.active_provider_id = id
      next.active_model = stored.selected_model || null
    }
    this.commit(next)
    if (sessionKey === undefined) this.sessionKeys.delete(id)
    else this.sessionKeys.set(id, sessionKey)
    return this.clientView(stored, next)
  }

  deleteProvider(id: string): boolean {
    const data = this.load()
    if (!data.providers[id]) return false
    const next = { ...data, providers: { ...data.providers } }
    delete next.providers[id]
    if (next.audio_provider_id === id) next.audio_provider_id = undefined
    if (next.active_provider_id === id) {
      next.active_provider_id = null
      next.active_model = null
    }
    this.commit(next)
    this.sessionKeys.delete(id)
    return true
  }

  setActiveProvider(id: string | null, selected_model?: string): void {
    const data = this.load()
    if (id && !data.providers[id]) throw new Error('This provider is no longer available. Add it again in Settings.')
    const next = { ...data, providers: { ...data.providers }, active_provider_id: id,
      active_model: id ? selected_model || data.providers[id].selected_model || null : null }
    if (id && selected_model) next.providers[id] = { ...data.providers[id], selected_model }
    this.commit(next)
  }

  /** Only main-process operations may resolve plaintext credentials. */
  private runtimeConfig(provider: StoredProviderConfig) {
    return {
      id: provider.id, name: provider.name, provider_type: provider.provider_type,
      base_url: provider.base_url, api_key: this.keyFor(provider),
      verify_ssl: provider.verify_ssl, selected_model: provider.selected_model,
    }
  }

  getDecryptedActiveConfig() {
    const data = this.load()
    const provider = data.active_provider_id ? data.providers[data.active_provider_id] : undefined
    if (!provider) return null
    const config = this.runtimeConfig(provider)
    return config.api_key ? { ...config, selected_model: data.active_model || config.selected_model } : null
  }

  getAllDecryptedConfigs() {
    return Object.values(this.load().providers).map((provider) => this.runtimeConfig(provider)).filter((config) => config.api_key)
  }

  /** Used by the Live API in main only; credentials never cross the renderer bridge. */
  resolveAudioCandidate(config?: ProviderSaveRequest) {
    const data = this.load()
    const stored = data.providers[config?.id ?? data.audio_provider_id ?? '']
    if ((config?.provider_type ?? stored?.provider_type) !== 'gemini') throw new Error('Configure Google Gemini audio in Providers first.')
    const apiKey = config?.api_key?.trim() || (stored ? this.keyFor(stored) : '')
    if (!apiKey) throw new Error('Enter your Gemini API key in Providers.')
    return { apiKey, model: config?.transcribe_model ?? stored?.transcribe_model,
      models: config?.transcribe_models ?? stored?.transcribe_models ?? [] }
  }

  private async candidateRequest(config: ProviderSaveRequest, operation: 'models' | 'test') {
    const stored = this.load().providers[config.id.trim()]
    const apiKey = config.api_key?.trim() || (stored ? this.keyFor(stored) : '')
    if (!apiKey) throw new Error(stored?.encrypted_api_key ? UNAVAILABLE_MESSAGE : 'Enter an API key to continue.')
    try {
      const response = await fetch('http://127.0.0.1:8000/api/v1/providers/' + operation, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: config.id, name: config.name, provider_type: config.provider_type,
          base_url: config.base_url, api_key: apiKey, verify_ssl: config.verify_ssl ?? true, selected_model: config.selected_model }),
      })
      if (!response.ok) throw new Error()
      return await response.json()
    } catch {
      throw new Error('Could not connect to the provider. Check your API key and connection, then try again.')
    }
  }

  async fetchModels(config: ProviderSaveRequest): Promise<ModelInfo[]> {
    const result = await this.candidateRequest(config, 'models') as { models: ModelInfo[] }
    return result.models || []
  }

  async testConnection(config: ProviderSaveRequest): Promise<ProviderConnectionResult> {
    return await this.candidateRequest(config, 'test') as ProviderConnectionResult
  }

  async syncWithBackend(backendUrl = 'http://127.0.0.1:8000/api/v1'): Promise<void> {
    const active = this.getDecryptedActiveConfig()
    const all = this.getAllDecryptedConfigs()
    try {
      const response = await fetch(backendUrl + '/providers/active', active ? {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(active),
      } : { method: 'DELETE' })
      if (!response.ok) throw new Error()
      // An empty list clears deleted credentials from the backend's memory too.
      const configured = await fetch(backendUrl + '/providers/configured', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providers: all }),
      })
      if (!configured.ok) throw new Error()
    } catch {
      console.warn('[providerSecureStore] Could not synchronize provider settings with the local backend.')
    }
  }
}

export const providerSecureStore = new ProviderSecureStore()
