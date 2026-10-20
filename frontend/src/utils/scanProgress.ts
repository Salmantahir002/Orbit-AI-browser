import type { WebpageContent } from '../types/securityTypes'

// Time-based progress for the webpage scan. The backend sends no progress
// events, so the bar is an estimate. It must never stall, however long the
// scan takes: it eases to KNEE over the expected duration, then keeps creeping
// toward CEILING without ever reaching it, and only hits 100% when the result
// is in.

/** Channels the backend classifies; mirrors MANUAL_SCAN_CHANNELS in backend security.routes.ts. */
const SCANNED_CHANNELS = [
  'visible_text', 'hidden_text', 'html_comments', 'meta_tags', 'input_values', 'aria_text',
  'iframe_content', 'shadow_dom_content', 'inline_javascript', 'css_content', 'css_generated_content',
  'external_javascript', 'source_maps',
] as const satisfies ReadonlyArray<keyof WebpageContent>

/** New text per chunk: backend DEFAULT_CHUNK_SIZE (800) minus DEFAULT_CHUNK_OVERLAP (100). */
const CHUNK_STRIDE_CHARS = 700
/** Rough CPU cost of rule + DL classification per chunk (~78 chunks took ~12 s when measured). */
const MS_PER_CHUNK = 150
/** BrowserShell never shows a result sooner than this. */
export const MINIMUM_SCAN_DURATION_MS = 10_000

const START = 8
const KNEE = 90
const CEILING = 99.9
/** Floor on the tail's time constant, so a small page that overruns does not use up its headroom early. */
const MIN_TAIL_MS = 40_000

export function estimateScanDurationMs(content: WebpageContent): number {
  const chunks = SCANNED_CHANNELS.reduce(
    (count, key) => count + Math.ceil((content[key]?.length ?? 0) / CHUNK_STRIDE_CHARS), 0)
  return Math.max(MINIMUM_SCAN_DURATION_MS, chunks * MS_PER_CHUNK)
}

/**
 * Percent complete after `elapsedMs` of a scan expected to take `expectedMs`.
 * Strictly increasing and below CEILING for all time. The two pieces meet at
 * KNEE with the same slope, so the bar slows down there instead of braking.
 */
export function scanProgressAt(elapsedMs: number, expectedMs: number): number {
  // The tail's time constant: a longer one keeps the crawl visible for longer.
  const tailMs = Math.max(expectedMs * 2, MIN_TAIL_MS)
  if (elapsedMs <= expectedMs) {
    // Cubic Hermite from START to KNEE: starts brisk, ends at the tail's slope.
    const x = Math.max(0, elapsedMs) / expectedMs
    const startSlope = 1.6 * (KNEE - START)
    const endSlope = (CEILING - KNEE) * (expectedMs / tailMs)
    const x2 = x * x
    const x3 = x2 * x
    return (2 * x3 - 3 * x2 + 1) * START
      + (x3 - 2 * x2 + x) * startSlope
      + (-2 * x3 + 3 * x2) * KNEE
      + (x3 - x2) * endSlope
  }
  // Hyperbolic tail: slows down the longer the scan runs, but never stops.
  return CEILING - (CEILING - KNEE) * tailMs / (elapsedMs - expectedMs + tailMs)
}

export function formatScanProgress(progress: number): string {
  // Whole numbers would sit on the same value for seconds in the tail.
  if (progress >= 100) return '100'
  if (progress >= 99) return progress.toFixed(2)
  return progress >= KNEE ? progress.toFixed(1) : String(Math.floor(progress))
}

export function formatElapsed(elapsedMs: number): string {
  const seconds = Math.floor(elapsedMs / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
