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
  id: string
  name: string
  provider_type: ProviderApiType
  base_url?: string
  api_key?: string
  masked_key?: string
  has_key?: boolean
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
