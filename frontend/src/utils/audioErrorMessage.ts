/** Electron wraps safe main-process messages with IPC implementation details. */
export function audioErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Could not connect to audio. Please try again.'
  return message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
}
