import https from 'node:https'
import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { shellQuote } from './shellLaunch.js'

const TELEGRAM_RUNNING_INTERVAL_MS = 5000

const TELEGRAM_START_MESSAGE = '👋 *Nexus Bot* 已就绪\n\n发送任意文字，我会用 `claude -p` 在你的服务器上执行并回复结果。\n\n发送图片或文件，我会保存到当前 session 目录。\n\n`/sessions` — 查看 tmux 窗口列表\n`/switch <编号>` — 切换目标窗口'

export class TelegramBridgeError extends Error {
  constructor(statusCode, message, options = {}) {
    super(message)
    this.name = 'TelegramBridgeError'
    this.statusCode = statusCode
    this.responseBody = options.responseBody || null
  }
}

function formatTelegramProgressMessage(sessionName, preview = '') {
  if (!preview) {
    return `⏳ *执行中*（session: \`${sessionName}\`）\n\n_等待输出..._`
  }
  return `⏳ *执行中*（session: \`${sessionName}\`）\n\`\`\`\n${preview}\n\`\`\``
}

function formatTelegramDoneMessage(sessionName, exitCode, result) {
  const status = exitCode === 0 ? '✅' : '❌'
  return `${status} *执行完成*（session: \`${sessionName}\`）\n\`\`\`\n${result}\n\`\`\``
}

function truncateTail(text, maxLength) {
  return text.length > maxLength ? `…${text.slice(-maxLength)}` : text
}

function truncateHead(text, maxLength) {
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n\n…(输出已截断)` : text
}

function defaultTelegramRequest(botToken, requestImpl, method, payload, log) {
  if (!botToken) return Promise.resolve(null)
  return new Promise((resolve) => {
    const body = JSON.stringify(payload)
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }
    const req = requestImpl(
      `https://api.telegram.org/bot${botToken}/${method}`,
      options,
      (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch {
            resolve(null)
          }
        })
      },
    )
    req.on('error', (error) => {
      log.error?.(`Telegram ${method} error:`, error.message)
      resolve(null)
    })
    req.write(body)
    req.end()
  })
}

function defaultHttpsGetJson(getImpl, url) {
  return new Promise((resolve, reject) => {
    getImpl(url, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => resolve(data))
      res.on('error', reject)
    }).on('error', reject)
  })
}

function defaultListTmuxWindows(execSyncImpl, sessionName) {
  const stdout = execSyncImpl(
    `tmux list-windows -t ${shellQuote(sessionName)} -F "#{window_index}|#{window_name}|#{pane_current_path}|#{window_active}" 2>/dev/null`,
    { encoding: 'utf8' },
  ).trim()

  if (!stdout) return []

  return stdout.split('\n').filter(Boolean).map((line) => {
    const parts = line.split('|')
    return {
      index: Number(parts[0]),
      name: parts[1] || '',
      cwd: parts[2] || '',
      active: parts[3]?.trim() === '1',
    }
  })
}

/**
 * @typedef {{
 *   botToken?: string,
 *   webhookSecret?: string,
 *   tmuxSession?: string,
 *   telegramDefaultSession?: string,
 *   workspaceRoot: string,
 *   taskRunner?: { runTask: Function },
 *   taskStore?: { updateTask?: Function },
 *   sendMessageImpl?: (chatId: number|string, text: string) => Promise<number|null> | number | null,
 *   editMessageImpl?: (chatId: number|string, messageId: number|string, text: string) => Promise<void> | void,
 *   downloadTelegramFileImpl?: (fileId: string, destDir: string, filename: string) => Promise<{ path: string, size: number }>,
 *   listTmuxWindowsImpl?: (sessionName: string) => Array<{ index: number, name: string, cwd: string, active: boolean }>,
 *   selectTmuxWindowImpl?: (sessionName: string, target: string) => Promise<void> | void,
 *   setWebhookImpl?: (input: { webhookUrl: string, secretToken: string }) => Promise<any>,
 *   setIntervalImpl?: typeof setInterval,
 *   clearIntervalImpl?: typeof clearInterval,
 *   nowImpl?: () => number,
 *   httpsRequestImpl?: typeof https.request,
 *   httpsGetImpl?: typeof https.get,
 *   execSyncImpl?: typeof execSync,
 *   writeFileSyncImpl?: typeof writeFileSync,
 *   log?: { error?: Function },
 * }} TelegramBridgeServiceOptions
 */

/** @param {TelegramBridgeServiceOptions} options */
export function createTelegramBridgeService(options) {
  const {
    botToken = '',
    webhookSecret = '',
    tmuxSession = '~',
    telegramDefaultSession = '',
    workspaceRoot,
    taskRunner = null,
    taskStore = null,
    sendMessageImpl,
    editMessageImpl,
    downloadTelegramFileImpl,
    listTmuxWindowsImpl,
    selectTmuxWindowImpl,
    setWebhookImpl,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    nowImpl = Date.now,
    httpsRequestImpl = https.request,
    httpsGetImpl = https.get,
    execSyncImpl = execSync,
    writeFileSyncImpl = writeFileSync,
    log = console,
  } = options

  const sendMessage = sendMessageImpl || (async (chatId, text) => {
    const result = await defaultTelegramRequest(
      botToken,
      httpsRequestImpl,
      'sendMessage',
      { chat_id: chatId, text, parse_mode: 'Markdown' },
      log,
    )
    return result?.result?.message_id ?? null
  })

  const editMessage = editMessageImpl || ((chatId, messageId, text) => {
    if (!messageId) return
    void defaultTelegramRequest(
      botToken,
      httpsRequestImpl,
      'editMessageText',
      { chat_id: chatId, message_id: messageId, text, parse_mode: 'Markdown' },
      log,
    )
  })

  const listTmuxWindows = listTmuxWindowsImpl || ((sessionName) => defaultListTmuxWindows(execSyncImpl, sessionName))

  const selectTmuxWindow = selectTmuxWindowImpl || ((sessionName, target) => {
    execSyncImpl(`tmux select-window -t ${shellQuote(`${sessionName}:${target}`)} 2>/dev/null`)
  })

  const downloadTelegramFile = downloadTelegramFileImpl || (async (fileId, destDir, filename) => {
    const infoRaw = await defaultHttpsGetJson(
      httpsGetImpl,
      `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`,
    )
    const info = JSON.parse(infoRaw)
    if (!info.ok) {
      throw new Error(`getFile failed: ${info.description}`)
    }
    const filePath = info.result.file_path
    const buffer = await new Promise((resolve, reject) => {
      httpsGetImpl(`https://api.telegram.org/file/bot${botToken}/${filePath}`, (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve(Buffer.concat(chunks)))
        res.on('error', reject)
      }).on('error', reject)
    })
    const destPath = join(destDir, filename)
    writeFileSyncImpl(destPath, buffer)
    return { path: destPath, size: buffer.length }
  })

  const setupWebhookRequest = setWebhookImpl || (async ({ webhookUrl, secretToken }) => {
    const secretParam = secretToken ? `&secret_token=${secretToken}` : ''
    const raw = await defaultHttpsGetJson(
      httpsGetImpl,
      `https://api.telegram.org/bot${botToken}/setWebhook?url=${encodeURIComponent(webhookUrl)}${secretParam}`,
    )
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  })

  function ensureConfigured(message = 'Telegram not configured') {
    if (!botToken) {
      throw new TelegramBridgeError(503, message)
    }
  }

  function verifyWebhookRequest(headers = {}) {
    if (webhookSecret) {
      const secret = headers['x-telegram-bot-api-secret-token']
      if (secret !== webhookSecret) {
        throw new TelegramBridgeError(403, 'forbidden')
      }
    }
    ensureConfigured('Telegram not configured')
  }

  async function sendSafe(chatId, text) {
    return Promise.resolve(sendMessage(chatId, text))
  }

  function editSafe(chatId, messageId, text) {
    return Promise.resolve(editMessage(chatId, messageId, text)).catch((error) => {
      log.error?.('telegram edit error:', error)
    })
  }

  function updateTaskSafe(taskId, patch) {
    if (!taskId || !taskStore?.updateTask) return
    try {
      taskStore.updateTask(taskId, patch)
    } catch (error) {
      log.error?.('telegram task update error:', error)
    }
  }

  function resolvePromptTarget() {
    let cwd = workspaceRoot
    let sessionName = telegramDefaultSession

    try {
      const windows = listTmuxWindows(tmuxSession)
      for (const window of windows) {
        if (telegramDefaultSession && window.name === telegramDefaultSession) {
          cwd = window.cwd || cwd
          sessionName = window.name
          break
        }
      }
      if (!sessionName) {
        const activeWindow = windows.find((window) => window.active)
        if (activeWindow) {
          sessionName = activeWindow.name
          cwd = activeWindow.cwd || cwd
        }
      }
    } catch {}

    return { cwd, sessionName }
  }

  function resolveUploadDirectory() {
    let cwd = workspaceRoot
    try {
      const activeWindow = listTmuxWindows(tmuxSession).find((window) => window.active)
      if (activeWindow?.cwd) cwd = activeWindow.cwd
    } catch {}
    return cwd
  }

  async function handleSessionsCommand(chatId) {
    try {
      const windows = listTmuxWindows(tmuxSession)
      const lines = windows.map((window) => `${window.active ? '▶' : '  '} \`${window.index}: ${window.name}\``)
      await sendSafe(chatId, `*当前 tmux 窗口:*\n${lines.join('\n')}\n\n用 \`/switch <编号>\` 切换`)
    } catch (error) {
      await sendSafe(chatId, `❌ 无法获取会话列表: ${error.message}`)
    }
  }

  async function handleSwitchCommand(chatId, text) {
    const rawTarget = String(text || '').trim().slice('/switch '.length).trim()
    const target = rawTarget.replace(/[^a-zA-Z0-9_\-]/g, '')
    if (!target) {
      await sendSafe(chatId, '❌ 无效的窗口名称，只允许字母/数字/下划线/连字符')
      return
    }

    try {
      await Promise.resolve(selectTmuxWindow(tmuxSession, target))
      await sendSafe(chatId, `✅ 已切换到窗口 \`${target}\`\n\n后续任务将在此窗口执行。`)
    } catch (error) {
      await sendSafe(chatId, `❌ 无法切换到窗口 \`${target}\`: ${error.message}`)
    }
  }

  async function runTelegramPrompt(chatId, prompt, cwd, sessionName) {
    if (!taskRunner?.runTask) return

    const displaySessionName = sessionName || 'default'
    const taskSessionName = sessionName || 'telegram'
    const messageId = await sendSafe(chatId, formatTelegramProgressMessage(displaySessionName))

    let currentOutput = ''
    let currentError = ''
    let currentTaskId = null

    const intervalId = setIntervalImpl(() => {
      const preview = (currentOutput || currentError).trim()
      if (!preview) return

      if (messageId) {
        void editSafe(chatId, messageId, formatTelegramProgressMessage(displaySessionName, truncateTail(preview, 3000)))
      }
      updateTaskSafe(currentTaskId, {
        output: currentOutput.slice(-10000),
        error: currentError.slice(-1000),
      })
    }, TELEGRAM_RUNNING_INTERVAL_MS)

    const taskResult = taskRunner.runTask(prompt, cwd, {
      sessionName: taskSessionName,
      source: 'telegram',
      onChunk: (chunk, isErr) => {
        if (isErr) currentError += chunk
        else currentOutput += chunk
      },
      onDone: ({ exitCode }) => {
        clearIntervalImpl(intervalId)
        const result = currentOutput.trim() || currentError.trim() || '(无输出)'
        const truncated = truncateHead(result, 3800)
        const doneMessage = formatTelegramDoneMessage(displaySessionName, exitCode, truncated)
        if (messageId) {
          void editSafe(chatId, messageId, doneMessage)
        } else {
          void sendSafe(chatId, doneMessage)
        }
      },
    }) || {}

    currentTaskId = taskResult.taskId || null
  }

  async function handleFileUpload(chatId, message) {
    try {
      const cwd = resolveUploadDirectory()
      let fileId = ''
      let filename = ''

      if (message.photo?.length) {
        const photo = message.photo[message.photo.length - 1]
        fileId = photo.file_id
        filename = `tg_photo_${nowImpl()}.jpg`
      } else if (message.document) {
        fileId = message.document.file_id
        filename = message.document.file_name || `tg_file_${nowImpl()}`
      }

      await sendSafe(chatId, `⬇️ 正在下载文件到 \`${cwd}\`...`)
      const result = await downloadTelegramFile(fileId, cwd, filename)
      await sendSafe(chatId, `✅ 文件已保存\n\`\`\`\n${result.path}\n\`\`\`\n大小: ${(result.size / 1024).toFixed(1)} KB`)

      if (message.caption?.trim()) {
        await runTelegramPrompt(chatId, message.caption.trim(), cwd, 'telegram')
      }
    } catch (error) {
      await sendSafe(chatId, `❌ 文件处理失败: ${error.message || String(error)}`)
    }
  }

  async function handleWebhookUpdate(update) {
    const message = update?.message || update?.edited_message
    if (!message?.chat?.id) return

    const chatId = message.chat.id
    const text = String(message.text || '').trim()

    if (text === '/start') {
      await sendSafe(chatId, TELEGRAM_START_MESSAGE)
      return
    }

    if (text === '/sessions') {
      await handleSessionsCommand(chatId)
      return
    }

    if (text.startsWith('/switch ')) {
      await handleSwitchCommand(chatId, text)
      return
    }

    if (message.photo || message.document) {
      await handleFileUpload(chatId, message)
      return
    }

    if (!text) return
    const target = resolvePromptTarget()
    await runTelegramPrompt(chatId, text, target.cwd, target.sessionName)
  }

  async function setupWebhook({ protocol, host }) {
    ensureConfigured('TELEGRAM_BOT_TOKEN not set')
    const webhookUrl = `${protocol}://${host}/api/webhooks/telegram`
    const telegramResponse = await setupWebhookRequest({
      webhookUrl,
      secretToken: webhookSecret,
    })
    if (typeof telegramResponse === 'string') {
      return { webhookUrl, raw: telegramResponse }
    }
    return { webhookUrl, telegramResponse }
  }

  return {
    verifyWebhookRequest,
    handleWebhookUpdate,
    setupWebhook,
  }
}
