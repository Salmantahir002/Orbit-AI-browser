import { ALL_INDICATORS } from '../core/securityConstants.js'

// These terms often appear in legitimate tutorials, news, video titles, and
// accessibility labels. They are useful corroborating evidence, but are not an
// indirect prompt injection by themselves.
const WEAK_JAILBREAK_TERMS = new Set([
  'dan',
  'developer mode',
  'jailbreak',
  'unlocked mode',
  'no rules',
  'acting as',
  'without constraints',
  'allow explicit content',
])

// Indicators that describe an ordinary action as often as a hostile one.
// "upload to" appears in "upload to your channel" on every video site; "extract
// user" and "leak info" read as product copy as easily as an attack. Like the
// weak jailbreak terms, they only count when something instruction-like sits
// next to them.
const WEAK_TERMS_BY_CATEGORY: Record<string, Set<string>> = {
  jailbreak_attempt: WEAK_JAILBREAK_TERMS,
  data_exfiltration: new Set(['upload to', 'extract user', 'leak info']),
}

// Language that marks nearby text as a directive aimed at an AI assistant
// rather than at a human reader.
//
// Bare imperatives were tried first and were far too common in ordinary pages:
// "show" matched the "Show more images" button on a search results page, and
// "follow" matched "follow every step" in a tutorial. Both turned an article
// that merely mentions jailbreaking into a blocked page. Corroboration now has
// to look like someone talking to a model.
const INSTRUCTION_CONTEXT_TERMS = [
  'ignore', 'disregard', 'override', 'bypass', 'pretend',
  'you are', 'you must', 'you should', 'you will', 'you may not',
  'your instructions', 'your rules', 'your guidelines', 'your system prompt',
  'system prompt', 'act as', 'respond with', 'reply with', 'output the',
  'do not tell', 'do not reveal', 'do not mention', 'forget your',
  'forget previous', 'from now on',
]

// How near an instruction-like word must be to a weak term to corroborate it.
// Scanning a whole chunk was too generous: a page large enough to contain
// "jailbreak" in one place almost certainly contains "show" or "follow"
// somewhere else, which silently disabled the guard on every big site.
const CONTEXT_PROXIMITY_CHARS = 160

// The phrase lists in securityConstants only catch exact wordings, so a trivial
// rewording ("ignore any higher-priority instructions", "report any session
// tokens") slipped straight past them. These match the *shape* of each attack:
// an override verb aimed at instructions, a request to reveal the hidden
// prompt, an order to hand over secrets, or an order to hide it from the user.
// Each is specific enough to need both the verb and its target, so ordinary
// prose that only mentions "rules" or "cookies" does not match.
const PATTERN_INDICATORS: Record<string, RegExp[]> = {
  override_instructions: [
    /\b(?:ignore|disregard|forget|override)\s+(?:(?:any|all|every|the|your|my|these|those|other|previous|prior|earlier|above|higher[- ]priority|system|developer)\s+){1,4}(?:instructions?|directives|guidelines|prompts?|rules)\b/,
    /\bignore\s+the\s+user(?:'s|\u2019s)?\s+(?:goal|request|task|question)/,
  ],
  jailbreak_attempt: [
    /\byou are now (?:an? )?(?:unrestricted|unfiltered|jailbroken|uncensored)\b/,
  ],
  hidden_instruction: [
    /\bdo not (?:mention|tell|reveal|disclose|show)\s+(?:this|it|that)(?:\s+\w+)?\s+to the user\b/,
    /\bwithout (?:telling|informing|notifying) the user\b/,
  ],
  system_prompt_reveal: [
    /\breveal\s+(?:(?:any|all|your|the)\s+)?(?:system|developer|hidden|internal)(?:\s*\/\s*\w+)?\s+(?:instructions?|prompts?|messages?)\b/,
  ],
  data_exfiltration: [
    /\b(?:report|send|share|leak|output|print|post|forward|reveal|exfiltrate)\s+(?:(?:any|all|the|your|every)\s+)?(?:session\s+tokens?|api[- ]?keys?|cookies|credentials|passwords?|secrets?|auth(?:orization)?\s+tokens?)\b/,
  ],
}

function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const termPatternCache = new Map<string, RegExp>()

/**
 * Whole-word matcher for an indicator.
 *
 * Substring matching made short indicators fire on ordinary English: "dan"
 * matched inside "guidance", "abundant" and "dance", which is exactly how a
 * safe page ends up blocked. Word boundaries are only applied at edges that
 * are alphanumeric, so multi-word and punctuated indicators still match.
 */
function termPattern(term: string): RegExp {
  const cached = termPatternCache.get(term)
  if (cached) return cached
  const prefix = /^[a-z0-9]/i.test(term[0] ?? '') ? '\\b' : ''
  const suffix = /[a-z0-9]$/i.test(term[term.length - 1] ?? '') ? '\\b' : ''
  const pattern = new RegExp(prefix + escapeRegExp(term) + suffix)
  termPatternCache.set(term, pattern)
  return pattern
}

function findTerm(text: string, term: string): [number, number] | null {
  const match = termPattern(term).exec(text)
  if (!match) return null
  return [match.index, match.index + match[0].length]
}

/**
 * Looks for an instruction-like word beside the match, excluding the match
 * itself. Without that exclusion a term would corroborate itself: "upload to"
 * contains "upload", so "upload to your channel" would always look like a
 * directive.
 */
function hasInstructionContextNear(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - CONTEXT_PROXIMITY_CHARS), start)
  const after = text.slice(end, end + CONTEXT_PROXIMITY_CHARS)
  const window = `${before} ${after}`
  return INSTRUCTION_CONTEXT_TERMS.some((term) => termPattern(term).test(window))
}

export interface DetectResult {
  is_malicious: boolean
  confidence: number
  matched_patterns: string[]
  pattern_evidence: Record<string, string[]>
}

class RuleBasedDetectorService {
  detect(text: string): DetectResult {
    const searchText = text.toLowerCase()
    const matchedPatterns: string[] = []
    const patternEvidence: Record<string, string[]> = {}
    let totalKeywordMatches = 0

    // Run signature matching for each category. A bare "jailbreak" (for
    // example, a video title) is not enough to block a page; it needs an
    // instruction-like phrase close enough to it to read as a directive.
    for (const [categoryName, keywordList] of Object.entries(ALL_INDICATORS)) {
      const matches: string[] = []
      for (const keyword of keywordList) {
        const span = findTerm(searchText, keyword)
        if (span === null) continue

        const isWeak = WEAK_TERMS_BY_CATEGORY[categoryName]?.has(keyword) ?? false
        if (isWeak && !hasInstructionContextNear(searchText, span[0], span[1])) continue

        matches.push(keyword)
        totalKeywordMatches += 1
      }

      for (const pattern of PATTERN_INDICATORS[categoryName] ?? []) {
        const found = pattern.exec(searchText)
        if (found && !matches.includes(found[0])) {
          matches.push(found[0])
          totalKeywordMatches += 1
        }
      }

      if (matches.length > 0) {
        matchedPatterns.push(categoryName)
        patternEvidence[categoryName] = matches
      }
    }

    const isMalicious = matchedPatterns.length > 0
    let confidence = 0.0

    if (isMalicious) {
      let baseConf: number
      if (matchedPatterns.length === 1) baseConf = 0.75
      else if (matchedPatterns.length === 2) baseConf = 0.85
      else baseConf = 0.95

      confidence = Math.min(0.99, baseConf + 0.01 * totalKeywordMatches)
    }

    return {
      is_malicious: isMalicious,
      confidence,
      matched_patterns: matchedPatterns,
      pattern_evidence: patternEvidence,
    }
  }
}

export const ruleBasedDetector = new RuleBasedDetectorService()
