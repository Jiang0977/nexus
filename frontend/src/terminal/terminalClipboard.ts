import type { Terminal as XTerm } from '@xterm/xterm'

type SelectedLogicalLine = {
  firstRow: number
  lastRow: number
  text: string
}

type JoinOptions = {
  columns?: number
  term?: XTerm
}

export const TERMINAL_SCROLLBACK_COPY_LINES = 10_000

const CONTINUATION_INDENT_PATTERN = /^ {1,4}(?=\S)/
const CJK_PATTERN = /[\u3400-\u9fff\uf900-\ufaff]/
const ASCII_WORD_PATTERN = /[A-Za-z0-9]/
const STRONG_LINE_END_PATTERN = /[。！？!?]/
const NON_BREAKING_SPACE_PATTERN = /\u00a0/g
const FALLBACK_CJK_WRAP_MIN_WIDTH = 40
const RIGHT_EDGE_TOLERANCE_COLUMNS = 3

function cellWidth(text: string): number {
  let width = 0
  for (const char of text) {
    width += CJK_PATTERN.test(char) ? 2 : 1
  }
  return width
}

function lastNonWhitespaceChar(text: string): string {
  const trimmed = text.trimEnd()
  return Array.from(trimmed).pop() || ''
}

function firstNonWhitespaceChar(text: string): string {
  const trimmed = text.trimStart()
  return Array.from(trimmed)[0] || ''
}

function isCjk(char: string): boolean {
  return CJK_PATTERN.test(char)
}

function isAsciiWord(char: string): boolean {
  return ASCII_WORD_PATTERN.test(char)
}

function lineLastContentColumn(term: XTerm, row: number): number {
  const buffer = term.buffer.active
  const line = buffer.getLine(row)
  if (!line) return -1

  const cell = buffer.getNullCell()
  const maxColumn = Math.min(term.cols, line.length) - 1
  for (let column = maxColumn; column >= 0; column -= 1) {
    const loaded = line.getCell(column, cell)
    if (!loaded) continue

    const chars = loaded.getChars()
    if (!chars || chars === ' ') continue

    return column + Math.max(loaded.getWidth(), 1)
  }

  return -1
}

function lineEndsNearRightEdge(term: XTerm, row: number): boolean {
  const lastColumn = lineLastContentColumn(term, row)
  return lastColumn >= term.cols - RIGHT_EDGE_TOLERANCE_COLUMNS
}

function getSelectedLogicalLines(term: XTerm, text: string): SelectedLogicalLine[] | null {
  const range = term.getSelectionPosition()
  if (!range) return null

  const startY = Math.min(range.start.y, range.end.y)
  const endY = Math.max(range.start.y, range.end.y)
  const lines: SelectedLogicalLine[] = []

  for (let row = startY; row <= endY; row += 1) {
    const bufferLine = term.buffer.active.getLine(row)
    if (row !== startY && bufferLine?.isWrapped && lines.length > 0) {
      lines[lines.length - 1].lastRow = row
      continue
    }

    lines.push({ firstRow: row, lastRow: row, text: '' })
  }

  const textLines = text.split(/\r\n|\n/)
  if (lines.length !== textLines.length) return null

  return lines.map((line, index) => ({
    ...line,
    text: textLines[index].replace(NON_BREAKING_SPACE_PATTERN, ' '),
  }))
}

function shouldJoinIndentedHardWrap(previous: SelectedLogicalLine, next: SelectedLogicalLine, options: JoinOptions = {}): boolean {
  if (!CONTINUATION_INDENT_PATTERN.test(next.text)) return false

  const previousLast = lastNonWhitespaceChar(previous.text)
  const nextBody = next.text.replace(CONTINUATION_INDENT_PATTERN, '')
  const nextFirst = firstNonWhitespaceChar(nextBody)
  if (!previousLast || !nextFirst) return false
  if (STRONG_LINE_END_PATTERN.test(previousLast)) return false
  if (/^[-*+•#>$|`[{(<]/.test(nextBody)) return false

  const isCjkWordSplit = isCjk(previousLast) && isCjk(nextFirst)
  const isWordContinuation = isCjk(previousLast)
    || isCjk(nextFirst)
    || (isAsciiWord(previousLast) && isAsciiWord(nextFirst))
  if (!isWordContinuation) return false

  if (options.term && lineEndsNearRightEdge(options.term, previous.lastRow)) return true

  const previousWidth = cellWidth(previous.text)
  if (options.columns && previousWidth >= options.columns - RIGHT_EDGE_TOLERANCE_COLUMNS) return true

  return isCjkWordSplit && previousWidth >= FALLBACK_CJK_WRAP_MIN_WIDTH
}

function joinContinuationText(previous: string, next: string): string {
  const nextBody = next.replace(CONTINUATION_INDENT_PATTERN, '')
  const previousLast = lastNonWhitespaceChar(previous)
  const nextFirst = firstNonWhitespaceChar(nextBody)
  const separator = isAsciiWord(previousLast) && isAsciiWord(nextFirst) ? ' ' : ''
  return `${previous.trimEnd()}${separator}${nextBody}`
}

function normalizeLogicalLines(lines: SelectedLogicalLine[], newline: string, options: JoinOptions = {}): string {
  if (lines.length < 2) return lines.map((line) => line.text).join(newline)

  const mergedLines: SelectedLogicalLine[] = []
  for (const line of lines) {
    const previous = mergedLines[mergedLines.length - 1]
    if (previous && shouldJoinIndentedHardWrap(previous, line, options)) {
      previous.text = joinContinuationText(previous.text, line.text)
      previous.lastRow = line.lastRow
      continue
    }
    mergedLines.push({ ...line })
  }

  return mergedLines.map((line) => line.text).join(newline)
}

export function getTerminalSelectionText(term: XTerm): string {
  if (!term.hasSelection()) return ''
  const text = term.getSelection()
  const lines = getSelectedLogicalLines(term, text)
  if (!lines || lines.length < 2) return text

  return normalizeLogicalLines(lines, text.includes('\r\n') ? '\r\n' : '\n', { term })
}

export function normalizeTerminalScrollbackText(text: string, options: { columns?: number } = {}): string {
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const rawLines = text.split(/\r\n|\n/)
  const lines = rawLines.map((line, index) => ({
    firstRow: index,
    lastRow: index,
    text: line.replace(NON_BREAKING_SPACE_PATTERN, ' '),
  }))
  return normalizeLogicalLines(lines, newline, { columns: options.columns })
}

export function getTerminalBufferText(term: XTerm): string {
  const buffer = term.buffer.active
  const lines: SelectedLogicalLine[] = []

  for (let row = 0; row < buffer.length; row += 1) {
    const bufferLine = buffer.getLine(row)
    if (!bufferLine) continue

    const text = bufferLine.translateToString(true).replace(NON_BREAKING_SPACE_PATTERN, ' ')
    if (row !== 0 && bufferLine.isWrapped && lines.length > 0) {
      const previous = lines[lines.length - 1]
      previous.text += text
      previous.lastRow = row
      continue
    }

    lines.push({ firstRow: row, lastRow: row, text })
  }

  return normalizeLogicalLines(lines, '\n', { columns: term.cols, term })
}

function positionTextareaAtPointer(textarea: HTMLTextAreaElement, screen: HTMLElement, event: MouseEvent) {
  const rect = screen.getBoundingClientRect()
  textarea.style.width = '20px'
  textarea.style.height = '20px'
  textarea.style.left = `${event.clientX - rect.left - 10}px`
  textarea.style.top = `${event.clientY - rect.top - 10}px`
  textarea.style.zIndex = '1000'
}

export function prepareTerminalSelectionForNativeCopy(
  term: XTerm,
  container: HTMLElement,
  event: MouseEvent,
): boolean {
  const text = getTerminalSelectionText(term)
  const textarea = term.textarea
  if (!text || !textarea) return false

  const screen = container.querySelector('.xterm-screen')
  if (screen instanceof HTMLElement) {
    positionTextareaAtPointer(textarea, screen, event)
  }

  textarea.value = text
  textarea.focus({ preventScroll: true })
  textarea.select()
  return true
}

export function writeTerminalSelectionToClipboardEvent(term: XTerm, event: ClipboardEvent): boolean {
  const text = getTerminalSelectionText(term)
  if (!text || !event.clipboardData) return false

  event.clipboardData.setData('text/plain', text)
  event.preventDefault()
  return true
}
