// server.js — Nexus WebSocket tmux 桥接服务
import express from 'express';
import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { createServer } from 'node:http';
import { exec, execSync } from 'child_process';
import { join } from 'path';
import { readFileSync, mkdirSync, existsSync } from 'fs';
import multer from 'multer';
import { SERVER_ONLY_ENV_KEYS, wrapInteractiveShellCommand } from './interactiveEnv.js';
import { ConfigProfilesError, createConfigProfilesService } from './configProfilesService.js';
import { normalizeShellType } from './frontend/src/shellType.js';
import { createGracefulShutdown } from './gracefulShutdown.js';
import { createPtyBrokerController } from './ptyBrokerController.js';
import { installRuntimeGuards } from './runtimeGuards.js';
import { createSessionManagementService, SessionManagementError } from './sessionManagementService.js';
import { createTaskRunner, createTaskStore } from './taskRunner.js';
import { streamTaskToSse } from './taskRunnerSse.js';
import { TelegramBridgeError, createTelegramBridgeService } from './telegramBridgeService.js';
import { createUploadFilesService, UploadFilesError } from './uploadFilesService.js';
import { createVersionService, VersionServiceError } from './versionService.js';
import { createWindowLaunchService, WindowLaunchError } from './windowLaunchService.js';
import { WorkspaceError, createWorkspaceService } from './workspaceService.js';
import { saveProjectDefault } from './projectDefaults.js';
import { createRuntimePaths } from './runtimePaths.js';
import { buildClientConfig } from './serverConfig.js';
import { buildInteractiveShellCommand, collectProxyVars, shellQuote } from './shellLaunch.js';

const runtimePaths = createRuntimePaths(import.meta.url);
const PROJECT_ROOT = runtimePaths.projectRoot;

// 加载 .env 文件（如果存在）
try {
  const envPath = runtimePaths.envFile;
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

// 持久化数据目录（通过 Docker volume 挂载，重建容器不丢失）
const DATA_DIR = runtimePaths.dataDir;
const TOOLBAR_CONFIG_FILE = join(DATA_DIR, 'toolbar-config.json');
const CONFIGS_DIR = join(DATA_DIR, 'configs');
const CODEX_CONFIGS_DIR = join(DATA_DIR, 'codex-configs');
const CODEX_RUNTIME_DIR = join(DATA_DIR, 'codex-runtime');
const CODEX_VALIDATE_DIR = join(DATA_DIR, 'codex-validate');
const SHARED_CODEX_HOME = join(process.env.HOME || '', '.codex');
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
const taskStore = createTaskStore({ tasksFile: TASKS_FILE });

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
  NEXUS_PTY_BROKER_MODE = 'local',
  NEXUS_TASK_RUNNER_MODE = 'local',
  NEXUS_CODEX_HISTORY_ENABLED = '1',
} = process.env;

const CODEX_HISTORY_ENABLED = NEXUS_CODEX_HISTORY_ENABLED !== '0';

const workspaceService = createWorkspaceService({ workspaceRoot: WORKSPACE_ROOT });
const configProfilesService = createConfigProfilesService({
  configsDir: CONFIGS_DIR,
  codexConfigsDir: CODEX_CONFIGS_DIR,
  toolbarConfigFile: TOOLBAR_CONFIG_FILE,
  projectDefaultsFile: PROJECT_DEFAULTS_FILE,
  workspaceRoot: WORKSPACE_ROOT,
  codexValidateDir: CODEX_VALIDATE_DIR,
  projectPath: PROJECT_ROOT,
  claudeProxy: CLAUDE_PROXY,
});

for (const key of SERVER_ONLY_ENV_KEYS) delete process.env[key];

const DEFAULT_INTERACTIVE_SHELL = wrapInteractiveShellCommand('exec zsh -i');

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

function buildShellCommand(shellType, profile, cwd, options = {}) {
  const proxyVars = collectProxyVars(process.env, CLAUDE_PROXY)
  return {
    proxyVars,
    shellCmd: buildInteractiveShellCommand({
      shellType,
      profile,
      cwd,
      resumeSessionId: options.resumeSessionId || '',
      scriptsDir: PROJECT_ROOT,
      defaultInteractiveShell: DEFAULT_INTERACTIVE_SHELL,
      proxyVars,
    }),
  }
}

function rememberProjectDefault(cwd, shellType, profile) {
  saveProjectDefault(PROJECT_DEFAULTS_FILE, { path: cwd, shellType, profile })
}

function sendConfigProfilesError(res, error) {
  const statusCode = error instanceof ConfigProfilesError ? error.statusCode : 500
  const body = error instanceof ConfigProfilesError && error.responseBody
    ? error.responseBody
    : { error: error?.message || 'internal error' }
  res.status(statusCode).json(body)
}

function sendTelegramBridgeError(res, error) {
  const statusCode = error instanceof TelegramBridgeError ? error.statusCode : 500
  const body = error instanceof TelegramBridgeError && error.responseBody
    ? error.responseBody
    : { error: error?.message || 'internal error' }
  res.status(statusCode).json(body)
}

function sendSessionManagementError(res, error) {
  const statusCode = error instanceof SessionManagementError ? error.statusCode : 500
  const body = error instanceof SessionManagementError && error.responseBody
    ? error.responseBody
    : { error: error?.message || 'internal error' }
  res.status(statusCode).json(body)
}

function sendWindowLaunchError(res, error) {
  const statusCode = error instanceof WindowLaunchError ? error.statusCode : 500
  const body = error instanceof WindowLaunchError && error.responseBody
    ? error.responseBody
    : { error: error?.message || 'internal error' }
  res.status(statusCode).json(body)
}

function sendUploadFilesError(res, error) {
  const statusCode = error instanceof UploadFilesError ? error.statusCode : 500
  const body = error instanceof UploadFilesError && error.responseBody
    ? error.responseBody
    : { error: error?.message || 'internal error' }
  res.status(statusCode).json(body)
}

function sendVersionServiceError(res, error) {
  const statusCode = error instanceof VersionServiceError ? error.statusCode : 500
  const body = error instanceof VersionServiceError && error.responseBody
    ? error.responseBody
    : { error: error?.message || 'internal error' }
  res.status(statusCode).json(body)
}

const sessionManagementService = createSessionManagementService({
  tmuxSession: TMUX_SESSION,
  workspaceRoot: WORKSPACE_ROOT,
  sharedCodexHome: SHARED_CODEX_HOME,
  codexRuntimeDir: CODEX_RUNTIME_DIR,
  defaultInteractiveShell: DEFAULT_INTERACTIVE_SHELL,
  codexHistoryEnabled: CODEX_HISTORY_ENABLED,
  resolveWorkspacePathImpl: resolveWorkspacePath,
  readSessionWorkspacePathImpl: readSessionWorkspacePath,
  rememberProjectDefaultImpl: rememberProjectDefault,
  setTmuxSessionEnvImpl: setTmuxSessionEnv,
  applyProxyEnvToSessionImpl: applyProxyEnvToSession,
  ensureTmuxSessionImpl: ensureTmuxSession,
  buildShellCommandImpl: buildShellCommand,
})

const windowLaunchService = createWindowLaunchService({
  tmuxSession: TMUX_SESSION,
  workspaceRoot: WORKSPACE_ROOT,
  resolveWorkspacePathImpl: resolveWorkspacePath,
  readSessionWorkspacePathImpl: readSessionWorkspacePath,
  setTmuxSessionEnvImpl: setTmuxSessionEnv,
  buildShellCommandImpl: buildShellCommand,
  ensureTmuxSessionImpl: ensureTmuxSession,
  applyProxyEnvToSessionImpl: applyProxyEnvToSession,
  rememberProjectDefaultImpl: rememberProjectDefault,
})

const versionService = createVersionService({
  projectPath: PROJECT_ROOT,
  githubRepo: GITHUB_REPO,
})

const uploadFilesService = createUploadFilesService({
  workspaceRoot: WORKSPACE_ROOT,
  uploadsDir: UPLOADS_DIR,
  tmuxSession: TMUX_SESSION,
})

if (!JWT_SECRET || !ACC_PASSWORD_HASH) {
  console.error('ERROR: JWT_SECRET and ACC_PASSWORD_HASH must be set in environment');
  process.exit(1);
}

// 静态文件：frontend/dist 和 public
app.use(express.static(runtimePaths.publicDir));
app.use(express.static(runtimePaths.frontendDistDir));

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
app.post('/api/windows', authMiddleware, async (req, res) => {
  try {
    res.json(await windowLaunchService.launchWindow({
      relPath: req.body?.rel_path,
      profile: req.body?.profile,
      shellType: normalizeShellType(req.body?.shell_type),
      sessionName: req.query.session || TMUX_SESSION,
    }))
  } catch (err) {
    sendWindowLaunchError(res, err)
  }
});

// POST /api/sessions — 在 tmux 中创建新 window
// body: { rel_path, shell_type?, profile?, session? }
//   shell_type: 'claude' | 'bash' (default: 'bash' => interactive zsh)
//   当 shell_type='claude' 时，profile 可选，使用 nexus-run-claude.sh 启动
//   当 shell_type='bash' 时，直接启动 zsh
app.post('/api/sessions', authMiddleware, async (req, res) => {
  try {
    res.json(await windowLaunchService.createSessionWindow({
      relPath: req.body?.rel_path,
      profile: req.body?.profile,
      shellType: normalizeShellType(req.body?.shell_type),
      sessionName: req.body?.session || TMUX_SESSION,
    }))
  } catch (err) {
    sendWindowLaunchError(res, err)
  }
});

// GET /api/configs — 列出所有 claude 配置 profile
app.get('/api/configs', authMiddleware, (req, res) => {
  res.json(configProfilesService.listClaudeConfigs());
});

// POST /api/configs/:id — 创建或更新配置 profile
app.post('/api/configs/:id', authMiddleware, (req, res) => {
  try {
    res.json(configProfilesService.saveClaudeConfig(req.params.id, req.body || {}));
  } catch (err) {
    sendConfigProfilesError(res, err);
  }
});

// POST /api/configs/:id/sync-current — 用当前系统 live Claude 配置覆盖现有 profile
app.post('/api/configs/:id/sync-current', authMiddleware, (req, res) => {
  try {
    res.json(configProfilesService.syncCurrentClaudeConfig(req.params.id));
  } catch (err) {
    sendConfigProfilesError(res, err);
  }
});

// DELETE /api/configs/:id — 删除配置 profile
app.delete('/api/configs/:id', authMiddleware, (req, res) => {
  try {
    res.json(configProfilesService.deleteClaudeConfig(req.params.id));
  } catch (err) {
    sendConfigProfilesError(res, err);
  }
});

// GET /api/codex-configs — 列出所有 codex 配置 profile
app.get('/api/codex-configs', authMiddleware, (req, res) => {
  res.json(configProfilesService.listCodexConfigs());
});

// POST /api/codex-configs/import-global — 导入当前用户 ~/.codex
app.post('/api/codex-configs/import-global', authMiddleware, (req, res) => {
  try {
    res.json(configProfilesService.importGlobalCodexConfig({ id: req.body?.id }));
  } catch (err) {
    sendConfigProfilesError(res, err);
  }
});

// POST /api/codex-configs/:id/sync-current — 用当前系统 live Codex 配置覆盖现有 profile
app.post('/api/codex-configs/:id/sync-current', authMiddleware, (req, res) => {
  try {
    res.json(configProfilesService.syncCurrentCodexConfig(req.params.id));
  } catch (err) {
    sendConfigProfilesError(res, err);
  }
});

// POST /api/codex-configs/:id/validate — 活体验证 codex profile
app.post('/api/codex-configs/:id/validate', authMiddleware, (req, res) => {
  try {
    res.json(configProfilesService.validateCodexConfig(req.params.id));
  } catch (err) {
    sendConfigProfilesError(res, err);
  }
});

// POST /api/codex-configs/:id — 创建或更新 codex profile
app.post('/api/codex-configs/:id', authMiddleware, (req, res) => {
  try {
    res.json(configProfilesService.saveCodexConfig(req.params.id, req.body || {}));
  } catch (err) {
    sendConfigProfilesError(res, err);
  }
});

// GET /api/cc-switch/providers?kind=claude|codex — 读取 cc-switch provider 列表
app.get('/api/cc-switch/providers', authMiddleware, (req, res) => {
  try {
    res.json(configProfilesService.listCcSwitchProviders(String(req.query.kind || '').trim()));
  } catch (err) {
    sendConfigProfilesError(res, err);
  }
});

// POST /api/cc-switch/providers/:kind/:providerId/import — 从 cc-switch 覆盖导入单个 provider
app.post('/api/cc-switch/providers/:kind/:providerId/import', authMiddleware, (req, res) => {
  try {
    res.json(configProfilesService.importCcSwitchProviderProfile({
      kind: String(req.params.kind || '').trim(),
      providerId: req.params.providerId,
    }));
  } catch (err) {
    sendConfigProfilesError(res, err);
  }
});

// DELETE /api/codex-configs/:id — 删除 codex profile
app.delete('/api/codex-configs/:id', authMiddleware, (req, res) => {
  try {
    res.json(configProfilesService.deleteCodexConfigProfile(req.params.id));
  } catch (err) {
    sendConfigProfilesError(res, err);
  }
});

// GET /api/project-defaults?path=/abs/path — 读取指定项目路径的 shell/profile 默认值
app.get('/api/project-defaults', authMiddleware, (req, res) => {
  res.json(configProfilesService.getProjectDefaultForPath(req.query.path));
});

// GET /api/toolbar-config — 读取工具栏配置
app.get('/api/toolbar-config', authMiddleware, (req, res) => {
  res.json(configProfilesService.readToolbarConfig());
});

// POST /api/toolbar-config — 保存工具栏配置
app.post('/api/toolbar-config', authMiddleware, (req, res) => {
  try {
    res.json(configProfilesService.saveToolbarConfig(req.body));
  } catch (err) {
    sendConfigProfilesError(res, err);
  }
});

// GET /api/version — 当前版本号及工作区状态
app.get('/api/version', authMiddleware, (req, res) => {
  try {
    res.json(versionService.getCurrentVersion());
  } catch (err) {
    sendVersionServiceError(res, err);
  }
});

// GET /api/version/latest — 代理 GitHub Tags API 获取最新版本（兼容只有 tag 没有 Release 的 repo）
app.get('/api/version/latest', authMiddleware, async (req, res) => {
  try {
    res.json(await versionService.fetchLatestVersion());
  } catch (err) {
    sendVersionServiceError(res, err);
  }
});

app.get('/api/browse', authMiddleware, (req, res) => {
  try {
    res.json(workspaceService.browseDirectories(req.query.path || ''))
  } catch (err) {
    res.status(err instanceof WorkspaceError ? err.statusCode : 500).json({ error: err.message })
  }
})

// GET /api/workspace/files — 浏览文件系统（支持文件和目录，任意路径）
app.get('/api/workspace/files', authMiddleware, (req, res) => {
  try {
    res.json(workspaceService.listEntries(req.query.path || ''))
  } catch (err) {
    res.status(err instanceof WorkspaceError ? err.statusCode : 500).json({ error: err.message })
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
    const fullPath = workspaceService.resolveServeFilePath({
      queryPath: req.query.path,
      requestPath: req.path,
    })
    if (req.query.dl === '1') {
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(workspaceService.basename(fullPath))}`)
    }
    res.sendFile(fullPath)
  } catch (err) {
    res.status(err instanceof WorkspaceError ? err.statusCode : 500).send(err.message)
  }
})

// POST /api/workspace/mkdir — 创建文件夹
app.post('/api/workspace/mkdir', authMiddleware, (req, res) => {
  try {
    res.json(workspaceService.createDirectory(req.body || {}))
  } catch (err) {
    res.status(err instanceof WorkspaceError ? err.statusCode : 500).json({ error: err.message })
  }
})

// POST /api/workspace/files — 创建新文件
app.post('/api/workspace/files', authMiddleware, (req, res) => {
  try {
    res.json(workspaceService.createFile(req.body || {}))
  } catch (err) {
    res.status(err instanceof WorkspaceError ? err.statusCode : 500).json({ error: err.message })
  }
})

// GET /api/workspace/file — 读取文件内容
app.get('/api/workspace/file', authMiddleware, (req, res) => {
  try {
    res.json(workspaceService.readFileContent(req.query.path || ''))
  } catch (err) {
    res.status(err instanceof WorkspaceError ? err.statusCode : 500).json({ error: err.message })
  }
})

// PUT /api/workspace/file — 保存文件内容
app.put('/api/workspace/file', authMiddleware, (req, res) => {
  try {
    res.json(workspaceService.writeFileContent(req.body || {}))
  } catch (err) {
    res.status(err instanceof WorkspaceError ? err.statusCode : 500).json({ error: err.message })
  }
})

// DELETE /api/workspace/entry — 删除文件或目录
app.delete('/api/workspace/entry', authMiddleware, (req, res) => {
  try {
    const pathValue = req.body?.path || req.query?.path || ''
    res.json(workspaceService.deleteEntry(pathValue))
  } catch (err) {
    res.status(err instanceof WorkspaceError ? err.statusCode : 500).json({ error: err.message })
  }
})

// POST /api/workspace/rename — 重命名文件或目录
app.post('/api/workspace/rename', authMiddleware, (req, res) => {
  try {
    res.json(workspaceService.renameEntry(req.body || {}))
  } catch (err) {
    res.status(err instanceof WorkspaceError ? err.statusCode : 500).json({ error: err.message })
  }
})

// POST /api/workspace/copy — 复制文件或目录
app.post('/api/workspace/copy', authMiddleware, (req, res) => {
  try {
    res.json(workspaceService.copyEntry(req.body || {}))
  } catch (err) {
    res.status(err instanceof WorkspaceError ? err.statusCode : 500).json({ error: err.message })
  }
})

// POST /api/workspace/move — 移动文件或目录
app.post('/api/workspace/move', authMiddleware, (req, res) => {
  try {
    res.json(workspaceService.moveEntry(req.body || {}))
  } catch (err) {
    res.status(err instanceof WorkspaceError ? err.statusCode : 500).json({ error: err.message })
  }
})

// POST /api/upload — 上传文件到指定 session 的 cwd（F-14）
// body: multipart/form-data, fields: file, session_name (optional)
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, uploadFilesService.resolveWorkspaceUploadDestination(req.body?.session_name || ''))
    },
    filename: (req, file, cb) => {
      cb(null, uploadFilesService.sanitizeWorkspaceUploadFilename(file.originalname))
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
})

app.post('/api/upload', authMiddleware, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message })
    if (!req.file) return res.status(400).json({ error: 'no file' })
    res.json(uploadFilesService.buildWorkspaceUploadResult(req.file))
  })
})

// ---- F-21: 独立文件上传 API（上传到 data/uploads，不混入项目目录）----

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
    try {
      res.json(uploadFilesService.saveManagedUploadFile({
        fileBuffer: req.file.buffer,
        originalName: req.file.originalname,
        preferredName: req.body?.originalName,
        size: req.file.size,
        overwrite: req.query.overwrite === '1',
      }))
    } catch (error) {
      sendUploadFilesError(res, error)
    }
  })
})

// 静态服务：上传的文件直接访问（/uploads/日期/文件名）
app.use('/uploads', express.static(UPLOADS_DIR))

// GET /api/files — 列出上传的文件（按日期分组）
app.get('/api/files', authMiddleware, (req, res) => {
  try {
    res.json(uploadFilesService.listManagedFiles())
  } catch (err) {
    sendUploadFilesError(res, err)
  }
})

// DELETE /api/files/:date/:filename — 删除上传的文件
app.delete('/api/files/:date/:filename', authMiddleware, (req, res) => {
  try {
    res.json(uploadFilesService.deleteManagedFile({
      date: req.params.date,
      filename: req.params.filename,
    }))
  } catch (err) {
    sendUploadFilesError(res, err)
  }
})

// DELETE /api/files/all — 删除所有上传的文件
app.delete('/api/files/all', authMiddleware, (req, res) => {
  try {
    res.json(uploadFilesService.deleteAllManagedFiles())
  } catch (err) {
    sendUploadFilesError(res, err)
  }
})

// POST /api/sessions/:id/rename — 重命名窗口
app.post('/api/sessions/:id/rename', authMiddleware, (req, res) => {
  try {
    res.json(sessionManagementService.renameSessionWindow({
      index: req.params.id,
      session: req.query.session || TMUX_SESSION,
      name: req.body?.name,
    }))
  } catch (err) {
    sendSessionManagementError(res, err)
  }
})

// GET /api/sessions/:id/output — 获取窗口最后输出（F-15 状态卡片）
app.get('/api/sessions/:id/output', authMiddleware, async (req, res) => {
  try {
    const windowIndex = parseInt(req.params.id, 10);
    const session = req.query.session || TMUX_SESSION;
    res.json(await broker.getOutputSnapshot(session, windowIndex));
  } catch (err) {
    res.status(500).json({ error: err?.message || 'internal error' });
  }
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
  res.json(buildClientConfig({
    tmuxSession: TMUX_SESSION,
    workspaceRoot: WORKSPACE_ROOT,
    codexHistoryEnabled: CODEX_HISTORY_ENABLED,
  }))
})

// GET /api/tmux-sessions — 列出所有 tmux session（F-18）
app.get('/api/tmux-sessions', authMiddleware, (req, res) => {
  res.json(sessionManagementService.listTmuxSessions())
})

// ========== F-20: Project-Channel API ==========
// Project = tmux session, Channel = tmux window (within a session)

// GET /api/projects — 列出所有 Projects（tmux sessions）
app.get('/api/projects', authMiddleware, (req, res) => {
  res.json(sessionManagementService.listProjects())
})

// GET /api/session-cwd — 获取指定 session 的 NEXUS_CWD
app.get('/api/session-cwd', authMiddleware, (req, res) => {
  res.json(sessionManagementService.getSessionCwd(req.query.session || TMUX_SESSION))
})

// GET /api/codex-sessions?project=<name>&limit=<n>&cursor=<offset>
app.get('/api/codex-sessions', authMiddleware, (req, res) => {
  const projectName = String(req.query.project || '').trim()
  try {
    res.json(sessionManagementService.listCodexSessions({
      projectName,
      limit: req.query.limit,
      cursor: req.query.cursor,
    }))
  } catch (err) {
    sendSessionManagementError(res, err)
  }
})

// GET /api/codex-sessions/:id/detail
app.get('/api/codex-sessions/:id/detail', authMiddleware, (req, res) => {
  try {
    res.json(sessionManagementService.getCodexSessionDetail({
      sessionId: req.params.id,
      projectName: req.query.project || '',
    }))
  } catch (err) {
    sendSessionManagementError(res, err)
  }
})

// POST /api/codex-sessions/:id/resume
app.post('/api/codex-sessions/:id/resume', authMiddleware, async (req, res) => {
  try {
    res.json(await sessionManagementService.resumeCodexSession({
      sessionId: req.params.id,
      projectName: req.body?.project || req.query.project || '',
    }))
  } catch (err) {
    sendSessionManagementError(res, err)
  }
})

// DELETE /api/codex-sessions/:id
app.delete('/api/codex-sessions/:id', authMiddleware, (req, res) => {
  try {
    res.json(sessionManagementService.deleteProjectCodexSession({
      sessionId: req.params.id,
      projectName: req.body?.project || req.query.project || '',
    }))
  } catch (err) {
    sendSessionManagementError(res, err)
  }
})

// GET /api/projects/:name/channels — 列出指定 Project 的 Channels（windows）
app.get('/api/projects/:name/channels', authMiddleware, (req, res) => {
  try {
    res.json(sessionManagementService.listProjectChannels(req.params.name))
  } catch (err) {
    sendSessionManagementError(res, err)
  }
})

// POST /api/projects — 新建 Project（创建 tmux session）
// body: { path, shell_type?, profile? }
// project 名称基于路径自动生成
app.post('/api/projects', authMiddleware, (req, res) => {
  try {
    res.json(sessionManagementService.createProject({
      path: req.body?.path,
      profile: req.body?.profile,
      shellType: normalizeShellType(req.body?.shell_type),
    }))
  } catch (err) {
    sendSessionManagementError(res, err)
  }
})

// POST /api/projects/:name/channels — 在指定 Project 中新建 Channel（window）
app.post('/api/projects/:name/channels', authMiddleware, (req, res) => {
  try {
    res.json(sessionManagementService.createProjectChannel({
      projectName: req.params.name,
      path: req.body?.path,
      profile: req.body?.profile,
      shellType: normalizeShellType(req.body?.shell_type),
    }))
  } catch (err) {
    sendSessionManagementError(res, err)
  }
})

// POST /api/projects/:name/activate — 切换到指定 Project（设置为目标 session）
app.post('/api/projects/:name/activate', authMiddleware, (req, res) => {
  try {
    res.json(sessionManagementService.activateProject(req.params.name))
  } catch (err) {
    sendSessionManagementError(res, err)
  }
})

// POST /api/projects/:name/rename — 重命名 Project（重命名 tmux session）
app.post('/api/projects/:name/rename', authMiddleware, (req, res) => {
  try {
    res.json(sessionManagementService.renameProject({
      oldName: req.params.name,
      newName: req.body?.name,
    }))
  } catch (err) {
    sendSessionManagementError(res, err)
  }
})

// DELETE /api/projects/:name — 关闭 Project（kill tmux session）
app.delete('/api/projects/:name', authMiddleware, (req, res) => {
  try {
    res.json(sessionManagementService.deleteProject(req.params.name))
  } catch (err) {
    sendSessionManagementError(res, err)
  }
})

// ================================================

// GET /api/sessions — 列出 tmux 会话的所有窗口
app.get('/api/sessions', authMiddleware, (req, res) => {
  try {
    res.json(sessionManagementService.listSessionWindows(req.query.session || TMUX_SESSION))
  } catch (err) {
    sendSessionManagementError(res, err)
  }
})

// DELETE /api/sessions/:id — 关闭 tmux 窗口
app.delete('/api/sessions/:id', authMiddleware, (req, res) => {
  try {
    res.json(sessionManagementService.deleteSessionWindow({
      index: req.params.id,
      session: req.query.session || TMUX_SESSION,
    }))
  } catch (err) {
    sendSessionManagementError(res, err)
  }
})

// POST /api/sessions/:id/attach — 切换到指定 tmux 窗口
app.post('/api/sessions/:id/attach', authMiddleware, (req, res) => {
  try {
    res.json(sessionManagementService.attachSessionWindow({
      index: req.params.id,
      session: req.query.session || TMUX_SESSION,
    }))
  } catch (err) {
    sendSessionManagementError(res, err)
  }
})

// ---- Tasks API (F-13: claude -p 非交互派发) ----
const taskRunner = createTaskRunner({
  taskStore,
  taskChildren: activeTaskChildren,
  claudeProxy: CLAUDE_PROXY,
  defaultTmuxSession: TMUX_SESSION,
  mode: NEXUS_TASK_RUNNER_MODE,
  log: console,
})

const telegramBridgeService = createTelegramBridgeService({
  botToken: TELEGRAM_BOT_TOKEN,
  webhookSecret: TELEGRAM_WEBHOOK_SECRET,
  tmuxSession: TMUX_SESSION,
  telegramDefaultSession: TELEGRAM_DEFAULT_SESSION,
  workspaceRoot: WORKSPACE_ROOT,
  taskRunner,
  taskStore,
  log: console,
})

// GET /api/tasks — 获取任务历史
app.get('/api/tasks', authMiddleware, (req, res) => {
  res.json(taskStore.listRecent(50))
})

// DELETE /api/tasks/:id — 删除单条任务记录
app.delete('/api/tasks/:id', authMiddleware, (req, res) => {
  taskStore.deleteTask(req.params.id)
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

  streamTaskToSse({
    res,
    taskRunner,
    prompt,
    cwd,
    sessionName: session_name,
    source: 'web',
    tmuxSession: targetSession,
    profile,
  })
})


// ---- Telegram Bot Webhook (F-16) ----

// POST /api/webhooks/telegram — Telegram Bot webhook
app.post('/api/webhooks/telegram', (req, res) => {
  try {
    telegramBridgeService.verifyWebhookRequest(req.headers)
  } catch (err) {
    sendTelegramBridgeError(res, err)
    return
  }

  res.json({ ok: true })
  void telegramBridgeService.handleWebhookUpdate(req.body).catch((err) => {
    console.error('telegram webhook error:', err)
  })
})

// GET /api/telegram/setup — 一键配置 Telegram webhook URL
app.get('/api/telegram/setup', authMiddleware, async (req, res) => {
  try {
    res.json(await telegramBridgeService.setupWebhook({
      protocol: req.protocol,
      host: req.get('host'),
    }))
  } catch (err) {
    sendTelegramBridgeError(res, err)
  }
})

// SPA fallback — 所有非 API 路由返回 index.html
app.get('*', (req, res) => {
  const indexPath = join(runtimePaths.frontendDistDir, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) res.status(404).send('Not found — run: cd frontend && npm run build');
  });
});

const broker = createPtyBrokerController({
  mode: NEXUS_PTY_BROKER_MODE,
  log: console,
});

// WebSocket 服务 — 支持 /ws?token=xxx&window=<index>
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const shutdown = createGracefulShutdown({
  server,
  wss,
  ptyMap: broker.ptyMap,
  taskChildren: activeTaskChildren,
  cleanupImpl: async () => {
    await Promise.allSettled([
      broker.close(),
      taskRunner.close?.(),
    ])
  },
});
installRuntimeGuards({ server, shutdown, log: console });

wss.on('connection', async (ws, req) => {
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

  const attached = await broker.attachClient(session, windowIndex, ws);
  if (attached.error) {
    ws.close(4004, attached.error);
    return;
  }

  const { key, clientsCount } = attached;
  console.log(`Client connected to ${key} (clients: ${clientsCount})`);

  ws.on('message', (msg) => {
    broker.handleClientMessage(key, ws, msg);
  });

  ws.on('close', () => {
    const current = broker.handleClientClose(key, ws);
    console.log(`Client disconnected from ${key} (clients: ${current.clientsCount})`);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
    broker.handleClientError(key, ws);
  });
});

// 启动时清理残留的 running 状态（服务重启导致的孤儿任务）
try {
  taskStore.markRunningTasksInterrupted('(服务重启，任务中断)')
} catch {}

server.listen(Number(PORT), HOST, () => {
  console.log(`Nexus listening on ${HOST}:${PORT}`);
  console.log(`tmux session: ${TMUX_SESSION}`);
  console.log(`workspace: ${WORKSPACE_ROOT}`);
  console.log(`pty broker mode: ${NEXUS_PTY_BROKER_MODE}`);
  console.log(`task runner mode: ${NEXUS_TASK_RUNNER_MODE}`);
  clearTmuxServerOnlyEnv();
  try {
    execSync(`tmux has-session -t ${TMUX_SESSION} 2>/dev/null`);
    console.log(`tmux session '${TMUX_SESSION}' ready`);
  } catch (e) { console.warn('tmux session init failed:', e.message); }
});
