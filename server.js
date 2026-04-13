// server.js — Nexus WebSocket tmux 桥接服务
import express from 'express';
import { WebSocketServer } from 'ws';
import * as pty from 'node-pty';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { createServer } from 'node:http';
import { exec, spawn, execSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join, normalize, isAbsolute, basename } from 'path';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, statSync, rmdirSync, renameSync, cpSync, rmSync, mkdtempSync } from 'fs';
import { readdir, stat as statAsync } from 'fs/promises';
import https from 'node:https';
import multer from 'multer';
import { SERVER_ONLY_ENV_KEYS, sanitizeInteractiveEnv, wrapInteractiveShellCommand } from './interactiveEnv.js';
import { resolvePassiveAttachTarget } from './tmuxSessionPolicy.js';
import { normalizeShellType } from './frontend/src/shellType.js';
import { createGracefulShutdown } from './gracefulShutdown.js';
import {
  deleteCodexConfig,
  listCodexConfigs,
  materializeCodexHome,
  readCodexConfig,
  resolveCodexRuntimeDir,
  sanitizeCodexConfigId,
  saveCodexConfig,
} from './codexConfig.js';
import {
  importCcSwitchProvider,
  listCcSwitchProviders,
  resolveCcSwitchTargetProfileId,
} from './ccSwitchConfig.js';
import { getProjectDefault, saveProjectDefault } from './projectDefaults.js';
import { buildInteractiveShellCommand, collectProxyVars, shellQuote } from './shellLaunch.js';
import { readGlobalClaudeConfig, readGlobalCodexConfig } from './systemConfig.js';

// 加载 .env 文件（如果存在）
try {
  const envPath = join(dirname(fileURLToPath(import.meta.url)), '.env');
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    if (key && !(key in process.env)) process.env[key] = val;
  }
} catch { /* .env 不存在时忽略 */ }

const __dirname = dirname(fileURLToPath(import.meta.url));

// 持久化数据目录（通过 Docker volume 挂载，重建容器不丢失）
const DATA_DIR = join(__dirname, 'data');
const TOOLBAR_CONFIG_FILE = join(DATA_DIR, 'toolbar-config.json');
const CONFIGS_DIR = join(DATA_DIR, 'configs');
const CODEX_CONFIGS_DIR = join(DATA_DIR, 'codex-configs');
const CODEX_RUNTIME_DIR = join(DATA_DIR, 'codex-runtime');
const CODEX_VALIDATE_DIR = join(DATA_DIR, 'codex-validate');
const PROJECT_DEFAULTS_FILE = join(DATA_DIR, 'project-shell-defaults.json');
const TASKS_FILE = join(DATA_DIR, 'tasks.json');
const UPLOADS_DIR = join(DATA_DIR, 'uploads');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(CONFIGS_DIR)) mkdirSync(CONFIGS_DIR, { recursive: true });
if (!existsSync(CODEX_CONFIGS_DIR)) mkdirSync(CODEX_CONFIGS_DIR, { recursive: true });
if (!existsSync(CODEX_RUNTIME_DIR)) mkdirSync(CODEX_RUNTIME_DIR, { recursive: true });
if (!existsSync(CODEX_VALIDATE_DIR)) mkdirSync(CODEX_VALIDATE_DIR, { recursive: true });
if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });

const app = express();
app.use(express.json());
const activeTaskChildren = new Set();

const {
  JWT_SECRET,
  ACC_PASSWORD_HASH,
  TMUX_SESSION = '~',
  WORKSPACE_ROOT = '/workspace',
  HOST = '0.0.0.0',
  PORT = '3000',
  CLAUDE_PROXY = '',
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET,
  TELEGRAM_DEFAULT_SESSION = '',
  GITHUB_REPO = 'librae8226/nexus4cc',
} = process.env;

for (const key of SERVER_ONLY_ENV_KEYS) delete process.env[key];

const DEFAULT_INTERACTIVE_SHELL = wrapInteractiveShellCommand('exec zsh -i');
const SYNC_METADATA_KEYS = ['SYNC_SOURCE', 'SYNC_SOURCE_ID', 'SYNC_SOURCE_NAME'];

function clearTmuxServerOnlyEnv() {
  for (const key of SERVER_ONLY_ENV_KEYS) {
    try {
      execSync(`tmux set-environment -gru ${key} 2>/dev/null`);
    } catch {}
  }
}

function resolveWorkspacePath(inputPath) {
  if (!inputPath) return WORKSPACE_ROOT
  return inputPath.startsWith('/') ? inputPath : `${WORKSPACE_ROOT}/${inputPath}`
}

function readSessionWorkspacePath(sessionName) {
  try {
    const envOutput = execSync(`tmux show-environment -t ${shellQuote(sessionName)} NEXUS_CWD 2>/dev/null`).toString().trim()
    const match = envOutput.match(/^NEXUS_CWD=(.+)$/)
    if (match) return match[1]
  } catch {}
  return WORKSPACE_ROOT
}

function ensureTmuxSession(sessionName) {
  try {
    execSync(
      `tmux has-session -t ${shellQuote(sessionName)} 2>/dev/null || tmux new-session -d -s ${shellQuote(sessionName)} -n shell ${shellQuote(DEFAULT_INTERACTIVE_SHELL)}`,
    )
  } catch {}
}

function setTmuxSessionEnv(sessionName, key, value) {
  try {
    execSync(`tmux set-environment -t ${shellQuote(sessionName)} ${key} ${shellQuote(value)} 2>/dev/null`)
  } catch {}
}

function applyProxyEnvToSession(sessionName, proxyVars) {
  for (const [key, value] of Object.entries(proxyVars)) {
    setTmuxSessionEnv(sessionName, key, value)
  }
}

function buildShellCommand(shellType, profile, cwd) {
  const proxyVars = collectProxyVars(process.env, CLAUDE_PROXY)
  return {
    proxyVars,
    shellCmd: buildInteractiveShellCommand({
      shellType,
      profile,
      cwd,
      scriptsDir: __dirname,
      defaultInteractiveShell: DEFAULT_INTERACTIVE_SHELL,
      proxyVars,
    }),
  }
}

function rememberProjectDefault(cwd, shellType, profile) {
  saveProjectDefault(PROJECT_DEFAULTS_FILE, { path: cwd, shellType, profile })
}

function getTmuxWindowId(sessionName, windowIndex) {
  try {
    return execSync(
      `tmux display-message -t ${shellQuote(`${sessionName}:${windowIndex}`)} -p '#{window_id}' 2>/dev/null`,
    ).toString().trim()
  } catch {
    return ''
  }
}

function cleanupCodexRuntime(windowId) {
  if (!windowId) return
  const runtimeDir = resolveCodexRuntimeDir(CODEX_RUNTIME_DIR, windowId)
  rmSync(runtimeDir, { recursive: true, force: true })
}

function cleanupCodexRuntimeForWindow(sessionName, windowIndex) {
  cleanupCodexRuntime(getTmuxWindowId(sessionName, windowIndex))
}

function cleanupCodexRuntimeForSession(sessionName) {
  try {
    const stdout = execSync(`tmux list-windows -t ${shellQuote(sessionName)} -F '#{window_id}' 2>/dev/null`).toString().trim()
    stdout.split('\n').filter(Boolean).forEach(cleanupCodexRuntime)
  } catch {}
}

function listTmuxWindowIds(sessionName) {
  try {
    return execSync(`tmux list-windows -t ${shellQuote(sessionName)} -F '#{window_id}' 2>/dev/null`)
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean)
  } catch {
    return []
  }
}

function resolveCodexExecutable() {
  try {
    const result = spawnSync('bash', ['-lc', 'which -a codex | tail -1'], { encoding: 'utf8' })
    const executable = result.status === 0 ? result.stdout.trim() : ''
    return executable || 'codex'
  } catch {
    return 'codex'
  }
}

function summarizeCodexValidationFailure(result) {
  const stderr = String(result.stderr || '').trim()
  const stdout = String(result.stdout || '').trim()
  if (result.error?.message) return result.error.message
  if (stderr) return stderr.split('\n').slice(-8).join('\n')
  if (stdout) return stdout.split('\n').slice(-8).join('\n')
  return `codex exited with status ${result.status ?? 'unknown'}`
}

function sanitizeProfileId(id) {
  return sanitizeCodexConfigId(id)
}

function mergeSyncMetadata(currentConfig = {}, nextConfig = {}) {
  const merged = { ...nextConfig }
  for (const key of SYNC_METADATA_KEYS) {
    if (!(key in merged) && currentConfig?.[key]) {
      merged[key] = currentConfig[key]
    }
  }
  return merged
}

function listClaudeConfigs(configDir = CONFIGS_DIR) {
  try {
    const files = readdirSync(configDir, { withFileTypes: true })
      .filter(f => f.isFile() && f.name.endsWith('.json'))
      .map(f => ({
        name: f.name,
        mtime: statSync(join(configDir, f.name)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime)
      .map(f => f.name);
    return files.map(f => {
      const id = f.replace('.json', '');
      try {
        const data = JSON.parse(readFileSync(join(configDir, f), 'utf8'));
        return { id, label: data.label || id, ...data };
      } catch {
        return { id, label: id };
      }
    });
  } catch {
    return [];
  }
}

function readClaudeConfig(configDir, id) {
  const sanitizedId = sanitizeProfileId(id)
  if (!sanitizedId) return null
  const filePath = join(configDir, `${sanitizedId}.json`)
  if (!existsSync(filePath)) return null
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf8'))
    return { id: sanitizedId, label: data.label || sanitizedId, ...data }
  } catch {
    return { id: sanitizedId, label: sanitizedId }
  }
}

function saveClaudeConfig(configDir, id, config = {}) {
  const sanitizedId = sanitizeProfileId(id)
  if (!sanitizedId) throw new Error('invalid id')
  const currentConfig = readClaudeConfig(configDir, sanitizedId) || {}
  const nextConfig = mergeSyncMetadata(currentConfig, config)
  writeFileSync(join(configDir, `${sanitizedId}.json`), JSON.stringify(nextConfig, null, 2), 'utf8')
  return { id: sanitizedId, config: { id: sanitizedId, ...nextConfig } }
}

function saveCodexConfigWithMetadata(configDir, id, config = {}) {
  const currentConfig = readCodexConfig(configDir, id) || {}
  const mergedConfig = mergeSyncMetadata(currentConfig, config)
  const savedId = saveCodexConfig(configDir, id, mergedConfig)
  return { id: savedId, config: readCodexConfig(configDir, savedId) }
}

if (!JWT_SECRET || !ACC_PASSWORD_HASH) {
  console.error('ERROR: JWT_SECRET and ACC_PASSWORD_HASH must be set in environment');
  process.exit(1);
}

// 静态文件：frontend/dist 和 public
app.use(express.static(join(__dirname, 'public')));
app.use(express.static(join(__dirname, 'frontend', 'dist')));

// Auth middleware
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'unauthorized' });
  }
}

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'password required' });
  try {
    const ok = await bcrypt.compare(password, ACC_PASSWORD_HASH);
    if (!ok) return res.status(401).json({ error: 'unauthorized' });
    const token = jwt.sign({}, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: 'internal error' });
  }
});

// POST /api/windows — F-19: 项目-窗口两级结构
// body: { rel_path?, shell_type?, profile? }
// - 提供 rel_path: 设置 NEXUS_CWD 并在此目录创建窗口（新项目）
// - 不提供 rel_path: 读取 NEXUS_CWD 并在此目录创建窗口（新窗口）
app.post('/api/windows', authMiddleware, (req, res) => {
  const { rel_path, profile } = req.body || {};
  const shellType = normalizeShellType(req.body?.shell_type);
  const tmuxSession = req.query.session || TMUX_SESSION;

  let cwd;
  if (rel_path) {
    // 新项目：设置 NEXUS_CWD
    cwd = resolveWorkspacePath(rel_path);
    try {
      setTmuxSessionEnv(tmuxSession, 'NEXUS_CWD', cwd);
    } catch (err) {
      return res.status(500).json({ error: 'failed to set NEXUS_CWD: ' + err.message });
    }
  } else {
    // 新窗口：读取 NEXUS_CWD
    cwd = readSessionWorkspacePath(tmuxSession);
  }

  // 窗口名称基于目录
  const name = cwd.replace(/^\/+|\/+$/g, '').replace(/\//g, '-') || 'window';

  const { proxyVars, shellCmd } = buildShellCommand(shellType, profile, cwd);

  // 确保 tmux session 存在
  ensureTmuxSession(tmuxSession);

  // 将代理变量设置到 tmux session 环境
  applyProxyEnvToSession(tmuxSession, proxyVars);

  const cmd = `tmux new-window -t ${shellQuote(tmuxSession)} -c ${shellQuote(cwd)} -n ${shellQuote(name)} ${shellQuote(shellCmd)}`;
  exec(cmd, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    rememberProjectDefault(cwd, shellType, profile);
    res.json({ name, cwd, shell_type: shellType, profile: profile || null, session: tmuxSession });
  });
});

// POST /api/sessions — 在 tmux 中创建新 window
// body: { rel_path, shell_type?, profile?, session? }
//   shell_type: 'claude' | 'bash' (default: 'bash' => interactive zsh)
//   当 shell_type='claude' 时，profile 可选，使用 nexus-run-claude.sh 启动
//   当 shell_type='bash' 时，直接启动 zsh
app.post('/api/sessions', authMiddleware, (req, res) => {
  const { rel_path, profile, session } = req.body || {};
  const shellType = normalizeShellType(req.body?.shell_type);
  const tmuxSession = session || TMUX_SESSION;
  if (!rel_path) return res.status(400).json({ error: 'rel_path required' });
  const cwd = resolveWorkspacePath(rel_path);
  const name = cwd.replace(/^\/+|\/+$/g, '').replace(/\//g, '-') || 'session';

  const { proxyVars, shellCmd } = buildShellCommand(shellType, profile, cwd);

  // 确保 tmux session 存在
  ensureTmuxSession(tmuxSession);

  // 将代理变量设置到 tmux session 环境，新窗口才能继承
  applyProxyEnvToSession(tmuxSession, proxyVars);

  const cmd = `tmux new-window -t ${shellQuote(tmuxSession)} -c ${shellQuote(cwd)} -n ${shellQuote(name)} ${shellQuote(shellCmd)}`;
  exec(cmd, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    rememberProjectDefault(cwd, shellType, profile);
    res.json({ name, cwd, shell_type: shellType, profile: profile || null, session: tmuxSession });
  });
});

// GET /api/configs — 列出所有 claude 配置 profile
app.get('/api/configs', authMiddleware, (req, res) => {
  res.json(listClaudeConfigs(CONFIGS_DIR));
});

// POST /api/configs/:id — 创建或更新配置 profile
app.post('/api/configs/:id', authMiddleware, (req, res) => {
  try {
    const { id } = saveClaudeConfig(CONFIGS_DIR, req.params.id, req.body || {});
    res.json({ ok: true, id });
  } catch (err) {
    const status = err.message === 'invalid id' ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

// POST /api/configs/:id/sync-current — 用当前系统 live Claude 配置覆盖现有 profile
app.post('/api/configs/:id/sync-current', authMiddleware, (req, res) => {
  const id = req.params.id.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  if (!id) return res.status(400).json({ error: 'invalid id' });

  const filePath = join(CONFIGS_DIR, `${id}.json`);
  if (!existsSync(filePath)) {
    return res.status(404).json({ error: 'config not found' });
  }

  const imported = readGlobalClaudeConfig();
  if (!imported) {
    return res.status(404).json({ error: 'global ~/.claude/settings.json not found' });
  }

  try {
    const current = readClaudeConfig(CONFIGS_DIR, id) || {};

    const { config } = saveClaudeConfig(CONFIGS_DIR, id, {
      ...imported,
      label: String(current.label || imported.label || id).trim() || id,
    });
    res.json({ ok: true, id, config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/configs/:id — 删除配置 profile
app.delete('/api/configs/:id', authMiddleware, (req, res) => {
  const file = join(CONFIGS_DIR, `${req.params.id}.json`);
  try {
    if (existsSync(file)) unlinkSync(file);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/codex-configs — 列出所有 codex 配置 profile
app.get('/api/codex-configs', authMiddleware, (req, res) => {
  res.json(listCodexConfigs(CODEX_CONFIGS_DIR));
});

// POST /api/codex-configs/import-global — 导入当前用户 ~/.codex
app.post('/api/codex-configs/import-global', authMiddleware, (req, res) => {
  const imported = readGlobalCodexConfig();
  if (!imported) {
    return res.status(404).json({ error: 'global ~/.codex not found' });
  }

  try {
    const preferredId = String(req.body?.id || '').trim();
    const baseId = preferredId.replace(/[^a-z0-9_-]/gi, '-').toLowerCase() || 'imported';
    let nextId = baseId;
    let counter = 1;
    while (existsSync(join(CODEX_CONFIGS_DIR, `${nextId}.json`))) {
      nextId = `${baseId}-${counter++}`;
    }

    const { id, config } = saveCodexConfigWithMetadata(CODEX_CONFIGS_DIR, nextId, imported);
    res.json({ ok: true, id, config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/codex-configs/:id/sync-current — 用当前系统 live Codex 配置覆盖现有 profile
app.post('/api/codex-configs/:id/sync-current', authMiddleware, (req, res) => {
  const existing = readCodexConfig(CODEX_CONFIGS_DIR, req.params.id);
  if (!existing) return res.status(404).json({ error: 'config not found' });

  const imported = readGlobalCodexConfig();
  if (!imported) {
    return res.status(404).json({ error: 'global ~/.codex not found' });
  }

  try {
    const { id, config } = saveCodexConfigWithMetadata(CODEX_CONFIGS_DIR, req.params.id, {
      ...imported,
      label: String(existing.label || imported.label || req.params.id).trim() || req.params.id,
    });
    res.json({ ok: true, id, config });
  } catch (err) {
    const status = err.message === 'invalid id' ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

// POST /api/codex-configs/:id/validate — 活体验证 codex profile
app.post('/api/codex-configs/:id/validate', authMiddleware, (req, res) => {
  const config = readCodexConfig(CODEX_CONFIGS_DIR, req.params.id);
  if (!config) return res.status(404).json({ error: 'config not found' });

  const tempHome = mkdtempSync(join(CODEX_VALIDATE_DIR, 'validate-'));
  const outputFile = join(tempHome, 'last-message.txt');
  try {
    materializeCodexHome({ config, homeDir: tempHome, projectPath: __dirname });
    const proxyVars = collectProxyVars(process.env, CLAUDE_PROXY);
    const result = spawnSync(
      resolveCodexExecutable(),
      [
        'exec',
        '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox',
        '--color',
        'never',
        '-C',
        __dirname,
        '-o',
        outputFile,
        'Reply with EXACTLY: OK',
      ],
      {
        env: sanitizeInteractiveEnv(process.env, {
          HOME: tempHome,
          ...proxyVars,
        }),
        encoding: 'utf8',
        timeout: 45000,
      },
    );

    if (result.error) {
      const status = result.error.code === 'ETIMEDOUT' ? 504 : 500;
      return res.status(status).json({ ok: false, error: result.error.message });
    }

    if (result.status !== 0) {
      return res.status(400).json({ ok: false, error: summarizeCodexValidationFailure(result) });
    }

    const message = existsSync(outputFile) ? readFileSync(outputFile, 'utf8').trim() : 'OK';
    res.json({ ok: true, message: message || 'OK' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
});

// POST /api/codex-configs/:id — 创建或更新 codex profile
app.post('/api/codex-configs/:id', authMiddleware, (req, res) => {
  try {
    const { id } = saveCodexConfigWithMetadata(CODEX_CONFIGS_DIR, req.params.id, req.body || {});
    res.json({ ok: true, id });
  } catch (err) {
    const status = err.message === 'invalid id' ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

// GET /api/cc-switch/providers?kind=claude|codex — 读取 cc-switch provider 列表
app.get('/api/cc-switch/providers', authMiddleware, (req, res) => {
  const kind = String(req.query.kind || '').trim();
  if (kind !== 'claude' && kind !== 'codex') {
    return res.status(400).json({ error: 'invalid kind' });
  }

  const existingProfiles = kind === 'claude'
    ? listClaudeConfigs(CONFIGS_DIR)
    : listCodexConfigs(CODEX_CONFIGS_DIR);

  res.json(listCcSwitchProviders({ kind, existingProfiles }));
});

// POST /api/cc-switch/providers/:kind/:providerId/import — 从 cc-switch 覆盖导入单个 provider
app.post('/api/cc-switch/providers/:kind/:providerId/import', authMiddleware, (req, res) => {
  const kind = String(req.params.kind || '').trim();
  if (kind !== 'claude' && kind !== 'codex') {
    return res.status(400).json({ error: 'invalid kind' });
  }

  const existingProfiles = kind === 'claude'
    ? listClaudeConfigs(CONFIGS_DIR)
    : listCodexConfigs(CODEX_CONFIGS_DIR);

  const imported = importCcSwitchProvider({
    kind,
    providerId: req.params.providerId,
  });
  if (!imported) {
    return res.status(404).json({ error: 'provider not found' });
  }

  const targetId = resolveCcSwitchTargetProfileId(existingProfiles, {
    id: req.params.providerId,
    name: imported.SYNC_SOURCE_NAME || imported.label,
  });

  try {
    if (kind === 'claude') {
      const { id, config } = saveClaudeConfig(CONFIGS_DIR, targetId, imported);
      return res.json({ ok: true, id, config });
    }

    const { id, config } = saveCodexConfigWithMetadata(CODEX_CONFIGS_DIR, targetId, imported);
    res.json({ ok: true, id, config });
  } catch (err) {
    const status = err.message === 'invalid id' ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

// DELETE /api/codex-configs/:id — 删除 codex profile
app.delete('/api/codex-configs/:id', authMiddleware, (req, res) => {
  try {
    deleteCodexConfig(CODEX_CONFIGS_DIR, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/project-defaults?path=/abs/path — 读取指定项目路径的 shell/profile 默认值
app.get('/api/project-defaults', authMiddleware, (req, res) => {
  const rawPath = String(req.query.path || '').trim();
  if (!rawPath) return res.json(null);
  const projectPath = resolveWorkspacePath(rawPath);
  res.json(getProjectDefault(PROJECT_DEFAULTS_FILE, projectPath));
});

// GET /api/toolbar-config — 读取工具栏配置
app.get('/api/toolbar-config', authMiddleware, (req, res) => {
  try {
    if (!existsSync(TOOLBAR_CONFIG_FILE)) return res.json(null);
    const data = readFileSync(TOOLBAR_CONFIG_FILE, 'utf8');
    res.json(JSON.parse(data));
  } catch {
    res.json(null);
  }
});

// POST /api/toolbar-config — 保存工具栏配置
app.post('/api/toolbar-config', authMiddleware, (req, res) => {
  try {
    writeFileSync(TOOLBAR_CONFIG_FILE, JSON.stringify(req.body), 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/version — 当前版本号及工作区状态
app.get('/api/version', authMiddleware, (req, res) => {
  try {
    const current = execSync('git describe --tags --abbrev=0', { cwd: __dirname }).toString().trim();
    const dirty = execSync('git status --porcelain', { cwd: __dirname }).toString().trim();
    res.json({ current, clean: dirty === '' });
  } catch {
    res.json({ current: 'unknown', clean: true });
  }
});

// GET /api/version/latest — 代理 GitHub Tags API 获取最新版本（兼容只有 tag 没有 Release 的 repo）
app.get('/api/version/latest', authMiddleware, (req, res) => {
  const options = {
    hostname: 'api.github.com',
    path: `/repos/${GITHUB_REPO}/tags`,
    headers: { 'User-Agent': 'nexus-update-check' },
  };
  https.get(options, (ghRes) => {
    let data = '';
    ghRes.on('data', chunk => { data += chunk; });
    ghRes.on('end', () => {
      try {
        const json = JSON.parse(data);
        if (!Array.isArray(json) || json.length === 0) return res.status(502).json({ error: 'no tags found' });
        const latest = json[0].name;
        res.json({ latest, url: `https://github.com/${GITHUB_REPO}/releases/tag/${latest}` });
      } catch {
        res.status(502).json({ error: 'invalid response from GitHub' });
      }
    });
  }).on('error', () => {
    res.status(502).json({ error: 'cannot reach GitHub' });
  });
});

app.get('/api/browse', authMiddleware, (req, res) => {
  try {
    let p = req.query.path || WORKSPACE_ROOT
    if (p === '~') p = WORKSPACE_ROOT
    if (!isAbsolute(p)) p = join(WORKSPACE_ROOT, p)
    p = normalize(p)
    const entries = readdirSync(p, { withFileTypes: true })
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => ({ name: e.name, path: join(p, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    const parent = dirname(p) !== p ? dirname(p) : null
    res.json({ path: p, parent, dirs })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/workspace/files — 浏览文件系统（支持文件和目录，任意路径）
app.get('/api/workspace/files', authMiddleware, async (req, res) => {
  try {
    let p = req.query.path || WORKSPACE_ROOT
    if (p === '~') p = WORKSPACE_ROOT
    if (!isAbsolute(p)) p = join(WORKSPACE_ROOT, p)
    p = normalize(p)
    const dirents = await readdir(p, { withFileTypes: true })
    const visible = dirents.filter(e => !e.name.startsWith('.'))
    const entries = await Promise.all(visible.map(async e => {
      const fullPath = join(p, e.name)
      const st = await statAsync(fullPath)
      return {
        name: e.name,
        type: e.isDirectory() ? 'dir' : 'file',
        size: e.isFile() ? st.size : undefined,
        mtime: st.mtimeMs,
      }
    }))
    res.json({ path: p, entries })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// 静态文件服务：工作目录文件直接访问（/workspace/相对路径）
// 支持 header 或 query string 传递 token（浏览器直接打开时用 query string）
// 支持通过 ?path=/absolute/path 访问任意路径（仍然限制在 workspaceRoot 内）
app.use('/workspace', (req, res, next) => {
  // 尝试从 query string 获取 token
  const token = req.query.token
  if (token) {
    try {
      jwt.verify(token, JWT_SECRET)
      return next()
    } catch {
      return res.status(401).send('unauthorized')
    }
  }
  // 否则使用 header auth
  return authMiddleware(req, res, next)
}, (req, res) => {
  try {
    let fullPath
    // 如果提供了 path 参数，使用它（绝对路径）
    if (req.query.path) {
      fullPath = normalize(decodeURIComponent(req.query.path))
    } else {
      // 否则使用相对路径（基于 WORKSPACE_ROOT）
      let relPath = decodeURIComponent(req.path)
      relPath = normalize(relPath).replace(/^(\.\.(\/|\|$))+/, '')
      fullPath = join(WORKSPACE_ROOT, relPath)
    }
    // 安全检查：防止路径遍历攻击（规范化后检查是否包含 ..）
    if (fullPath.includes('..')) {
      return res.status(403).send('access denied: invalid path')
    }
    if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
      return res.status(404).send('not found')
    }
    if (req.query.dl === '1') {
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(basename(fullPath))}`)
    }
    res.sendFile(fullPath)
  } catch (err) {
    res.status(500).send(err.message)
  }
})

// POST /api/workspace/mkdir — 创建文件夹
app.post('/api/workspace/mkdir', authMiddleware, (req, res) => {
  try {
    let { path: targetPath, name } = req.body
    if (!name) return res.status(400).json({ error: 'name required' })
    if (!isAbsolute(targetPath)) targetPath = join(WORKSPACE_ROOT, targetPath)
    targetPath = normalize(targetPath)
    const dirPath = join(targetPath, name)
    if (dirPath.includes('..')) {
      return res.status(403).json({ error: 'invalid path' })
    }
    if (existsSync(dirPath)) {
      return res.status(409).json({ error: 'already exists' })
    }
    mkdirSync(dirPath, { recursive: true })
    res.json({ ok: true, path: dirPath })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/workspace/files — 创建新文件
app.post('/api/workspace/files', authMiddleware, (req, res) => {
  try {
    let { path: targetPath, name, content = '' } = req.body
    if (!name) return res.status(400).json({ error: 'name required' })
    if (!isAbsolute(targetPath)) targetPath = join(WORKSPACE_ROOT, targetPath)
    targetPath = normalize(targetPath)
    const filePath = join(targetPath, name)
    if (filePath.includes('..')) {
      return res.status(403).json({ error: 'invalid path' })
    }
    if (existsSync(filePath)) {
      return res.status(409).json({ error: 'already exists' })
    }
    writeFileSync(filePath, content, 'utf8')
    res.json({ ok: true, path: filePath })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/workspace/file — 读取文件内容
app.get('/api/workspace/file', authMiddleware, (req, res) => {
  try {
    let p = req.query.path || ''
    if (!isAbsolute(p)) p = join(WORKSPACE_ROOT, p)
    p = normalize(p)
    if (p.includes('..')) {
      return res.status(403).json({ error: 'invalid path' })
    }
    if (!existsSync(p) || !statSync(p).isFile()) {
      return res.status(404).json({ error: 'not found' })
    }
    const content = readFileSync(p, 'utf8')
    res.json({ path: p, content })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PUT /api/workspace/file — 保存文件内容
app.put('/api/workspace/file', authMiddleware, (req, res) => {
  try {
    let { path: filePath, content = '' } = req.body
    if (!filePath) return res.status(400).json({ error: 'path required' })
    if (!isAbsolute(filePath)) filePath = join(WORKSPACE_ROOT, filePath)
    filePath = normalize(filePath)
    if (filePath.includes('..')) {
      return res.status(403).json({ error: 'invalid path' })
    }
    writeFileSync(filePath, content, 'utf8')
    res.json({ ok: true, path: filePath })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/workspace/entry — 删除文件或目录
app.delete('/api/workspace/entry', authMiddleware, (req, res) => {
  try {
    let p = req.body?.path || req.query?.path || ''
    if (!p) return res.status(400).json({ error: 'path required' })
    if (!isAbsolute(p)) p = join(WORKSPACE_ROOT, p)
    p = normalize(p)
    if (p.includes('..')) {
      return res.status(403).json({ error: 'invalid path' })
    }
    if (!existsSync(p)) {
      return res.status(404).json({ error: 'not found' })
    }
    rmSync(p, { recursive: true, force: true })
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/workspace/rename — 重命名文件或目录
app.post('/api/workspace/rename', authMiddleware, (req, res) => {
  try {
    let { path: srcPath, newName } = req.body || {}
    if (!srcPath || !newName) return res.status(400).json({ error: 'path and newName required' })
    if (!isAbsolute(srcPath)) srcPath = join(WORKSPACE_ROOT, srcPath)
    srcPath = normalize(srcPath)
    if (srcPath.includes('..')) {
      return res.status(403).json({ error: 'invalid path' })
    }
    if (!existsSync(srcPath)) {
      return res.status(404).json({ error: 'not found' })
    }
    const destPath = normalize(join(dirname(srcPath), newName))
    if (destPath.includes('..')) {
      return res.status(403).json({ error: 'invalid newName' })
    }
    if (existsSync(destPath)) {
      return res.status(409).json({ error: 'already exists' })
    }
    renameSync(srcPath, destPath)
    res.json({ ok: true, path: destPath })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/workspace/copy — 复制文件或目录
app.post('/api/workspace/copy', authMiddleware, (req, res) => {
  try {
    let { sourcePath, targetPath } = req.body || {}
    if (!sourcePath || !targetPath) return res.status(400).json({ error: 'sourcePath and targetPath required' })
    if (!isAbsolute(sourcePath)) sourcePath = join(WORKSPACE_ROOT, sourcePath)
    if (!isAbsolute(targetPath)) targetPath = join(WORKSPACE_ROOT, targetPath)
    sourcePath = normalize(sourcePath)
    targetPath = normalize(targetPath)
    if (sourcePath.includes('..') || targetPath.includes('..')) {
      return res.status(403).json({ error: 'invalid path' })
    }
    if (!existsSync(sourcePath)) {
      return res.status(404).json({ error: 'source not found' })
    }
    if (existsSync(targetPath)) {
      return res.status(409).json({ error: 'target already exists' })
    }
    cpSync(sourcePath, targetPath, { recursive: true })
    res.json({ ok: true, path: targetPath })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/workspace/move — 移动文件或目录
app.post('/api/workspace/move', authMiddleware, (req, res) => {
  try {
    let { sourcePath, targetPath } = req.body || {}
    if (!sourcePath || !targetPath) return res.status(400).json({ error: 'sourcePath and targetPath required' })
    if (!isAbsolute(sourcePath)) sourcePath = join(WORKSPACE_ROOT, sourcePath)
    if (!isAbsolute(targetPath)) targetPath = join(WORKSPACE_ROOT, targetPath)
    sourcePath = normalize(sourcePath)
    targetPath = normalize(targetPath)
    if (sourcePath.includes('..') || targetPath.includes('..')) {
      return res.status(403).json({ error: 'invalid path' })
    }
    if (!existsSync(sourcePath)) {
      return res.status(404).json({ error: 'source not found' })
    }
    if (existsSync(targetPath)) {
      return res.status(409).json({ error: 'target already exists' })
    }
    try {
      renameSync(sourcePath, targetPath)
    } catch (err) {
      if (err.code === 'EXDEV') {
        cpSync(sourcePath, targetPath, { recursive: true })
        rmSync(sourcePath, { recursive: true, force: true })
      } else {
        throw err
      }
    }
    res.json({ ok: true, path: targetPath })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/upload — 上传文件到指定 session 的 cwd（F-14）
// body: multipart/form-data, fields: file, session_name (optional)
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      // 找到目标 session 的 cwd，否则存 WORKSPACE_ROOT
      let cwd = WORKSPACE_ROOT
      try {
        const sessionName = req.body?.session_name || ''
        const windows = execSync(`tmux list-windows -t ${TMUX_SESSION} -F "#I:#W:#{pane_current_path}"`).toString().trim().split('\n')
        for (const line of windows) {
          const parts = line.split(':')
          const name = parts[1]
          const path = parts.slice(2).join(':')
          if (sessionName && name === sessionName) { cwd = path; break }
          // 如果没指定 session，用 active window
          if (!sessionName) {
            const activeLines = execSync(`tmux list-windows -t ${TMUX_SESSION} -F "#I:#W:#{pane_current_path}:#{window_active}"`).toString().trim().split('\n')
            for (const al of activeLines) {
              const ap = al.split(':')
              if (ap[ap.length - 1]?.trim() === '1') { cwd = ap.slice(2, ap.length - 1).join(':'); break }
            }
            break
          }
        }
      } catch {}
      if (!existsSync(cwd)) cwd = WORKSPACE_ROOT
      cb(null, cwd)
    },
    filename: (req, file, cb) => {
      // 保留原始文件名，避免冲突加时间戳前缀
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')
      cb(null, safe)
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
})

app.post('/api/upload', authMiddleware, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message })
    if (!req.file) return res.status(400).json({ error: 'no file' })
    const filePath = req.file.path
    res.json({ ok: true, path: filePath, filename: req.file.filename, size: req.file.size })
  })
})

// ---- F-21: 独立文件上传 API（上传到 data/uploads，不混入项目目录）----

// 按日期生成上传目录
function getUploadDir() {
  const dateDir = new Date().toISOString().slice(0, 10)
  const dir = join(UPLOADS_DIR, dateDir)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

const fileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB
})

// POST /api/files/upload — 上传文件到 data/uploads/日期/
// Query: overwrite=1 强制覆盖已存在的文件
app.post('/api/files/upload', authMiddleware, (req, res, next) => {
  fileUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message })
    if (!req.file) return res.status(400).json({ error: 'no file' })

    const dateDir = new Date().toISOString().slice(0, 10)
    const uploadDir = join(UPLOADS_DIR, dateDir)
    if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true })

    // 使用前端传递的原始文件名（避免 multer 解析编码问题）
    const originalName = req.body.originalName || req.file.originalname
    // 清理文件名：只保留合法字符，中文保留
    const safe = originalName.replace(/[<>:"|?*\\/\x00-\x1f]/g, '_')
    const filePath = join(uploadDir, safe)
    const overwrite = req.query.overwrite === '1'

    // 检查文件是否已存在
    if (!overwrite && existsSync(filePath)) {
      return res.status(409).json({
        error: 'file exists',
        filename: safe,
        message: `文件 "${safe}" 已存在`
      })
    }

    // 写入文件
    try {
      writeFileSync(filePath, req.file.buffer)
      const url = `/uploads/${dateDir}/${safe}`
      const responseData = {
        ok: true,
        filename: safe,
        url,
        fullPath: filePath,
        size: req.file.size,
        originalName: originalName
      }
      console.log('[Upload]', safe, '→', filePath)
      res.json(responseData)
    } catch (writeErr) {
      res.status(500).json({ error: writeErr.message })
    }
  })
})

// 静态服务：上传的文件直接访问（/uploads/日期/文件名）
app.use('/uploads', express.static(UPLOADS_DIR))

// GET /api/files — 列出上传的文件（按日期分组）
app.get('/api/files', authMiddleware, (req, res) => {
  try {
    const result = []
    const dateDirs = readdirSync(UPLOADS_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort((a, b) => b.localeCompare(a)) // 降序，最新的在前

    for (const dateDir of dateDirs) {
      const dirPath = join(UPLOADS_DIR, dateDir)
      const files = readdirSync(dirPath, { withFileTypes: true })
        .filter(e => e.isFile())
        .map(e => {
          const stat = statSync(join(dirPath, e.name))
          return {
            name: e.name,
            url: `/uploads/${dateDir}/${e.name}`,
            fullPath: join(dirPath, e.name),
            size: stat.size,
            created: stat.mtimeMs,
          }
        })
        .sort((a, b) => b.created - a.created)
      if (files.length > 0) {
        result.push({ date: dateDir, files })
      }
    }
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/files/:date/:filename — 删除上传的文件
app.delete('/api/files/:date/:filename', authMiddleware, (req, res) => {
  const dateDir = req.params.date.replace(/[^0-9-]/g, '')
  const filename = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, '_')
  const filePath = join(UPLOADS_DIR, dateDir, filename)
  // 安全检查：确保文件在 uploads 目录内
  if (!filePath.startsWith(UPLOADS_DIR)) {
    return res.status(400).json({ error: 'invalid path' })
  }
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath)
      res.json({ ok: true })
    } else {
      res.status(404).json({ error: 'file not found' })
    }
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/files/all — 删除所有上传的文件
app.delete('/api/files/all', authMiddleware, (req, res) => {
  try {
    const dateDirs = readdirSync(UPLOADS_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory())
    let deletedCount = 0
    for (const dateDir of dateDirs) {
      const dirPath = join(UPLOADS_DIR, dateDir.name)
      const files = readdirSync(dirPath, { withFileTypes: true })
        .filter(e => e.isFile())
      for (const file of files) {
        const filePath = join(dirPath, file.name)
        try {
          unlinkSync(filePath)
          deletedCount++
        } catch {}
      }
      // 尝试删除空目录
      try {
        rmdirSync(dirPath)
      } catch {}
    }
    res.json({ ok: true, deletedCount })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/sessions/:id/rename — 重命名窗口
app.post('/api/sessions/:id/rename', authMiddleware, (req, res) => {
  const index = req.params.id
  const session = req.query.session || TMUX_SESSION
  const { name } = req.body || {}
  if (!name) return res.status(400).json({ error: 'name required' })
  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '-').substring(0, 50)
  exec(`tmux rename-window -t ${session}:${index} "${safeName}"`, (err) => {
    if (err) return res.status(500).json({ error: err.message })
    res.json({ ok: true, name: safeName })
  })
})

// GET /api/sessions/:id/output — 获取窗口最后输出（F-15 状态卡片）
app.get('/api/sessions/:id/output', authMiddleware, (req, res) => {
  const windowIndex = parseInt(req.params.id, 10);
  const session = req.query.session || TMUX_SESSION;
  const entry = ptyMap.get(ptyKey(session, windowIndex));
  if (!entry) return res.json({ connected: false, output: '', clients: 0 });
  res.json({
    connected: true,
    output: entry.lastOutput.slice(-2000), // 最后 2KB
    clients: entry.clients.size,
    idleMs: Date.now() - entry.lastActivity,
  });
});

// GET /api/sessions/:id/scrollback — fetch tmux scrollback history (works in alternate screen too)
app.get('/api/sessions/:id/scrollback', authMiddleware, (req, res) => {
  const windowIndex = parseInt(req.params.id, 10)
  const session = req.query.session || TMUX_SESSION
  const lines = Math.min(parseInt(req.query.lines || '3000', 10), 10000)
  exec(`tmux capture-pane -p -S -${lines} -t ${session}:${windowIndex} 2>/dev/null`, (err, stdout) => {
    if (err) return res.status(500).json({ error: err.message })
    // trim trailing spaces tmux pads to pane width
    const content = stdout.split('\n').map(l => l.trimEnd()).join('\n')
    res.json({ content })
  })
})

// GET /api/config — 服务端配置信息（供前端初始化用）
app.get('/api/config', authMiddleware, (req, res) => {
  res.json({ tmuxSession: TMUX_SESSION, workspaceRoot: WORKSPACE_ROOT })
})

// GET /api/tmux-sessions — 列出所有 tmux session（F-18）
app.get('/api/tmux-sessions', authMiddleware, (req, res) => {
  exec('tmux list-sessions -F "#{session_name}|#{session_windows}|#{session_attached}"', (err, stdout) => {
    if (err) return res.json([{ name: TMUX_SESSION, windows: 0, attached: false }])
    const sessions = stdout.trim().split('\n').filter(Boolean).map(line => {
      const [name, windows, attached] = line.split('|')
      return { name, windows: Number(windows), attached: Number(attached) > 0 }
    })
    res.json(sessions)
  })
})

// ========== F-20: Project-Channel API ==========
// Project = tmux session, Channel = tmux window (within a session)

// GET /api/projects — 列出所有 Projects（tmux sessions）
app.get('/api/projects', authMiddleware, (req, res) => {
  exec('tmux list-sessions -F "#{session_name}|#{session_windows}|#{session_attached}"', (err, stdout) => {
    if (err) return res.json([])
    const lines = stdout.trim().split('\n').filter(Boolean)
    const projects = lines.map(line => {
      const [name, windows, attached] = line.split('|')
      // 尝试读取 NEXUS_CWD
      let path = ''
      try {
        const envOutput = execSync(`tmux show-environment -t ${name} NEXUS_CWD 2>/dev/null`).toString().trim()
        const match = envOutput.match(/^NEXUS_CWD=(.+)$/)
        if (match) path = match[1]
      } catch {}
      // 没有 NEXUS_CWD，尝试取第一个 window 的 pane_current_path
      if (!path && windows !== '0') {
        try {
          const cwdOutput = execSync(`tmux list-windows -t ${name} -F '#{pane_current_path}' 2>/dev/null | head -1`).toString().trim()
          if (cwdOutput) path = cwdOutput
        } catch {}
      }
      return {
        name,
        path: path || WORKSPACE_ROOT,
        active: name === TMUX_SESSION,
        channelCount: Number(windows) || 0
      }
    })
    projects.reverse()
    res.json(projects)
  })
})

// GET /api/session-cwd — 获取指定 session 的 NEXUS_CWD
app.get('/api/session-cwd', authMiddleware, (req, res) => {
  const session = req.query.session || TMUX_SESSION
  let cwd = WORKSPACE_ROOT

  // 1. 尝试读取 NEXUS_CWD（外部启动的 session 可能没有，会抛异常）
  try {
    const envOutput = execSync(`tmux show-environment -t ${session} NEXUS_CWD 2>/dev/null`).toString().trim()
    const match = envOutput.match(/^NEXUS_CWD=(.+)$/)
    if (match) cwd = match[1]
  } catch { /* NEXUS_CWD 未设置 */ }

  // 2. 若 NEXUS_CWD 未设置，回退到 pane_current_path
  if (cwd === WORKSPACE_ROOT) {
    try {
      const panePath = execSync(`tmux display-message -t ${session} -p '#{pane_current_path}' 2>/dev/null`).toString().trim()
      if (panePath) cwd = panePath
    } catch { /* fallback to WORKSPACE_ROOT */ }
  }

  const relative = cwd.startsWith(WORKSPACE_ROOT) ? cwd.slice(WORKSPACE_ROOT.length).replace(/^\/+/, '') : ''
  res.json({ cwd, relative })
})

// GET /api/projects/:name/channels — 列出指定 Project 的 Channels（windows）
app.get('/api/projects/:name/channels', authMiddleware, (req, res) => {
  const sessionName = req.params.name
  exec(
    `tmux list-windows -t ${sessionName} -F "#{window_index}|#{window_name}|#{window_active}|#{pane_current_path}"`,
    (err, stdout) => {
      if (err) return res.status(500).json({ error: err.message })
      const lines = stdout.trim().split('\n').filter(Boolean)
      const channels = lines.map(line => {
        const parts = line.split('|')
        const index = Number(parts[0])
        const name = parts[1]
        const active = parts[2]?.trim() === '1'
        const cwd = parts.slice(3).join(':') || ''
        return { index, name, active, cwd }
      })
      // 新创建的频道排在上面
      channels.reverse()
      res.json({ project: sessionName, channels })
    }
  )
})

// POST /api/projects — 新建 Project（创建 tmux session）
// body: { path, shell_type?, profile? }
// project 名称基于路径自动生成
app.post('/api/projects', authMiddleware, (req, res) => {
  const { path, profile } = req.body || {}
  const shellType = normalizeShellType(req.body?.shell_type)
  if (!path) return res.status(400).json({ error: 'path required' })

  const cwd = resolveWorkspacePath(path)

  // project 名称基于路径：把 / 替换成 -，并去除首尾 -
  let projectName = cwd.replace(/^\/+|\/+$/g, '').replace(/\//g, '-')
  if (!projectName) projectName = 'home'
  // 确保名称安全且唯一
  const safeName = projectName.replace(/[^a-zA-Z0-9._~-]/g, '-').substring(0, 50) || 'project'

  // 检查是否已存在同名 session，如果存在则添加序号
  let finalName = safeName
  try {
    const existing = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null').toString().trim().split('\n')
    let counter = 1
    while (existing.includes(finalName)) {
      finalName = `${safeName}-${counter++}`
    }
  } catch {}

  const { proxyVars, shellCmd } = buildShellCommand(shellType, profile, cwd)

  // 初始窗口名使用目录名[-profile名]（取路径最后一部分）
  const dirName = cwd.replace(/^\/+|\/+$/g, '').split('/').pop() || '~'
  const initialWindowName = profile ? `${dirName}-${profile}` : dirName

  // 创建 tmux session（如果不存在）
  try {
    execSync(`tmux new-session -d -s ${shellQuote(finalName)} -n ${shellQuote(initialWindowName)} -c ${shellQuote(cwd)} ${shellQuote(shellCmd)}`)
    // 设置 NEXUS_CWD
    setTmuxSessionEnv(finalName, 'NEXUS_CWD', cwd)
    // 设置代理变量
    applyProxyEnvToSession(finalName, proxyVars)
  } catch (err) {
    return res.status(500).json({ error: 'failed to create project: ' + err.message })
  }

  rememberProjectDefault(cwd, shellType, profile)
  res.json({ name: finalName, path: cwd, shell_type: shellType, profile: profile || null })
})

// POST /api/projects/:name/channels — 在指定 Project 中新建 Channel（window）
app.post('/api/projects/:name/channels', authMiddleware, (req, res) => {
  const sessionName = req.params.name
  const { profile, path: bodyPath } = req.body || {}
  const shellType = normalizeShellType(req.body?.shell_type)

  // 优先使用前端传入的 path，其次读取 NEXUS_CWD，最后 fallback 到 WORKSPACE_ROOT
  let cwd = WORKSPACE_ROOT
  if (bodyPath) {
    cwd = resolveWorkspacePath(bodyPath)
  } else {
    cwd = readSessionWorkspacePath(sessionName)
  }

  // Channel 命名：profile 名[-序号]
  const baseName = profile || 'channel'
  let channelName = baseName
  try {
    const existing = execSync(`tmux list-windows -t ${sessionName} -F "#{window_name}"`).toString().trim().split('\n')
    let counter = 1
    while (existing.includes(channelName)) {
      channelName = `${baseName}-${counter++}`
    }
  } catch {}

  const { proxyVars, shellCmd } = buildShellCommand(shellType, profile, cwd)

  // 确保 session 存在
  ensureTmuxSession(sessionName)
  applyProxyEnvToSession(sessionName, proxyVars)

  // 创建新 window
  const cmd = `tmux new-window -t ${shellQuote(sessionName)} -c ${shellQuote(cwd)} -n ${shellQuote(channelName)} ${shellQuote(shellCmd)}`
  exec(cmd, (err) => {
    if (err) return res.status(500).json({ error: err.message })
    rememberProjectDefault(cwd, shellType, profile)
    res.json({ name: channelName, cwd, shell_type: shellType, profile: profile || null, project: sessionName })
  })
})

// POST /api/projects/:name/activate — 切换到指定 Project（设置为目标 session）
app.post('/api/projects/:name/activate', authMiddleware, (req, res) => {
  const sessionName = req.params.name
  // 验证 session 存在
  try {
    execSync(`tmux has-session -t ${sessionName}`)
  } catch {
    return res.status(404).json({ error: 'project not found' })
  }
  // 读取该 session 最后激活的 channel
  let lastChannel = null
  try {
    const envOutput = execSync(`tmux show-environment -t ${sessionName} NEXUS_LAST_CHANNEL 2>/dev/null`).toString().trim()
    const match = envOutput.match(/^NEXUS_LAST_CHANNEL=(\d+)$/)
    if (match) lastChannel = parseInt(match[1], 10)
  } catch {}
  // 验证 channel 是否存在，不存在则返回 null（前端会用第一个）
  if (lastChannel !== null) {
    try {
      const windows = execSync(`tmux list-windows -t ${sessionName} -F "#I"`).toString().trim().split('\n')
      if (!windows.includes(String(lastChannel))) {
        lastChannel = null
      }
    } catch {
      lastChannel = null
    }
  }
  // 返回 session 信息，前端据此切换 WebSocket 连接
  res.json({ active: true, project: sessionName, lastChannel })
})

// POST /api/projects/:name/rename — 重命名 Project（重命名 tmux session）
app.post('/api/projects/:name/rename', authMiddleware, (req, res) => {
  const oldName = req.params.name
  const { name: newName } = req.body || {}
  if (!newName || !newName.trim()) {
    return res.status(400).json({ error: 'new name required' })
  }
  const sanitizedNewName = newName.trim().replace(/[^a-zA-Z0-9_\-]/g, '')
  if (!sanitizedNewName) {
    return res.status(400).json({ error: 'invalid name format' })
  }
  // 验证旧 session 存在
  try {
    execSync(`tmux has-session -t ${oldName}`)
  } catch {
    return res.status(404).json({ error: 'project not found' })
  }
  // 检查新名称是否已存在
  try {
    execSync(`tmux has-session -t ${sanitizedNewName}`)
    return res.status(409).json({ error: 'project name already exists' })
  } catch {
    // 不存在，可以重命名
  }
  // 执行重命名
  exec(`tmux rename-session -t ${oldName} ${sanitizedNewName}`, (err) => {
    if (err) return res.status(500).json({ error: err.message })
    res.json({ ok: true, oldName, newName: sanitizedNewName })
  })
})

// DELETE /api/projects/:name — 关闭 Project（kill tmux session）
app.delete('/api/projects/:name', authMiddleware, (req, res) => {
  const sessionName = req.params.name
  // 验证 session 存在
  try {
    execSync(`tmux has-session -t ${shellQuote(sessionName)}`)
  } catch {
    return res.status(404).json({ error: 'project not found' })
  }
  const windowIds = listTmuxWindowIds(sessionName)
  // kill session
  exec(`tmux kill-session -t ${shellQuote(sessionName)}`, (err) => {
    if (err) return res.status(500).json({ error: err.message })
    windowIds.forEach(cleanupCodexRuntime)
    res.json({ ok: true })
  })
})

// ================================================

// GET /api/sessions — 列出 tmux 会话的所有窗口
app.get('/api/sessions', authMiddleware, (req, res) => {
  const session = req.query.session || TMUX_SESSION
  exec(
    `tmux list-windows -t ${session} -F "#{window_index}|#{window_name}|#{window_active}"`,
    (err, stdout) => {
      if (err) return res.status(500).json({ error: err.message })
      const windows = stdout.trim().split('\n').filter(Boolean).map(line => {
        const [index, name, active] = line.split('|')
        return { index: Number(index), name, active: active?.trim() === '1' }
      })
      res.json({ session, windows })
    }
  )
})

// DELETE /api/sessions/:id — 关闭 tmux 窗口
app.delete('/api/sessions/:id', authMiddleware, (req, res) => {
  const index = req.params.id
  const session = req.query.session || TMUX_SESSION
  const windowId = getTmuxWindowId(session, index)
  // Check window count first; if this is the last window, create a fallback
  // window before killing so the tmux session is not destroyed.
  exec(`tmux list-windows -t ${shellQuote(session)} -F "#{window_index}" 2>/dev/null | wc -l`, (countErr, countOut) => {
    const windowCount = parseInt(countOut.trim()) || 0
    if (windowCount <= 1) {
      // Last window: create a new shell first to keep the session alive
      exec(`tmux new-window -t ${shellQuote(session)} -n shell ${shellQuote(DEFAULT_INTERACTIVE_SHELL)}`, () => {
        exec(`tmux kill-window -t ${shellQuote(`${session}:${index}`)}`, (err) => {
          if (err) return res.status(500).json({ error: err.message })
          cleanupCodexRuntime(windowId)
          res.json({ ok: true })
        })
      })
    } else {
      exec(`tmux kill-window -t ${shellQuote(`${session}:${index}`)}`, (err) => {
        if (err) return res.status(500).json({ error: err.message })
        cleanupCodexRuntime(windowId)
        res.json({ ok: true })
      })
    }
  })
})

// POST /api/sessions/:id/attach — 切换到指定 tmux 窗口
app.post('/api/sessions/:id/attach', authMiddleware, (req, res) => {
  const index = req.params.id
  const session = req.query.session || TMUX_SESSION
  exec(`tmux select-window -t ${session}:${index}`, (err) => {
    if (err) return res.status(500).json({ error: err.message })
    // 记录最后激活的 channel 到环境变量
    try {
      execSync(`tmux set-environment -t ${session} NEXUS_LAST_CHANNEL ${index}`)
    } catch {}
    res.json({ ok: true })
  })
})

// ---- Tasks API (F-13: claude -p 非交互派发) ----

function loadTasks() {
  try {
    if (existsSync(TASKS_FILE)) {
      return JSON.parse(readFileSync(TASKS_FILE, 'utf8'))
    }
  } catch {}
  return []
}

const MAX_TASKS = 200

function saveTasks(tasks) {
  // 保留最新的 MAX_TASKS 条，防止文件无限增长
  const trimmed = tasks.length > MAX_TASKS ? tasks.slice(-MAX_TASKS) : tasks
  writeFileSync(TASKS_FILE, JSON.stringify(trimmed, null, 2))
}

function updateTask(id, updates) {
  const tasks = loadTasks()
  const idx = tasks.findIndex(t => t.id === id)
  if (idx !== -1) {
    Object.assign(tasks[idx], updates)
    saveTasks(tasks)
  }
}

/**
 * F-17: 统一任务执行入口 — spawn claude -p, 管理任务记录, 回调给各渠道
 * @param {string} prompt
 * @param {string} cwd
 * @param {{ sessionName?: string, source?: string, tmuxSession?: string, profile?: string, onChunk?: (chunk:string,isErr:boolean)=>void, onDone?: (result:object)=>void }} opts
 * @returns {string} taskId
 */
function runTask(prompt, cwd, opts = {}) {
  const { sessionName, source = 'web', tmuxSession, profile, onChunk, onDone } = opts
  const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const createdAt = new Date().toISOString()

  const taskRecord = {
    id: taskId,
    session_name: sessionName || '',
    prompt: prompt.slice(0, 1000),
    status: 'running',
    output: '',
    error: '',
    createdAt,
    source,
    ...(tmuxSession && tmuxSession !== TMUX_SESSION ? { tmux_session: tmuxSession } : {}),
  }
  const allTasks = loadTasks()
  allTasks.push(taskRecord)
  saveTasks(allTasks)

  const proxyEnv = CLAUDE_PROXY ? { ALL_PROXY: CLAUDE_PROXY, HTTPS_PROXY: CLAUDE_PROXY, HTTP_PROXY: CLAUDE_PROXY } : {}
  const claudeArgs = ['-p', prompt, '--dangerously-skip-permissions']
  if (profile) claudeArgs.push('--profile', profile)
  const child = spawn('claude', claudeArgs, {
    cwd,
    env: sanitizeInteractiveEnv(process.env, proxyEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  activeTaskChildren.add(child)

  let output = ''
  let errorOutput = ''

  child.stdout.on('data', (data) => {
    const chunk = data.toString()
    output += chunk
    onChunk?.(chunk, false)
  })
  child.stderr.on('data', (data) => {
    const chunk = data.toString()
    errorOutput += chunk
    onChunk?.(chunk, true)
  })

  child.on('close', (code) => {
    activeTaskChildren.delete(child)
    const status = code === 0 ? 'success' : 'error'
    updateTask(taskId, {
      status,
      output: output.slice(-10000),
      error: errorOutput.slice(-1000),
      completedAt: new Date().toISOString(),
      exitCode: code,
    })
    onDone?.({ taskId, status, output, errorOutput, exitCode: code })
  })

  return { taskId, kill: () => { if (!child.killed) child.kill() } }
}

// GET /api/tasks — 获取任务历史
app.get('/api/tasks', authMiddleware, (req, res) => {
  const tasks = loadTasks()
  res.json(tasks.slice(-50).reverse()) // 最近50条，倒序
})

// DELETE /api/tasks/:id — 删除单条任务记录
app.delete('/api/tasks/:id', authMiddleware, (req, res) => {
  const tasks = loadTasks()
  const filtered = tasks.filter(t => t.id !== req.params.id)
  saveTasks(filtered)
  res.json({ ok: true })
})

// POST /api/tasks — 创建新任务，SSE 流式返回
app.post('/api/tasks', authMiddleware, (req, res) => {
  const { session_name, prompt, profile, tmux_session } = req.body || {}
  if (!prompt) return res.status(400).json({ error: 'prompt required' })

  // 找到 session 对应的 cwd
  let cwd = WORKSPACE_ROOT
  const targetSession = tmux_session || TMUX_SESSION
  try {
    const windows = execSync(`tmux list-windows -t ${targetSession} -F "#I:#W:#{pane_current_path}"`).toString().trim().split('\n')
    for (const line of windows) {
      const parts = line.split(':')
      const name = parts[1]
      const path = parts.slice(2).join(':')
      if (name === session_name && path) { cwd = path; break }
    }
  } catch {}

  // 设置 SSE headers
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  const createdAt = new Date().toISOString()
  const { taskId, kill } = runTask(prompt, cwd, {
    sessionName: session_name,
    source: 'web',
    tmuxSession: targetSession,
    profile,
    onChunk: (chunk, isErr) => {
      const ev = isErr ? 'error' : 'output'
      res.write(`event: ${ev}\ndata: ${JSON.stringify({ chunk })}\n\n`)
    },
    onDone: ({ taskId: tid, status, exitCode }) => {
      res.write(`event: done\ndata: ${JSON.stringify({ taskId: tid, status, exitCode })}\n\n`)
      res.end()
    },
  })

  res.write(`event: start\ndata: ${JSON.stringify({ taskId, session_name, prompt, createdAt })}\n\n`)
  req.on('close', kill)
})


// ---- Telegram Bot Webhook (F-16) ----

function telegramRequest(method, payload) {
  if (!TELEGRAM_BOT_TOKEN) return Promise.resolve(null)
  return new Promise((resolve) => {
    const body = JSON.stringify(payload)
    const options = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }
    const req = https.request(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,
      options,
      (res) => {
        let data = ''
        res.on('data', d => data += d)
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch { resolve(null) }
        })
      }
    )
    req.on('error', (e) => { console.error(`Telegram ${method} error:`, e.message); resolve(null) })
    req.write(body)
    req.end()
  })
}

// Returns the sent message_id (or null)
async function telegramSend(chatId, text) {
  const result = await telegramRequest('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown' })
  return result?.result?.message_id ?? null
}

// Edit an existing message in-place (silently ignores errors)
function telegramEdit(chatId, messageId, text) {
  if (!messageId) return
  telegramRequest('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'Markdown' })
}

// 下载 Telegram 文件到指定目录
function downloadTelegramFile(fileId, destDir, filename) {
  return new Promise((resolve, reject) => {
    // 1. 获取 file_path
    const infoUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`
    https.get(infoUrl, (res) => {
      let data = ''
      res.on('data', d => data += d)
      res.on('end', () => {
        try {
          const info = JSON.parse(data)
          if (!info.ok) return reject(new Error('getFile failed: ' + info.description))
          const filePath = info.result.file_path
          const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`

          // 2. 下载文件
          https.get(fileUrl, (fres) => {
            const chunks = []
            fres.on('data', c => chunks.push(c))
            fres.on('end', () => {
              const buf = Buffer.concat(chunks)
              const destPath = join(destDir, filename)
              writeFileSync(destPath, buf)
              resolve({ path: destPath, size: buf.length })
            })
            fres.on('error', reject)
          }).on('error', reject)
        } catch (e) { reject(e) }
      })
    }).on('error', reject)
  })
}

// POST /api/webhooks/telegram — Telegram Bot webhook
app.post('/api/webhooks/telegram', (req, res) => {
  // 验证 secret（如果配置了）
  if (TELEGRAM_WEBHOOK_SECRET) {
    const secret = req.headers['x-telegram-bot-api-secret-token']
    if (secret !== TELEGRAM_WEBHOOK_SECRET) {
      return res.status(403).json({ error: 'forbidden' })
    }
  }

  if (!TELEGRAM_BOT_TOKEN) return res.status(503).json({ error: 'Telegram not configured' })

  const update = req.body
  res.json({ ok: true }) // 立即返回，避免 Telegram 重试

  const message = update.message || update.edited_message
  if (!message) return

  const chatId = message.chat.id

  // /start 欢迎消息
  if (message.text?.trim() === '/start') {
    telegramSend(chatId, '👋 *Nexus Bot* 已就绪\n\n发送任意文字，我会用 `claude -p` 在你的服务器上执行并回复结果。\n\n发送图片或文件，我会保存到当前 session 目录。\n\n`/sessions` — 查看 tmux 窗口列表\n`/switch <编号>` — 切换目标窗口')
    return
  }

  // /sessions 列出当前窗口
  if (message.text?.trim() === '/sessions') {
    exec(`tmux list-windows -t ${TMUX_SESSION} -F "#{window_index}|#{window_name}|#{window_active}"`, (err, stdout) => {
      if (err) {
        telegramSend(chatId, '❌ 无法获取会话列表: ' + err.message)
        return
      }
      const lines = stdout.trim().split('\n').filter(Boolean).map(line => {
        const [idx, name, active] = line.split('|')
        return `${active?.trim() === '1' ? '▶' : '  '} \`${idx}: ${name}\``
      })
      telegramSend(chatId, '*当前 tmux 窗口:*\n' + lines.join('\n') + '\n\n用 `/switch <编号>` 切换')
    })
    return
  }

  // /switch <index|name> — 切换 active tmux 窗口
  if (message.text?.trim().startsWith('/switch ')) {
    const raw = message.text.trim().slice('/switch '.length).trim()
    const target = raw.replace(/[^a-zA-Z0-9_\-]/g, '') // 只允许安全字符
    if (!target) {
      telegramSend(chatId, '❌ 无效的窗口名称，只允许字母/数字/下划线/连字符')
      return
    }
    exec(`tmux select-window -t ${TMUX_SESSION}:${target}`, (err) => {
      if (err) {
        telegramSend(chatId, `❌ 无法切换到窗口 \`${target}\`: ${err.message}`)
      } else {
        telegramSend(chatId, `✅ 已切换到窗口 \`${target}\`\n\n后续任务将在此窗口执行。`)
      }
    })
    return
  }

  // 执行 claude -p，Telegram 渠道：增量进度推送
  async function runClaudePrompt(prompt, cwd, sessionName) {
    const msgId = await telegramSend(chatId, `⏳ *执行中*（session: \`${sessionName || 'default'}\`）\n\n_等待输出..._`)

    let currentOutput = ''
    let currentError = ''
    let currentTaskId = null

    const progressInterval = setInterval(() => {
      const preview = (currentOutput || currentError).trim()
      if (preview) {
        if (msgId) {
          const truncated = preview.length > 3000 ? '…' + preview.slice(-3000) : preview
          telegramEdit(chatId, msgId, `⏳ *执行中*（session: \`${sessionName || 'default'}\`）\n\`\`\`\n${truncated}\n\`\`\``)
        }
        // 更新任务记录，让 Web TaskPanel 可见中间输出
        if (currentTaskId) updateTask(currentTaskId, { output: currentOutput.slice(-10000), error: currentError.slice(-1000) })
      }
    }, 5000)

    const { taskId } = runTask(prompt, cwd, {
      sessionName: sessionName || 'telegram',
      source: 'telegram',
      onChunk: (chunk, isErr) => {
        if (isErr) currentError += chunk; else currentOutput += chunk
      },
      onDone: ({ exitCode }) => {
        clearInterval(progressInterval)
        const result = currentOutput.trim() || currentError.trim() || '(无输出)'
        const truncated = result.length > 3800 ? result.slice(0, 3800) + '\n\n…(输出已截断)' : result
        const status = exitCode === 0 ? '✅' : '❌'
        if (msgId) {
          telegramEdit(chatId, msgId, `${status} *执行完成*（session: \`${sessionName || 'default'}\`）\n\`\`\`\n${truncated}\n\`\`\``)
        } else {
          telegramSend(chatId, `${status} *执行完成*\n\`\`\`\n${truncated}\n\`\`\``)
        }
      },
    })
    currentTaskId = taskId
  }

  // 处理文件/图片上传
  if (message.photo || message.document) {
    (async () => {
      try {
        // 确定目标目录
        let cwd = WORKSPACE_ROOT
        try {
          const activeLines = execSync(`tmux list-windows -t ${TMUX_SESSION} -F "#I:#W:#{pane_current_path}:#{window_active}"`).toString().trim().split('\n')
          for (const line of activeLines) {
            const parts = line.split(':')
            if (parts[parts.length - 1]?.trim() === '1') {
              cwd = parts.slice(2, parts.length - 1).join(':')
              break
            }
          }
        } catch {}

        let fileId, filename
        if (message.photo) {
          const photo = message.photo[message.photo.length - 1]
          fileId = photo.file_id
          filename = `tg_photo_${Date.now()}.jpg`
        } else {
          fileId = message.document.file_id
          filename = message.document.file_name || `tg_file_${Date.now()}`
        }

        telegramSend(chatId, `⬇️ 正在下载文件到 \`${cwd}\`...`)
        const result = await downloadTelegramFile(fileId, cwd, filename)
        telegramSend(chatId, `✅ 文件已保存\n\`\`\`\n${result.path}\n\`\`\`\n大小: ${(result.size / 1024).toFixed(1)} KB`)

        // 如果有 caption，把 caption 作为 prompt 执行
        if (message.caption?.trim()) {
          const caption = message.caption.trim()
          runClaudePrompt(caption, cwd, 'telegram').catch(e => console.error('runClaudePrompt error:', e))
        }
      } catch (e) {
        telegramSend(chatId, '❌ 文件处理失败: ' + (e.message || String(e)))
      }
    })()
    return
  }

  // 普通 prompt
  const text = message.text?.trim()
  if (!text) return
  let cwd = WORKSPACE_ROOT
  let sessionName = TELEGRAM_DEFAULT_SESSION

  try {
    const windows = execSync(`tmux list-windows -t ${TMUX_SESSION} -F "#I:#W:#{pane_current_path}"`).toString().trim().split('\n')
    // 优先用默认 session，否则用 active window
    for (const line of windows) {
      const parts = line.split(':')
      const idx = parts[0]
      const name = parts[1]
      const path = parts.slice(2).join(':')
      if (TELEGRAM_DEFAULT_SESSION && name === TELEGRAM_DEFAULT_SESSION) {
        cwd = path
        sessionName = name
        break
      }
    }
    // 如果没找到默认 session，用 active window
    if (!sessionName) {
      const activeLines = execSync(`tmux list-windows -t ${TMUX_SESSION} -F "#I:#W:#{pane_current_path}:#{window_active}"`).toString().trim().split('\n')
      for (const line of activeLines) {
        const parts = line.split(':')
        const active = parts[parts.length - 1]
        if (active?.trim() === '1') {
          sessionName = parts[1]
          cwd = parts.slice(2, parts.length - 1).join(':')
          break
        }
      }
    }
  } catch { /* ignore */ }

  runClaudePrompt(text, cwd, sessionName).catch(e => console.error('runClaudePrompt error:', e))
})

// GET /api/telegram/setup — 一键配置 Telegram webhook URL
app.get('/api/telegram/setup', authMiddleware, (req, res) => {
  if (!TELEGRAM_BOT_TOKEN) return res.status(503).json({ error: 'TELEGRAM_BOT_TOKEN not set' })
  const webhookUrl = `${req.protocol}://${req.get('host')}/api/webhooks/telegram`
  const secretParam = TELEGRAM_WEBHOOK_SECRET ? `&secret_token=${TELEGRAM_WEBHOOK_SECRET}` : ''
  const setupUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}${secretParam}`

  // 调用 Telegram API 设置 webhook
  https.get(setupUrl, (r) => {
    let data = ''
    r.on('data', d => data += d)
    r.on('end', () => {
      try {
        res.json({ webhookUrl, telegramResponse: JSON.parse(data) })
      } catch {
        res.json({ webhookUrl, raw: data })
      }
    })
  }).on('error', (e) => res.status(500).json({ error: e.message }))
})

// SPA fallback — 所有非 API 路由返回 index.html
app.get('*', (req, res) => {
  const indexPath = join(__dirname, 'frontend', 'dist', 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) res.status(404).send('Not found — run: cd frontend && npm run build');
  });
});

// PTY 多实例管理（F-11/F-18：每个 session:window 独立 PTY）
const ptyMap = new Map(); // "session:windowIndex" -> { pty, clients: Set<ws>, lastOutput, lastActivity }

function ptyKey(session, windowIndex) {
  return `${session}:${windowIndex}`;
}

function tmuxSessionExists(session) {
  try {
    execSync(`tmux has-session -t ${session} 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

function listWindowIndices(session) {
  try {
    const output = execSync(`tmux list-windows -t ${session} -F "#I"`).toString().trim();
    if (!output) return [];
    return output
      .split('\n')
      .map((line) => Number.parseInt(line, 10))
      .filter((index) => Number.isInteger(index) && index >= 0);
  } catch {
    return [];
  }
}

function ensureWindowPty(session, windowIndex) {
  const key = ptyKey(session, windowIndex);
  if (ptyMap.has(key)) return { key, entry: ptyMap.get(key) };

  const target = resolvePassiveAttachTarget({
    sessionExists: tmuxSessionExists(session),
    existingWindows: listWindowIndices(session),
    requestedWindowIndex: windowIndex,
  });
  if (!target.ok) return { error: target.reason };

  const targetWindow = target.windowIndex;

  const actualKey = ptyKey(session, targetWindow);
  if (ptyMap.has(actualKey)) return { key: actualKey, entry: ptyMap.get(actualKey) }; // reuse if fallback exists

  const ptyProc = pty.spawn('tmux', ['attach-session', '-t', `${session}:${targetWindow}`], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    env: sanitizeInteractiveEnv(process.env, { LANG: 'C.UTF-8', TERM: 'xterm-256color' }),
  });

  const entry = { pty: ptyProc, clients: new Set(), clientSizes: new Map(), lastOutput: '', lastActivity: Date.now() };
  ptyMap.set(actualKey, entry);

  ptyProc.onData((data) => {
    const ent = ptyMap.get(actualKey);
    if (!ent) return;
    ent.lastOutput = (ent.lastOutput + data).slice(-10000);
    ent.lastActivity = Date.now();
    for (const ws of ent.clients) {
      if (ws.readyState === 1) ws.send(data);
    }
  });

  ptyProc.onExit(({ exitCode }) => {
    console.log(`PTY ${actualKey} exited with code ${exitCode}`);
    ptyMap.delete(actualKey);
    // 如果 window 还在，重新创建
    try {
      const list = execSync(`tmux list-windows -t ${session} -F "#I"`).toString().trim().split('\n');
      if (list.includes(String(targetWindow))) {
        setTimeout(() => ensureWindowPty(session, targetWindow), 100);
      }
    } catch {}
  });

  return { key: actualKey, entry };
}

// WebSocket 服务 — 支持 /ws?token=xxx&window=<index>
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const shutdown = createGracefulShutdown({
  server,
  wss,
  ptyMap,
  taskChildren: activeTaskChildren,
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    shutdown(signal).catch((error) => {
      console.error(`Graceful shutdown failed after ${signal}:`, error);
      process.exit(1);
    });
  });
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('token');
  const windowParam = url.searchParams.get('window') || '0';
  const windowIndex = parseInt(windowParam, 10) || 0;
  const session = url.searchParams.get('session') || TMUX_SESSION;

  try {
    jwt.verify(token, JWT_SECRET);
  } catch {
    ws.close(4001, 'unauthorized');
    return;
  }

  const ensured = ensureWindowPty(session, windowIndex);
  if (ensured.error) {
    ws.close(4004, ensured.error);
    return;
  }

  const { key, entry } = ensured;
  entry.clients.add(ws);
  console.log(`Client connected to ${key} (clients: ${entry.clients.size})`);

  // Send recent output so the screen isn't blank while waiting for the first repaint.
  if (entry.lastOutput) {
    ws.send(entry.lastOutput.slice(-2000));
  }

  ws.on('message', (msg) => {
    const ent = ptyMap.get(key);
    if (!ent) return;
    const str = typeof msg === 'string' ? msg : msg.toString();
    let isResize = false;
    try {
      const data = JSON.parse(str);
      if (data && data.type === 'resize' && data.cols && data.rows) {
        isResize = true;
        const newCols = Number(data.cols);
        const newRows = Number(data.rows);
        ent.clientSizes.set(ws, { cols: newCols, rows: newRows });
        // 直接使用当前客户端的尺寸，而不是所有客户端的最小值
        // 避免多个客户端/窗口切换时的尺寸混乱
        ent.pty.resize(Math.max(newCols, 10), Math.max(newRows, 5));
      }
    } catch { /* not JSON — fall through to pty.write */ }
    // Write for all non-resize messages. Previously only the catch branch wrote,
    // which silently dropped single-digit strings ('1'..'9','0') since
    // JSON.parse('1') succeeds without throwing.
    if (!isResize) ent.pty.write(str);
  });

  ws.on('close', () => {
    const ent = ptyMap.get(key);
    if (ent) {
      ent.clients.delete(ws);
      ent.clientSizes.delete(ws);
      console.log(`Client disconnected from ${key} (clients: ${ent.clients.size})`);
      // Recompute minimum size if other clients remain
      if (ent.clients.size > 0 && ent.clientSizes.size > 0) {
        let minCols = Infinity, minRows = Infinity;
        for (const [, size] of ent.clientSizes) {
          if (size.cols < minCols) minCols = size.cols;
          if (size.rows < minRows) minRows = size.rows;
        }
        if (minCols !== Infinity) ent.pty.resize(Math.max(minCols, 10), Math.max(minRows, 5));
      }
      // 如果 5 分钟后没有客户端，清理 PTY 节省资源
      setTimeout(() => {
        const e = ptyMap.get(key);
        if (e && e.clients.size === 0 && Date.now() - e.lastActivity > 300000) {
          e.pty.kill();
          ptyMap.delete(key);
          console.log(`PTY ${key} cleaned up (idle)`);
        }
      }, 300000);
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
    const ent = ptyMap.get(key);
    if (ent) { ent.clients.delete(ws); ent.clientSizes.delete(ws); }
  });
});

// 启动时清理残留的 running 状态（服务重启导致的孤儿任务）
try {
  const staleTasks = loadTasks()
  let changed = false
  for (const t of staleTasks) {
    if (t.status === 'running') {
      t.status = 'error'
      t.error = '(服务重启，任务中断)'
      t.completedAt = new Date().toISOString()
      changed = true
    }
  }
  if (changed) saveTasks(staleTasks)
} catch {}

server.listen(Number(PORT), HOST, () => {
  console.log(`Nexus listening on ${HOST}:${PORT}`);
  console.log(`tmux session: ${TMUX_SESSION}`);
  console.log(`workspace: ${WORKSPACE_ROOT}`);
  clearTmuxServerOnlyEnv();
  try {
    execSync(`tmux has-session -t ${TMUX_SESSION} 2>/dev/null`);
    console.log(`tmux session '${TMUX_SESSION}' ready`);
  } catch (e) { console.warn('tmux session init failed:', e.message); }
});
