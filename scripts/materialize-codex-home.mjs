import { existsSync, readFileSync } from 'fs'

import { EMPTY_CODEX_CONFIG, materializeCodexHome } from '../codexConfig.js'
import { readGlobalCodexConfig } from '../systemConfig.js'

const [, , configFile = '', homeDir = '', projectPath = ''] = process.argv

if (!homeDir || !projectPath) {
  console.error('[Nexus] Usage: node scripts/materialize-codex-home.mjs <config-file?> <home-dir> <project-path>')
  process.exit(1)
}

let config = EMPTY_CODEX_CONFIG
if (configFile && existsSync(configFile)) {
  config = JSON.parse(readFileSync(configFile, 'utf8'))
} else {
  config = readGlobalCodexConfig() || EMPTY_CODEX_CONFIG
}

materializeCodexHome({ config, homeDir, projectPath })
