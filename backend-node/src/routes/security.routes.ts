import type { FastifyInstance } from 'fastify'
import { settings } from '../config/env.js'
import { featureExplanationService } from '../services/featureExplanationService.js'
import { preprocessingService } from '../services/promptPreprocessingService.js'
import { promptClassifier } from '../services/promptClassifierService.js'
import { securityEventStore } from '../services/securityEventStore.js'
import { chunkingService } from '../services/textChunkingService.js'
import {
  PromptCheckRequestSchema,
  SecurityCheckResponseSchema,
  WebpageCheckRequestSchema,
  type SecurityCheckResponse,
} from '../schemas/security.schemas.js'
import type { AnalysisDetails, ChunkResult } from '../schemas/analysisDetails.schemas.js'
import { ErrorResponseSchema } from '../schemas/common.js'

// The original 14 DOM/accessibility/network channels (ported verbatim from
// security_routes.py's MANUAL_SCAN_CHANNELS).
const CORE_CHANNELS = [
  'visible_text',
  'hidden_text',
  'html_comments',
  'meta_tags',
  'input_values',
  'aria_text',
  'iframe_content',
  'shadow_dom_content',
  'inline_javascript',
  'css_content',
  'css_generated_content',
] as const

// Node-only enhancement: cdpInspectionService.ts (Electron) has always captured
// these extra telemetry channels and sent them in every check-webpage request
// — WebpageCheckRequestSchema already accepts them — but nothing classified them.
// Wiring them in is pure reuse: zero frontend/schema changes, same detector,
// same chunking/aggregation path.
const EXTENDED_CHANNELS = [
  'external_javascript',
  'source_maps',
] as const

// `dom_snapshot_content` stays deliberately excluded from both lists: it is the
// raw string table from DOMSnapshot.captureSnapshot (every tag name, class,
// attribute value, URL — unstructured), and scanning it is what let "dan" match
// inside "guidance" in a YouTube config blob (see test_agent_and_manual_scan_agree.py).
// Its readable text is already covered by visible_text/hidden_text/aria_text.
export const MANUAL_SCAN_CHANNELS = [...CORE_CHANNELS, ...EXTENDED_CHANNELS] as const

type ContentSource = [string, string]

function riskLevelForConfidence(confidence: number): 'low' | 'medium' | 'high' {
  if (confidence >= 0.85) return 'high'
  if (confidence >= settings.CLASSIFIER_THRESHOLD) return 'medium'
  return 'low'
}

function excerptForDisplay(text: string, evidence: readonly string[]): string {
  const lowerText = text.toLowerCase()
  const matchedTerm = evidence.find((term) => lowerText.includes(term.toLowerCase())) ?? ''
  if (!matchedTerm) {
    return text.slice(0, 240) + (text.length > 240 ? '...' : '')
  }

  const matchStart = lowerText.indexOf(matchedTerm.toLowerCase())
  const start = Math.max(0, matchStart - 110)
  const end = Math.min(text.length, matchStart + matchedTerm.length + 180)
  const prefix = start > 0 ? '...' : ''
  const suffix = end < text.length ? '...' : ''
  return `${prefix}${text.slice(start, end)}${suffix}`
}

function chunkReason(
  label: 'benign' | 'malicious',
  matchedPatterns: readonly string[],
  evidence: readonly string[],
): string {
  if (label === 'malicious') {
    // A DL-only detection has no keyword evidence to quote — the transformer
    // scores the whole chunk rather than matching terms in it.
    if (evidence.length === 0) {
      return `Classified as prompt injection by ${matchedPatterns.join(', ')} without a literal keyword match.`
    }
    const phrases = evidence.slice(0, 3).map((term) => `“${term}”`).join(', ')
    return `Matched ${matchedPatterns.join(', ')} indicator(s): ${phrases}.`
  }
  return 'Chunk does not contain suspicious override, reveal, hidden instruction, or exfiltration intent.'
}

export async function analyzeText(
  rawText: string,
  source: 'direct_prompt' | 'webpage_content',
  contentSources?: readonly ContentSource[],
): Promise<SecurityCheckResponse> {
  const { normalizedText, summary: preprocessing } = preprocessingService.preprocess(rawText)
  const chunkSize = settings.DEFAULT_CHUNK_SIZE
  const overlap = settings.DEFAULT_CHUNK_OVERLAP
  const sources: readonly ContentSource[] = contentSources ?? [['prompt', normalizedText]]
  const chunks: Array<{ chunk_id: string; text: string; source: string }> = []

  for (const [sourceName, sourceText] of sources) {
    // Keep the original channel text in the result so the report can show the
    // user exactly what was captured. The classifier normalizes its own search
    // text, while aggregate preprocessing remains in the metadata.
    for (const sourceChunk of chunkingService.chunkText(sourceText, chunkSize, overlap)) {
      chunks.push({
        ...sourceChunk,
        chunk_id: `${sourceName}_${sourceChunk.chunk_id}`,
        source: sourceName,
      })
    }
  }

  const chunkResults: ChunkResult[] = []
  const aggregatedEvidence: Record<string, string[]> = {}

  // One batched call rather than one per chunk: the DL detector runs the whole
  // set as batched forward passes, which is far cheaper than N sequential ones.
  const detectorResults = await promptClassifier.classifyMany(chunks.map((chunk) => chunk.text))

  for (const [chunkIndex, chunk] of chunks.entries()) {
    const detectorResult = detectorResults[chunkIndex]!
    const label = detectorResult.is_malicious ? 'malicious' : 'benign'
    const confidence = label === 'malicious' ? detectorResult.confidence : 0.94
    const matchedPatterns = detectorResult.matched_patterns
    const matchedEvidence = [...new Set(Object.values(detectorResult.pattern_evidence).flat())].sort()

    for (const [category, keywords] of Object.entries(detectorResult.pattern_evidence)) {
      const current = aggregatedEvidence[category] ?? (aggregatedEvidence[category] = [])
      for (const keyword of keywords) {
        if (!current.includes(keyword)) current.push(keyword)
      }
    }

    chunkResults.push({
      chunk_id: chunk.chunk_id,
      source: chunk.source,
      label,
      confidence,
      risk_level: label === 'benign' ? 'low' : riskLevelForConfidence(confidence),
      matched_patterns: matchedPatterns,
      reason: chunkReason(label, matchedPatterns, matchedEvidence),
      excerpt: excerptForDisplay(chunk.text, matchedEvidence),
      matched_evidence: matchedEvidence,
      detector_source: detectorResult.detector_source,
      rule_based: detectorResult.rule_based,
      dl: detectorResult.dl,
    })
  }

  const maliciousChunks = chunkResults.filter((chunk) => chunk.label === 'malicious')
  const allowed = maliciousChunks.length === 0
  const label = allowed ? 'benign' : 'malicious'
  const confidence = allowed ? 0.94 : Math.max(...maliciousChunks.map((chunk) => chunk.confidence))
  const riskLevel = allowed ? 'low' : riskLevelForConfidence(confidence)
  // Union of what the chunks actually reported, not just the rule engine's
  // evidence categories: a chunk the DL detector alone flagged carries
  // DL_DETECTION_PATTERN and no keyword evidence, and would otherwise leave
  // this list empty on a blocked scan.
  const matchedPatterns = [...new Set(chunkResults.flatMap((chunk) => chunk.matched_patterns))].sort()
  const highestRiskChunk = maliciousChunks.length > 0
    ? maliciousChunks.reduce((highest, chunk) => chunk.confidence > highest.confidence ? chunk : highest)
    : chunkResults[0]

  // Callers reject an empty direct prompt/page before reaching this helper, so
  // at least one chunk always exists, exactly as the Python route assumes.
  if (!highestRiskChunk) {
    throw new Error('Security analysis received no chunks after non-empty content validation.')
  }

  let summaryReason: string
  let finalRationale: string
  if (allowed) {
    summaryReason = 'No instruction-like prompt injection pattern was detected in the scanned content.'
    finalRationale = 'All scanned content channels were analyzed without a chunk crossing the malicious threshold.'
  } else {
    const detectionType = source === 'webpage_content' ? 'Indirect prompt injection' : 'Prompt injection'
    const affectedSources = [...new Set(maliciousChunks.map((chunk) => chunk.source.replaceAll('_', ' ')))].sort()
    summaryReason = `${detectionType} indicators detected in ${maliciousChunks.length} chunk(s) from ${affectedSources.join(', ')}: ${matchedPatterns.join(', ')}.`
    finalRationale = 'The input is blocked because one or more chunks crossed the malicious threshold with matched prompt injection indicators.'
  }

  const analysisDetails: AnalysisDetails = {
    classifier_mode: promptClassifier.classifierMode,
    model_precision: promptClassifier.modelPrecision,
    threshold_used: settings.CLASSIFIER_THRESHOLD,
    preprocessing,
    chunking: {
      chunk_count: chunks.length,
      chunk_size: chunkSize,
      overlap,
      highest_risk_chunk_id: highestRiskChunk.chunk_id,
    },
    feature_evidence: featureExplanationService.extractFeatures(normalizedText, aggregatedEvidence),
    chunk_results: chunkResults,
    final_rationale: finalRationale,
  }

  const response: SecurityCheckResponse = {
    allowed,
    label,
    confidence,
    risk_level: riskLevel,
    summary_reason: summaryReason,
    matched_patterns: matchedPatterns,
    source,
    timestamp: new Date().toISOString(),
    analysis_details: analysisDetails,
  }

  securityEventStore.addEvent(response.allowed, response.label, response.source, response.summary_reason)
  return response
}

export default async function securityRoutes(app: FastifyInstance): Promise<void> {
  app.post('/security/check-prompt', {
    schema: { body: PromptCheckRequestSchema, response: { 200: SecurityCheckResponseSchema, 400: ErrorResponseSchema } },
  }, async (request, reply) => {
    const { prompt } = request.body as { prompt: string }
    if (!prompt.trim()) {
      return reply.code(400).send({ detail: 'Prompt content cannot be empty.' })
    }
    return analyzeText(prompt, 'direct_prompt')
  })

  app.post('/security/check-webpage', {
    schema: { body: WebpageCheckRequestSchema, response: { 200: SecurityCheckResponseSchema, 400: ErrorResponseSchema } },
  }, async (request, reply) => {
    const body = request.body as Record<string, string | undefined>
    // Keep every capture channel separate. This prevents a match in telemetry
    // from being misreported as page text and lets the UI identify its origin.
    const nonEmptySources: ContentSource[] = MANUAL_SCAN_CHANNELS
      .map((name) => [name, body[name] ?? ''] as ContentSource)
      .filter(([, text]) => text.trim().length > 0)

    if (nonEmptySources.length === 0) {
      return reply.code(400).send({ detail: 'Webpage content cannot be empty.' })
    }

    const combinedWebpageContent = nonEmptySources.map(([, text]) => text).join('\n')
    return analyzeText(combinedWebpageContent, 'webpage_content', nonEmptySources)
  })

  app.get('/security/events', async () => securityEventStore.getEvents())
}
