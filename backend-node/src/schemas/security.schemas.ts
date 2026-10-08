import { Type, type Static } from '@sinclair/typebox'
import { AnalysisDetailsSchema } from './analysisDetails.schemas.js'

export const PromptCheckRequestSchema = Type.Object({
  prompt: Type.String(),
})

// Field-for-field port of WebpageCheckRequest. Required fields intentionally
// match Pydantic's defaults: only the original seven core capture fields are
// required, while the newer channels default to an empty string.
export const WebpageCheckRequestSchema = Type.Object({
  visible_text: Type.String(),
  hidden_text: Type.String(),
  html_comments: Type.String(),
  meta_tags: Type.String(),
  input_values: Type.String(),
  page_title: Type.String(),
  url: Type.String(),
  aria_text: Type.Optional(Type.String()),
  iframe_content: Type.Optional(Type.String()),
  shadow_dom_content: Type.Optional(Type.String()),
  external_javascript: Type.Optional(Type.String()),
  inline_javascript: Type.Optional(Type.String()),
  css_content: Type.Optional(Type.String()),
  css_generated_content: Type.Optional(Type.String()),
  source_maps: Type.Optional(Type.String()),
  dom_snapshot_content: Type.Optional(Type.String()),
})

export const SecurityCheckResponseSchema = Type.Object({
  allowed: Type.Boolean(),
  label: Type.Union([Type.Literal('benign'), Type.Literal('malicious')]),
  confidence: Type.Number(),
  risk_level: Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')]),
  summary_reason: Type.String(),
  matched_patterns: Type.Array(Type.String()),
  source: Type.Union([Type.Literal('direct_prompt'), Type.Literal('webpage_content')]),
  timestamp: Type.String(),
  analysis_details: AnalysisDetailsSchema,
})

// The finished scan output (rule-based + DL verdicts per chunk), not the raw page.
export const ExplainScanRequestSchema = Type.Object({
  source: Type.Union([Type.Literal('direct_prompt'), Type.Literal('webpage_content')]),
  url: Type.Optional(Type.String()),
  page_title: Type.Optional(Type.String()),
  analysis_details: AnalysisDetailsSchema,
})

export const ScanSummaryResponseSchema = Type.Object({
  summary: Type.String(),
  // `llm`: written by the active provider. `local`: built-in summary (no provider, or it failed).
  source: Type.Union([Type.Literal('llm'), Type.Literal('local')]),
  provider: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  note: Type.Optional(Type.String()),
})

export type PromptCheckRequest = Static<typeof PromptCheckRequestSchema>
export type WebpageCheckRequest = Static<typeof WebpageCheckRequestSchema>
export type ExplainScanRequest = Static<typeof ExplainScanRequestSchema>
export type SecurityCheckResponse = Static<typeof SecurityCheckResponseSchema>
