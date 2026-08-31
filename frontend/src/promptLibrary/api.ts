import { buildAuthHeaders, parseApiError, parseNetworkError } from '../sessionManager/api'

export const MAX_PROMPT_TITLE_CHARS = 160
export const MAX_PROMPT_CONTENT_CHARS = 200_000

export interface PromptRecord {
  id: string
  title: string
  content: string
  createdAt: string
  updatedAt: string
}

export interface PromptLibraryResponse {
  version: number
  prompts: PromptRecord[]
}

export interface PromptInput {
  title: string
  content: string
}

async function request<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  try {
    const response = await fetch(path, {
      ...init,
      headers: {
        ...buildAuthHeaders(token),
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    })
    if (!response.ok) {
      throw new Error(await parseApiError(response, 'Prompt library request failed'))
    }
    return await response.json() as T
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    if (error instanceof Error && error.message) throw error
    throw new Error(parseNetworkError(error))
  }
}

export function listPrompts(token: string, signal?: AbortSignal): Promise<PromptLibraryResponse> {
  return request<PromptLibraryResponse>(token, '/api/prompt-library', { signal })
}

export function createPrompt(token: string, input: PromptInput): Promise<PromptRecord> {
  return request<PromptRecord>(token, '/api/prompt-library', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function updatePrompt(token: string, id: string, input: PromptInput): Promise<PromptRecord> {
  return request<PromptRecord>(token, `/api/prompt-library/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  })
}

export function deletePrompt(token: string, id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(token, `/api/prompt-library/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}
