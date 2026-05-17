#!/usr/bin/env node

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const DEFAULT_SECRET_FILE = '.context/secrets/e2e.env'
const DEFAULT_BASE_URL = 'http://127.0.0.1:59000'
const PNG_1X1_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return
  const content = readFileSync(filePath, 'utf8')
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    let value = line.slice(index + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!process.env[key]) process.env[key] = value
  }
}

function usage() {
  return [
    'Usage: npm run smoke:login-upload',
    '',
    'Required secret:',
    `  ${DEFAULT_SECRET_FILE}: NEXUS_E2E_PASSWORD=<login password>`,
    '',
    'Optional environment:',
    '  NEXUS_E2E_BASE_URL=http://127.0.0.1:59000',
    '  NEXUS_E2E_SESSION=<project/session name> (defaults to project matching cwd)',
    '  NEXUS_E2E_WINDOW=<channel/window index>',
    `  NEXUS_E2E_SECRET_FILE=${DEFAULT_SECRET_FILE}`,
  ].join('\n')
}

async function jsonFetch(url, options) {
  const response = await fetch(url, options)
  let body = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (!response.ok) {
    throw new Error(`${url} failed with HTTP ${response.status}${body ? `: ${JSON.stringify(body)}` : ''}`)
  }
  return body
}

async function pickSessionName(baseUrl, token) {
  if (process.env.NEXUS_E2E_SESSION) return process.env.NEXUS_E2E_SESSION

  const projects = await jsonFetch(`${baseUrl}/api/projects`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!Array.isArray(projects) || projects.length === 0) {
    throw new Error('No Nexus projects found; create or select a project before running login smoke')
  }

  const cwd = process.cwd()
  const matchingCwd = projects.find((project) => project?.path === cwd)
  if (matchingCwd?.name) return matchingCwd.name

  const activeProject = projects.find((project) => project?.active && project?.name)
  if (activeProject?.name) return activeProject.name

  const withChannel = projects.find((project) => project?.name && Number(project.channelCount) > 0)
  if (withChannel?.name) return withChannel.name

  const firstProject = projects.find((project) => project?.name)
  if (firstProject?.name) return firstProject.name

  throw new Error('No usable Nexus project name found')
}

async function main() {
  const secretFile = process.env.NEXUS_E2E_SECRET_FILE || DEFAULT_SECRET_FILE
  loadEnvFile(resolve(secretFile))

  const password = process.env.NEXUS_E2E_PASSWORD
  if (!password) {
    console.error(`Missing NEXUS_E2E_PASSWORD.\n\n${usage()}`)
    process.exit(2)
  }

  const baseUrl = (process.env.NEXUS_E2E_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '')

  const login = await jsonFetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  const token = login.token
  if (!token) throw new Error('login response did not include token')

  const sessionName = await pickSessionName(baseUrl, token)
  const sessions = await jsonFetch(`${baseUrl}/api/sessions?session=${encodeURIComponent(sessionName)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const configuredWindow = process.env.NEXUS_E2E_WINDOW ? Number(process.env.NEXUS_E2E_WINDOW) : null
  const windowIndex = Number.isInteger(configuredWindow)
    ? configuredWindow
    : sessions.windows?.[0]?.index
  if (!Number.isInteger(windowIndex)) {
    throw new Error(`No channel/window found for session ${sessionName}`)
  }

  const unique = `nexus-login-upload-smoke-${Date.now()}.png`
  const uploadPath = `/tmp/${unique}`
  writeFileSync(uploadPath, Buffer.from(PNG_1X1_BASE64, 'base64'))

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  })
  await context.addInitScript(({ sessionName: initSessionName, windowIndex: initWindowIndex }) => {
    localStorage.setItem('nexus_guide_seen', 'true')
    localStorage.setItem('nexus_session', initSessionName)
    localStorage.setItem('nexus_session_source', 'user')
    localStorage.setItem('nexus_window', String(initWindowIndex))
    localStorage.removeItem('nexus_token')
    localStorage.removeItem('nexus_toolbar_collapsed')
    window.__nexusWsSends = []
    const OriginalWebSocket = window.WebSocket
    window.WebSocket = new Proxy(OriginalWebSocket, {
      construct(target, args) {
        const ws = Reflect.construct(target, args)
        const originalSend = ws.send.bind(ws)
        ws.send = (data) => {
          window.__nexusWsSends.push(String(data))
          return originalSend(data)
        }
        return ws
      },
    })
  }, { sessionName, windowIndex })

  const page = await context.newPage()
  let uploadedPath = ''
  try {
    await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' })
    await page.locator('input[type=password]').fill(password)
    await page.locator('button[type=submit]').click()
    await page.getByRole('button', { name: /Select text|选字复制/ }).waitFor({ timeout: 20000 })
    await page.waitForFunction(() => {
      return (window.__nexusWsSends || []).some((item) => item.includes('resize'))
    }, null, { timeout: 20000 })

    const mobileUploadInput = page.locator('span[data-native-file-picker="true"] input[type=file][accept="image/*"]').first()
    await mobileUploadInput.setInputFiles(uploadPath)
    await page.waitForSelector('text=/路径已就绪|Path ready/', { timeout: 20000 })
    const sendsHandle = await page.waitForFunction((filename) => {
      return (window.__nexusWsSends || []).filter((item) => item.includes('/uploads/') && item.includes(filename))
    }, unique, { timeout: 20000 })
    const matchedSends = await sendsHandle.jsonValue()
    if (!matchedSends.length) throw new Error('uploaded path was not sent to the terminal websocket')
    await page.keyboard.press('Control+U')
    await page.waitForTimeout(12000)
    const finalMatchedSends = await page.evaluate((filename) => {
      return (window.__nexusWsSends || []).filter((item) => item.includes('/uploads/') && item.includes(filename))
    }, unique)
    if (finalMatchedSends.length !== 1) {
      throw new Error(`uploaded path was sent ${finalMatchedSends.length} times; expected exactly 1`)
    }
    uploadedPath = matchedSends[0]

    console.log(JSON.stringify({
      ok: true,
      baseUrl,
      session: sessionName,
      windowIndex,
      uploadPathSendCount: finalMatchedSends.length,
      uploadedPath,
    }, null, 2))
  } finally {
    await browser.close()
    rmSync(uploadPath, { force: true })
    if (uploadedPath.endsWith(unique)) {
      rmSync(uploadedPath, { force: true })
    }
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exit(1)
})
