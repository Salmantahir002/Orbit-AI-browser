import type { AnalysisDetails, RiskLevel, SecurityLabel } from './analysisDetailsTypes'

export type SecuritySource = 'direct_prompt' | 'webpage_content'

export type SecurityCheckResponse = {
  allowed: boolean
  label: SecurityLabel
  confidence: number
  risk_level: RiskLevel
  summary_reason: string
  matched_patterns: string[]
  source: SecuritySource
  timestamp: string
  analysis_details: AnalysisDetails
}

export type LlmResponse = {
  response: string
  model: string
  usage: Record<string, number>
}

export type ScanSummary = {
  summary: string
  source: 'llm' | 'local'
  provider?: string
  model?: string
  note?: string
}

export type ChatHistoryTurn = {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export type ChatAttachment = {
  id: string
  name: string
  type: string
  size: number
  data: string // data URL or base64 string
  isImage: boolean
  textContent?: string
}

export type WebpageContent = {
  visible_text: string
  hidden_text: string
  html_comments: string
  meta_tags: string
  input_values: string
  page_title: string
  url: string
  aria_text: string
  iframe_content: string
  shadow_dom_content: string
  external_javascript: string
  inline_javascript: string
  css_content: string
  css_generated_content: string
  source_maps: string
  dom_snapshot_content: string
}
