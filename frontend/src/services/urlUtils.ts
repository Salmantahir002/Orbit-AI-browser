const PROTOCOL_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//
const LOCALHOST_PATTERN = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/.*)?$/i

function shouldTreatAsSearch(input: string): boolean {
  if (input.includes(' ') || input.includes('\t')) {
    return true
  }

  return !input.includes('.') && !LOCALHOST_PATTERN.test(input)
}

export function normalizeUrl(input: string): string {
  const trimmedInput = input.trim()

  if (!trimmedInput) {
    throw new Error('Enter a URL')
  }

  if (!PROTOCOL_PATTERN.test(trimmedInput) && shouldTreatAsSearch(trimmedInput)) {
    return `https://www.google.com/search?q=${encodeURIComponent(trimmedInput)}`
  }

  const urlWithProtocol = PROTOCOL_PATTERN.test(trimmedInput)
    ? trimmedInput
    : `https://${trimmedInput}`

  if (!isValidUrl(urlWithProtocol)) {
    throw new Error('Enter a valid URL')
  }

  return urlWithProtocol
}

const COMMON_SITES: Record<string, string> = {
  youtube: 'https://www.youtube.com',
  github: 'https://github.com',
  google: 'https://www.google.com',
  twitter: 'https://twitter.com',
  x: 'https://x.com',
  reddit: 'https://www.reddit.com',
  facebook: 'https://www.facebook.com',
  instagram: 'https://www.instagram.com',
  linkedin: 'https://www.linkedin.com',
  wikipedia: 'https://www.wikipedia.org',
  netflix: 'https://www.netflix.com',
  twitch: 'https://www.twitch.tv',
  amazon: 'https://www.amazon.com',
}

export function resolveNavigationUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed || trimmed === 'about:blank') return 'about:blank'

  const lower = trimmed.toLowerCase()
  if (COMMON_SITES[lower]) {
    return COMMON_SITES[lower]
  }

  return normalizeUrl(trimmed)
}

export function extractDomainForFavicon(inputUrl: string): string | null {
  if (!inputUrl || inputUrl === 'about:blank') return null
  const clean = inputUrl.trim()
  if (!clean || clean === 'about:blank') return null

  const lower = clean.toLowerCase()
  if (COMMON_SITES[lower]) {
    try {
      return new URL(COMMON_SITES[lower]).hostname.replace(/^www\./, '')
    } catch {
      return `${lower}.com`
    }
  }

  try {
    const fullUrl = clean.includes('://') ? clean : `https://${clean}`
    const parsed = new URL(fullUrl)
    let host = parsed.hostname.toLowerCase().replace(/^www\./, '')
    if (host === 'localhost' || host === '127.0.0.1') return null
    if (!host.includes('.')) {
      host = `${host}.com`
    }
    return host
  } catch {
    return null
  }
}

export function getFaviconCandidates(url: string, explicitFavicon?: string): string[] {
  const candidates: string[] = []
  if (explicitFavicon && explicitFavicon.trim()) {
    candidates.push(explicitFavicon.trim())
  }

  const domain = extractDomainForFavicon(url)
  if (domain) {
    const s2Url = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`
    if (!candidates.includes(s2Url)) {
      candidates.push(s2Url)
    }
    const ddgUrl = `https://icons.duckduckgo.com/ip3/${domain}.ico`
    if (!candidates.includes(ddgUrl)) {
      candidates.push(ddgUrl)
    }
  }

  return candidates
}

function isValidUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url)
    return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:'
  } catch {
    return false
  }
}

