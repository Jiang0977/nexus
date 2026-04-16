import { execSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, normalize } from 'node:path'

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50

function normalizePath(value = '') {
  if (!value) return ''
  return normalize(value).replace(/\\/g, '/').replace(/\/+$/, '') || '/'
}

function isSameOrNestedPath(parentPath, childPath) {
  const parent = normalizePath(parentPath)
  const child = normalizePath(childPath)
  if (!parent || !child) return false
  return child === parent || child.startsWith(`${parent}/`)
}

function parseJsonlLines(text) {
  return String(text || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
}

function optionalText(value) {
  const text = String(value || '').trim()
  return text || ''
}

function readFirstLine(filePath) {
  const fd = openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(4096)
  let content = ''

  try {
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null)
      if (!bytesRead) break
      content += buffer.subarray(0, bytesRead).toString('utf8')
      const newlineIndex = content.indexOf('\n')
      if (newlineIndex !== -1) {
        return content.slice(0, newlineIndex).trim()
      }
    }
    return content.trim()
  } finally {
    closeSync(fd)
  }
}

function collectSessionFiles(rootDir) {
  if (!existsSync(rootDir)) return []
  const files = []
  const stack = [rootDir]

  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
        continue
      }
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(fullPath)
      }
    }
  }

  return files
}

function loadSessionIndex(codexHome) {
  const sessionIndexPath = join(codexHome, 'session_index.jsonl')
  if (!existsSync(sessionIndexPath)) {
    return { entries: [], badIndexLines: 0 }
  }

  let badIndexLines = 0
  const entries = []
  for (const line of parseJsonlLines(readFileSync(sessionIndexPath, 'utf8'))) {
    try {
      const parsed = JSON.parse(line)
      if (!parsed?.id) {
        badIndexLines += 1
        continue
      }
      entries.push({
        id: String(parsed.id),
        title: normalizeTitle(parsed.thread_name),
        updatedAt: parsed.updated_at ? String(parsed.updated_at) : '',
      })
    } catch {
      badIndexLines += 1
    }
  }

  entries.sort((left, right) => {
    const leftTs = Date.parse(left.updatedAt || '') || 0
    const rightTs = Date.parse(right.updatedAt || '') || 0
    return rightTs - leftTs
  })

  return { entries, badIndexLines }
}

function removeSessionIndexEntry(codexHome, sessionId) {
  const sessionIndexPath = join(codexHome, 'session_index.jsonl')
  if (!existsSync(sessionIndexPath)) return

  const remainingLines = []
  for (const rawLine of String(readFileSync(sessionIndexPath, 'utf8') || '').split('\n')) {
    const line = rawLine.trim()
    if (!line) continue

    try {
      const parsed = JSON.parse(line)
      if (String(parsed?.id || '') === sessionId) {
        continue
      }
    } catch {
      // Preserve malformed lines so delete does not silently rewrite unrelated corruption.
    }

    remainingLines.push(line)
  }

  writeFileSync(
    sessionIndexPath,
    remainingLines.length > 0 ? `${remainingLines.join('\n')}\n` : '',
    'utf8',
  )
}

function loadSessionMetaMap(codexHome) {
  const sessionsRoot = join(codexHome, 'sessions')
  const sessionFiles = collectSessionFiles(sessionsRoot)
  const sessionMetaById = new Map()
  let badSessionFiles = 0

  for (const filePath of sessionFiles) {
    try {
      const firstLine = readFirstLine(filePath)
      if (!firstLine) {
        badSessionFiles += 1
        continue
      }
      const parsed = JSON.parse(firstLine)
      if (parsed?.type !== 'session_meta' || !parsed?.payload?.id) {
        badSessionFiles += 1
        continue
      }

      sessionMetaById.set(String(parsed.payload.id), {
        filePath,
        cwd: normalizePath(parsed.payload.cwd || ''),
        timestamp: String(parsed.payload.timestamp || parsed.timestamp || ''),
        source: optionalText(parsed.payload.source),
        originator: optionalText(parsed.payload.originator),
        cliVersion: optionalText(parsed.payload.cli_version),
        modelProvider: optionalText(parsed.payload.model_provider),
      })
    } catch {
      badSessionFiles += 1
    }
  }

  return { sessionMetaById, badSessionFiles }
}

function normalizeTitle(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > 120 ? `${text.slice(0, 117)}...` : text
}

function fallbackTitle(sessionId, cwd) {
  const normalizedCwd = normalizePath(cwd)
  const lastSegment = normalizedCwd.split('/').filter(Boolean).pop()
  return lastSegment || `Session ${String(sessionId).slice(0, 8)}`
}

function parseLimit(limit) {
  const value = Number.parseInt(String(limit || DEFAULT_LIMIT), 10)
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_LIMIT
  return Math.min(value, MAX_LIMIT)
}

function parseCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === '') return 0
  const value = Number.parseInt(String(cursor), 10)
  if (!Number.isFinite(value) || value <= 0) return 0
  return value
}

function buildWarning({ badIndexLines, badSessionFiles, missingSessionFiles, cwdFallbackMatches }) {
  const codes = []
  if (badIndexLines > 0 || badSessionFiles > 0 || missingSessionFiles > 0) {
    codes.push('partial_results')
  }
  if (cwdFallbackMatches > 0) {
    codes.push('attribution_unavailable')
  }
  if (codes.length === 0) return null

  let message = '部分历史会话结果不可用。'
  if (codes.length === 1 && codes[0] === 'attribution_unavailable') {
    message = '部分历史会话只能按工作目录匹配，归属信息可能不完整。'
  } else if (codes.length === 2) {
    message = '部分历史会话结果不完整，且部分条目只能按工作目录匹配。'
  }

  return { codes, message }
}

export function resolveGitRoot(cwd, { execSyncImpl = execSync } = {}) {
  const normalizedCwd = normalizePath(cwd)
  if (!normalizedCwd) return ''
  try {
    return normalizePath(
      execSyncImpl(`git -C ${JSON.stringify(normalizedCwd)} rev-parse --show-toplevel 2>/dev/null`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    )
  } catch {
    return ''
  }
}

function collectProjectCodexSessions({
  projectName,
  projectPath,
  codexHome,
  resolveGitRoot: resolveGitRootImpl = resolveGitRoot,
}) {
  const normalizedProjectPath = normalizePath(projectPath)
  const projectRepoRoot = resolveGitRootImpl(normalizedProjectPath) || ''
  const { entries, badIndexLines } = loadSessionIndex(codexHome)
  const { sessionMetaById, badSessionFiles } = loadSessionMetaMap(codexHome)
  const sessionIndexById = new Map()
  const items = []
  let missingSessionFiles = 0
  let cwdFallbackMatches = 0

  for (const entry of entries) {
    if (!sessionIndexById.has(entry.id)) {
      sessionIndexById.set(entry.id, entry)
    }
    if (!sessionMetaById.has(entry.id)) {
      missingSessionFiles += 1
    }
  }

  for (const [sessionId, meta] of sessionMetaById.entries()) {
    const sessionCwd = normalizePath(meta.cwd)
    if (!sessionCwd) continue

    const sessionRepoRoot = resolveGitRootImpl(sessionCwd) || ''
    let attributionKind = ''

    if (projectRepoRoot && sessionRepoRoot) {
      if (projectRepoRoot !== sessionRepoRoot) {
        continue
      }
      attributionKind = 'repo-root'
    } else if (projectRepoRoot) {
      if (!isSameOrNestedPath(normalizedProjectPath, sessionCwd)) {
        continue
      }
      attributionKind = 'cwd'
      cwdFallbackMatches += 1
    } else if (sessionCwd === normalizedProjectPath) {
      attributionKind = 'cwd'
      cwdFallbackMatches += 1
    } else {
      continue
    }

    const entry = sessionIndexById.get(sessionId)
    items.push({
      id: sessionId,
      title: entry?.title || fallbackTitle(sessionId, sessionCwd),
      updatedAt: entry?.updatedAt || meta.timestamp || '',
      cwd: sessionCwd,
      attributionKind,
    })
  }

  items.sort((left, right) => {
    const leftTs = Date.parse(left.updatedAt || '') || 0
    const rightTs = Date.parse(right.updatedAt || '') || 0
    if (rightTs !== leftTs) return rightTs - leftTs
    return String(left.id).localeCompare(String(right.id))
  })

  return {
    scope: {
      project: projectName,
      path: normalizedProjectPath,
      repoRoot: projectRepoRoot,
      summary: projectRepoRoot
        ? `repo root: ${projectRepoRoot}`
        : `cwd: ${normalizedProjectPath}`,
    },
    items,
    warning: buildWarning({
      badIndexLines,
      badSessionFiles,
      missingSessionFiles,
      cwdFallbackMatches,
    }),
  }
}

export function listProjectCodexSessions({
  projectName,
  projectPath,
  codexHome,
  limit = DEFAULT_LIMIT,
  cursor = 0,
  resolveGitRoot: resolveGitRootImpl = resolveGitRoot,
}) {
  const pageSize = parseLimit(limit)
  const offset = parseCursor(cursor)
  const result = collectProjectCodexSessions({
    projectName,
    projectPath,
    codexHome,
    resolveGitRoot: resolveGitRootImpl,
  })

  const pageItems = result.items.slice(offset, offset + pageSize)
  const nextCursor = result.items.length > offset + pageSize ? String(offset + pageSize) : null

  return {
    scope: result.scope,
    items: pageItems,
    nextCursor,
    warning: result.warning,
  }
}

export function findProjectCodexSession({
  sessionId,
  projectName,
  projectPath,
  codexHome,
  resolveGitRoot: resolveGitRootImpl = resolveGitRoot,
}) {
  const result = collectProjectCodexSessions({
    projectName,
    projectPath,
    codexHome,
    resolveGitRoot: resolveGitRootImpl,
  })
  return result.items.find(item => item.id === sessionId) || null
}

export function getProjectCodexSessionDetail({
  sessionId,
  projectName,
  projectPath,
  codexHome,
  resolveGitRoot: resolveGitRootImpl = resolveGitRoot,
}) {
  const summary = findProjectCodexSession({
    sessionId,
    projectName,
    projectPath,
    codexHome,
    resolveGitRoot: resolveGitRootImpl,
  })
  if (!summary) return null

  const { sessionMetaById } = loadSessionMetaMap(codexHome)
  const meta = sessionMetaById.get(String(sessionId || '').trim())
  if (!meta) return null

  return {
    id: summary.id,
    title: summary.title,
    updatedAt: summary.updatedAt,
    startedAt: meta.timestamp || '',
    cwd: summary.cwd,
    attributionKind: summary.attributionKind,
    source: meta.source || '',
    originator: meta.originator || '',
    cliVersion: meta.cliVersion || '',
    modelProvider: meta.modelProvider || '',
  }
}

export function deleteCodexSession({
  sessionId,
  codexHome,
}) {
  const normalizedSessionId = String(sessionId || '').trim()
  if (!normalizedSessionId) {
    throw new Error('session id required')
  }

  const { sessionMetaById } = loadSessionMetaMap(codexHome)
  const meta = sessionMetaById.get(normalizedSessionId)

  if (!meta?.filePath || !existsSync(meta.filePath)) {
    throw new Error(`codex session file not found for session ${normalizedSessionId}`)
  }

  unlinkSync(meta.filePath)
  removeSessionIndexEntry(codexHome, normalizedSessionId)

  return {
    id: normalizedSessionId,
    filePath: meta.filePath,
  }
}
