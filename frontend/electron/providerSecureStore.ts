/**
 * Secure Storage for LLM Provider credentials using Electron safeStorage.
 * Stores encrypted API keys in the OS keychain and persists configuration
 * in the user's application data directory.
 */

import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export type ProviderType = 'openai_compatible' | 'anthropic' | 'gemini'

export interface StoredProviderConfig {
  id: string
  name: string
  provider_type: ProviderType
  base_url?: string
  encrypted_api_key?: string
  verify_ssl: boolean
  selected_model?: string
  models?: Array<{ id: string; name: string; description?: string }>
  updated_at: string
}

export interface ClientProviderView {
  id: string
  name: string
  provider_type: ProviderType
  base_url?: string
  masked_key: string
  has_key: boolean
  verify_ssl: boolean
  selected_model?: string
  models?: Array<{ id: string; name: string; description?: string }>
  is_active: boolean
}

/** What the renderer sends to save a provider; the plain API key never leaves main once stored. */
export interface ProviderSaveRequest {
  id: string
  name: string
  provider_type: ProviderType
  base_url?: string
  api_key?: string
  verify_ssl?: boolean
  selected_model?: string
  models?: Array<{ id: string; name: string; description?: string }>
  set_active?: boolean
}

export interface StoredSettingsFile {
  active_provider_id: string | null
  active_model?: string | null
  providers: Record<string, StoredProviderConfig>
}

export class ProviderSecureStore {
  private filePath: string | null = null
  private cache: StoredSettingsFile | null = null

  private getStorePath(): string {
    if (!this.filePath) {
      // Store permanently in %APPDATA%/prompt-defense-browser/provider_settings.json
      const baseDir = path.join(app.getPath('appData'), 'prompt-defense-browser')
      this.filePath = path.join(baseDir, 'provider_settings.json')
    }
    return this.filePath
  }

  private load(): StoredSettingsFile {
    if (this.cache) return this.cache

    const storePath = this.getStorePath()
    if (fs.existsSync(storePath)) {
      try {
        const raw = fs.readFileSync(storePath, 'utf-8')
        this.cache = JSON.parse(raw) as StoredSettingsFile
        return this.cache
      } catch (err) {
        console.warn('[providerSecureStore] Failed to read provider settings file:', err)
      }
    }

    this.cache = {
      active_provider_id: null,
      active_model: null,
      providers: {},
    }
    return this.cache
  }

  private save(): void {
    if (!this.cache) return
    const storePath = this.getStorePath()
    try {
      const dir = path.dirname(storePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      fs.writeFileSync(storePath, JSON.stringify(this.cache, null, 2), 'utf-8')
    } catch (err) {
      console.error('[providerSecureStore] Failed to write provider settings:', err)
    }
  }

  private encryptApiKey(key: string): string {
    if (!key) return ''
    if (app.isReady() && safeStorage.isEncryptionAvailable()) {
      try {
        const encrypted = safeStorage.encryptString(key).toString('base64')
        return `enc:${encrypted}`
      } catch (err) {
        console.warn('[providerSecureStore] safeStorage.encryptString failed:', err)
      }
    }
    // Fallback encoding if OS keychain is unavailable
    return `b64:${Buffer.from(key, 'utf-8').toString('base64')}`
  }

  private decryptApiKey(storedVal?: string): string {
    if (!storedVal) return ''
    if (storedVal.startsWith('enc:')) {
      const b64 = storedVal.slice(4)
      const buffer = Buffer.from(b64, 'base64')
      if (app.isReady() && safeStorage.isEncryptionAvailable()) {
        try {
          return safeStorage.decryptString(buffer)
        } catch (err) {
          console.warn('[providerSecureStore] safeStorage.decryptString failed:', err)
        }
      }
    } else if (storedVal.startsWith('b64:')) {
      const b64 = storedVal.slice(4)
      try {
        return Buffer.from(b64, 'base64').toString('utf-8')
      } catch {
        return ''
      }
    } else {
      // Legacy without prefix
      const buffer = Buffer.from(storedVal, 'base64')
      if (app.isReady() && safeStorage.isEncryptionAvailable()) {
        try {
          return safeStorage.decryptString(buffer)
        } catch {
          // May have been saved with fallback encoding
        }
      }
      try {
        return buffer.toString('utf-8')
      } catch {
        return ''
      }
    }
    return ''
  }

  private maskKey(key?: string): string {
    if (!key) return ''
    if (key.length <= 8) return '••••••••'
    return `${key.slice(0, 4)}••••${key.slice(-4)}`
  }

  /**
   * Returns list of saved providers for the UI with masked keys.
   */
  getAllProviders(): ClientProviderView[] {
    const data = this.load()
    const result: ClientProviderView[] = []

    for (const p of Object.values(data.providers)) {
      const plainKey = this.decryptApiKey(p.encrypted_api_key)
      result.push({
        id: p.id,
        name: p.name,
        provider_type: p.provider_type,
        base_url: p.base_url,
        masked_key: this.maskKey(plainKey),
        has_key: Boolean(plainKey),
        verify_ssl: p.verify_ssl ?? true,
        selected_model: p.selected_model,
        models: p.models || [],
        is_active: data.active_provider_id === p.id,
      })
    }

    return result
  }

  /**
   * Saves a provider configuration with OS-level encrypted key.
   */
  saveProvider(config: ProviderSaveRequest): ClientProviderView {
    const data = this.load()
    const existing = data.providers[config.id]

    let encryptedKey = existing?.encrypted_api_key
    if (config.api_key !== undefined) {
      encryptedKey = this.encryptApiKey(config.api_key.trim())
    }

    const stored: StoredProviderConfig = {
      id: config.id.trim(),
      name: config.name.trim(),
      provider_type: config.provider_type,
      base_url: config.base_url?.trim() || undefined,
      encrypted_api_key: encryptedKey,
      verify_ssl: config.verify_ssl ?? true,
      selected_model: config.selected_model?.trim() || existing?.selected_model,
      models: config.models || existing?.models || [],
      updated_at: new Date().toISOString(),
    }

    data.providers[stored.id] = stored

    if (config.set_active) {
      data.active_provider_id = stored.id
      if (stored.selected_model) {
        data.active_model = stored.selected_model
      }
    }

    this.save()

    const plainKey = this.decryptApiKey(stored.encrypted_api_key)
    return {
      id: stored.id,
      name: stored.name,
      provider_type: stored.provider_type,
      base_url: stored.base_url,
      masked_key: this.maskKey(plainKey),
      has_key: Boolean(plainKey),
      verify_ssl: stored.verify_ssl,
      selected_model: stored.selected_model,
      models: stored.models,
      is_active: data.active_provider_id === stored.id,
    }
  }

  deleteProvider(id: string): boolean {
    const data = this.load()
    if (data.providers[id]) {
      delete data.providers[id]
      if (data.active_provider_id === id) {
        data.active_provider_id = null
        data.active_model = null
      }
      this.save()
      return true
    }
    return false
  }

  setActiveProvider(id: string | null, selected_model?: string): void {
    const data = this.load()
    data.active_provider_id = id
    if (selected_model) {
      data.active_model = selected_model
      if (id && data.providers[id]) {
        data.providers[id].selected_model = selected_model
      }
    } else if (id && data.providers[id]?.selected_model) {
      data.active_model = data.providers[id].selected_model
    } else if (!id) {
      data.active_model = null
    }
    this.save()
  }

  /**
   * Retrieves decrypted active provider config for backend synchronization.
   */
  getDecryptedActiveConfig(): {
    id: string
    name: string
    provider_type: ProviderType
    base_url?: string
    api_key: string
    verify_ssl: boolean
    selected_model?: string
  } | null {
    const data = this.load()
    if (!data.active_provider_id) return null

    const stored = data.providers[data.active_provider_id]
    if (!stored) return null

    return {
      id: stored.id,
      name: stored.name,
      provider_type: stored.provider_type,
      base_url: stored.base_url,
      api_key: this.decryptApiKey(stored.encrypted_api_key),
      verify_ssl: stored.verify_ssl,
      selected_model: data.active_model || stored.selected_model,
    }
  }

  /**
   * Returns all stored provider configs with decrypted API keys for backend fallback operations.
   */
  getAllDecryptedConfigs(): Array<{
    id: string
    name: string
    provider_type: ProviderType
    base_url?: string
    api_key: string
    verify_ssl: boolean
    selected_model?: string
  }> {
    const data = this.load()
    const result = []
    for (const stored of Object.values(data.providers)) {
      const apiKey = this.decryptApiKey(stored.encrypted_api_key)
      if (apiKey) {
        result.push({
          id: stored.id,
          name: stored.name,
          provider_type: stored.provider_type,
          base_url: stored.base_url,
          api_key: apiKey,
          verify_ssl: stored.verify_ssl,
          selected_model: stored.selected_model,
        })
      }
    }
    return result
  }

  /**
   * Synchronize the active provider configuration and all configured providers with the Node backend.
   */
  async syncWithBackend(backendUrl: string = 'http://127.0.0.1:8000/api/v1'): Promise<void> {
    const active = this.getDecryptedActiveConfig()
    const all = this.getAllDecryptedConfigs()

    try {
      if (active) {
        await fetch(`${backendUrl}/providers/active`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(active),
        })
        console.log(`[providerSecureStore] Synced active provider "${active.name}" to backend`)
      } else {
        await fetch(`${backendUrl}/providers/active`, {
          method: 'DELETE',
        })
        console.log(`[providerSecureStore] Cleared active provider in backend (no provider active)`)
      }

      if (all.length > 0) {
        await fetch(`${backendUrl}/providers/configured`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providers: all }),
        })
        console.log(`[providerSecureStore] Synced ${all.length} configured provider(s) to backend for audio fallback`)
      }
    } catch (err) {
      console.warn('[providerSecureStore] Backend not reachable for provider sync on startup:', err)
    }
  }
}

export const providerSecureStore = new ProviderSecureStore()
