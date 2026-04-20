const STORAGE_KEY = 'nexus_token'

export function buildAuthHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

/** Parse API error response into a user-friendly message.
 *  For 401, clears the token and reloads (auto-logout). */
export async function parseApiError(r: Response, fallback?: string): Promise<string> {
  if (r.status === 401) {
    localStorage.removeItem(STORAGE_KEY)
    window.location.reload()
    return ''
  }
  try {
    const data = await r.json()
    if (data?.error) return data.error
  } catch {
    // response body not JSON
  }
  const statusMessages: Record<number, string> = {
    400: '请求参数有误',
    403: '无访问权限',
    404: '资源不存在',
    409: '操作冲突，可能已存在',
    500: '服务器内部错误',
    502: '网关错误，服务可能未启动',
    503: '服务暂时不可用',
  }
  return statusMessages[r.status] ?? fallback ?? `请求失败 (${r.status})`
}

/** Friendly message when fetch() itself throws (network unreachable). */
export function parseNetworkError(error: unknown): string {
  if (error instanceof TypeError) return '无法连接服务器，请检查服务是否已启动'
  if (error instanceof Error) return error.message
  return '未知错误'
}
