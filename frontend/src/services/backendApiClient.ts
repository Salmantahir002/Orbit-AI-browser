import type {
  LlmResponse,
  SecurityCheckResponse,
  WebpageContent,
  ChatHistoryTurn,
  ChatAttachment,
} from '../types/securityTypes'

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




