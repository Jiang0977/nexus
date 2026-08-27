export const WINDOW_OUTPUT_POLL_TAIL_CHARS = 4096

export interface WindowOutputPollResult {
  output: string
  clients: number
  idleMs: number
  connected: boolean
}

type WindowRef = {
  index: number
}

type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<WindowOutputPollResult>
}>

export function buildWindowOutputRequestUrl(
  windowIndex: number,
  options: { session?: string; tailChars?: number } = {},
): string {
  const params = new URLSearchParams()
  if (options.session) {
    params.set('session', options.session)
  }
  params.set('tailChars', String(options.tailChars ?? WINDOW_OUTPUT_POLL_TAIL_CHARS))
  return `/api/sessions/${windowIndex}/output?${params.toString()}`
}

export function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'name' in error && error.name === 'AbortError')
}

export function createNonOverlappingPoller(run: () => Promise<void>): () => Promise<void> {
  let inFlight = false
  return async () => {
    if (inFlight) return
    inFlight = true
    try {
      await run()
    } finally {
      inFlight = false
    }
  }
}

export async function pollWindowOutputs(args: {
  windows: WindowRef[]
  session?: string
  token: string
  tailChars?: number
  fetchImpl?: FetchLike
  signal: AbortSignal
  onError?: (detail: { windowIndex: number; status?: number; error?: unknown }) => void
}): Promise<Record<number, WindowOutputPollResult> | undefined> {
  const fetchImpl = args.fetchImpl ?? fetch
  const outputs: Record<number, WindowOutputPollResult> = {}

  for (const win of args.windows) {
    if (args.signal.aborted) return undefined
    try {
      const response = await fetchImpl(
        buildWindowOutputRequestUrl(win.index, {
          session: args.session,
          tailChars: args.tailChars,
        }),
        {
          headers: { Authorization: `Bearer ${args.token}` },
          signal: args.signal,
        },
      )
      if (args.signal.aborted) return undefined
      if (response.ok) {
        outputs[win.index] = await response.json()
        if (args.signal.aborted) return undefined
        continue
      }
      args.onError?.({ windowIndex: win.index, status: response.status })
    } catch (error: unknown) {
      if (isAbortError(error) || args.signal.aborted) return undefined
      args.onError?.({ windowIndex: win.index, error })
    }
  }

  if (args.signal.aborted) return undefined
  return outputs
}
