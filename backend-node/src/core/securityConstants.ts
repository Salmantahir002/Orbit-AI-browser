// Ported verbatim from backend/app/core/security_constants.py — keep these two files in sync.

export const OVERRIDE_INSTRUCTIONS = [
  'ignore previous',
  'ignore all previous instructions',
  'ignore all previous',
  'disregard all',
  'forget your instructions',
  'forget previous',
  'override instructions',
  'disregard previous',
  'forget what you were told',
  'stop following instructions',
  'ignore above',
  'ignore below',
  'new instructions start now',
  'do not write the previous',
  'ignore the instructions',
  'system overrides',
]

export const JAILBREAK_ATTEMPT = [
  'dan',
  'do anything now',
  'developer mode',
  'bypass restrictions',
  'jailbreak',
  'unlocked mode',
  'no rules',
  'bypass boundaries',
  'pretend you are',
  'acting as',
  'without constraints',
  'allow explicit content',
  'bypass filter',
  'ignore guardrails',
]

export const HIDDEN_INSTRUCTION = [
  'hidden instruction',
  'invisible text',
  'execute secretly',
  'do not show the user',
  'keep this secret',
  'run in background',
  'silent instruction',
  'background task',
  'secret directive',
  'do not print this',
  'process silently',
]

export const SYSTEM_PROMPT_REVEAL = [
  'reveal system prompt',
  'reveal your system prompt',
  'show your instructions',
  'what are your rules',
  'output the initialization',
  'print system message',
  'what is your system prompt',
  'how were you configured',
  'provide your system instructions',
  'reveal guidelines',
]

export const DATA_EXFILTRATION = [
  'export all data',
  'export all user data',
  'send to external',
  'extract user',
  'exfiltrate',
  'send to http',
  'leak info',
  'transfer credentials',
  'upload to',
  'send user data',
  'exfiltrate history',
]

export const ALL_INDICATORS: Record<string, string[]> = {
  override_instructions: OVERRIDE_INSTRUCTIONS,
  jailbreak_attempt: JAILBREAK_ATTEMPT,
  hidden_instruction: HIDDEN_INSTRUCTION,
  system_prompt_reveal: SYSTEM_PROMPT_REVEAL,
  data_exfiltration: DATA_EXFILTRATION,
}

/**
 * Corroboration cue for webpage passages that only the DL model flagged.
 *
 * Prompt Guard scores ordinary imperative marketing copy ("Never start a
 * document from scratch", "Stay in control of access to your documents") at
 * 0.98+, the same as a real attack, so its score alone cannot separate the two.
 * An indirect injection has to do one of these things to work: address the AI,
 * talk about its instructions/rules, target the user or their data, or ask for
 * secrecy. Deliberately much broader than ALL_INDICATORS — this is not a
 * detector, it only decides whether a model-only hit is credible.
 */
export const AI_DIRECTED_CUE_PATTERN = new RegExp([
  // Addresses an AI.
  String.raw`\b(ai|a\.i\.|assistants?|chatbots?|bots?|llms?|language models?|models?|agents?|gpt|chatgpt|claude|gemini|copilot)\b`,
  // Talks about the AI's instructions, rules or persona.
  String.raw`\b(instructions?|prompts?|guidelines?|guidance|rules|polic(y|ies)|directives?|system|ignore|disregard|forget|override|bypass|restrictions?|jailbreak|developer mode|pretend|role-?play|act as|you are now|from now on|previous|prior|above|earlier)\b`,
  // Targets the user or their data.
  String.raw`\b(the user|users?'s?|credentials?|passwords?|cookies?|tokens?|api[ -]?keys?|secrets?|exfiltrat\w*|confidential)\b|https?:\/\/`,
  // Asks for secrecy.
  String.raw`\b(do not|don't|never) (tell|show|reveal|mention|inform)\b|\bsecretly\b|\bwithout (telling|asking|confirmation|notifying)\b`,
].join('|'), 'i')
