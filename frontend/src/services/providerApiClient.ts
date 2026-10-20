/** Main-process provider storage and runtime credential operations. */
import type { ActiveProviderInfo, ClientProviderConfig, ModelInfo, TestConnectionResult } from '../types/providerTypes'

const API_BASE_URL = 'http://127.0.0.1:8000/api/v1'

function providersBridge() {
  const providers = window.electronAPI?.providers
  if (!providers) throw new Error('Open Orbit to manage provider API keys. Keys cannot be saved in this browser.')
  return providers
}

/** Candidate keys and saved keys are resolved in main, never through ordinary readback. */
export async function fetchProviderModels(config: ClientProviderConfig): Promise<ModelInfo[]> {
  return providersBridge().fetchModels(config)
}

export async function testProviderConnection(config: ClientProviderConfig): Promise<TestConnectionResult> {
  return providersBridge().testConnection(config)
}

export async function setBackendActiveProvider(config: ClientProviderConfig): Promise<ActiveProviderInfo> {
  const response = await fetch(API_BASE_URL + '/providers/active', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: config.id, name: config.name, provider_type: config.provider_type,
      base_url: config.base_url, api_key: config.api_key || '',
      verify_ssl: config.verify_ssl ?? true, selected_model: config.selected_model,
    }),
  })
  if (!response.ok) throw new Error('Could not activate this provider. Check your API key and connection.')
  return response.json() as Promise<ActiveProviderInfo>
}

export async function getAllStoredProviders(): Promise<ClientProviderConfig[]> {
  // Never fall back to localStorage after an IPC failure.
  return providersBridge().getAll()
}

export async function saveStoredProvider(config: ClientProviderConfig & { set_active?: boolean }): Promise<ClientProviderConfig> {
  return providersBridge().save(config)
}

export async function deleteStoredProvider(providerId: string): Promise<boolean> {
  return (await providersBridge().delete(providerId)).ok
}

export async function setActiveStoredProvider(id: string | null, selectedModel?: string): Promise<boolean> {
  return (await providersBridge().setActive({ id, selected_model: selectedModel })).ok
}
