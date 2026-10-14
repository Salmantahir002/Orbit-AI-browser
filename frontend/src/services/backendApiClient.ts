import type {
  LlmResponse,
  SecurityCheckResponse,
  WebpageContent,
  ChatHistoryTurn,
  ChatAttachment,
  ScanSummary,
  SecuritySource,
} from '../types/securityTypes'
import type { AnalysisDetails } from '../types/analysisDetailsTypes'

const API_BASE_URL = 'http://127.0.0.1:8000/api/v1'

async function requestJson<TResponse>(path: string, init?: RequestInit): Promise<TResponse> {
  let response: Response

  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      headers: {
        'Content-Type': 'application/json',
        ...init?.headers,
      },
      ...init,
    })
  } catch (err) {
    throw new Error(
      `Backend is not reachable (${err instanceof Error ? err.message : 'connection refused'}). Start Electron with npm run electron:start or run backend on port 8000.`,
      { cause: err },
    )
  }

  if (!response.ok) {
    const errorText = await response.text()
    try {
      const parsed = JSON.parse(errorText)
      if (parsed.detail) throw new Error(parsed.detail)
      if (parsed.message) throw new Error(parsed.message)
    } catch (e) {
      if (e instanceof Error && e.message !== errorText) throw e
    }
    throw new Error(errorText || `Request failed with status ${response.status}`)
  }

  return response.json() as Promise<TResponse>
}


export function checkPrompt(prompt: string): Promise<SecurityCheckResponse> {
  return requestJson<SecurityCheckResponse>('/security/check-prompt', {
    method: 'POST',
    body: JSON.stringify({ prompt }),
  })
}

export function checkWebpage(content: WebpageContent): Promise<SecurityCheckResponse> {
  return requestJson<SecurityCheckResponse>('/security/check-webpage', {
    method: 'POST',
    body: JSON.stringify(content),
  })
}

/** Sends a finished scan's output to the active provider for a plain-language summary. */
export function explainScan(
  source: SecuritySource,
  analysisDetails: AnalysisDetails,
  page?: Pick<WebpageContent, 'url' | 'page_title'>,
): Promise<ScanSummary> {
  return requestJson<ScanSummary>('/security/explain-scan', {
    method: 'POST',
    body: JSON.stringify({ source, url: page?.url, page_title: page?.page_title, analysis_details: analysisDetails }),
  })
}

export type ChatPageContext = {
  page_url?: string
  page_title?: string
  page_content?: string
}

export function chatWithLlm(
  prompt: string,
  pageContext?: ChatPageContext,
  history?: ChatHistoryTurn[],
  attachments?: ChatAttachment[],
): Promise<LlmResponse> {
  return requestJson<LlmResponse>('/llm/chat', {
    method: 'POST',
    body: JSON.stringify({
      prompt,
      page_url: pageContext?.page_url,
      page_title: pageContext?.page_title,
      page_content: pageContext?.page_content,
      history,
      attachments: attachments?.map((a) => ({
        name: a.name,
        type: a.type,
        data: a.data,
        isImage: a.isImage,
        size: a.size,
        textContent: a.textContent,
      })),
    }),
  })
}




