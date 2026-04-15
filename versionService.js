import { execSync } from 'node:child_process'
import https from 'node:https'

export class VersionServiceError extends Error {
  constructor(statusCode, message, options = {}) {
    super(message)
    this.name = 'VersionServiceError'
    this.statusCode = statusCode
    this.responseBody = options.responseBody || null
  }
}

/**
 * @typedef {{
 *   projectPath: string,
 *   githubRepo: string,
 *   execSyncImpl?: typeof execSync,
 *   fetchTagsPayloadImpl?: () => Promise<string>,
 * }} VersionServiceOptions
 */

function readCommandOutput(execSyncImpl, command, projectPath) {
  return String(execSyncImpl(command, { cwd: projectPath }) || '').trim()
}

function fetchTagsPayloadFromGitHub(githubRepo) {
  return new Promise((resolve, reject) => {
    const request = https.get({
      hostname: 'api.github.com',
      path: `/repos/${githubRepo}/tags`,
      headers: { 'User-Agent': 'nexus-update-check' },
    }, (response) => {
      let data = ''
      response.on('data', (chunk) => {
        data += String(chunk)
      })
      response.on('end', () => {
        resolve(data)
      })
    })

    request.on('error', reject)
  })
}

/** @param {VersionServiceOptions} options */
export function createVersionService(options) {
  const {
    projectPath,
    githubRepo,
    execSyncImpl = execSync,
    fetchTagsPayloadImpl = () => fetchTagsPayloadFromGitHub(githubRepo),
  } = options

  function getCurrentVersion() {
    try {
      const current = readCommandOutput(execSyncImpl, 'git describe --tags --abbrev=0', projectPath)
      const dirty = readCommandOutput(execSyncImpl, 'git status --porcelain', projectPath)
      return { current, clean: dirty === '' }
    } catch {
      return { current: 'unknown', clean: true }
    }
  }

  async function fetchLatestVersion() {
    let payload = ''

    try {
      payload = await fetchTagsPayloadImpl()
    } catch {
      throw new VersionServiceError(502, 'cannot reach GitHub', {
        responseBody: { error: 'cannot reach GitHub' },
      })
    }

    let tags = null
    try {
      tags = JSON.parse(payload)
    } catch {
      throw new VersionServiceError(502, 'invalid response from GitHub', {
        responseBody: { error: 'invalid response from GitHub' },
      })
    }

    if (!Array.isArray(tags) || tags.length === 0) {
      throw new VersionServiceError(502, 'no tags found', {
        responseBody: { error: 'no tags found' },
      })
    }

    const latest = String(tags[0]?.name || '').trim()
    if (!latest) {
      throw new VersionServiceError(502, 'invalid response from GitHub', {
        responseBody: { error: 'invalid response from GitHub' },
      })
    }

    return {
      latest,
      url: `https://github.com/${githubRepo}/releases/tag/${latest}`,
    }
  }

  return {
    getCurrentVersion,
    fetchLatestVersion,
  }
}
