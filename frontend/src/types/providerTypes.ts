/**
 * Types for the Multi-Provider AI Gateway system in PromptGuard.
 */

export type ProviderApiType = 'openai_compatible' | 'anthropic' | 'gemini'

export interface ModelInfo {
  id: string
  name: string
  description?: string
}

export interface ClientProviderConfig {
  transcribe_model?: string
  transcribe_models?: import('../../electron/aiAudioTypes').TranscribeModel[]
  is_audio_provider?: boolean
  id: string
  name: string
  provider_type: ProviderApiType
  base_url?: string
  api_key?: string
  masked_key?: string
  has_key?: boolean
  key_storage?: 'encrypted' | 'session' | 'unavailable' | 'none'
  storage_message?: string
  verify_ssl: boolean
  selected_model?: string
  models?: ModelInfo[]
  is_active?: boolean
}

export interface ActiveProviderInfo {
  id: string
  name: string
  provider_type: string
  base_url?: string
  is_active: boolean
  is_fallback?: boolean
  selected_model?: string
  models?: ModelInfo[]
  masked_key?: string
}

export interface TestConnectionResult {
  success: boolean
  latency_ms: number
  models_count: number
  message: string
  models: ModelInfo[]
}

export interface FetchModelsResult {
  provider_id: string
  models: ModelInfo[]
  count: number
}
