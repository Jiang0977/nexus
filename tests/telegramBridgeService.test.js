import test from 'node:test'
import assert from 'node:assert/strict'

import { createTelegramBridgeService, TelegramBridgeError } from '../telegramBridgeService.js'

function createService(overrides = {}) {
  const sentMessages = []
  const editedMessages = []
  const downloadedFiles = []
  const taskUpdates = []
  const intervalCallbacks = []
  const clearedIntervals = []
  const taskRuns = []
  const selectedWindows = []

  const service = createTelegramBridgeService({
    botToken: 'bot-token',
    webhookSecret: 'secret-token',
    tmuxSession: 'nexus',
    telegramDefaultSession: '',
    workspaceRoot: '/workspace',
    taskRunner: {
      runTask(prompt, cwd, options) {
        taskRuns.push({ prompt, cwd, options })
        return { taskId: 'task-1' }
      },
    },
    taskStore: {
      updateTask(taskId, patch) {
        taskUpdates.push({ taskId, patch })
      },
    },
    listTmuxWindowsImpl: () => [],
    selectTmuxWindowImpl: (sessionName, target) => {
      selectedWindows.push({ sessionName, target })
    },
    sendMessageImpl: async (chatId, text) => {
      sentMessages.push({ chatId, text })
      return sentMessages.length
    },
    editMessageImpl: async (chatId, messageId, text) => {
      editedMessages.push({ chatId, messageId, text })
    },
    downloadTelegramFileImpl: async (fileId, destDir, filename) => {
      downloadedFiles.push({ fileId, destDir, filename })
      return { path: `${destDir}/${filename}`, size: 2048 }
    },
    setWebhookImpl: async ({ webhookUrl, secretToken }) => ({ ok: true, webhookUrl, secretToken }),
    setIntervalImpl: (callback) => {
      intervalCallbacks.push(callback)
      return intervalCallbacks.length
    },
    clearIntervalImpl: (id) => {
      clearedIntervals.push(id)
    },
    log: { error() {} },
    ...overrides,
  })

  return {
    service,
    sentMessages,
    editedMessages,
    downloadedFiles,
    taskUpdates,
    intervalCallbacks,
    clearedIntervals,
    taskRuns,
    selectedWindows,
  }
}

test('verifyWebhookRequest enforces secret token and bot configuration', () => {
  const { service } = createService()

  assert.throws(
    () => service.verifyWebhookRequest({ 'x-telegram-bot-api-secret-token': 'wrong' }),
    (error) => error instanceof TelegramBridgeError
      && error.statusCode === 403
      && error.message === 'forbidden',
  )

  const { service: unconfigured } = createService({ botToken: '' })
  assert.throws(
    () => unconfigured.verifyWebhookRequest({ 'x-telegram-bot-api-secret-token': 'secret-token' }),
    (error) => error instanceof TelegramBridgeError
      && error.statusCode === 503
      && error.message === 'Telegram not configured',
  )
})

test('handleWebhookUpdate replies to /start and /sessions commands', async () => {
  const { service, sentMessages } = createService({
    listTmuxWindowsImpl: () => [
      { index: 0, name: 'shell', cwd: '/workspace', active: false },
      { index: 1, name: 'work', cwd: '/workspace/work', active: true },
    ],
  })

  await service.handleWebhookUpdate({ message: { chat: { id: 7 }, text: '/start' } })
  await service.handleWebhookUpdate({ message: { chat: { id: 7 }, text: '/sessions' } })

  assert.match(sentMessages[0].text, /Nexus Bot/)
  assert.equal(
    sentMessages[1].text,
    '*当前 tmux 窗口:*\n   `0: shell`\n▶ `1: work`\n\n用 `/switch <编号>` 切换',
  )
})

test('handleWebhookUpdate validates and switches tmux windows for /switch', async () => {
  const { service, sentMessages, selectedWindows } = createService()

  await service.handleWebhookUpdate({ message: { chat: { id: 9 }, text: '/switch ???' } })
  await service.handleWebhookUpdate({ message: { chat: { id: 9 }, text: '/switch 2' } })

  assert.match(sentMessages[0].text, /无效的窗口名称/)
  assert.equal(selectedWindows.length, 1)
  assert.deepEqual(selectedWindows[0], { sessionName: 'nexus', target: '2' })
  assert.match(sentMessages[1].text, /已切换到窗口 `2`/)
})

test('handleWebhookUpdate runs text prompts through taskRunner and edits progress messages', async () => {
  const harness = createService({
    telegramDefaultSession: 'dev',
    listTmuxWindowsImpl: () => [
      { index: 0, name: 'shell', cwd: '/workspace', active: false },
      { index: 1, name: 'dev', cwd: '/workspace/dev', active: true },
    ],
    taskRunner: {
      runTask(prompt, cwd, options) {
        harness.taskRuns.push({ prompt, cwd, options })
        queueMicrotask(() => {
          options.onChunk('line 1\nline 2', false)
          harness.intervalCallbacks[0]?.()
          options.onDone({ exitCode: 0 })
        })
        return { taskId: 'task-42' }
      },
    },
  })

  await harness.service.handleWebhookUpdate({ message: { chat: { id: 11 }, text: 'fix this' } })
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(harness.taskRuns.length, 1)
  assert.equal(harness.taskRuns[0].prompt, 'fix this')
  assert.equal(harness.taskRuns[0].cwd, '/workspace/dev')
  assert.equal(harness.taskRuns[0].options.sessionName, 'dev')
  assert.equal(harness.taskRuns[0].options.source, 'telegram')
  assert.equal(harness.sentMessages[0].text.includes('执行中'), true)
  assert.equal(harness.taskUpdates.length, 1)
  assert.deepEqual(harness.taskUpdates[0], {
    taskId: 'task-42',
    patch: { output: 'line 1\nline 2', error: '' },
  })
  assert.equal(harness.editedMessages.length, 2)
  assert.match(harness.editedMessages[0].text, /执行中/)
  assert.match(harness.editedMessages[1].text, /✅ \*执行完成\*/)
  assert.deepEqual(harness.clearedIntervals, [1])
})

test('handleWebhookUpdate downloads uploaded files to the active window cwd and runs caption prompts', async () => {
  const harness = createService({
    listTmuxWindowsImpl: () => [
      { index: 0, name: 'shell', cwd: '/workspace', active: false },
      { index: 1, name: 'images', cwd: '/workspace/images', active: true },
    ],
    taskRunner: {
      runTask(prompt, cwd, options) {
        harness.taskRuns.push({ prompt, cwd, options })
        queueMicrotask(() => options.onDone({ exitCode: 0 }))
        return { taskId: 'task-file' }
      },
    },
  })

  await harness.service.handleWebhookUpdate({
    message: {
      chat: { id: 21 },
      document: { file_id: 'file-1', file_name: 'note.txt' },
      caption: 'summarize it',
    },
  })
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(harness.downloadedFiles, [{
    fileId: 'file-1',
    destDir: '/workspace/images',
    filename: 'note.txt',
  }])
  assert.equal(harness.taskRuns.length, 1)
  assert.equal(harness.taskRuns[0].prompt, 'summarize it')
  assert.equal(harness.taskRuns[0].cwd, '/workspace/images')
  assert.match(harness.sentMessages[0].text, /正在下载文件/)
  assert.match(harness.sentMessages[1].text, /文件已保存/)
})

test('setupWebhook returns the computed webhook URL and provider response', async () => {
  const { service } = createService()

  const result = await service.setupWebhook({ protocol: 'https', host: 'nexus.example.com' })

  assert.deepEqual(result, {
    webhookUrl: 'https://nexus.example.com/api/webhooks/telegram',
    telegramResponse: {
      ok: true,
      webhookUrl: 'https://nexus.example.com/api/webhooks/telegram',
      secretToken: 'secret-token',
    },
  })
})
