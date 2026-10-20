export type TranscribeModel = { id: string; name: string; description?: string; responseModality?: 'TEXT' | 'AUDIO' }
export type AudioEvent = { sessionId: string; type: 'text' | 'closed' | 'error' | 'revoked'; text?: string; message?: string }
export interface AiAudioBridge {
  fetchModels(config: import('./providerSecureStore.js').ProviderSaveRequest): Promise<TranscribeModel[]>
  testConnection(config: import('./providerSecureStore.js').ProviderSaveRequest): Promise<{ message: string }>
  start(sessionId: string): Promise<void>
  send(sessionId: string, pcm: ArrayBuffer): void
  stop(sessionId: string, cancel?: boolean): Promise<void>
  onEvent(listener: (event: AudioEvent) => void): () => void
}
