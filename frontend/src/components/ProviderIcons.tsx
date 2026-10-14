import type { ReactNode } from 'react'

export function ZenBrandIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 6H20L9 18H20"
        stroke="#ffffff"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="15.5" cy="11.5" r="1.5" fill="#ffffff" />
    </svg>
  )
}

export function GeminiBrandIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 2L13.8 8.2C14.4 10.2 16 11.8 18 12.4L24 14.2L18 16C16 16.6 14.4 18.2 13.8 20.2L12 26.4L10.2 20.2C9.6 18.2 8 16.6 6 16L0 14.2L6 12.4C8 11.8 9.6 10.2 10.2 8.2L12 2Z"
        transform="scale(0.8) translate(3, 3)"
        fill="#ffffff"
      />
    </svg>
  )
}

export function AnthropicBrandIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M14 4L7 20H10.5L12 16.5H17L18.5 20H22L15 4H14ZM12.9 13.5L14.5 9.5L16.1 13.5H12.9Z"
        fill="#ffffff"
      />
      <path d="M2.5 20L6 4H9.5L6 20H2.5Z" fill="#ffffff" opacity="0.6" />
    </svg>
  )
}

export function OpenAiBrandIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M22.28 9.87a5.98 5.98 0 0 0-.52-4.91 6.05 6.05 0 0 0-6.57-2.9 6.07 6.07 0 0 0-4.9-2.06 6.01 6.01 0 0 0-5.74 4.23 6 6 0 0 0-4.04 2.94 6.05 6.05 0 0 0 .74 7.15 5.98 5.98 0 0 0 .51 4.92 6.05 6.05 0 0 0 6.58 2.9 6.07 6.07 0 0 0 4.9 2.06 6.01 6.01 0 0 0 5.74-4.23 6 6 0 0 0 4.04-2.94 6.05 6.05 0 0 0-.74-7.16l-.34.2.34-.2ZM12.01 2.4c1.23 0 2.37.45 3.27 1.22l-.12.07-5.06 2.92a.84.84 0 0 0-.42.73v6.07l-1.8-1.04V6.97a4.52 4.52 0 0 1 4.13-4.57ZM3.87 6.64a4.49 4.49 0 0 1 2.21-2.45l.12.07 5.06 2.92c.26.15.42.43.42.73v2.09l-1.8 1.04-3.51-2.02a.84.84 0 0 0-.84 0l-1.66.96a4.5 4.5 0 0 1-.001-3.34v-.001Zm-.61 9.49a4.5 4.5 0 0 1-.48-3.26l.12.07 5.06 2.92c.26.15.58.15.84 0l3.52-2.03v2.08a.84.84 0 0 0 .42.73l1.66.96a4.52 4.52 0 0 1-5.88.94l-5.26-2.41Zm9.73 5.47a4.52 4.52 0 0 1-3.27-1.22l.12-.07 5.06-2.92a.84.84 0 0 0 .42-.73V10.6l1.8 1.04v5.39a4.52 4.52 0 0 1-4.13 4.57v-.13Zm8.14-4.24a4.49 4.49 0 0 1-2.21 2.45l-.12-.07-5.06-2.92a.84.84 0 0 0-.42-.73v-2.09l1.8-1.04 3.51 2.02a.84.84 0 0 0 .84 0l1.66-.96a4.5 4.5 0 0 1 0 3.34Zm.61-9.49a4.5 4.5 0 0 1 .48 3.26l-.12-.07-5.06-2.92a.84.84 0 0 0-.84 0l-3.52 2.03V8.89a.84.84 0 0 0-.42-.73l-1.66-.96a4.52 4.52 0 0 1 5.88-.94l5.26 2.41Zm-7.74 5.64 2.37-1.37v2.74l-2.37 1.37-2.37-1.37v-2.74l2.37 1.37Z" />
    </svg>
  )
}

export function NvidiaBrandIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8.88 15.65c-1.3-.14-2.19-.92-2.25-2.04-.05-1.08.79-1.94 2.07-2.14.6-.1 1.57-.04 2.29.15v2.85c-.63.8-1.4 1.25-2.11 1.18zm0-5.52c-2.21.16-3.8 1.7-3.72 3.63.08 2 1.88 3.51 4.21 3.57.93.02 1.99-.31 3-1v1.31h1.52V9.82c-1.52-.29-3.35-.29-5.01.09zm5.01 7.7c-1.58.87-3.33 1.26-4.9 1.15-3.98-.27-7.02-3.19-7.07-6.87C1.86 8.27 4.88 5.14 8.99 4.77c2.1-.19 4.24.33 5.98 1.49l-1.13 1.25c-1.4-.9-3.15-1.32-4.83-1.16-3.23.3-5.65 2.8-5.6 5.8.05 2.91 2.49 5.27 5.69 5.48 1.29.09 2.71-.23 3.98-.94l.8 1.15z" />
    </svg>
  )
}

export function RouterBrandIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="6" cy="12" r="3" stroke="#ffffff" strokeWidth="2" />
      <circle cx="18" cy="6" r="3" stroke="#ffffff" strokeWidth="2" />
      <circle cx="18" cy="18" r="3" stroke="#ffffff" strokeWidth="2" />
      <path d="M8.5 10.8L15.5 7.2M8.5 13.2L15.5 16.8" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

export function CustomBrandIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="1.8" aria-hidden="true">
      <rect x="3" y="4" width="18" height="6" rx="2" />
      <rect x="3" y="14" width="18" height="6" rx="2" />
      <circle cx="6.5" cy="7" r="0.8" fill="#ffffff" />
      <circle cx="6.5" cy="17" r="0.8" fill="#ffffff" />
      <line x1="14" y1="7" x2="17" y2="7" />
      <line x1="14" y1="17" x2="17" y2="17" />
    </svg>
  )
}

export function CloudflareBrandIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z" />
    </svg>
  )
}

export function OpenRouterBrandIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" stroke="#8b5cf6" strokeWidth="2.2" />
      <path d="M8 12L12 8L16 12L12 16Z" fill="#a78bfa" />
      <circle cx="12" cy="12" r="1.5" fill="#ffffff" />
    </svg>
  )
}

export function TokenRouterBrandIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" stroke="#0284c7" strokeWidth="2.2" />
      <path d="M8 9H16M12 9V17" stroke="#38bdf8" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="15" cy="15" r="1.8" fill="#0284c7" />
    </svg>
  )
}

export function NaraRouterBrandIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3.5" y="3.5" width="7.5" height="7.5" rx="2" fill="#10b981" />
      <rect x="13" y="13" width="7.5" height="7.5" rx="2" fill="#34d399" />
      <path d="M11 7H14.5C15.9 7 17 8.1 17 9.5V13" stroke="#10b981" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

export function OpenAdapterBrandIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" stroke="#f59e0b" strokeWidth="2.2" />
      <circle cx="8.5" cy="12" r="2" fill="#fbbf24" />
      <circle cx="15.5" cy="12" r="2" fill="#fbbf24" />
      <path d="M10.5 12H13.5" stroke="#f59e0b" strokeWidth="2.2" />
    </svg>
  )
}

/** The brand mark for a provider id, falling back to a generic one. */
export function ProviderLogo({ id, size = 18 }: { id?: string | null; size?: number }): ReactNode {
  if (!id) return <ZenBrandIcon size={size} />
  const norm = id.toLowerCase()
  if (norm === 'opencode' || norm.includes('zen')) return <ZenBrandIcon size={size} />
  if (norm.includes('gemini') || norm.includes('google')) return <GeminiBrandIcon size={size} />
  if (norm.includes('anthropic') || norm.includes('claude')) return <AnthropicBrandIcon size={size} />
  if (norm.includes('openai') || norm.includes('gpt')) return <OpenAiBrandIcon size={size} />
  if (norm.includes('nvidia') || norm.includes('nim')) return <NvidiaBrandIcon size={size} />
  if (norm.includes('cloudflare') || norm.includes('workers_ai') || norm.includes('cf')) return <CloudflareBrandIcon size={size} />
  if (norm.includes('openrouter')) return <OpenRouterBrandIcon size={size} />
  if (norm.includes('tokenrouter')) return <TokenRouterBrandIcon size={size} />
  if (norm.includes('nara')) return <NaraRouterBrandIcon size={size} />
  if (norm.includes('openadapter') || norm.includes('adapter')) return <OpenAdapterBrandIcon size={size} />
  if (norm.includes('agentrouter') || norm.includes('router')) return <RouterBrandIcon size={size} />
  return <CustomBrandIcon size={size} />
}
