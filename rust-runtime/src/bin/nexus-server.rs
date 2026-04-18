use axum::Router;
use axum::body::Body;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Json, Multipart, Path as AxumPath, Query, State};
use axum::http::header::{
    AUTHORIZATION, CACHE_CONTROL, CONNECTION, CONTENT_DISPOSITION, CONTENT_TYPE,
};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::response::sse::{Event as SseEvent, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, delete, get, post, put};
use bcrypt::verify;
use chrono::Utc;
use futures_core::Stream;
use jsonwebtoken::{EncodingKey, Header, encode};
use mime_guess::from_path;
use nexus_rust_runtime::auth::validate_auth_token;
use nexus_rust_runtime::path_utils::{
    copy_path_recursive_sync, normalize_path_lexically, path_contains_parent_marker,
    path_to_string, percent_encode_utf8, remove_path_recursive_sync, resolve_workspace_path,
    sanitize_request_path, strip_leading_parent_components,
};
use nexus_rust_runtime::project_defaults::{get_project_default_payload, remember_project_default};
use nexus_rust_runtime::runtime_config::{AppConfig, RuntimeConfigs, RuntimeServiceConfig};
use nexus_rust_runtime::sanitize::{
    sanitize_managed_upload_filename, sanitize_project_name, sanitize_telegram_filename,
    sanitize_telegram_switch_target, sanitize_window_name, sanitize_workspace_upload_filename,
    truncate_head, truncate_head_with_notice, truncate_tail, truncate_websocket_close_reason,
};
use nexus_rust_runtime::shell::{
    build_interactive_shell_command, build_window_name, derive_initial_window_name,
    derive_project_session_name, next_available_name, normalize_shell_type,
};
use reqwest::Client;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::convert::Infallible;
use std::env;
use std::error::Error;
use std::fs as stdfs;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::task::{Context, Poll};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::fs;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{Mutex, broadcast, mpsc, oneshot};
use tokio::time::{Duration, timeout};

const DEFAULT_INTERACTIVE_SHELL: &str = "unset HOST; exec zsh -i";
const TOKEN_TTL_SECONDS: u64 = 30 * 24 * 60 * 60;
const DEFAULT_TASK_HISTORY_LIMIT: usize = 50;
const DEFAULT_MAX_TASKS: usize = 200;
const MAX_TASK_OUTPUT_LENGTH: usize = 10_000;
const MAX_TASK_ERROR_LENGTH: usize = 1_000;
const MAX_TASK_PROMPT_LENGTH: usize = 1_000;
const TASK_INTERRUPT_MESSAGE: &str = "(服务重启，任务中断)";
const CODEX_LOGIN_STATUS_TIMEOUT_MS: u64 = 15_000;
const CODEX_EXEC_VALIDATE_TIMEOUT_MS: u64 = 120_000;
const CC_SWITCH_SYNC_SOURCE: &str = "cc-switch";
const TELEGRAM_RUNNING_INTERVAL_MS: u64 = 5_000;
const TELEGRAM_START_MESSAGE: &str = "👋 *Nexus Bot* 已就绪\n\n发送任意文字，我会用 `claude -p` 在你的服务器上执行并回复结果。\n\n发送图片或文件，我会保存到当前 session 目录。\n\n`/sessions` — 查看 tmux 窗口列表\n`/switch <编号>` — 切换目标窗口";

#[derive(Clone)]
struct AppState {
    jwt_secret: Arc<String>,
    password_hash: Arc<String>,
    default_tmux_session: Arc<String>,
    codex_history_enabled: bool,
    ws_connection_counter: Arc<AtomicUsize>,
    github_repo: Arc<String>,
    project_root: Arc<PathBuf>,
    workspace_root: Arc<String>,
    configs_dir: Arc<PathBuf>,
    codex_configs_dir: Arc<PathBuf>,
    codex_validate_dir: Arc<PathBuf>,
    project_defaults_file: Arc<PathBuf>,
    toolbar_config_file: Arc<PathBuf>,
    uploads_dir: Arc<PathBuf>,
    proxy_vars: Arc<Vec<(String, String)>>,
    public_dir: Arc<PathBuf>,
    frontend_dist_dir: Arc<PathBuf>,
    runtime_manager: Arc<RuntimeManager>,
    task_manager: Arc<TaskManager>,
    telegram_bridge: Arc<TelegramBridge>,
}

impl AppState {
    fn find_static_file(&self, request_path: &str) -> Option<PathBuf> {
        let safe_path = sanitize_request_path(request_path)?;
        if safe_path.as_os_str().is_empty() {
            return None;
        }

        for base in [&*self.public_dir, &*self.frontend_dist_dir] {
            let candidate = base.join(&safe_path);
            if candidate.is_file() {
                return Some(candidate);
            }
        }

        None
    }

    fn index_path(&self) -> PathBuf {
        self.frontend_dist_dir.join("index.html")
    }
}

struct RuntimeManager {
    task_runner: Arc<ManagedRuntime>,
    pty_broker: Arc<ManagedRuntime>,
    window_launch: Arc<ManagedRuntime>,
    session_management: Arc<ManagedRuntime>,
}

impl RuntimeManager {
    async fn new(configs: RuntimeConfigs) -> Self {
        Self {
            task_runner: ManagedRuntime::boot(configs.task_runner).await,
            pty_broker: ManagedRuntime::boot(configs.pty_broker).await,
            window_launch: ManagedRuntime::boot(configs.window_launch).await,
            session_management: ManagedRuntime::boot(configs.session_management).await,
        }
    }

    async fn runtime_status_payload(&self) -> Value {
        json!({
            "server": {
                "mode": "rust",
                "ready": true,
                "source": "nexus-server",
            },
            "taskRunner": self.task_runner.runtime_status().await,
            "ptyBroker": self.pty_broker.runtime_status().await,
            "windowLaunch": self.window_launch.runtime_status().await,
            "sessionManagement": self.session_management.runtime_status().await,
        })
    }

    async fn shutdown_all(&self) {
        self.task_runner.shutdown().await;
        self.pty_broker.shutdown().await;
        self.window_launch.shutdown().await;
        self.session_management.shutdown().await;
    }

    async fn session_management_request(
        &self,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        self.session_management.request(method, params).await
    }

    async fn window_launch_request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.window_launch.request(method, params).await
    }

    async fn pty_broker_request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.pty_broker.request(method, params).await
    }

    async fn pty_broker_notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.pty_broker.notify(method, params).await
    }

    async fn pty_broker_subscribe_events(
        &self,
    ) -> Option<broadcast::Receiver<RuntimeEventEnvelope>> {
        self.pty_broker.subscribe_events().await
    }
}

struct ManagedRuntime {
    display_name: &'static str,
    inner: Mutex<ManagedRuntimeState>,
}

struct ManagedRuntimeState {
    ready_timeout: Duration,
    process: Option<RuntimeProcess>,
    status: Value,
}

impl ManagedRuntime {
    async fn boot(config: RuntimeServiceConfig) -> Arc<Self> {
        let runtime = Arc::new(Self {
            display_name: config.display_name,
            inner: Mutex::new(ManagedRuntimeState {
                ready_timeout: config.ready_timeout,
                process: None,
                status: runtime_unconfigured_status(),
            }),
        });

        if let Some(executable) = config.executable {
            let status = runtime
                .boot_process(executable, config.args, config.ready_timeout)
                .await;
            let mut guard = runtime.inner.lock().await;
            guard.status = status;
        }

        runtime
    }

    async fn boot_process(
        &self,
        executable: PathBuf,
        args: Vec<String>,
        ready_timeout: Duration,
    ) -> Value {
        let mut process = match RuntimeProcess::spawn(self.display_name, &executable, &args).await {
            Ok(process) => process,
            Err(error) => return runtime_error_status("nexus-server", &error),
        };

        match process.request("ready", json!({}), ready_timeout).await {
            Ok(result) => {
                let status = normalize_runtime_status(result);
                log_runtime_ready(self.display_name, &status);
                let mut guard = self.inner.lock().await;
                guard.process = Some(process);
                status
            }
            Err(error) => {
                let _ = process.terminate().await;
                runtime_error_status("nexus-server", &error)
            }
        }
    }

    async fn runtime_status(&self) -> Value {
        let mut guard = self.inner.lock().await;
        let ready_timeout = guard.ready_timeout;

        let Some(process) = guard.process.as_mut() else {
            return guard.status.clone();
        };

        match process
            .request("runtimeStatus", json!({}), ready_timeout)
            .await
        {
            Ok(result) => {
                let status = normalize_runtime_status(result);
                guard.status = status.clone();
                status
            }
            Err(error) => {
                if let Some(mut process) = guard.process.take() {
                    let _ = process.terminate().await;
                }
                let source = guard
                    .status
                    .get("source")
                    .and_then(Value::as_str)
                    .unwrap_or("nexus-server");
                let status = runtime_error_status(source, &error);
                guard.status = status.clone();
                status
            }
        }
    }

    async fn shutdown(&self) {
        let mut guard = self.inner.lock().await;
        if let Some(mut process) = guard.process.take() {
            let _ = process.shutdown(guard.ready_timeout).await;
        }
        if let Some(status) = guard.status.as_object_mut() {
            status.insert("ready".to_string(), Value::Bool(false));
        }
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let mut guard = self.inner.lock().await;
        let ready_timeout = guard.ready_timeout;

        let Some(process) = guard.process.as_mut() else {
            return Err(format!(
                "{} runtime executable not configured",
                self.display_name
            ));
        };

        process.request(method, params, ready_timeout).await
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let mut guard = self.inner.lock().await;

        let Some(process) = guard.process.as_mut() else {
            return Err(format!(
                "{} runtime executable not configured",
                self.display_name
            ));
        };

        process.notify(method, params).await
    }

    async fn subscribe_events(&self) -> Option<broadcast::Receiver<RuntimeEventEnvelope>> {
        let guard = self.inner.lock().await;
        guard.process.as_ref().map(RuntimeProcess::subscribe_events)
    }
}

type PendingRuntimeRequests = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>;

#[derive(Clone, Debug)]
struct RuntimeEventEnvelope {
    event: String,
    params: Value,
}

struct RuntimeProcess {
    display_name: &'static str,
    child: Child,
    stdin: ChildStdin,
    request_counter: u64,
    pending_requests: PendingRuntimeRequests,
    event_tx: broadcast::Sender<RuntimeEventEnvelope>,
    closed_error: Arc<Mutex<Option<String>>>,
    closing: Arc<AtomicBool>,
}

impl RuntimeProcess {
    async fn spawn(
        display_name: &'static str,
        executable: &Path,
        args: &[String],
    ) -> Result<Self, String> {
        let mut child = Command::new(executable)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| {
                format!(
                    "failed to spawn {} runtime {}: {}",
                    display_name,
                    executable.display(),
                    error
                )
            })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| format!("failed to capture {} runtime stdin", display_name))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| format!("failed to capture {} runtime stdout", display_name))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| format!("failed to capture {} runtime stderr", display_name))?;

        spawn_stderr_logger(display_name, stderr);

        let pending_requests = Arc::new(Mutex::new(HashMap::new()));
        let (event_tx, _) = broadcast::channel(256);
        let closed_error = Arc::new(Mutex::new(None));
        let closing = Arc::new(AtomicBool::new(false));
        spawn_runtime_stdout_dispatcher(
            display_name,
            stdout,
            pending_requests.clone(),
            event_tx.clone(),
            closed_error.clone(),
            closing.clone(),
        );

        Ok(Self {
            display_name,
            child,
            stdin,
            request_counter: 0,
            pending_requests,
            event_tx,
            closed_error,
            closing,
        })
    }

    async fn request(
        &mut self,
        method: &str,
        params: Value,
        request_timeout: Duration,
    ) -> Result<Value, String> {
        if let Some(exit_status) = self.child.try_wait().map_err(|error| {
            format!(
                "{} runtime wait failed before request: {}",
                self.display_name, error
            )
        })? {
            return Err(format!(
                "{} runtime exited before request {}: {}",
                self.display_name, method, exit_status
            ));
        }

        if let Some(message) = self.closed_error.lock().await.clone() {
            return Err(message);
        }

        self.request_counter += 1;
        let request_id = format!("runtime_req_{}", self.request_counter);
        let payload = json!({
            "kind": "request",
            "id": request_id,
            "method": method,
            "params": params,
        });
        let (response_tx, response_rx) = oneshot::channel::<Result<Value, String>>();
        self.pending_requests
            .lock()
            .await
            .insert(request_id.clone(), response_tx);

        let message = serde_json::to_string(&payload).map_err(|error| {
            format!(
                "failed to serialize {} request: {}",
                self.display_name, error
            )
        })?;
        if let Err(error) = self.stdin.write_all(message.as_bytes()).await {
            self.pending_requests.lock().await.remove(&request_id);
            return Err(format!(
                "failed to write {} request: {}",
                self.display_name, error
            ));
        }
        if let Err(error) = self.stdin.write_all(b"\n").await {
            self.pending_requests.lock().await.remove(&request_id);
            return Err(format!(
                "failed to write {} request newline: {}",
                self.display_name, error
            ));
        }
        if let Err(error) = self.stdin.flush().await {
            self.pending_requests.lock().await.remove(&request_id);
            return Err(format!(
                "failed to flush {} request: {}",
                self.display_name, error
            ));
        }

        match timeout(request_timeout, response_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(self.closed_error.lock().await.clone().unwrap_or_else(|| {
                format!(
                    "{} runtime response channel closed: {}",
                    self.display_name, method
                )
            })),
            Err(_) => {
                self.pending_requests.lock().await.remove(&request_id);
                Err(format!(
                    "{} runtime request timed out: {}",
                    self.display_name, method
                ))
            }
        }
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        if let Some(exit_status) = self.child.try_wait().map_err(|error| {
            format!(
                "{} runtime wait failed before notify: {}",
                self.display_name, error
            )
        })? {
            return Err(format!(
                "{} runtime exited before notify {}: {}",
                self.display_name, method, exit_status
            ));
        }

        if let Some(message) = self.closed_error.lock().await.clone() {
            return Err(message);
        }

        let payload = json!({
            "kind": "notify",
            "method": method,
            "params": params,
        });
        let message = serde_json::to_string(&payload).map_err(|error| {
            format!(
                "failed to serialize {} notify: {}",
                self.display_name, error
            )
        })?;
        self.stdin
            .write_all(message.as_bytes())
            .await
            .map_err(|error| format!("failed to write {} notify: {}", self.display_name, error))?;
        self.stdin.write_all(b"\n").await.map_err(|error| {
            format!(
                "failed to write {} notify newline: {}",
                self.display_name, error
            )
        })?;
        self.stdin
            .flush()
            .await
            .map_err(|error| format!("failed to flush {} notify: {}", self.display_name, error))
    }

    fn subscribe_events(&self) -> broadcast::Receiver<RuntimeEventEnvelope> {
        self.event_tx.subscribe()
    }

    async fn shutdown(&mut self, request_timeout: Duration) -> Result<(), String> {
        self.closing.store(true, Ordering::SeqCst);
        let _ = self.request("shutdown", json!({}), request_timeout).await;
        self.terminate().await
    }

    async fn terminate(&mut self) -> Result<(), String> {
        self.closing.store(true, Ordering::SeqCst);
        if self
            .child
            .try_wait()
            .map_err(|error| format!("{} runtime wait failed: {}", self.display_name, error))?
            .is_some()
        {
            return Ok(());
        }

        let _ = self.child.start_kill();
        self.child.wait().await.map_err(|error| {
            format!(
                "failed to wait for {} runtime shutdown: {}",
                self.display_name, error
            )
        })?;
        Ok(())
    }
}

fn spawn_runtime_stdout_dispatcher(
    display_name: &'static str,
    stdout: ChildStdout,
    pending_requests: PendingRuntimeRequests,
    event_tx: broadcast::Sender<RuntimeEventEnvelope>,
    closed_error: Arc<Mutex<Option<String>>>,
    closing: Arc<AtomicBool>,
) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();

        loop {
            let maybe_line = lines.next_line().await;
            let Some(line) = (match maybe_line {
                Ok(line) => line,
                Err(error) => {
                    let message = format!(
                        "failed to read {} runtime response: {}",
                        display_name, error
                    );
                    handle_runtime_dispatch_failure(
                        &pending_requests,
                        &event_tx,
                        &closed_error,
                        &closing,
                        message,
                    )
                    .await;
                    return;
                }
            }) else {
                let message = format!("{} runtime stdout closed", display_name);
                handle_runtime_dispatch_failure(
                    &pending_requests,
                    &event_tx,
                    &closed_error,
                    &closing,
                    message,
                )
                .await;
                return;
            };

            if line.trim().is_empty() {
                continue;
            }

            let message = match serde_json::from_str::<RuntimeWireMessage>(&line) {
                Ok(message) => message,
                Err(error) => {
                    let failure = format!(
                        "{} runtime sent invalid JSON: {} ({})",
                        display_name, error, line
                    );
                    handle_runtime_dispatch_failure(
                        &pending_requests,
                        &event_tx,
                        &closed_error,
                        &closing,
                        failure,
                    )
                    .await;
                    return;
                }
            };

            match message.kind.as_str() {
                "response" => {
                    let Some(response_id) = message.id else {
                        continue;
                    };
                    let pending = pending_requests.lock().await.remove(&response_id);
                    let Some(pending) = pending else {
                        continue;
                    };

                    let result = if message.ok.unwrap_or(false) {
                        Ok(message.result.unwrap_or_else(|| json!({})))
                    } else {
                        Err(message
                            .error
                            .and_then(|error| error.message)
                            .unwrap_or_else(|| format!("{} runtime request failed", display_name)))
                    };
                    let _ = pending.send(result);
                }
                "event" => {
                    if let Some(event_name) = message.event {
                        let _ = event_tx.send(RuntimeEventEnvelope {
                            event: event_name,
                            params: message.params.unwrap_or_else(|| json!({})),
                        });
                    }
                }
                _ => {}
            }
        }
    });
}

async fn handle_runtime_dispatch_failure(
    pending_requests: &PendingRuntimeRequests,
    event_tx: &broadcast::Sender<RuntimeEventEnvelope>,
    closed_error: &Arc<Mutex<Option<String>>>,
    closing: &Arc<AtomicBool>,
    message: String,
) {
    {
        let mut guard = closed_error.lock().await;
        if guard.is_none() {
            *guard = Some(message.clone());
        }
    }

    let pending = {
        let mut guard = pending_requests.lock().await;
        guard
            .drain()
            .map(|(_, pending)| pending)
            .collect::<Vec<_>>()
    };
    for sender in pending {
        let _ = sender.send(Err(message.clone()));
    }

    if !closing.load(Ordering::SeqCst) {
        let _ = event_tx.send(RuntimeEventEnvelope {
            event: "fatal".to_string(),
            params: json!({ "message": message }),
        });
    }
}

#[derive(Deserialize)]
struct RuntimeWireMessage {
    kind: String,
    id: Option<String>,
    ok: Option<bool>,
    result: Option<Value>,
    event: Option<String>,
    params: Option<Value>,
    error: Option<RuntimeWireError>,
}

#[derive(Deserialize)]
struct RuntimeWireError {
    message: Option<String>,
}

#[derive(Deserialize, Default)]
struct LoginRequest {
    password: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct AuthClaims {
    exp: u64,
}

#[derive(Deserialize, Default)]
struct SessionQuery {
    session: Option<String>,
}

#[derive(Deserialize, Default)]
struct ScrollbackQuery {
    session: Option<String>,
    lines: Option<String>,
}

#[derive(Deserialize, Default)]
struct WsQuery {
    token: Option<String>,
    session: Option<String>,
    window: Option<String>,
}

#[derive(Deserialize, Default)]
struct OverwriteQuery {
    overwrite: Option<String>,
}

#[derive(Deserialize, Default)]
struct PathQuery {
    path: Option<String>,
}

#[derive(Deserialize, Default)]
struct WorkspaceServeQuery {
    path: Option<String>,
    token: Option<String>,
    dl: Option<String>,
}

#[derive(Deserialize, Default)]
struct KindQuery {
    kind: Option<String>,
}

#[derive(Deserialize, Default)]
struct CodexSessionsQuery {
    project: Option<String>,
    limit: Option<String>,
    cursor: Option<String>,
}

#[derive(Deserialize, Default)]
struct ProjectQuery {
    project: Option<String>,
}

#[derive(Deserialize, Default)]
struct ProjectBody {
    project: Option<String>,
}

#[derive(Deserialize, Default)]
struct NameBody {
    name: Option<String>,
}

#[derive(Deserialize, Default)]
struct WorkspaceCreateEntryBody {
    path: Option<String>,
    name: Option<String>,
    content: Option<String>,
}

#[derive(Deserialize, Default)]
struct WorkspaceWriteFileBody {
    path: Option<String>,
    content: Option<String>,
}

#[derive(Deserialize, Default)]
struct WorkspaceDeleteBody {
    path: Option<String>,
}

#[derive(Deserialize, Default)]
struct WorkspaceRenameBody {
    path: Option<String>,
    #[serde(default, alias = "newName")]
    new_name: Option<String>,
}

#[derive(Deserialize, Default)]
struct WorkspaceTransferBody {
    #[serde(default, alias = "sourcePath")]
    source_path: Option<String>,
    #[serde(default, alias = "targetPath")]
    target_path: Option<String>,
}

#[derive(Deserialize, Default)]
struct IdBody {
    id: Option<String>,
}

#[derive(Deserialize, Default)]
struct CreateProjectBody {
    path: Option<String>,
    profile: Option<String>,
    #[serde(default, alias = "shellType")]
    shell_type: Option<String>,
}

#[derive(Deserialize, Default)]
struct WindowLaunchBody {
    #[serde(default, alias = "relPath")]
    rel_path: Option<String>,
    profile: Option<String>,
    #[serde(default, alias = "shellType")]
    shell_type: Option<String>,
    #[serde(default, alias = "sessionName")]
    session: Option<String>,
}

#[derive(Deserialize, Default)]
struct TaskBody {
    #[serde(default, alias = "sessionName")]
    session_name: Option<String>,
    prompt: Option<String>,
    profile: Option<String>,
    #[serde(default, alias = "tmuxSession")]
    tmux_session: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskRuntimeChunkEvent {
    task_id: String,
    chunk: String,
    is_err: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskRuntimeDoneEvent {
    task_id: String,
    exit_code: Option<i32>,
    error_message: Option<String>,
}

struct TaskRunOptions {
    session_name: String,
    source: String,
    tmux_session: String,
    profile: Option<String>,
}

struct TaskRunHandle {
    task_id: String,
    created_at: String,
    receiver: mpsc::UnboundedReceiver<TaskSseFrame>,
}

struct RunningTaskState {
    output: String,
    error_output: String,
    sender: mpsc::UnboundedSender<TaskSseFrame>,
}

struct TaskManager {
    tasks_file: Arc<PathBuf>,
    store_lock: Mutex<()>,
    runtime: Arc<ManagedRuntime>,
    running_tasks: Mutex<HashMap<String, RunningTaskState>>,
    next_task_counter: AtomicUsize,
}

#[derive(Clone)]
struct TaskSseFrame {
    event: String,
    payload: Value,
}

struct TaskEventStream {
    task_manager: Arc<TaskManager>,
    task_id: String,
    start_frame: Option<TaskSseFrame>,
    receiver: mpsc::UnboundedReceiver<TaskSseFrame>,
    completed: bool,
}

impl TaskManager {
    async fn new(tasks_file: PathBuf, runtime: Arc<ManagedRuntime>) -> Arc<Self> {
        let manager = Arc::new(Self {
            tasks_file: Arc::new(tasks_file),
            store_lock: Mutex::new(()),
            runtime: runtime.clone(),
            running_tasks: Mutex::new(HashMap::new()),
            next_task_counter: AtomicUsize::new(0),
        });

        let _ = manager
            .mark_running_tasks_interrupted(TASK_INTERRUPT_MESSAGE)
            .await;

        if let Some(receiver) = runtime.subscribe_events().await {
            manager.spawn_event_loop(receiver);
        }

        manager
    }

    fn spawn_event_loop(self: &Arc<Self>, mut receiver: broadcast::Receiver<RuntimeEventEnvelope>) {
        let manager = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                match receiver.recv().await {
                    Ok(event) => manager.handle_runtime_event(event).await,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    async fn run_task(
        self: &Arc<Self>,
        prompt: String,
        cwd: String,
        options: TaskRunOptions,
    ) -> Result<TaskRunHandle, String> {
        let TaskRunOptions {
            session_name,
            source,
            tmux_session,
            profile,
        } = options;
        let task_id = self.next_task_id();
        let created_at = iso_timestamp_now();
        let (sender, receiver) = mpsc::unbounded_channel();

        self.append_task(json!({
            "id": task_id.clone(),
            "session_name": session_name,
            "prompt": truncate_head(&prompt, MAX_TASK_PROMPT_LENGTH),
            "status": "running",
            "output": "",
            "error": "",
            "createdAt": created_at.clone(),
            "source": source,
            "tmux_session": tmux_session,
        }))
        .await?;

        self.running_tasks.lock().await.insert(
            task_id.clone(),
            RunningTaskState {
                output: String::new(),
                error_output: String::new(),
                sender,
            },
        );

        let manager = Arc::clone(self);
        let task_id_for_runtime = task_id.clone();
        tokio::spawn(async move {
            let result = manager
                .runtime
                .request(
                    "startTask",
                    json!({
                        "taskId": task_id_for_runtime.clone(),
                        "prompt": prompt,
                        "cwd": cwd,
                        "profile": profile,
                    }),
                )
                .await;
            if let Err(error) = result {
                manager
                    .finalize_task(&task_id_for_runtime, None, Some(error))
                    .await;
            }
        });

        Ok(TaskRunHandle {
            task_id,
            created_at,
            receiver,
        })
    }

    async fn kill_task(&self, task_id: &str) -> Result<(), String> {
        self.runtime
            .notify("killTask", json!({ "taskId": task_id }))
            .await
    }

    async fn list_recent(&self, limit: usize) -> Result<Vec<Value>, String> {
        let tasks = self.load_tasks().await?;
        Ok(tasks.into_iter().rev().take(limit).collect())
    }

    async fn delete_task(&self, id: &str) -> Result<(), String> {
        let _guard = self.store_lock.lock().await;
        let tasks = self.load_tasks_locked().await?;
        let filtered = tasks
            .into_iter()
            .filter(|task| task.get("id").and_then(Value::as_str) != Some(id))
            .collect::<Vec<_>>();
        self.save_tasks_locked(filtered).await
    }

    async fn append_task(&self, task: Value) -> Result<(), String> {
        let _guard = self.store_lock.lock().await;
        let mut tasks = self.load_tasks_locked().await?;
        tasks.push(task);
        self.save_tasks_locked(tasks).await
    }

    async fn update_task(&self, id: &str, updates: Value) -> Result<(), String> {
        let _guard = self.store_lock.lock().await;
        let mut tasks = self.load_tasks_locked().await?;
        for task in &mut tasks {
            if task.get("id").and_then(Value::as_str) != Some(id) {
                continue;
            }
            if let (Some(task_object), Some(update_object)) =
                (task.as_object_mut(), updates.as_object())
            {
                for (key, value) in update_object {
                    task_object.insert(key.clone(), value.clone());
                }
            }
            break;
        }
        self.save_tasks_locked(tasks).await
    }

    async fn mark_running_tasks_interrupted(&self, message: &str) -> Result<(), String> {
        let _guard = self.store_lock.lock().await;
        let mut tasks = self.load_tasks_locked().await?;
        let mut changed = false;
        for task in &mut tasks {
            if task.get("status").and_then(Value::as_str) != Some("running") {
                continue;
            }
            if let Some(object) = task.as_object_mut() {
                object.insert("status".to_string(), Value::String("error".to_string()));
                object.insert("error".to_string(), Value::String(message.to_string()));
                object.insert(
                    "completedAt".to_string(),
                    Value::String(iso_timestamp_now()),
                );
                changed = true;
            }
        }

        if changed {
            self.save_tasks_locked(tasks).await?;
        }
        Ok(())
    }

    async fn handle_runtime_event(self: &Arc<Self>, event: RuntimeEventEnvelope) {
        match event.event.as_str() {
            "chunk" => {
                if let Ok(chunk) = serde_json::from_value::<TaskRuntimeChunkEvent>(event.params) {
                    let mut running = self.running_tasks.lock().await;
                    let Some(state) = running.get_mut(&chunk.task_id) else {
                        return;
                    };
                    if chunk.is_err {
                        state.error_output.push_str(&chunk.chunk);
                    } else {
                        state.output.push_str(&chunk.chunk);
                    }
                    let _ = state.sender.send(TaskSseFrame {
                        event: if chunk.is_err { "error" } else { "output" }.to_string(),
                        payload: json!({ "chunk": chunk.chunk }),
                    });
                }
            }
            "done" => {
                if let Ok(done) = serde_json::from_value::<TaskRuntimeDoneEvent>(event.params) {
                    self.finalize_task(&done.task_id, done.exit_code, done.error_message)
                        .await;
                }
            }
            "fatal" => {
                let message = event
                    .params
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("task runner backend unavailable")
                    .to_string();
                self.fail_all_running_tasks(&message).await;
            }
            _ => {}
        }
    }

    async fn finalize_task(
        &self,
        task_id: &str,
        exit_code: Option<i32>,
        error_message: Option<String>,
    ) {
        let state = self.running_tasks.lock().await.remove(task_id);
        let Some(mut state) = state else {
            return;
        };

        let trimmed_error = error_message.unwrap_or_default().trim().to_string();
        if !trimmed_error.is_empty() && state.error_output.is_empty() {
            state.error_output = trimmed_error;
        }

        let status = if exit_code == Some(0) {
            "success"
        } else {
            "error"
        };
        if let Err(error) = self
            .update_task(
                task_id,
                json!({
                    "status": status,
                    "output": truncate_tail(&state.output, MAX_TASK_OUTPUT_LENGTH),
                    "error": truncate_tail(&state.error_output, MAX_TASK_ERROR_LENGTH),
                    "completedAt": iso_timestamp_now(),
                    "exitCode": exit_code,
                }),
            )
            .await
        {
            eprintln!("task store update failed for {task_id}: {error}");
        }

        let _ = state.sender.send(TaskSseFrame {
            event: "done".to_string(),
            payload: json!({
                "taskId": task_id,
                "status": status,
                "exitCode": exit_code,
            }),
        });
    }

    async fn fail_all_running_tasks(&self, message: &str) {
        let task_ids = self
            .running_tasks
            .lock()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for task_id in task_ids {
            self.finalize_task(&task_id, None, Some(message.to_string()))
                .await;
        }
    }

    fn next_task_id(&self) -> String {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        let counter = self.next_task_counter.fetch_add(1, Ordering::SeqCst);
        format!("task_{millis}_{counter}")
    }

    async fn load_tasks(&self) -> Result<Vec<Value>, String> {
        let _guard = self.store_lock.lock().await;
        self.load_tasks_locked().await
    }

    async fn load_tasks_locked(&self) -> Result<Vec<Value>, String> {
        match fs::read_to_string(self.tasks_file.as_ref()).await {
            Ok(raw) => serde_json::from_str::<Vec<Value>>(&raw)
                .map_err(|error| format!("failed to parse task store: {error}")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(error) => Err(format!("failed to read task store: {error}")),
        }
    }

    async fn save_tasks_locked(&self, mut tasks: Vec<Value>) -> Result<(), String> {
        if tasks.len() > DEFAULT_MAX_TASKS {
            tasks = tasks.split_off(tasks.len() - DEFAULT_MAX_TASKS);
        }
        if let Some(parent) = self.tasks_file.parent() {
            fs::create_dir_all(parent)
                .await
                .map_err(|error| format!("failed to create task store directory: {error}"))?;
        }
        let content = serde_json::to_string_pretty(&tasks)
            .map_err(|error| format!("failed to serialize task store: {error}"))?;
        fs::write(self.tasks_file.as_ref(), format!("{content}\n"))
            .await
            .map_err(|error| format!("failed to write task store: {error}"))
    }
}

impl TaskEventStream {
    fn new(
        task_manager: Arc<TaskManager>,
        session_name: String,
        prompt: String,
        handle: TaskRunHandle,
    ) -> Self {
        Self {
            task_manager,
            task_id: handle.task_id.clone(),
            start_frame: Some(TaskSseFrame {
                event: "start".to_string(),
                payload: json!({
                    "taskId": handle.task_id,
                    "session_name": session_name,
                    "prompt": prompt,
                    "createdAt": handle.created_at,
                }),
            }),
            receiver: handle.receiver,
            completed: false,
        }
    }
}

impl Stream for TaskEventStream {
    type Item = Result<SseEvent, Infallible>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if let Some(frame) = self.start_frame.take() {
            return Poll::Ready(Some(Ok(to_sse_event(frame))));
        }

        match Pin::new(&mut self.receiver).poll_recv(cx) {
            Poll::Ready(Some(frame)) => {
                if frame.event == "done" {
                    self.completed = true;
                }
                Poll::Ready(Some(Ok(to_sse_event(frame))))
            }
            Poll::Ready(None) => {
                self.completed = true;
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Drop for TaskEventStream {
    fn drop(&mut self) {
        if self.completed {
            return;
        }
        let task_manager = Arc::clone(&self.task_manager);
        let task_id = self.task_id.clone();
        tokio::spawn(async move {
            let _ = task_manager.kill_task(&task_id).await;
        });
    }
}

#[derive(Clone)]
struct TelegramBridge {
    client: Client,
    bot_token: Arc<String>,
    webhook_secret: Arc<String>,
    default_session: Arc<String>,
    api_base_url: Arc<String>,
}

#[derive(Clone)]
struct TelegramWindow {
    index: String,
    name: String,
    cwd: String,
    active: bool,
}

struct TelegramRouteError {
    status: StatusCode,
    message: String,
}

#[derive(Clone, Deserialize)]
struct TelegramUpdate {
    message: Option<TelegramMessage>,
    edited_message: Option<TelegramMessage>,
}

#[derive(Clone, Deserialize)]
struct TelegramMessage {
    chat: Option<TelegramChat>,
    text: Option<String>,
    caption: Option<String>,
    photo: Option<Vec<TelegramPhoto>>,
    document: Option<TelegramDocument>,
}

#[derive(Clone, Deserialize)]
struct TelegramChat {
    id: i64,
}

#[derive(Clone, Deserialize)]
struct TelegramPhoto {
    file_id: String,
}

#[derive(Clone, Deserialize)]
struct TelegramDocument {
    file_id: String,
    file_name: Option<String>,
}

impl TelegramRouteError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

impl TelegramBridge {
    fn new(
        bot_token: String,
        webhook_secret: String,
        default_session: String,
        api_base_url: String,
    ) -> Self {
        Self {
            client: Client::new(),
            bot_token: Arc::new(bot_token),
            webhook_secret: Arc::new(webhook_secret),
            default_session: Arc::new(default_session),
            api_base_url: Arc::new(api_base_url.trim_end_matches('/').to_string()),
        }
    }

    fn ensure_configured(&self, message: &str) -> Result<(), TelegramRouteError> {
        if self.bot_token.trim().is_empty() {
            return Err(TelegramRouteError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                message,
            ));
        }
        Ok(())
    }

    fn verify_webhook_request(&self, headers: &HeaderMap) -> Result<(), TelegramRouteError> {
        if !self.webhook_secret.is_empty() {
            let secret = header_string(headers, "x-telegram-bot-api-secret-token");
            if secret.as_deref() != Some(self.webhook_secret.as_str()) {
                return Err(TelegramRouteError::new(StatusCode::FORBIDDEN, "forbidden"));
            }
        }
        self.ensure_configured("Telegram not configured")
    }

    async fn setup_webhook(&self, protocol: &str, host: &str) -> Result<Value, TelegramRouteError> {
        self.ensure_configured("TELEGRAM_BOT_TOKEN not set")?;
        let webhook_url = format!("{protocol}://{host}/api/webhooks/telegram");
        let request = self
            .client
            .get(self.telegram_api_url("setWebhook"))
            .query(&[("url", webhook_url.as_str())]);
        let request = if self.webhook_secret.is_empty() {
            request
        } else {
            request.query(&[("secret_token", self.webhook_secret.as_str())])
        };

        let raw = request
            .send()
            .await
            .map_err(|error| {
                TelegramRouteError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
            })?
            .text()
            .await
            .map_err(|error| {
                TelegramRouteError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
            })?;

        let response = serde_json::from_str::<Value>(&raw).unwrap_or_else(|_| Value::String(raw));
        Ok(match response {
            Value::String(raw) => json!({
                "webhookUrl": webhook_url,
                "raw": raw,
            }),
            other => json!({
                "webhookUrl": webhook_url,
                "telegramResponse": other,
            }),
        })
    }

    async fn handle_update(
        &self,
        state: Arc<AppState>,
        update: TelegramUpdate,
    ) -> Result<(), String> {
        let Some(message) = update.message.or(update.edited_message) else {
            return Ok(());
        };
        let Some(chat_id) = message.chat.as_ref().map(|chat| chat.id) else {
            return Ok(());
        };
        let text = message.text.clone().unwrap_or_default().trim().to_string();

        if text == "/start" {
            let _ = self.send_message(chat_id, TELEGRAM_START_MESSAGE).await;
            return Ok(());
        }

        if text == "/sessions" {
            self.handle_sessions_command(&state, chat_id).await;
            return Ok(());
        }

        if text.starts_with("/switch ") {
            self.handle_switch_command(&state, chat_id, &text).await;
            return Ok(());
        }

        if message
            .photo
            .as_ref()
            .map(|photos| !photos.is_empty())
            .unwrap_or(false)
            || message.document.is_some()
        {
            self.handle_file_upload(state, chat_id, message).await;
            return Ok(());
        }

        if text.is_empty() {
            return Ok(());
        }

        let (cwd, session_name) = self.resolve_prompt_target(&state).await;
        self.run_prompt(state, chat_id, text, cwd, session_name)
            .await;
        Ok(())
    }

    async fn handle_sessions_command(&self, state: &AppState, chat_id: i64) {
        match self.list_windows(state).await {
            Ok(windows) => {
                let mut sorted = windows;
                sorted.sort_by_key(|window| window.index.parse::<u32>().unwrap_or(u32::MAX));
                let lines = sorted
                    .into_iter()
                    .map(|window| {
                        format!(
                            "{} `{}`",
                            if window.active { "▶" } else { "  " },
                            format!("{}: {}", window.index, window.name)
                        )
                    })
                    .collect::<Vec<_>>();
                let body = format!(
                    "*当前 tmux 窗口:*\n{}\n\n用 `/switch <编号>` 切换",
                    lines.join("\n")
                );
                let _ = self.send_message(chat_id, &body).await;
            }
            Err(error) => {
                let _ = self
                    .send_message(chat_id, &format!("❌ 无法获取会话列表: {error}"))
                    .await;
            }
        }
    }

    async fn handle_switch_command(&self, state: &AppState, chat_id: i64, text: &str) {
        let target = sanitize_telegram_switch_target(text);
        if target.is_empty() {
            let _ = self
                .send_message(chat_id, "❌ 无效的窗口名称，只允许字母/数字/下划线/连字符")
                .await;
            return;
        }

        let result = state
            .runtime_manager
            .session_management_request(
                "attachSessionWindow",
                json!({
                    "sessionName": state.default_tmux_session.as_ref(),
                    "index": target,
                }),
            )
            .await;
        match result {
            Ok(_) => {
                let _ = self
                    .send_message(
                        chat_id,
                        &format!("✅ 已切换到窗口 `{target}`\n\n后续任务将在此窗口执行。"),
                    )
                    .await;
            }
            Err(error) => {
                let _ = self
                    .send_message(chat_id, &format!("❌ 无法切换到窗口 `{target}`: {error}"))
                    .await;
            }
        }
    }

    async fn handle_file_upload(
        &self,
        state: Arc<AppState>,
        chat_id: i64,
        message: TelegramMessage,
    ) {
        let result = async {
            let cwd = self.resolve_upload_directory(&state).await;
            let (file_id, filename) = telegram_file_target(&message)?;
            let _ = self
                .send_message(chat_id, &format!("⬇️ 正在下载文件到 `{cwd}`..."))
                .await;
            let download = self.download_file(&file_id, &cwd, &filename).await?;
            let _ = self
                .send_message(
                    chat_id,
                    &format!(
                        "✅ 文件已保存\n```\n{}\n```\n大小: {:.1} KB",
                        download.path,
                        (download.size as f64) / 1024.0
                    ),
                )
                .await;
            if let Some(caption) = message
                .caption
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                self.run_prompt(
                    state,
                    chat_id,
                    caption.to_string(),
                    cwd,
                    Some("telegram".to_string()),
                )
                .await;
            }
            Ok::<(), String>(())
        }
        .await;

        if let Err(error) = result {
            let _ = self
                .send_message(chat_id, &format!("❌ 文件处理失败: {error}"))
                .await;
        }
    }

    async fn resolve_prompt_target(&self, state: &AppState) -> (String, Option<String>) {
        let mut cwd = state.workspace_root.as_ref().clone();
        let mut session_name = self
            .default_session
            .as_ref()
            .trim()
            .is_empty()
            .then(|| None)
            .unwrap_or_else(|| Some(self.default_session.as_ref().clone()));

        if let Ok(windows) = self.list_windows(state).await {
            if let Some(default_name) = session_name.as_deref() {
                if let Some(window) = windows.iter().find(|window| window.name == default_name) {
                    cwd = if window.cwd.is_empty() {
                        cwd
                    } else {
                        window.cwd.clone()
                    };
                    session_name = Some(window.name.clone());
                }
            } else if let Some(active_window) = windows.iter().find(|window| window.active) {
                session_name = Some(active_window.name.clone());
                if !active_window.cwd.is_empty() {
                    cwd = active_window.cwd.clone();
                }
            }
        }

        (cwd, session_name)
    }

    async fn resolve_upload_directory(&self, state: &AppState) -> String {
        match self.list_windows(state).await {
            Ok(windows) => windows
                .into_iter()
                .find(|window| window.active)
                .map(|window| window.cwd)
                .filter(|cwd| !cwd.is_empty())
                .unwrap_or_else(|| state.workspace_root.as_ref().clone()),
            Err(_) => state.workspace_root.as_ref().clone(),
        }
    }

    async fn run_prompt(
        &self,
        state: Arc<AppState>,
        chat_id: i64,
        prompt: String,
        cwd: String,
        session_name: Option<String>,
    ) {
        let display_session_name = session_name
            .clone()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "default".to_string());
        let task_session_name = session_name
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "telegram".to_string());
        let progress_message_id = self
            .send_message(
                chat_id,
                &telegram_progress_message(&display_session_name, None),
            )
            .await;

        let handle = match state
            .task_manager
            .run_task(
                prompt.clone(),
                cwd,
                TaskRunOptions {
                    session_name: task_session_name,
                    source: "telegram".to_string(),
                    tmux_session: state.default_tmux_session.as_ref().clone(),
                    profile: None,
                },
            )
            .await
        {
            Ok(handle) => handle,
            Err(error) => {
                let message = telegram_done_message(
                    &display_session_name,
                    Some(1),
                    &truncate_head_with_notice(&error, 3_800),
                );
                if let Some(message_id) = progress_message_id {
                    self.edit_message(chat_id, message_id, &message).await;
                } else {
                    let _ = self.send_message(chat_id, &message).await;
                }
                return;
            }
        };

        let task_id = handle.task_id.clone();
        let mut receiver = handle.receiver;
        let mut output = String::new();
        let mut error_output = String::new();
        let mut progress_interval =
            tokio::time::interval(Duration::from_millis(TELEGRAM_RUNNING_INTERVAL_MS));

        loop {
            tokio::select! {
                _ = progress_interval.tick() => {
                    let preview = if output.is_empty() { error_output.trim() } else { output.trim() };
                    if preview.is_empty() {
                        continue;
                    }
                    if let Some(message_id) = progress_message_id {
                        self.edit_message(
                            chat_id,
                            message_id,
                            &telegram_progress_message(
                                &display_session_name,
                                Some(&truncate_tail(preview, 3_000)),
                            ),
                        ).await;
                    }
                    let _ = state.task_manager.update_task(
                        &task_id,
                        json!({
                            "output": truncate_tail(&output, MAX_TASK_OUTPUT_LENGTH),
                            "error": truncate_tail(&error_output, MAX_TASK_ERROR_LENGTH),
                        }),
                    ).await;
                }
                maybe_frame = receiver.recv() => {
                    let Some(frame) = maybe_frame else {
                        break;
                    };

                    match frame.event.as_str() {
                        "output" => {
                            if let Some(chunk) = frame.payload.get("chunk").and_then(Value::as_str) {
                                output.push_str(chunk);
                            }
                        }
                        "error" => {
                            if let Some(chunk) = frame.payload.get("chunk").and_then(Value::as_str) {
                                error_output.push_str(chunk);
                            }
                        }
                        "done" => {
                            let exit_code = frame
                                .payload
                                .get("exitCode")
                                .and_then(Value::as_i64)
                                .map(|value| value as i32);
                            let result = if !output.trim().is_empty() {
                                output.trim().to_string()
                            } else if !error_output.trim().is_empty() {
                                error_output.trim().to_string()
                            } else {
                                "(无输出)".to_string()
                            };
                            let message = telegram_done_message(
                                &display_session_name,
                                exit_code,
                                &truncate_head_with_notice(&result, 3_800),
                            );
                            if let Some(message_id) = progress_message_id {
                                self.edit_message(chat_id, message_id, &message).await;
                            } else {
                                let _ = self.send_message(chat_id, &message).await;
                            }
                            break;
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    async fn list_windows(&self, state: &AppState) -> Result<Vec<TelegramWindow>, String> {
        let payload = state
            .runtime_manager
            .session_management_request(
                "listProjectChannels",
                json!({ "projectName": state.default_tmux_session.as_ref() }),
            )
            .await?;

        let channels = payload
            .get("channels")
            .and_then(Value::as_array)
            .ok_or_else(|| "failed to list project channels".to_string())?;

        Ok(channels
            .iter()
            .map(|channel| TelegramWindow {
                index: json_value_to_string(channel.get("index"))
                    .unwrap_or_else(|| "0".to_string()),
                name: channel
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                cwd: channel
                    .get("cwd")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                active: channel
                    .get("active")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })
            .collect())
    }

    async fn send_message(&self, chat_id: i64, text: &str) -> Option<i64> {
        self.send_telegram_message(
            "sendMessage",
            json!({
                "chat_id": chat_id,
                "text": text,
                "parse_mode": "Markdown",
            }),
        )
        .await
        .and_then(|payload| {
            payload
                .get("result")
                .and_then(|result| result.get("message_id"))
                .and_then(Value::as_i64)
        })
    }

    async fn edit_message(&self, chat_id: i64, message_id: i64, text: &str) {
        let _ = self
            .send_telegram_message(
                "editMessageText",
                json!({
                    "chat_id": chat_id,
                    "message_id": message_id,
                    "text": text,
                    "parse_mode": "Markdown",
                }),
            )
            .await;
    }

    async fn send_telegram_message(&self, method: &str, payload: Value) -> Option<Value> {
        if self.bot_token.is_empty() {
            return None;
        }

        let response = self
            .client
            .post(self.telegram_api_url(method))
            .json(&payload)
            .send()
            .await;
        let Ok(response) = response else {
            return None;
        };
        let text = response.text().await.ok()?;
        serde_json::from_str::<Value>(&text).ok()
    }

    async fn download_file(
        &self,
        file_id: &str,
        dest_dir: &str,
        filename: &str,
    ) -> Result<TelegramDownloadedFile, String> {
        let raw = self
            .client
            .get(self.telegram_api_url("getFile"))
            .query(&[("file_id", file_id)])
            .send()
            .await
            .map_err(|error| error.to_string())?
            .text()
            .await
            .map_err(|error| error.to_string())?;
        let payload = serde_json::from_str::<Value>(&raw)
            .map_err(|error| format!("invalid getFile response: {error}"))?;
        if payload.get("ok").and_then(Value::as_bool) != Some(true) {
            let description = payload
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("unknown error");
            return Err(format!("getFile failed: {description}"));
        }

        let file_path = payload
            .get("result")
            .and_then(|result| result.get("file_path"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "telegram file path missing".to_string())?;
        let bytes = self
            .client
            .get(self.telegram_file_url(file_path))
            .send()
            .await
            .map_err(|error| error.to_string())?
            .bytes()
            .await
            .map_err(|error| error.to_string())?;

        let safe_filename = sanitize_telegram_filename(filename, "telegram-file");
        fs::create_dir_all(dest_dir)
            .await
            .map_err(|error| error.to_string())?;
        let path = Path::new(dest_dir).join(safe_filename);
        fs::write(&path, &bytes)
            .await
            .map_err(|error| error.to_string())?;
        Ok(TelegramDownloadedFile {
            path: path_to_string(&path),
            size: bytes.len(),
        })
    }

    fn telegram_api_url(&self, method: &str) -> String {
        format!("{}/bot{}/{}", self.api_base_url, self.bot_token, method)
    }

    fn telegram_file_url(&self, file_path: &str) -> String {
        format!(
            "{}/file/bot{}/{}",
            self.api_base_url,
            self.bot_token,
            file_path.trim_start_matches('/')
        )
    }
}

struct TelegramDownloadedFile {
    path: String,
    size: usize,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let config = match AppConfig::load() {
        Ok(config) => config,
        Err(message) => {
            eprintln!("ERROR: {message}");
            std::process::exit(1);
        }
    };

    let runtime_manager = Arc::new(RuntimeManager::new(config.runtime_configs).await);
    if let Some(parent) = config.tasks_file.parent() {
        fs::create_dir_all(parent).await?;
    }
    fs::create_dir_all(&config.uploads_dir).await?;
    let task_manager = TaskManager::new(
        config.tasks_file.clone(),
        runtime_manager.task_runner.clone(),
    )
    .await;
    let telegram_bridge = Arc::new(TelegramBridge::new(
        config.telegram_bot_token,
        config.telegram_webhook_secret,
        config.telegram_default_session,
        config.telegram_api_base_url,
    ));
    let bind_addr = format!("{}:{}", config.host, config.port);
    let state = Arc::new(AppState {
        jwt_secret: Arc::new(config.jwt_secret),
        password_hash: Arc::new(config.password_hash),
        default_tmux_session: Arc::new(config.default_tmux_session),
        codex_history_enabled: config.codex_history_enabled,
        ws_connection_counter: Arc::new(AtomicUsize::new(0)),
        github_repo: Arc::new(config.github_repo),
        project_root: Arc::new(config.project_root.clone()),
        workspace_root: Arc::new(config.workspace_root),
        configs_dir: Arc::new(config.configs_dir),
        codex_configs_dir: Arc::new(config.codex_configs_dir),
        codex_validate_dir: Arc::new(config.codex_validate_dir),
        project_defaults_file: Arc::new(config.project_defaults_file),
        toolbar_config_file: Arc::new(config.toolbar_config_file),
        uploads_dir: Arc::new(config.uploads_dir),
        proxy_vars: Arc::new(config.proxy_vars),
        public_dir: Arc::new(config.project_root.join("public")),
        frontend_dist_dir: Arc::new(config.project_root.join("frontend").join("dist")),
        runtime_manager: runtime_manager.clone(),
        task_manager,
        telegram_bridge,
    });
    let app = Router::new()
        .route("/api/health", get(api_health))
        .route("/api/auth/login", post(api_login))
        .route("/api/config", get(api_config))
        .route("/api/configs", get(api_claude_configs))
        .route("/api/configs/{id}", post(api_save_claude_config))
        .route("/api/configs/{id}", delete(api_delete_claude_config))
        .route(
            "/api/configs/{id}/sync-current",
            post(api_sync_current_claude_config),
        )
        .route("/api/runtime/status", get(api_runtime_status))
        .route("/api/codex-configs", get(api_codex_configs))
        .route(
            "/api/codex-configs/import-global",
            post(api_import_global_codex_config),
        )
        .route(
            "/api/codex-configs/{id}/sync-current",
            post(api_sync_current_codex_config),
        )
        .route(
            "/api/codex-configs/{id}/validate",
            post(api_validate_codex_config),
        )
        .route("/api/codex-configs/{id}", post(api_save_codex_config))
        .route("/api/codex-configs/{id}", delete(api_delete_codex_config))
        .route("/api/cc-switch/providers", get(api_cc_switch_providers))
        .route(
            "/api/cc-switch/providers/{kind}/{provider_id}/import",
            post(api_import_cc_switch_provider),
        )
        .route("/api/project-defaults", get(api_project_defaults))
        .route("/api/toolbar-config", get(api_toolbar_config))
        .route("/api/toolbar-config", post(api_save_toolbar_config))
        .route("/api/webhooks/telegram", post(api_telegram_webhook))
        .route("/api/telegram/setup", get(api_telegram_setup))
        .route("/api/version", get(api_version))
        .route("/api/version/latest", get(api_latest_version))
        .route("/api/browse", get(api_browse))
        .route("/api/workspace/files", get(api_workspace_entries))
        .route("/api/workspace/files", post(api_workspace_create_file))
        .route("/api/workspace/mkdir", post(api_workspace_mkdir))
        .route("/api/workspace/file", get(api_workspace_read_file))
        .route("/api/workspace/file", put(api_workspace_write_file))
        .route("/api/workspace/entry", delete(api_workspace_delete_entry))
        .route("/api/workspace/rename", post(api_workspace_rename_entry))
        .route("/api/workspace/copy", post(api_workspace_copy_entry))
        .route("/api/workspace/move", post(api_workspace_move_entry))
        .route("/ws", get(api_ws))
        .route("/api/tasks", get(api_tasks))
        .route("/api/tasks", post(api_create_task))
        .route("/api/tasks/{id}", delete(api_delete_task))
        .route("/api/upload", post(api_upload_workspace_file))
        .route("/api/files/upload", post(api_upload_managed_file))
        .route("/api/files", get(api_files))
        .route("/api/files/all", delete(api_delete_all_files))
        .route("/api/files/{date}/{filename}", delete(api_delete_file))
        .route("/api/sessions/{id}/output", get(api_session_output))
        .route("/api/sessions/{id}/scrollback", get(api_session_scrollback))
        .route("/api/tmux-sessions", get(api_tmux_sessions))
        .route("/api/projects", get(api_projects))
        .route("/api/projects", post(api_create_project))
        .route("/api/windows", post(api_launch_window))
        .route("/api/session-cwd", get(api_session_cwd))
        .route("/api/codex-sessions", get(api_codex_sessions))
        .route(
            "/api/codex-sessions/{id}/detail",
            get(api_codex_session_detail),
        )
        .route(
            "/api/codex-sessions/{id}/resume",
            post(api_codex_session_resume),
        )
        .route("/api/codex-sessions/{id}", delete(api_codex_session_delete))
        .route("/api/projects/{name}/channels", get(api_project_channels))
        .route(
            "/api/projects/{name}/channels",
            post(api_create_project_channel),
        )
        .route("/api/projects/{name}/activate", post(api_activate_project))
        .route("/api/projects/{name}/rename", post(api_rename_project))
        .route("/api/projects/{name}", delete(api_delete_project))
        .route("/api/sessions", get(api_sessions))
        .route("/api/sessions", post(api_create_session_window))
        .route("/api/sessions/{id}", delete(api_delete_session))
        .route("/api/sessions/{id}/attach", post(api_attach_session))
        .route("/api/sessions/{id}/rename", post(api_rename_session))
        .route("/workspace", get(api_workspace_file_root))
        .route("/workspace/{*path}", get(api_workspace_file_path))
        .route("/uploads/{*path}", get(static_uploads))
        .route("/", any(static_fallback))
        .route("/{*path}", any(static_fallback))
        .with_state(state);

    let listener = TcpListener::bind(&bind_addr).await?;
    println!("nexus-server listening on {}", listener.local_addr()?);

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    runtime_manager.shutdown_all().await;
    Ok(())
}

async fn api_health() -> impl IntoResponse {
    Json(json!({
        "ok": true,
        "server": "nexus-server",
    }))
}

async fn api_login(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<LoginRequest>,
) -> Response {
    let Some(password) = payload.password.filter(|value| !value.is_empty()) else {
        return json_error(StatusCode::BAD_REQUEST, "password required");
    };

    let password_matches = match verify(password, state.password_hash.as_str()) {
        Ok(matches) => matches,
        Err(_) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "internal error"),
    };

    if !password_matches {
        return json_error(StatusCode::UNAUTHORIZED, "unauthorized");
    }

    let now = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_secs(),
        Err(_) => 0,
    };
    let claims = AuthClaims {
        exp: now + TOKEN_TTL_SECONDS,
    };

    match encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(state.jwt_secret.as_bytes()),
    ) {
        Ok(token) => Json(json!({ "token": token })).into_response(),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "internal error"),
    }
}

async fn api_config(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    Json(json!({
        "tmuxSession": state.default_tmux_session.as_ref(),
        "workspaceRoot": state.workspace_root.as_ref(),
        "features": {
            "codexHistory": state.codex_history_enabled,
        },
    }))
    .into_response()
}

async fn api_claude_configs(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    Json(list_claude_configs(state.configs_dir.as_ref())).into_response()
}

async fn api_save_claude_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Json(payload): Json<Value>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    config_profiles_response(save_claude_config_route(
        state.configs_dir.as_ref(),
        &id,
        payload,
    ))
}

async fn api_sync_current_claude_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    config_profiles_response(sync_current_claude_config_route(
        state.configs_dir.as_ref(),
        &id,
    ))
}

async fn api_delete_claude_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    config_profiles_response(delete_claude_config_route(state.configs_dir.as_ref(), &id))
}

async fn api_runtime_status(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    Json(state.runtime_manager.runtime_status_payload().await).into_response()
}

async fn api_codex_configs(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    Json(list_codex_configs(state.codex_configs_dir.as_ref())).into_response()
}

async fn api_import_global_codex_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Option<Json<IdBody>>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    config_profiles_response(import_global_codex_config_route(
        state.codex_configs_dir.as_ref(),
        body.and_then(|Json(payload)| payload.id),
    ))
}

async fn api_sync_current_codex_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    config_profiles_response(sync_current_codex_config_route(
        state.codex_configs_dir.as_ref(),
        &id,
    ))
}

async fn api_validate_codex_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    config_profiles_response(
        validate_codex_config_route(
            state.codex_configs_dir.as_ref(),
            state.codex_validate_dir.as_ref(),
            state.project_root.as_ref(),
            &id,
            state.proxy_vars.as_ref(),
        )
        .await,
    )
}

async fn api_save_codex_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Json(payload): Json<Value>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    config_profiles_response(save_codex_config_route(
        state.codex_configs_dir.as_ref(),
        &id,
        payload,
    ))
}

async fn api_delete_codex_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    config_profiles_response(delete_codex_config_route(
        state.codex_configs_dir.as_ref(),
        &id,
    ))
}

async fn api_cc_switch_providers(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<KindQuery>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    config_profiles_response(list_cc_switch_providers_route(
        state.configs_dir.as_ref(),
        state.codex_configs_dir.as_ref(),
        query.kind.as_deref().unwrap_or_default(),
    ))
}

async fn api_import_cc_switch_provider(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath((kind, provider_id)): AxumPath<(String, String)>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    config_profiles_response(import_cc_switch_provider_route(
        state.configs_dir.as_ref(),
        state.codex_configs_dir.as_ref(),
        &kind,
        &provider_id,
    ))
}

async fn api_project_defaults(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<PathQuery>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    Json(get_project_default_payload(
        state.project_defaults_file.as_ref(),
        state.workspace_root.as_ref(),
        query.path.as_deref(),
    ))
    .into_response()
}

async fn api_toolbar_config(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    Json(read_toolbar_config_file(state.toolbar_config_file.as_ref()).await).into_response()
}

async fn api_save_toolbar_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    match write_toolbar_config_file(state.toolbar_config_file.as_ref(), &payload).await {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

async fn api_telegram_webhook(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(update): Json<TelegramUpdate>,
) -> Response {
    if let Err(error) = state.telegram_bridge.verify_webhook_request(&headers) {
        return json_error(error.status, &error.message);
    }

    let telegram_bridge = state.telegram_bridge.clone();
    let task_state = state.clone();
    tokio::spawn(async move {
        if let Err(error) = telegram_bridge.handle_update(task_state, update).await {
            eprintln!("telegram webhook error: {error}");
        }
    });

    Json(json!({ "ok": true })).into_response()
}

async fn api_telegram_setup(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    let protocol =
        forwarded_header_value(&headers, "x-forwarded-proto").unwrap_or_else(|| "http".to_string());
    let host = forwarded_header_value(&headers, "x-forwarded-host")
        .or_else(|| header_string(&headers, "host"))
        .unwrap_or_default();
    if host.is_empty() {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "host header missing");
    }

    match state
        .telegram_bridge
        .setup_webhook(protocol.trim(), host.trim())
        .await
    {
        Ok(payload) => Json(payload).into_response(),
        Err(error) => json_error(error.status, &error.message),
    }
}

async fn api_version(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    Json(current_version_payload(state.project_root.as_ref()).await).into_response()
}

async fn api_latest_version(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    match fetch_latest_version_payload(state.github_repo.as_ref()).await {
        Ok(payload) => Json(payload).into_response(),
        Err(error) => json_response(error.status_code, error.body),
    }
}

async fn api_browse(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<PathQuery>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    workspace_json_response(
        browse_workspace_directories(state.workspace_root.as_ref(), query.path.as_deref()).await,
    )
}

async fn api_workspace_entries(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<PathQuery>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    workspace_json_response(
        list_workspace_entries(state.workspace_root.as_ref(), query.path.as_deref()).await,
    )
}

async fn api_workspace_mkdir(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<WorkspaceCreateEntryBody>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    workspace_json_response(
        create_workspace_directory(
            state.workspace_root.as_ref(),
            body.path.as_deref(),
            body.name.as_deref(),
        )
        .await,
    )
}

async fn api_workspace_create_file(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<WorkspaceCreateEntryBody>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    workspace_json_response(
        create_workspace_file(
            state.workspace_root.as_ref(),
            body.path.as_deref(),
            body.name.as_deref(),
            body.content.as_deref().unwrap_or(""),
        )
        .await,
    )
}

async fn api_workspace_read_file(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<PathQuery>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    workspace_json_response(
        read_workspace_file_content(state.workspace_root.as_ref(), query.path.as_deref()).await,
    )
}

async fn api_workspace_write_file(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<WorkspaceWriteFileBody>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    workspace_json_response(
        write_workspace_file_content(
            state.workspace_root.as_ref(),
            body.path.as_deref(),
            body.content.as_deref().unwrap_or(""),
        )
        .await,
    )
}

async fn api_workspace_delete_entry(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<PathQuery>,
    body: Option<Json<WorkspaceDeleteBody>>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    let path = body
        .and_then(|Json(payload)| payload.path)
        .or(query.path)
        .unwrap_or_default();
    workspace_json_response(delete_workspace_entry(state.workspace_root.as_ref(), &path).await)
}

async fn api_workspace_rename_entry(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<WorkspaceRenameBody>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    workspace_json_response(
        rename_workspace_entry(
            state.workspace_root.as_ref(),
            body.path.as_deref(),
            body.new_name.as_deref(),
        )
        .await,
    )
}

async fn api_workspace_copy_entry(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<WorkspaceTransferBody>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    workspace_json_response(
        copy_workspace_entry(
            state.workspace_root.as_ref(),
            body.source_path.as_deref(),
            body.target_path.as_deref(),
        )
        .await,
    )
}

async fn api_workspace_move_entry(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<WorkspaceTransferBody>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    workspace_json_response(
        move_workspace_entry(
            state.workspace_root.as_ref(),
            body.source_path.as_deref(),
            body.target_path.as_deref(),
        )
        .await,
    )
}

async fn api_workspace_file_root(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<WorkspaceServeQuery>,
) -> Response {
    serve_workspace_file_response(state, headers, query, "").await
}

async fn api_workspace_file_path(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<WorkspaceServeQuery>,
    AxumPath(path): AxumPath<String>,
) -> Response {
    serve_workspace_file_response(state, headers, query, &path).await
}

async fn api_upload_workspace_file(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    multipart: Multipart,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    let payload = match parse_upload_multipart(multipart).await {
        Ok(payload) => payload,
        Err(response) => return response,
    };
    let Some(file) = payload.file else {
        return json_error(StatusCode::BAD_REQUEST, "no file");
    };
    let destination =
        resolve_workspace_upload_destination(&state, payload.session_name.as_deref()).await;
    let file_name = sanitize_workspace_upload_filename(&file.original_name);
    let file_path = PathBuf::from(&destination).join(&file_name);

    if let Err(error) = fs::create_dir_all(&destination).await {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string());
    }
    if let Err(error) = fs::write(&file_path, &file.bytes).await {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string());
    }

    Json(json!({
        "ok": true,
        "path": file_path.to_string_lossy().to_string(),
        "filename": file_name,
        "size": file.size,
    }))
    .into_response()
}

async fn api_upload_managed_file(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<OverwriteQuery>,
    multipart: Multipart,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    let payload = match parse_upload_multipart(multipart).await {
        Ok(payload) => payload,
        Err(response) => return response,
    };
    let Some(file) = payload.file else {
        return json_error(StatusCode::BAD_REQUEST, "no file");
    };

    match save_managed_upload_file(
        state.uploads_dir.as_ref(),
        &file.bytes,
        &file.original_name,
        payload.original_name.as_deref(),
        file.size,
        query.overwrite.as_deref() == Some("1"),
    )
    .await
    {
        Ok(payload) => Json(payload).into_response(),
        Err(error) => json_response(error.status_code, error.body),
    }
}

async fn api_files(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    match list_managed_files(state.uploads_dir.as_ref()).await {
        Ok(payload) => Json(payload).into_response(),
        Err(error) => json_response(error.status_code, error.body),
    }
}

async fn api_delete_file(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath((date, filename)): AxumPath<(String, String)>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    match delete_managed_file(state.uploads_dir.as_ref(), &date, &filename).await {
        Ok(payload) => Json(payload).into_response(),
        Err(error) => json_response(error.status_code, error.body),
    }
}

async fn api_delete_all_files(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    match delete_all_managed_files(state.uploads_dir.as_ref()).await {
        Ok(payload) => Json(payload).into_response(),
        Err(error) => json_response(error.status_code, error.body),
    }
}

async fn api_ws(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    Query(query): Query<WsQuery>,
) -> Response {
    ws.on_upgrade(move |socket| handle_pty_websocket(socket, state, query))
}

async fn api_tasks(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    match state
        .task_manager
        .list_recent(DEFAULT_TASK_HISTORY_LIMIT)
        .await
    {
        Ok(tasks) => Json(Value::Array(tasks)).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

async fn static_uploads(
    State(state): State<Arc<AppState>>,
    AxumPath(path): AxumPath<String>,
) -> Response {
    let Some(safe_path) = sanitize_request_path(&path) else {
        return json_error(StatusCode::NOT_FOUND, "not found");
    };
    let full_path = state.uploads_dir.join(safe_path);
    if !full_path.starts_with(state.uploads_dir.as_ref()) || !full_path.is_file() {
        return json_error(StatusCode::NOT_FOUND, "not found");
    }
    serve_file(full_path).await
}

async fn api_delete_task(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    match state.task_manager.delete_task(&id).await {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

async fn api_create_task(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<TaskBody>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    let Some(prompt) = body.prompt.filter(|value| !value.is_empty()) else {
        return json_error(StatusCode::BAD_REQUEST, "prompt required");
    };

    let session_name = body.session_name.unwrap_or_default();
    let tmux_session = body
        .tmux_session
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| state.default_tmux_session.as_ref().clone());
    let cwd = resolve_task_cwd_from_runtime(&state, &tmux_session, &session_name).await;
    let handle = match state
        .task_manager
        .run_task(
            prompt.clone(),
            cwd,
            TaskRunOptions {
                session_name: session_name.clone(),
                source: "web".to_string(),
                tmux_session: tmux_session.clone(),
                profile: body.profile.filter(|value| !value.is_empty()),
            },
        )
        .await
    {
        Ok(handle) => handle,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    };

    let stream = TaskEventStream::new(state.task_manager.clone(), session_name, prompt, handle);
    let mut response = Sse::new(stream).into_response();
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
        .headers_mut()
        .insert(CONNECTION, HeaderValue::from_static("keep-alive"));
    response
}

async fn api_session_output(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<SessionQuery>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    let window_index = match id.parse::<u32>() {
        Ok(value) => value,
        Err(_) => return json_error(StatusCode::BAD_REQUEST, "invalid window index"),
    };
    let session = query
        .session
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| state.default_tmux_session.as_ref().clone());

    runtime_request_response(
        state
            .runtime_manager
            .pty_broker_request(
                "getOutputSnapshot",
                json!({
                    "session": session,
                    "windowIndex": window_index,
                }),
            )
            .await,
    )
}

async fn api_session_scrollback(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<ScrollbackQuery>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    let window_index = match id.parse::<u32>() {
        Ok(value) => value,
        Err(_) => return json_error(StatusCode::BAD_REQUEST, "invalid window index"),
    };
    let session = query
        .session
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| state.default_tmux_session.as_ref().clone());
    let lines = query
        .lines
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(3000)
        .min(10_000);

    match capture_tmux_scrollback(&session, window_index, lines).await {
        Ok(content) => Json(json!({ "content": content })).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

async fn api_tmux_sessions(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    runtime_request_response(
        state
            .runtime_manager
            .session_management_request("listTmuxSessions", json!({}))
            .await,
    )
}

async fn api_projects(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    runtime_request_response(
        state
            .runtime_manager
            .session_management_request("listProjects", json!({}))
            .await,
    )
}

async fn api_session_cwd(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<SessionQuery>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    runtime_request_response(
        state
            .runtime_manager
            .session_management_request(
                "getSessionCwd",
                json!({
                    "sessionName": query
                        .session
                        .filter(|value| !value.is_empty())
                        .unwrap_or_else(|| state.default_tmux_session.as_ref().clone()),
                }),
            )
            .await,
    )
}

async fn api_launch_window(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<SessionQuery>,
    Json(body): Json<WindowLaunchBody>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    let session_name = query
        .session
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| state.default_tmux_session.as_ref().clone());
    let shell_type = normalize_shell_type(body.shell_type.as_deref());
    let response_profile = body.profile.filter(|value| !value.is_empty());
    let rel_path = body.rel_path.filter(|value| !value.is_empty());
    let update_session_cwd = rel_path.is_some();
    let cwd = match rel_path {
        Some(path) => resolve_workspace_path(state.workspace_root.as_ref(), &path),
        None => resolve_session_cwd_from_runtime(&state, &session_name).await,
    };

    launch_window_via_runtime(
        &state,
        session_name,
        cwd,
        &shell_type,
        response_profile,
        update_session_cwd,
        "window",
    )
    .await
}

async fn api_codex_sessions(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<CodexSessionsQuery>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    runtime_request_response(
        state
            .runtime_manager
            .session_management_request(
                "listCodexSessions",
                json!({
                    "projectName": query.project.unwrap_or_default(),
                    "limit": query.limit,
                    "cursor": query.cursor,
                }),
            )
            .await,
    )
}

async fn api_codex_session_detail(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<ProjectQuery>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    runtime_request_response(
        state
            .runtime_manager
            .session_management_request(
                "getCodexSessionDetail",
                json!({
                    "sessionId": id,
                    "projectName": query.project.unwrap_or_default(),
                }),
            )
            .await,
    )
}

async fn api_codex_session_resume(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<ProjectQuery>,
    body: Option<Json<ProjectBody>>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    runtime_request_response(
        state
            .runtime_manager
            .session_management_request(
                "resumeCodexSession",
                json!({
                    "sessionId": id,
                    "projectName": project_from_sources(body, query.project),
                }),
            )
            .await,
    )
}

async fn api_codex_session_delete(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<ProjectQuery>,
    body: Option<Json<ProjectBody>>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    runtime_request_response(
        state
            .runtime_manager
            .session_management_request(
                "deleteProjectCodexSession",
                json!({
                    "sessionId": id,
                    "projectName": project_from_sources(body, query.project),
                }),
            )
            .await,
    )
}

async fn api_project_channels(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(name): AxumPath<String>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    runtime_request_response(
        state
            .runtime_manager
            .session_management_request("listProjectChannels", json!({ "projectName": name }))
            .await,
    )
}

async fn api_create_project(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<CreateProjectBody>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    let Some(path) = body.path.filter(|value| !value.is_empty()) else {
        return json_error(StatusCode::BAD_REQUEST, "path required");
    };

    let shell_type = normalize_shell_type(body.shell_type.as_deref());
    let response_profile = body.profile.filter(|value| !value.is_empty());
    let cwd = resolve_workspace_path(state.workspace_root.as_ref(), &path);
    let safe_name = derive_project_session_name(&cwd);
    let existing_sessions = list_all_session_names_from_runtime(&state).await;
    let final_name = next_available_name(&safe_name, &existing_sessions);
    let initial_window_name =
        derive_initial_window_name(&cwd, response_profile.as_deref()).to_string();
    let shell_cmd = build_interactive_shell_command(
        state.project_root.as_ref(),
        state.proxy_vars.as_ref(),
        DEFAULT_INTERACTIVE_SHELL,
        &shell_type,
        response_profile.as_deref(),
        &cwd,
        None,
    );

    match state
        .runtime_manager
        .session_management_request(
            "createProject",
            json!({
                "sessionName": final_name.clone(),
                "cwd": cwd.clone(),
                "initialWindowName": initial_window_name,
                "shellCmd": shell_cmd,
                "proxyVars": proxy_vars_json(&state),
            }),
        )
        .await
    {
        Ok(_) => {}
        Err(error) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("failed to create project: {error}"),
            );
        }
    }

    if let Err(error) = remember_project_default(
        state.project_defaults_file.as_ref(),
        &cwd,
        &shell_type,
        response_profile.as_deref(),
    )
    .await
    {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, &error);
    }

    Json(json!({
        "name": final_name,
        "path": cwd,
        "shell_type": shell_type,
        "profile": response_profile,
    }))
    .into_response()
}

async fn api_create_project_channel(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(name): AxumPath<String>,
    Json(body): Json<CreateProjectBody>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    let shell_type = normalize_shell_type(body.shell_type.as_deref());
    let response_profile = body.profile.filter(|value| !value.is_empty());
    let cwd = match body.path.filter(|value| !value.is_empty()) {
        Some(path) => resolve_workspace_path(state.workspace_root.as_ref(), &path),
        None => resolve_session_cwd_from_runtime(&state, &name).await,
    };
    let base_channel_name = response_profile
        .as_deref()
        .filter(|value| !value.is_empty())
        .unwrap_or("channel");
    let existing_channel_names = list_channel_names_from_runtime(&state, &name).await;
    let channel_name = next_available_name(base_channel_name, &existing_channel_names);
    let shell_cmd = build_interactive_shell_command(
        state.project_root.as_ref(),
        state.proxy_vars.as_ref(),
        DEFAULT_INTERACTIVE_SHELL,
        &shell_type,
        response_profile.as_deref(),
        &cwd,
        None,
    );

    match state
        .runtime_manager
        .session_management_request(
            "createProjectChannel",
            json!({
                "sessionName": name.clone(),
                "cwd": cwd.clone(),
                "channelName": channel_name.clone(),
                "shellCmd": shell_cmd,
                "defaultShellCmd": DEFAULT_INTERACTIVE_SHELL,
                "proxyVars": proxy_vars_json(&state),
            }),
        )
        .await
    {
        Ok(_) => {}
        Err(error) => {
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, &error);
        }
    }

    if let Err(error) = remember_project_default(
        state.project_defaults_file.as_ref(),
        &cwd,
        &shell_type,
        response_profile.as_deref(),
    )
    .await
    {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, &error);
    }

    Json(json!({
        "name": channel_name,
        "cwd": cwd,
        "shell_type": shell_type,
        "profile": response_profile,
        "project": name,
    }))
    .into_response()
}

async fn api_activate_project(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(name): AxumPath<String>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    runtime_request_response(
        state
            .runtime_manager
            .session_management_request("activateProject", json!({ "projectName": name }))
            .await,
    )
}

async fn api_create_session_window(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<WindowLaunchBody>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    let Some(path) = body.rel_path.filter(|value| !value.is_empty()) else {
        return json_error(StatusCode::BAD_REQUEST, "rel_path required");
    };

    let session_name = body
        .session
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| state.default_tmux_session.as_ref().clone());
    let shell_type = normalize_shell_type(body.shell_type.as_deref());
    let response_profile = body.profile.filter(|value| !value.is_empty());
    let cwd = resolve_workspace_path(state.workspace_root.as_ref(), &path);

    launch_window_via_runtime(
        &state,
        session_name,
        cwd,
        &shell_type,
        response_profile,
        false,
        "session",
    )
    .await
}

async fn api_sessions(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<SessionQuery>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    runtime_request_response(
        state
            .runtime_manager
            .session_management_request(
                "listSessionWindows",
                json!({
                    "sessionName": query
                        .session
                        .filter(|value| !value.is_empty())
                        .unwrap_or_else(|| state.default_tmux_session.as_ref().clone()),
                }),
            )
            .await,
    )
}

async fn api_rename_project(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(name): AxumPath<String>,
    Json(body): Json<NameBody>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    let Some(new_name) = sanitize_project_name(body.name) else {
        return json_error(StatusCode::BAD_REQUEST, "invalid name format");
    };

    runtime_request_response(
        state
            .runtime_manager
            .session_management_request(
                "renameProject",
                json!({
                    "oldName": name,
                    "newName": new_name,
                }),
            )
            .await,
    )
}

async fn api_delete_project(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(name): AxumPath<String>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    runtime_request_response(
        state
            .runtime_manager
            .session_management_request("deleteProject", json!({ "sessionName": name }))
            .await,
    )
}

async fn api_attach_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<SessionQuery>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    runtime_request_response(
        state
            .runtime_manager
            .session_management_request(
                "attachSessionWindow",
                json!({
                    "sessionName": query
                        .session
                        .filter(|value| !value.is_empty())
                        .unwrap_or_else(|| state.default_tmux_session.as_ref().clone()),
                    "index": id,
                }),
            )
            .await,
    )
}

async fn api_rename_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<SessionQuery>,
    Json(body): Json<NameBody>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    let Some(window_name) = sanitize_window_name(body.name) else {
        return json_error(StatusCode::BAD_REQUEST, "name required");
    };

    runtime_request_response(
        state
            .runtime_manager
            .session_management_request(
                "renameSessionWindow",
                json!({
                    "sessionName": query
                        .session
                        .filter(|value| !value.is_empty())
                        .unwrap_or_else(|| state.default_tmux_session.as_ref().clone()),
                    "index": id,
                    "name": window_name,
                }),
            )
            .await,
    )
}

async fn api_delete_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<SessionQuery>,
) -> Response {
    if let Some(response) = require_auth(&headers, &state) {
        return response;
    }

    runtime_request_response(
        state
            .runtime_manager
            .session_management_request(
                "deleteSessionWindow",
                json!({
                    "sessionName": query
                        .session
                        .filter(|value| !value.is_empty())
                        .unwrap_or_else(|| state.default_tmux_session.as_ref().clone()),
                    "index": id,
                    "defaultShellCmd": DEFAULT_INTERACTIVE_SHELL,
                }),
            )
            .await,
    )
}

struct WorkspaceRouteError {
    status_code: StatusCode,
    message: String,
}

impl WorkspaceRouteError {
    fn new(status_code: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status_code,
            message: message.into(),
        }
    }
}

fn workspace_json_response(result: Result<Value, WorkspaceRouteError>) -> Response {
    match result {
        Ok(payload) => Json(payload).into_response(),
        Err(error) => json_error(error.status_code, &error.message),
    }
}

async fn serve_workspace_file_response(
    state: Arc<AppState>,
    headers: HeaderMap,
    query: WorkspaceServeQuery,
    request_path: &str,
) -> Response {
    if let Some(response) = require_workspace_auth(&headers, query.token.as_deref(), &state) {
        return response;
    }

    match resolve_workspace_serve_file_path(
        state.workspace_root.as_ref(),
        query.path.as_deref(),
        request_path,
    )
    .await
    {
        Ok(full_path) => {
            let mut response = serve_file(full_path.clone()).await;
            if response.status() == StatusCode::OK && query.dl.as_deref() == Some("1") {
                if let Some(file_name) = full_path.file_name().and_then(|value| value.to_str()) {
                    if let Ok(header_value) = HeaderValue::from_str(&format!(
                        "attachment; filename*=UTF-8''{}",
                        percent_encode_utf8(file_name)
                    )) {
                        response
                            .headers_mut()
                            .insert(CONTENT_DISPOSITION, header_value);
                    }
                }
            }
            response
        }
        Err(error) => (error.status_code, error.message).into_response(),
    }
}

async fn browse_workspace_directories(
    workspace_root: &str,
    path: Option<&str>,
) -> Result<Value, WorkspaceRouteError> {
    let resolved_path = resolve_workspace_input_path(workspace_root, path, true)?;
    let mut dirs = Vec::new();
    let mut entries = fs::read_dir(&resolved_path).await.map_err(|error| {
        WorkspaceRouteError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
    })?;

    while let Some(entry) = entries.next_entry().await.map_err(|error| {
        WorkspaceRouteError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
    })? {
        let file_type = entry.file_type().await.map_err(|error| {
            WorkspaceRouteError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
        })?;
        if !file_type.is_dir() {
            continue;
        }

        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }

        dirs.push(json!({
            "name": name,
            "path": path_to_string(&entry.path()),
        }));
    }

    dirs.sort_by(|left, right| {
        left.get("name")
            .and_then(Value::as_str)
            .cmp(&right.get("name").and_then(Value::as_str))
    });

    Ok(json!({
        "path": path_to_string(&resolved_path),
        "parent": resolved_path.parent().map(path_to_string),
        "dirs": dirs,
    }))
}

async fn list_workspace_entries(
    workspace_root: &str,
    path: Option<&str>,
) -> Result<Value, WorkspaceRouteError> {
    let resolved_path = resolve_workspace_input_path(workspace_root, path, true)?;
    let mut entries = Vec::new();
    let mut read_dir = fs::read_dir(&resolved_path).await.map_err(|error| {
        WorkspaceRouteError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
    })?;

    while let Some(entry) = read_dir.next_entry().await.map_err(|error| {
        WorkspaceRouteError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
    })? {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }

        let file_type = entry.file_type().await.map_err(|error| {
            WorkspaceRouteError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
        })?;
        let metadata = entry.metadata().await.map_err(|error| {
            WorkspaceRouteError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
        })?;
        let mut payload = serde_json::Map::new();
        payload.insert("name".to_string(), Value::String(name));
        payload.insert(
            "type".to_string(),
            Value::String(if file_type.is_dir() {
                "dir".to_string()
            } else {
                "file".to_string()
            }),
        );
        if file_type.is_file() {
            payload.insert("size".to_string(), Value::from(metadata.len()));
        }
        let mtime = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_millis() as u64)
            .unwrap_or(0);
        payload.insert("mtime".to_string(), Value::from(mtime));
        entries.push(Value::Object(payload));
    }

    entries.sort_by(|left, right| {
        left.get("name")
            .and_then(Value::as_str)
            .cmp(&right.get("name").and_then(Value::as_str))
    });

    Ok(json!({
        "path": path_to_string(&resolved_path),
        "entries": entries,
    }))
}

async fn create_workspace_directory(
    workspace_root: &str,
    path: Option<&str>,
    name: Option<&str>,
) -> Result<Value, WorkspaceRouteError> {
    let Some(name) = name.filter(|value| !value.is_empty()) else {
        return Err(WorkspaceRouteError::new(
            StatusCode::BAD_REQUEST,
            "name required",
        ));
    };
    let resolved_path = resolve_workspace_input_path(workspace_root, path, true)?;
    let dir_path = normalize_path_lexically(&resolved_path.join(name));
    if path_contains_parent_marker(&dir_path) {
        return Err(WorkspaceRouteError::new(
            StatusCode::FORBIDDEN,
            "invalid path",
        ));
    }
    if fs::metadata(&dir_path).await.is_ok() {
        return Err(WorkspaceRouteError::new(
            StatusCode::CONFLICT,
            "already exists",
        ));
    }

    fs::create_dir_all(&dir_path).await.map_err(|error| {
        WorkspaceRouteError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
    })?;
    Ok(json!({
        "ok": true,
        "path": path_to_string(&dir_path),
    }))
}

async fn create_workspace_file(
    workspace_root: &str,
    path: Option<&str>,
    name: Option<&str>,
    content: &str,
) -> Result<Value, WorkspaceRouteError> {
    let Some(name) = name.filter(|value| !value.is_empty()) else {
        return Err(WorkspaceRouteError::new(
            StatusCode::BAD_REQUEST,
            "name required",
        ));
    };
    let resolved_path = resolve_workspace_input_path(workspace_root, path, true)?;
    let file_path = normalize_path_lexically(&resolved_path.join(name));
    if path_contains_parent_marker(&file_path) {
        return Err(WorkspaceRouteError::new(
            StatusCode::FORBIDDEN,
            "invalid path",
        ));
    }
    if fs::metadata(&file_path).await.is_ok() {
        return Err(WorkspaceRouteError::new(
            StatusCode::CONFLICT,
            "already exists",
        ));
    }

    fs::write(&file_path, content).await.map_err(|error| {
        WorkspaceRouteError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
    })?;
    Ok(json!({
        "ok": true,
        "path": path_to_string(&file_path),
    }))
}

async fn read_workspace_file_content(
    workspace_root: &str,
    path: Option<&str>,
) -> Result<Value, WorkspaceRouteError> {
    let resolved_path = resolve_workspace_input_path(workspace_root, path, false)?;
    let metadata = fs::metadata(&resolved_path)
        .await
        .map_err(|_| WorkspaceRouteError::new(StatusCode::NOT_FOUND, "not found"))?;
    if !metadata.is_file() {
        return Err(WorkspaceRouteError::new(StatusCode::NOT_FOUND, "not found"));
    }

    let content = fs::read_to_string(&resolved_path).await.map_err(|error| {
        WorkspaceRouteError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
    })?;
    Ok(json!({
        "path": path_to_string(&resolved_path),
        "content": content,
    }))
}

async fn write_workspace_file_content(
    workspace_root: &str,
    path: Option<&str>,
    content: &str,
) -> Result<Value, WorkspaceRouteError> {
    let resolved_path = resolve_workspace_input_path(workspace_root, path, false)?;
    fs::write(&resolved_path, content).await.map_err(|error| {
        WorkspaceRouteError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
    })?;
    Ok(json!({
        "ok": true,
        "path": path_to_string(&resolved_path),
    }))
}

async fn delete_workspace_entry(
    workspace_root: &str,
    path: &str,
) -> Result<Value, WorkspaceRouteError> {
    let resolved_path = resolve_workspace_input_path(workspace_root, Some(path), false)?;
    let metadata = fs::metadata(&resolved_path)
        .await
        .map_err(|_| WorkspaceRouteError::new(StatusCode::NOT_FOUND, "not found"))?;

    let result = if metadata.is_dir() {
        fs::remove_dir_all(&resolved_path).await
    } else {
        fs::remove_file(&resolved_path).await
    };
    result.map_err(|error| {
        WorkspaceRouteError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
    })?;

    Ok(json!({ "ok": true }))
}

async fn rename_workspace_entry(
    workspace_root: &str,
    path: Option<&str>,
    new_name: Option<&str>,
) -> Result<Value, WorkspaceRouteError> {
    let Some(source_path) = path.filter(|value| !value.is_empty()) else {
        return Err(WorkspaceRouteError::new(
            StatusCode::BAD_REQUEST,
            "path and newName required",
        ));
    };
    let Some(new_name) = new_name.filter(|value| !value.is_empty()) else {
        return Err(WorkspaceRouteError::new(
            StatusCode::BAD_REQUEST,
            "path and newName required",
        ));
    };
    let resolved_source = resolve_workspace_input_path(workspace_root, Some(source_path), false)?;
    if fs::metadata(&resolved_source).await.is_err() {
        return Err(WorkspaceRouteError::new(StatusCode::NOT_FOUND, "not found"));
    }

    let parent = resolved_source
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(PathBuf::new);
    let dest_path = normalize_path_lexically(&parent.join(new_name));
    if path_contains_parent_marker(&dest_path) {
        return Err(WorkspaceRouteError::new(
            StatusCode::FORBIDDEN,
            "invalid newName",
        ));
    }
    if fs::metadata(&dest_path).await.is_ok() {
        return Err(WorkspaceRouteError::new(
            StatusCode::CONFLICT,
            "already exists",
        ));
    }

    fs::rename(&resolved_source, &dest_path)
        .await
        .map_err(|error| {
            WorkspaceRouteError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
        })?;
    Ok(json!({
        "ok": true,
        "path": path_to_string(&dest_path),
    }))
}

async fn copy_workspace_entry(
    workspace_root: &str,
    source_path: Option<&str>,
    target_path: Option<&str>,
) -> Result<Value, WorkspaceRouteError> {
    let Some(source_path) = source_path.filter(|value| !value.is_empty()) else {
        return Err(WorkspaceRouteError::new(
            StatusCode::BAD_REQUEST,
            "sourcePath and targetPath required",
        ));
    };
    let Some(target_path) = target_path.filter(|value| !value.is_empty()) else {
        return Err(WorkspaceRouteError::new(
            StatusCode::BAD_REQUEST,
            "sourcePath and targetPath required",
        ));
    };
    let resolved_source = resolve_workspace_input_path(workspace_root, Some(source_path), false)?;
    let resolved_target = resolve_workspace_input_path(workspace_root, Some(target_path), false)?;

    if fs::metadata(&resolved_source).await.is_err() {
        return Err(WorkspaceRouteError::new(
            StatusCode::NOT_FOUND,
            "source not found",
        ));
    }
    if fs::metadata(&resolved_target).await.is_ok() {
        return Err(WorkspaceRouteError::new(
            StatusCode::CONFLICT,
            "target already exists",
        ));
    }

    copy_path_recursive_sync(&resolved_source, &resolved_target)
        .map_err(|error| WorkspaceRouteError::new(StatusCode::INTERNAL_SERVER_ERROR, error))?;
    Ok(json!({
        "ok": true,
        "path": path_to_string(&resolved_target),
    }))
}

async fn move_workspace_entry(
    workspace_root: &str,
    source_path: Option<&str>,
    target_path: Option<&str>,
) -> Result<Value, WorkspaceRouteError> {
    let Some(source_path) = source_path.filter(|value| !value.is_empty()) else {
        return Err(WorkspaceRouteError::new(
            StatusCode::BAD_REQUEST,
            "sourcePath and targetPath required",
        ));
    };
    let Some(target_path) = target_path.filter(|value| !value.is_empty()) else {
        return Err(WorkspaceRouteError::new(
            StatusCode::BAD_REQUEST,
            "sourcePath and targetPath required",
        ));
    };
    let resolved_source = resolve_workspace_input_path(workspace_root, Some(source_path), false)?;
    let resolved_target = resolve_workspace_input_path(workspace_root, Some(target_path), false)?;

    if fs::metadata(&resolved_source).await.is_err() {
        return Err(WorkspaceRouteError::new(
            StatusCode::NOT_FOUND,
            "source not found",
        ));
    }
    if fs::metadata(&resolved_target).await.is_ok() {
        return Err(WorkspaceRouteError::new(
            StatusCode::CONFLICT,
            "target already exists",
        ));
    }

    match stdfs::rename(&resolved_source, &resolved_target) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::CrossesDevices => {
            copy_path_recursive_sync(&resolved_source, &resolved_target).map_err(|copy_error| {
                WorkspaceRouteError::new(StatusCode::INTERNAL_SERVER_ERROR, copy_error)
            })?;
            remove_path_recursive_sync(&resolved_source).map_err(|remove_error| {
                WorkspaceRouteError::new(StatusCode::INTERNAL_SERVER_ERROR, remove_error)
            })?;
        }
        Err(error) => {
            return Err(WorkspaceRouteError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                error.to_string(),
            ));
        }
    }

    Ok(json!({
        "ok": true,
        "path": path_to_string(&resolved_target),
    }))
}

fn config_profiles_response(result: Result<Value, ServiceRouteError>) -> Response {
    match result {
        Ok(payload) => Json(payload).into_response(),
        Err(error) => json_response(error.status_code, error.body),
    }
}

fn sync_metadata_keys() -> [&'static str; 3] {
    ["SYNC_SOURCE", "SYNC_SOURCE_ID", "SYNC_SOURCE_NAME"]
}

fn object_value(value: &Value) -> serde_json::Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn value_string(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn json_object_file(path: &Path) -> Option<serde_json::Map<String, Value>> {
    stdfs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| value.as_object().cloned())
}

fn write_json_object_file(
    path: &Path,
    object: &serde_json::Map<String, Value>,
    trailing_newline: bool,
) -> Result<(), ServiceRouteError> {
    if let Some(parent) = path.parent() {
        stdfs::create_dir_all(parent).map_err(|error| {
            ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
        })?;
    }
    let mut content =
        serde_json::to_string_pretty(&Value::Object(object.clone())).map_err(|error| {
            ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
        })?;
    if trailing_newline {
        content.push('\n');
    }
    stdfs::write(path, content).map_err(|error| {
        ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
    })
}

fn sanitize_profile_id(id: &str) -> String {
    id.chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '_' || character == '-' {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
}

fn merge_sync_metadata(
    current: &serde_json::Map<String, Value>,
    next: &mut serde_json::Map<String, Value>,
) {
    for key in sync_metadata_keys() {
        if !next.contains_key(key) {
            if let Some(value) = current.get(key) {
                next.insert(key.to_string(), value.clone());
            }
        }
    }
}

fn metadata_mtime_ms(path: &Path) -> u64 {
    stdfs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn build_claude_config_response_object(
    id: &str,
    raw: Option<serde_json::Map<String, Value>>,
) -> Value {
    let mut payload = raw.unwrap_or_default();
    let label = value_string(payload.get("label"));
    payload.insert("id".to_string(), Value::String(id.to_string()));
    payload.insert(
        "label".to_string(),
        Value::String(if label.is_empty() {
            id.to_string()
        } else {
            label
        }),
    );
    Value::Object(payload)
}

fn read_stored_claude_config(configs_dir: &Path, id: &str) -> Option<Value> {
    let sanitized_id = sanitize_profile_id(id);
    if sanitized_id.is_empty() {
        return None;
    }
    let file_path = configs_dir.join(format!("{sanitized_id}.json"));
    if !file_path.exists() {
        return None;
    }
    Some(build_claude_config_response_object(
        &sanitized_id,
        json_object_file(&file_path),
    ))
}

fn list_claude_configs(configs_dir: &Path) -> Value {
    let mut files = match stdfs::read_dir(configs_dir) {
        Ok(entries) => entries
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.path().is_file())
            .filter(|entry| {
                entry.path().extension().and_then(|value| value.to_str()) == Some("json")
            })
            .map(|entry| entry.path())
            .collect::<Vec<_>>(),
        Err(_) => Vec::new(),
    };

    files.sort_by(|left, right| metadata_mtime_ms(right).cmp(&metadata_mtime_ms(left)));
    Value::Array(
        files
            .into_iter()
            .map(|path| {
                let id = path
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default()
                    .to_string();
                build_claude_config_response_object(&id, json_object_file(&path))
            })
            .collect(),
    )
}

fn save_stored_claude_config(
    configs_dir: &Path,
    id: &str,
    config: Value,
) -> Result<(String, Value), ServiceRouteError> {
    let sanitized_id = sanitize_profile_id(id);
    if sanitized_id.is_empty() {
        return Err(ServiceRouteError::from_message(
            StatusCode::BAD_REQUEST,
            "invalid id",
        ));
    }

    let file_path = configs_dir.join(format!("{sanitized_id}.json"));
    let current = read_stored_claude_config(configs_dir, &sanitized_id)
        .map(|value| object_value(&value))
        .unwrap_or_default();
    let mut next = object_value(&config);
    merge_sync_metadata(&current, &mut next);
    write_json_object_file(&file_path, &next, false)?;

    Ok((
        sanitized_id.clone(),
        build_claude_config_response_object(&sanitized_id, Some(next)),
    ))
}

fn save_claude_config_route(
    configs_dir: &Path,
    id: &str,
    config: Value,
) -> Result<Value, ServiceRouteError> {
    let (saved_id, _) = save_stored_claude_config(configs_dir, id, config)?;
    Ok(json!({
        "ok": true,
        "id": saved_id,
    }))
}

fn read_global_claude_config() -> Option<Value> {
    let home_dir = env::var("HOME").ok()?;
    let settings_file = Path::new(&home_dir).join(".claude").join("settings.json");
    let settings = json_object_file(&settings_file)?;
    let env_payload = settings
        .get("env")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let default_model = {
        let sonnet = value_string(env_payload.get("ANTHROPIC_DEFAULT_SONNET_MODEL"));
        if sonnet.is_empty() {
            value_string(env_payload.get("ANTHROPIC_MODEL"))
        } else {
            sonnet
        }
    };
    let think_model = {
        let opus = value_string(env_payload.get("ANTHROPIC_DEFAULT_OPUS_MODEL"));
        if opus.is_empty() {
            value_string(env_payload.get("ANTHROPIC_THINK_MODEL"))
        } else {
            opus
        }
    };
    let api_timeout_ms = {
        let timeout = value_string(env_payload.get("API_TIMEOUT_MS"));
        if timeout.is_empty() {
            "3000000".to_string()
        } else {
            timeout
        }
    };

    Some(json!({
        "label": "Imported from ~/.claude/settings.json",
        "BASE_URL": value_string(env_payload.get("ANTHROPIC_BASE_URL")),
        "AUTH_TOKEN": value_string(env_payload.get("ANTHROPIC_AUTH_TOKEN")),
        "API_KEY": value_string(env_payload.get("ANTHROPIC_API_KEY")),
        "DEFAULT_MODEL": default_model,
        "THINK_MODEL": think_model,
        "LONG_CONTEXT_MODEL": value_string(env_payload.get("ANTHROPIC_LONG_CONTEXT_MODEL")),
        "DEFAULT_HAIKU_MODEL": value_string(env_payload.get("ANTHROPIC_DEFAULT_HAIKU_MODEL")),
        "API_TIMEOUT_MS": api_timeout_ms,
    }))
}

fn sync_current_claude_config_route(
    configs_dir: &Path,
    id: &str,
) -> Result<Value, ServiceRouteError> {
    let sanitized_id = sanitize_profile_id(id);
    if sanitized_id.is_empty() {
        return Err(ServiceRouteError::from_message(
            StatusCode::BAD_REQUEST,
            "invalid id",
        ));
    }

    let existing = read_stored_claude_config(configs_dir, &sanitized_id).ok_or_else(|| {
        ServiceRouteError::from_message(StatusCode::NOT_FOUND, "config not found")
    })?;
    let imported = read_global_claude_config().ok_or_else(|| {
        ServiceRouteError::from_message(
            StatusCode::NOT_FOUND,
            "global ~/.claude/settings.json not found",
        )
    })?;

    let mut imported_object = object_value(&imported);
    let existing_label = value_string(object_value(&existing).get("label"));
    let imported_label = value_string(imported_object.get("label"));
    imported_object.insert(
        "label".to_string(),
        Value::String(if existing_label.is_empty() {
            if imported_label.is_empty() {
                sanitized_id.clone()
            } else {
                imported_label
            }
        } else {
            existing_label
        }),
    );

    let (saved_id, saved_config) =
        save_stored_claude_config(configs_dir, &sanitized_id, Value::Object(imported_object))?;
    Ok(json!({
        "ok": true,
        "id": saved_id,
        "config": saved_config,
    }))
}

fn delete_claude_config_route(configs_dir: &Path, id: &str) -> Result<Value, ServiceRouteError> {
    let sanitized_id = sanitize_profile_id(id);
    if sanitized_id.is_empty() {
        return Err(ServiceRouteError::from_message(
            StatusCode::BAD_REQUEST,
            "invalid id",
        ));
    }
    let file_path = configs_dir.join(format!("{sanitized_id}.json"));
    if file_path.exists() {
        stdfs::remove_file(file_path).map_err(|error| {
            ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
        })?;
    }
    Ok(json!({ "ok": true }))
}

fn parse_json_object_from_str(raw: &str) -> Option<serde_json::Map<String, Value>> {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| value.as_object().cloned())
}

fn normalize_json_text_value(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(raw)) => parse_json_object_from_str(raw)
            .and_then(|object| serde_json::to_string_pretty(&Value::Object(object)).ok())
            .unwrap_or_default(),
        Some(Value::Object(object)) => {
            serde_json::to_string_pretty(&Value::Object(object.clone())).unwrap_or_default()
        }
        _ => String::new(),
    }
}

fn empty_codex_config_object(label: &str) -> serde_json::Map<String, Value> {
    serde_json::Map::from_iter([
        ("label".to_string(), Value::String(label.to_string())),
        ("OPENAI_API_KEY".to_string(), Value::String(String::new())),
        ("BASE_URL".to_string(), Value::String(String::new())),
        ("MODEL".to_string(), Value::String(String::new())),
        ("REASONING_EFFORT".to_string(), Value::String(String::new())),
        ("CONFIG_TOML".to_string(), Value::String(String::new())),
        ("AUTH_JSON".to_string(), Value::String(String::new())),
        ("SYNC_SOURCE".to_string(), Value::String(String::new())),
        ("SYNC_SOURCE_ID".to_string(), Value::String(String::new())),
        ("SYNC_SOURCE_NAME".to_string(), Value::String(String::new())),
    ])
}

fn normalize_codex_config_value(value: &Value) -> serde_json::Map<String, Value> {
    let raw = object_value(value);
    let auth_json = normalize_json_text_value(raw.get("AUTH_JSON"));
    let auth_payload = parse_json_object_from_str(&auth_json).unwrap_or_default();
    let mut normalized = empty_codex_config_object(&value_string(raw.get("label")));
    let openai_api_key = value_string(raw.get("OPENAI_API_KEY"));
    normalized.insert(
        "OPENAI_API_KEY".to_string(),
        Value::String(if openai_api_key.is_empty() {
            value_string(auth_payload.get("OPENAI_API_KEY"))
        } else {
            openai_api_key
        }),
    );
    normalized.insert(
        "BASE_URL".to_string(),
        Value::String(value_string(raw.get("BASE_URL"))),
    );
    normalized.insert(
        "MODEL".to_string(),
        Value::String(value_string(raw.get("MODEL"))),
    );
    normalized.insert(
        "REASONING_EFFORT".to_string(),
        Value::String(value_string(raw.get("REASONING_EFFORT"))),
    );
    normalized.insert(
        "CONFIG_TOML".to_string(),
        Value::String(value_string(raw.get("CONFIG_TOML"))),
    );
    normalized.insert("AUTH_JSON".to_string(), Value::String(auth_json));
    for key in sync_metadata_keys() {
        normalized.insert(key.to_string(), Value::String(value_string(raw.get(key))));
    }
    normalized
}

fn build_codex_config_response_object(
    id: &str,
    raw: Option<serde_json::Map<String, Value>>,
) -> Value {
    let mut normalized = match raw {
        Some(raw) => normalize_codex_config_value(&Value::Object(raw)),
        None => empty_codex_config_object(id),
    };
    let label = value_string(normalized.get("label"));
    normalized.insert("id".to_string(), Value::String(id.to_string()));
    normalized.insert(
        "label".to_string(),
        Value::String(if label.is_empty() {
            id.to_string()
        } else {
            label
        }),
    );
    Value::Object(normalized)
}

fn read_codex_config(configs_dir: &Path, id: &str) -> Option<Value> {
    let sanitized_id = sanitize_profile_id(id);
    if sanitized_id.is_empty() {
        return None;
    }
    let file_path = configs_dir.join(format!("{sanitized_id}.json"));
    if !file_path.exists() {
        return None;
    }
    Some(build_codex_config_response_object(
        &sanitized_id,
        json_object_file(&file_path),
    ))
}

fn list_codex_configs(configs_dir: &Path) -> Value {
    let mut files = match stdfs::read_dir(configs_dir) {
        Ok(entries) => entries
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.path().is_file())
            .filter(|entry| {
                entry.path().extension().and_then(|value| value.to_str()) == Some("json")
            })
            .map(|entry| entry.path())
            .collect::<Vec<_>>(),
        Err(_) => Vec::new(),
    };

    files.sort_by(|left, right| metadata_mtime_ms(right).cmp(&metadata_mtime_ms(left)));
    Value::Array(
        files
            .into_iter()
            .map(|path| {
                let id = path
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default()
                    .to_string();
                build_codex_config_response_object(&id, json_object_file(&path))
            })
            .collect(),
    )
}

fn save_codex_config_file(
    configs_dir: &Path,
    id: &str,
    config: Value,
) -> Result<String, ServiceRouteError> {
    let sanitized_id = sanitize_profile_id(id);
    if sanitized_id.is_empty() {
        return Err(ServiceRouteError::from_message(
            StatusCode::BAD_REQUEST,
            "invalid id",
        ));
    }
    let file_path = configs_dir.join(format!("{sanitized_id}.json"));
    let normalized = normalize_codex_config_value(&config);
    write_json_object_file(&file_path, &normalized, true)?;
    Ok(sanitized_id)
}

fn save_codex_config_with_metadata(
    configs_dir: &Path,
    id: &str,
    config: Value,
) -> Result<(String, Value), ServiceRouteError> {
    let current = read_codex_config(configs_dir, id)
        .map(|value| object_value(&value))
        .unwrap_or_default();
    let mut next = object_value(&config);
    merge_sync_metadata(&current, &mut next);
    let saved_id = save_codex_config_file(configs_dir, id, Value::Object(next.clone()))?;
    let saved_config = read_codex_config(configs_dir, &saved_id)
        .unwrap_or_else(|| build_codex_config_response_object(&saved_id, Some(next)));
    Ok((saved_id, saved_config))
}

fn save_codex_config_route(
    configs_dir: &Path,
    id: &str,
    config: Value,
) -> Result<Value, ServiceRouteError> {
    let (saved_id, _) = save_codex_config_with_metadata(configs_dir, id, config)?;
    Ok(json!({
        "ok": true,
        "id": saved_id,
    }))
}

struct SimpleToml {
    root: HashMap<String, String>,
    sections: HashMap<String, HashMap<String, String>>,
}

fn parse_toml_scalar(raw: &str) -> String {
    let value = raw.trim();
    if value.starts_with('"') && value.ends_with('"') && value.len() >= 2 {
        serde_json::from_str::<String>(value)
            .unwrap_or_else(|_| value[1..value.len() - 1].to_string())
    } else {
        value.to_string()
    }
}

fn parse_simple_toml(text: &str) -> SimpleToml {
    let mut root = HashMap::new();
    let mut sections: HashMap<String, HashMap<String, String>> = HashMap::new();
    let mut current_section: Option<String> = None;

    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            let section_name = line[1..line.len() - 1].trim().to_string();
            sections.entry(section_name.clone()).or_default();
            current_section = Some(section_name);
            continue;
        }
        if let Some((key, raw_value)) = line.split_once('=') {
            let key = key.trim().to_string();
            let value = parse_toml_scalar(raw_value);
            if let Some(section_name) = current_section.as_ref() {
                sections
                    .entry(section_name.clone())
                    .or_default()
                    .insert(key, value);
            } else {
                root.insert(key, value);
            }
        }
    }

    SimpleToml { root, sections }
}

fn import_codex_config_from_global(config_toml_text: &str, auth_json_text: &str) -> Value {
    let normalized_config_toml = config_toml_text.trim().to_string();
    let normalized_auth_json =
        normalize_json_text_value(Some(&Value::String(auth_json_text.to_string())));
    let parsed_toml = parse_simple_toml(&normalized_config_toml);
    let provider_name = parsed_toml
        .root
        .get("model_provider")
        .cloned()
        .unwrap_or_default();
    let provider_section = parsed_toml
        .sections
        .get(&format!("model_providers.{provider_name}"))
        .cloned()
        .unwrap_or_default();
    let auth_payload = parse_json_object_from_str(&normalized_auth_json).unwrap_or_default();
    let model = parsed_toml.root.get("model").cloned().unwrap_or_default();

    let config = json!({
        "label": if model.is_empty() {
            "Imported from ~/.codex".to_string()
        } else {
            format!("Imported ({model})")
        },
        "OPENAI_API_KEY": value_string(auth_payload.get("OPENAI_API_KEY")),
        "BASE_URL": provider_section.get("base_url").cloned().unwrap_or_default(),
        "MODEL": model,
        "REASONING_EFFORT": parsed_toml
            .root
            .get("model_reasoning_effort")
            .cloned()
            .unwrap_or_default(),
        "CONFIG_TOML": normalized_config_toml,
        "AUTH_JSON": normalized_auth_json,
    });
    Value::Object(normalize_codex_config_value(&config))
}

fn read_global_codex_config() -> Option<Value> {
    let home_dir = env::var("HOME").ok()?;
    let codex_dir = Path::new(&home_dir).join(".codex");
    let config_file = codex_dir.join("config.toml");
    let auth_file = codex_dir.join("auth.json");
    if !config_file.exists() && !auth_file.exists() {
        return None;
    }

    let config_toml_text = stdfs::read_to_string(&config_file).unwrap_or_default();
    let auth_json_text = stdfs::read_to_string(&auth_file).unwrap_or_default();
    Some(import_codex_config_from_global(
        &config_toml_text,
        &auth_json_text,
    ))
}

fn import_global_codex_config_route(
    configs_dir: &Path,
    preferred_id: Option<String>,
) -> Result<Value, ServiceRouteError> {
    let imported = read_global_codex_config().ok_or_else(|| {
        ServiceRouteError::from_message(StatusCode::NOT_FOUND, "global ~/.codex not found")
    })?;

    let preferred_id = preferred_id.unwrap_or_default().trim().to_string();
    let raw_base_id = sanitize_profile_id(if preferred_id.is_empty() {
        "imported"
    } else {
        &preferred_id
    });
    let base_id = if raw_base_id.is_empty() {
        "imported".to_string()
    } else {
        raw_base_id
    };
    let mut next_id = base_id.clone();
    let mut counter = 1;
    while configs_dir.join(format!("{next_id}.json")).exists() {
        next_id = format!("{base_id}-{counter}");
        counter += 1;
    }

    let (saved_id, saved_config) =
        save_codex_config_with_metadata(configs_dir, &next_id, imported)?;
    Ok(json!({
        "ok": true,
        "id": saved_id,
        "config": saved_config,
    }))
}

fn sync_current_codex_config_route(
    configs_dir: &Path,
    id: &str,
) -> Result<Value, ServiceRouteError> {
    let existing = read_codex_config(configs_dir, id).ok_or_else(|| {
        ServiceRouteError::from_message(StatusCode::NOT_FOUND, "config not found")
    })?;
    let imported = read_global_codex_config().ok_or_else(|| {
        ServiceRouteError::from_message(StatusCode::NOT_FOUND, "global ~/.codex not found")
    })?;

    let existing_label = value_string(object_value(&existing).get("label"));
    let imported_label = value_string(object_value(&imported).get("label"));
    let mut next = object_value(&imported);
    next.insert(
        "label".to_string(),
        Value::String(if existing_label.is_empty() {
            if imported_label.is_empty() {
                id.to_string()
            } else {
                imported_label
            }
        } else {
            existing_label
        }),
    );

    let (saved_id, saved_config) =
        save_codex_config_with_metadata(configs_dir, id, Value::Object(next))?;
    Ok(json!({
        "ok": true,
        "id": saved_id,
        "config": saved_config,
    }))
}

fn detect_codex_auth_mode(config: &Value) -> String {
    let normalized = normalize_codex_config_value(config);
    let auth_payload =
        parse_json_object_from_str(&value_string(normalized.get("AUTH_JSON"))).unwrap_or_default();
    let auth_mode = value_string(auth_payload.get("auth_mode"));
    if !auth_mode.is_empty() {
        return auth_mode;
    }
    if !value_string(normalized.get("OPENAI_API_KEY")).is_empty() {
        return "api_key".to_string();
    }
    String::new()
}

fn build_codex_validation_config(config: &Value) -> Value {
    let mut normalized = normalize_codex_config_value(config);
    normalized.insert("CONFIG_TOML".to_string(), Value::String(String::new()));
    Value::Object(normalized)
}

fn ensure_trailing_newline(text: &str) -> String {
    if text.is_empty() {
        String::new()
    } else if text.ends_with('\n') {
        text.to_string()
    } else {
        format!("{text}\n")
    }
}

fn append_trusted_project_section(config_toml_text: &str, project_path: &str) -> String {
    let trimmed = config_toml_text.trim();
    if project_path.is_empty() {
        return ensure_trailing_newline(trimmed);
    }
    let project_header = format!(
        "[projects.{}]",
        serde_json::to_string(project_path).unwrap_or_else(|_| "\"\"".to_string())
    );
    if trimmed.contains(&project_header) {
        return ensure_trailing_newline(trimmed);
    }
    let project_section = format!("{project_header}\ntrust_level = \"trusted\"");
    let merged = if trimmed.is_empty() {
        project_section
    } else {
        format!("{trimmed}\n\n{project_section}")
    };
    ensure_trailing_newline(&merged)
}

fn build_codex_config_toml(config: &Value, project_path: &str) -> String {
    let normalized = normalize_codex_config_value(config);
    let config_toml = value_string(normalized.get("CONFIG_TOML"));
    if !config_toml.is_empty() {
        return append_trusted_project_section(&config_toml, project_path);
    }

    let mut lines = Vec::new();
    let base_url = value_string(normalized.get("BASE_URL"));
    let model = value_string(normalized.get("MODEL"));
    let reasoning_effort = value_string(normalized.get("REASONING_EFFORT"));
    if !base_url.is_empty() {
        lines.push("model_provider = \"custom\"".to_string());
    }
    if !model.is_empty() {
        lines.push(format!(
            "model = {}",
            serde_json::to_string(&model).unwrap_or_else(|_| "\"\"".to_string())
        ));
    }
    if !reasoning_effort.is_empty() {
        lines.push(format!(
            "model_reasoning_effort = {}",
            serde_json::to_string(&reasoning_effort).unwrap_or_else(|_| "\"\"".to_string())
        ));
    }
    if !base_url.is_empty() {
        if !lines.is_empty() {
            lines.push(String::new());
        }
        lines.push("[model_providers]".to_string());
        lines.push(String::new());
        lines.push("[model_providers.custom]".to_string());
        lines.push("name = \"custom\"".to_string());
        lines.push("wire_api = \"responses\"".to_string());
        lines.push("requires_openai_auth = true".to_string());
        lines.push(format!(
            "base_url = {}",
            serde_json::to_string(&base_url).unwrap_or_else(|_| "\"\"".to_string())
        ));
    }
    if !project_path.is_empty() {
        if !lines.is_empty() {
            lines.push(String::new());
        }
        lines.push(format!(
            "[projects.{}]",
            serde_json::to_string(project_path).unwrap_or_else(|_| "\"\"".to_string())
        ));
        lines.push("trust_level = \"trusted\"".to_string());
    }

    ensure_trailing_newline(&lines.join("\n"))
}

fn materialize_codex_home(
    config: &Value,
    home_dir: &Path,
    project_path: &Path,
) -> Result<(), ServiceRouteError> {
    let codex_dir = home_dir.join(".codex");
    stdfs::create_dir_all(home_dir).map_err(|error| {
        ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
    })?;
    let _ = stdfs::remove_dir_all(&codex_dir);
    stdfs::create_dir_all(&codex_dir).map_err(|error| {
        ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
    })?;

    let normalized = normalize_codex_config_value(config);
    let config_toml = build_codex_config_toml(
        &Value::Object(normalized.clone()),
        &path_to_string(project_path),
    );
    stdfs::write(codex_dir.join("config.toml"), config_toml).map_err(|error| {
        ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
    })?;

    let auth_json = value_string(normalized.get("AUTH_JSON"));
    let openai_api_key = value_string(normalized.get("OPENAI_API_KEY"));
    let auth_file = codex_dir.join("auth.json");
    if !auth_json.is_empty() {
        stdfs::write(auth_file, ensure_trailing_newline(&auth_json)).map_err(|error| {
            ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
        })?;
    } else if !openai_api_key.is_empty() {
        let content = serde_json::to_string_pretty(&json!({ "OPENAI_API_KEY": openai_api_key }))
            .unwrap_or_else(|_| "{}".to_string());
        stdfs::write(auth_file, format!("{content}\n")).map_err(|error| {
            ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
        })?;
    } else {
        let _ = stdfs::remove_file(auth_file);
    }
    Ok(())
}

enum CommandRunError {
    Timeout,
    Io(String),
}

struct CommandRunResult {
    status: i32,
    stdout: String,
    stderr: String,
}

fn resolve_codex_executable() -> String {
    match std::process::Command::new("bash")
        .args(["-lc", "which -a codex | tail -1"])
        .output()
    {
        Ok(output) if output.status.success() => {
            let executable = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if executable.is_empty() {
                "codex".to_string()
            } else {
                executable
            }
        }
        _ => "codex".to_string(),
    }
}

async fn run_command_with_timeout(
    executable: &str,
    args: &[String],
    home_dir: &Path,
    proxy_vars: &[(String, String)],
    timeout_ms: u64,
) -> Result<CommandRunResult, CommandRunError> {
    let mut command = Command::new(executable);
    command.args(args);
    command.env("HOME", home_dir);
    command.env_remove("HOST");
    for (key, value) in proxy_vars {
        command.env(key, value);
    }
    let output = timeout(Duration::from_millis(timeout_ms), command.output())
        .await
        .map_err(|_| CommandRunError::Timeout)?
        .map_err(|error| CommandRunError::Io(error.to_string()))?;

    Ok(CommandRunResult {
        status: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

fn summarize_command_success(result: &CommandRunResult) -> String {
    let stdout = result.stdout.trim();
    let stderr = result.stderr.trim();
    if !stdout.is_empty() {
        stdout.to_string()
    } else if !stderr.is_empty() {
        stderr.to_string()
    } else {
        "OK".to_string()
    }
}

fn summarize_command_failure(result: &CommandRunResult) -> String {
    let stderr = result.stderr.trim();
    let stdout = result.stdout.trim();
    let source = if !stderr.is_empty() { stderr } else { stdout };
    let lines = source.lines().collect::<Vec<_>>();
    if !lines.is_empty() {
        let start = lines.len().saturating_sub(8);
        lines[start..].join("\n")
    } else {
        format!("codex exited with status {}", result.status)
    }
}

fn codex_timeout_message(step: &str, timeout_ms: u64) -> String {
    format!("codex {step} timed out after {}s", timeout_ms / 1000)
}

fn unique_validation_home(codex_validate_dir: &Path) -> Result<PathBuf, ServiceRouteError> {
    stdfs::create_dir_all(codex_validate_dir).map_err(|error| {
        ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
    })?;
    let pid = std::process::id();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let path = codex_validate_dir.join(format!("validate-{pid}-{nanos}"));
    stdfs::create_dir_all(&path).map_err(|error| {
        ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
    })?;
    Ok(path)
}

async fn validate_codex_config_route(
    configs_dir: &Path,
    codex_validate_dir: &Path,
    project_path: &Path,
    id: &str,
    proxy_vars: &[(String, String)],
) -> Result<Value, ServiceRouteError> {
    let config = read_codex_config(configs_dir, id).ok_or_else(|| {
        ServiceRouteError::from_message(StatusCode::NOT_FOUND, "config not found")
    })?;
    let temp_home = unique_validation_home(codex_validate_dir)?;
    let output_file = temp_home.join("last-message.txt");
    let executable = resolve_codex_executable();

    let validation_result = async {
        let validation_config = build_codex_validation_config(&config);
        let auth_mode = detect_codex_auth_mode(&validation_config);
        let normalized = normalize_codex_config_value(&validation_config);
        let requires_exec_validation = auth_mode != "chatgpt"
            || !value_string(normalized.get("OPENAI_API_KEY")).is_empty()
            || !value_string(normalized.get("BASE_URL")).is_empty();

        materialize_codex_home(&validation_config, &temp_home, project_path)?;

        let login_status = run_command_with_timeout(
            &executable,
            &["login".to_string(), "status".to_string()],
            &temp_home,
            proxy_vars,
            CODEX_LOGIN_STATUS_TIMEOUT_MS,
        )
        .await
        .map_err(|error| match error {
            CommandRunError::Timeout => ServiceRouteError {
                status_code: StatusCode::GATEWAY_TIMEOUT,
                body: json!({
                    "ok": false,
                    "error": codex_timeout_message("login status", CODEX_LOGIN_STATUS_TIMEOUT_MS),
                }),
            },
            CommandRunError::Io(message) => ServiceRouteError {
                status_code: StatusCode::INTERNAL_SERVER_ERROR,
                body: json!({
                    "ok": false,
                    "error": message,
                }),
            },
        })?;

        if login_status.status != 0 {
            return Err(ServiceRouteError {
                status_code: StatusCode::BAD_REQUEST,
                body: json!({
                    "ok": false,
                    "error": summarize_command_failure(&login_status),
                }),
            });
        }

        let login_message = summarize_command_success(&login_status);
        if !requires_exec_validation {
            return Ok(json!({
                "ok": true,
                "message": if login_message.is_empty() {
                    "Logged in using ChatGPT".to_string()
                } else {
                    login_message
                },
            }));
        }

        let exec_args = vec![
            "exec".to_string(),
            "--skip-git-repo-check".to_string(),
            "--ephemeral".to_string(),
            "--dangerously-bypass-approvals-and-sandbox".to_string(),
            "--color".to_string(),
            "never".to_string(),
            "-C".to_string(),
            path_to_string(project_path),
            "-o".to_string(),
            path_to_string(&output_file),
            "Reply with EXACTLY: OK".to_string(),
        ];
        let exec_result = run_command_with_timeout(
            &executable,
            &exec_args,
            &temp_home,
            proxy_vars,
            CODEX_EXEC_VALIDATE_TIMEOUT_MS,
        )
        .await
        .map_err(|error| match error {
            CommandRunError::Timeout => ServiceRouteError {
                status_code: StatusCode::GATEWAY_TIMEOUT,
                body: json!({
                    "ok": false,
                    "error": codex_timeout_message("exec validation", CODEX_EXEC_VALIDATE_TIMEOUT_MS),
                }),
            },
            CommandRunError::Io(message) => ServiceRouteError {
                status_code: StatusCode::INTERNAL_SERVER_ERROR,
                body: json!({
                    "ok": false,
                    "error": message,
                }),
            },
        })?;

        if exec_result.status != 0 {
            return Err(ServiceRouteError {
                status_code: StatusCode::BAD_REQUEST,
                body: json!({
                    "ok": false,
                    "error": summarize_command_failure(&exec_result),
                }),
            });
        }

        let message = stdfs::read_to_string(&output_file)
            .unwrap_or_else(|_| "OK".to_string())
            .trim()
            .to_string();
        Ok(json!({
            "ok": true,
            "message": if message.is_empty() { "OK".to_string() } else { message },
        }))
    }
    .await;

    let _ = stdfs::remove_dir_all(&temp_home);
    validation_result
}

fn delete_codex_config_route(configs_dir: &Path, id: &str) -> Result<Value, ServiceRouteError> {
    let sanitized_id = sanitize_profile_id(id);
    if sanitized_id.is_empty() {
        return Err(ServiceRouteError::from_message(
            StatusCode::BAD_REQUEST,
            "invalid id",
        ));
    }
    let file_path = configs_dir.join(format!("{sanitized_id}.json"));
    if file_path.exists() {
        stdfs::remove_file(file_path).map_err(|error| {
            ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
        })?;
    }
    Ok(json!({ "ok": true }))
}

#[derive(Clone)]
struct CcSwitchProviderRow {
    id: String,
    app_type: String,
    name: String,
    settings_config: String,
    is_current: bool,
}

fn ensure_cc_switch_kind(kind: &str) -> Result<(), ServiceRouteError> {
    if kind == "claude" || kind == "codex" {
        Ok(())
    } else {
        Err(ServiceRouteError::from_message(
            StatusCode::BAD_REQUEST,
            "invalid kind",
        ))
    }
}

fn resolve_cc_switch_db_path() -> Option<PathBuf> {
    let home_dir = env::var("HOME").ok()?;
    Some(Path::new(&home_dir).join(".cc-switch").join("cc-switch.db"))
}

fn open_cc_switch_db() -> Result<Option<Connection>, ServiceRouteError> {
    let Some(db_path) = resolve_cc_switch_db_path() else {
        return Ok(None);
    };
    if !db_path.exists() {
        return Ok(None);
    }
    Connection::open(db_path).map(Some).map_err(|error| {
        ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
    })
}

fn load_cc_switch_provider_rows(
    connection: &Connection,
    kind: &str,
) -> Result<Vec<CcSwitchProviderRow>, ServiceRouteError> {
    let mut statement = connection
        .prepare(
            "
            SELECT id, app_type, name, settings_config, is_current
            FROM providers
            WHERE app_type = ?
            ORDER BY is_current DESC, name ASC, id ASC
            ",
        )
        .map_err(|error| {
            ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
        })?;
    let rows = statement
        .query_map([kind], |row| {
            Ok(CcSwitchProviderRow {
                id: row.get::<_, String>(0)?,
                app_type: row.get::<_, String>(1)?,
                name: row.get::<_, String>(2)?,
                settings_config: row.get::<_, String>(3)?,
                is_current: row.get::<_, bool>(4)?,
            })
        })
        .map_err(|error| {
            ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
        })?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|error| {
        ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
    })
}

fn load_cc_switch_provider_row(
    connection: &Connection,
    kind: &str,
    provider_id: &str,
) -> Result<Option<CcSwitchProviderRow>, ServiceRouteError> {
    let mut statement = connection
        .prepare(
            "
            SELECT id, app_type, name, settings_config, is_current
            FROM providers
            WHERE app_type = ? AND id = ?
            LIMIT 1
            ",
        )
        .map_err(|error| {
            ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
        })?;
    let mut rows = statement.query([kind, provider_id]).map_err(|error| {
        ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
    })?;
    match rows.next().map_err(|error| {
        ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
    })? {
        Some(row) => Ok(Some(CcSwitchProviderRow {
            id: row.get::<_, String>(0).map_err(|error| {
                ServiceRouteError::from_message(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &error.to_string(),
                )
            })?,
            app_type: row.get::<_, String>(1).map_err(|error| {
                ServiceRouteError::from_message(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &error.to_string(),
                )
            })?,
            name: row.get::<_, String>(2).map_err(|error| {
                ServiceRouteError::from_message(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &error.to_string(),
                )
            })?,
            settings_config: row.get::<_, String>(3).map_err(|error| {
                ServiceRouteError::from_message(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &error.to_string(),
                )
            })?,
            is_current: row.get::<_, bool>(4).map_err(|error| {
                ServiceRouteError::from_message(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &error.to_string(),
                )
            })?,
        })),
        None => Ok(None),
    }
}

fn existing_profile_match(existing_profiles: &[Value], provider_id: &str) -> Option<String> {
    existing_profiles
        .iter()
        .find(|profile| {
            let profile_object = object_value(profile);
            value_string(profile_object.get("SYNC_SOURCE")) == CC_SWITCH_SYNC_SOURCE
                && value_string(profile_object.get("SYNC_SOURCE_ID")) == provider_id
        })
        .and_then(|profile| {
            let profile_object = object_value(profile);
            profile_object
                .get("id")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
}

fn resolve_cc_switch_target_profile_id(
    existing_profiles: &[Value],
    provider_id: &str,
    provider_name: &str,
) -> String {
    if let Some(existing_id) = existing_profile_match(existing_profiles, provider_id) {
        return existing_id;
    }

    let base = sanitize_profile_id(&format!(
        "cc-switch-{}",
        if provider_name.is_empty() {
            provider_id
        } else {
            provider_name
        }
    ));
    let base = if base.is_empty() {
        "cc-switch-provider".to_string()
    } else {
        base
    };
    let existing_ids = existing_profiles
        .iter()
        .filter_map(|profile| {
            let profile_object = object_value(profile);
            profile_object
                .get("id")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .collect::<Vec<_>>();
    let mut next_id = base.clone();
    let mut counter = 1;
    while existing_ids
        .iter()
        .any(|existing_id| existing_id == &next_id)
    {
        next_id = format!("{base}-{counter}");
        counter += 1;
    }
    next_id
}

fn summarize_claude_provider(row: &CcSwitchProviderRow) -> (String, String, String) {
    let settings = parse_json_object_from_str(&row.settings_config).unwrap_or_default();
    let env_payload = settings
        .get("env")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let model = {
        let sonnet = value_string(env_payload.get("ANTHROPIC_DEFAULT_SONNET_MODEL"));
        if sonnet.is_empty() {
            value_string(env_payload.get("ANTHROPIC_MODEL"))
        } else {
            sonnet
        }
    };
    let base_url = value_string(env_payload.get("ANTHROPIC_BASE_URL"));
    let auth_mode = if !value_string(env_payload.get("ANTHROPIC_AUTH_TOKEN")).is_empty() {
        "auth_token".to_string()
    } else if !value_string(env_payload.get("ANTHROPIC_API_KEY")).is_empty() {
        "api_key".to_string()
    } else {
        String::new()
    };
    (model, base_url, auth_mode)
}

fn summarize_codex_provider(row: &CcSwitchProviderRow) -> (String, String, String) {
    let settings = parse_json_object_from_str(&row.settings_config).unwrap_or_default();
    let auth_payload = settings
        .get("auth")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let parsed_toml = parse_simple_toml(&value_string(settings.get("config")));
    let provider_name = parsed_toml
        .root
        .get("model_provider")
        .cloned()
        .unwrap_or_default();
    let provider_section = parsed_toml
        .sections
        .get(&format!("model_providers.{provider_name}"))
        .cloned()
        .unwrap_or_default();
    let auth_mode = {
        let explicit = value_string(auth_payload.get("auth_mode"));
        if !explicit.is_empty() {
            explicit
        } else if !value_string(auth_payload.get("OPENAI_API_KEY")).is_empty() {
            "api_key".to_string()
        } else {
            String::new()
        }
    };
    (
        parsed_toml.root.get("model").cloned().unwrap_or_default(),
        provider_section
            .get("base_url")
            .cloned()
            .unwrap_or_default(),
        auth_mode,
    )
}

fn import_cc_switch_provider_value(row: &CcSwitchProviderRow) -> Value {
    let settings = parse_json_object_from_str(&row.settings_config).unwrap_or_default();
    let env_payload = settings
        .get("env")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let claude_default_model = {
        let sonnet = value_string(env_payload.get("ANTHROPIC_DEFAULT_SONNET_MODEL"));
        if sonnet.is_empty() {
            value_string(env_payload.get("ANTHROPIC_MODEL"))
        } else {
            sonnet
        }
    };
    let claude_think_model = {
        let opus = value_string(env_payload.get("ANTHROPIC_DEFAULT_OPUS_MODEL"));
        if opus.is_empty() {
            value_string(env_payload.get("ANTHROPIC_THINK_MODEL"))
        } else {
            opus
        }
    };
    let claude_timeout = {
        let value = value_string(env_payload.get("API_TIMEOUT_MS"));
        if value.is_empty() {
            "3000000".to_string()
        } else {
            value
        }
    };
    let mut imported = if row.app_type == "claude" {
        object_value(&json!({
            "label": "Imported from ~/.claude/settings.json",
            "BASE_URL": value_string(env_payload.get("ANTHROPIC_BASE_URL")),
            "AUTH_TOKEN": value_string(env_payload.get("ANTHROPIC_AUTH_TOKEN")),
            "API_KEY": value_string(env_payload.get("ANTHROPIC_API_KEY")),
            "DEFAULT_MODEL": claude_default_model,
            "THINK_MODEL": claude_think_model,
            "LONG_CONTEXT_MODEL": value_string(env_payload.get("ANTHROPIC_LONG_CONTEXT_MODEL")),
            "DEFAULT_HAIKU_MODEL": value_string(env_payload.get("ANTHROPIC_DEFAULT_HAIKU_MODEL")),
            "API_TIMEOUT_MS": claude_timeout,
        }))
    } else {
        object_value(&import_codex_config_from_global(
            &value_string(settings.get("config")),
            &serde_json::to_string_pretty(
                &settings.get("auth").cloned().unwrap_or_else(|| json!({})),
            )
            .unwrap_or_else(|_| "{}".to_string()),
        ))
    };
    imported.insert(
        "label".to_string(),
        Value::String(if row.name.trim().is_empty() {
            row.id.clone()
        } else {
            row.name.trim().to_string()
        }),
    );
    imported.insert(
        "SYNC_SOURCE".to_string(),
        Value::String(CC_SWITCH_SYNC_SOURCE.to_string()),
    );
    imported.insert("SYNC_SOURCE_ID".to_string(), Value::String(row.id.clone()));
    imported.insert(
        "SYNC_SOURCE_NAME".to_string(),
        Value::String(row.name.trim().to_string()),
    );
    Value::Object(imported)
}

fn list_cc_switch_providers_route(
    configs_dir: &Path,
    codex_configs_dir: &Path,
    kind: &str,
) -> Result<Value, ServiceRouteError> {
    ensure_cc_switch_kind(kind)?;
    let existing_profiles = if kind == "claude" {
        match list_claude_configs(configs_dir) {
            Value::Array(items) => items,
            _ => Vec::new(),
        }
    } else {
        match list_codex_configs(codex_configs_dir) {
            Value::Array(items) => items,
            _ => Vec::new(),
        }
    };
    let Some(connection) = open_cc_switch_db()? else {
        return Ok(Value::Array(Vec::new()));
    };
    let rows = load_cc_switch_provider_rows(&connection, kind)?;
    let providers = rows
        .into_iter()
        .map(|row| {
            let (model, base_url, auth_mode) = if kind == "claude" {
                summarize_claude_provider(&row)
            } else {
                summarize_codex_provider(&row)
            };
            let existing_profile_id = existing_profile_match(&existing_profiles, &row.id);
            let target_profile_id =
                resolve_cc_switch_target_profile_id(&existing_profiles, &row.id, &row.name);
            json!({
                "provider_id": row.id,
                "kind": kind,
                "name": if row.name.trim().is_empty() { row.id } else { row.name },
                "is_current": row.is_current,
                "model": model,
                "base_url": base_url,
                "auth_mode": auth_mode,
                "existing_profile_id": existing_profile_id,
                "target_profile_id": target_profile_id,
            })
        })
        .collect::<Vec<_>>();
    Ok(Value::Array(providers))
}

fn import_cc_switch_provider_route(
    configs_dir: &Path,
    codex_configs_dir: &Path,
    kind: &str,
    provider_id: &str,
) -> Result<Value, ServiceRouteError> {
    ensure_cc_switch_kind(kind)?;
    let existing_profiles = if kind == "claude" {
        match list_claude_configs(configs_dir) {
            Value::Array(items) => items,
            _ => Vec::new(),
        }
    } else {
        match list_codex_configs(codex_configs_dir) {
            Value::Array(items) => items,
            _ => Vec::new(),
        }
    };
    let Some(connection) = open_cc_switch_db()? else {
        return Err(ServiceRouteError::from_message(
            StatusCode::NOT_FOUND,
            "provider not found",
        ));
    };
    let row = load_cc_switch_provider_row(&connection, kind, provider_id)?.ok_or_else(|| {
        ServiceRouteError::from_message(StatusCode::NOT_FOUND, "provider not found")
    })?;
    let imported = import_cc_switch_provider_value(&row);
    let target_id = resolve_cc_switch_target_profile_id(&existing_profiles, &row.id, &row.name);

    if kind == "claude" {
        let (saved_id, saved_config) =
            save_stored_claude_config(configs_dir, &target_id, imported)?;
        Ok(json!({
            "ok": true,
            "id": saved_id,
            "config": saved_config,
        }))
    } else {
        let (saved_id, saved_config) =
            save_codex_config_with_metadata(codex_configs_dir, &target_id, imported)?;
        Ok(json!({
            "ok": true,
            "id": saved_id,
            "config": saved_config,
        }))
    }
}

async fn static_fallback(State(state): State<Arc<AppState>>, method: Method, uri: Uri) -> Response {
    if uri.path().starts_with("/api/") {
        return StatusCode::NOT_FOUND.into_response();
    }

    if method != Method::GET && method != Method::HEAD {
        return StatusCode::NOT_FOUND.into_response();
    }

    if uri.path() == "/" {
        return serve_index(&state).await;
    }

    if let Some(path) = state.find_static_file(uri.path()) {
        return serve_file(path).await;
    }

    serve_index(&state).await
}

struct UploadMultipartPayload {
    session_name: Option<String>,
    original_name: Option<String>,
    file: Option<UploadMultipartFile>,
}

struct UploadMultipartFile {
    original_name: String,
    bytes: Vec<u8>,
    size: usize,
}

struct ServiceRouteError {
    status_code: StatusCode,
    body: Value,
}

impl ServiceRouteError {
    fn from_message(status_code: StatusCode, message: &str) -> Self {
        Self {
            status_code,
            body: json!({ "error": message }),
        }
    }
}

async fn current_version_payload(project_root: &Path) -> Value {
    let describe_output = Command::new("git")
        .args(["describe", "--tags", "--abbrev=0"])
        .current_dir(project_root)
        .output()
        .await;
    let Ok(describe_output) = describe_output else {
        return json!({ "current": "unknown", "clean": true });
    };
    if !describe_output.status.success() {
        return json!({ "current": "unknown", "clean": true });
    }

    let status_output = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(project_root)
        .output()
        .await;
    let Ok(status_output) = status_output else {
        return json!({ "current": "unknown", "clean": true });
    };
    if !status_output.status.success() {
        return json!({ "current": "unknown", "clean": true });
    }

    json!({
        "current": String::from_utf8_lossy(&describe_output.stdout).trim().to_string(),
        "clean": String::from_utf8_lossy(&status_output.stdout).trim().is_empty(),
    })
}

async fn fetch_latest_version_payload(github_repo: &str) -> Result<Value, ServiceRouteError> {
    let remote = version_remote_ref(github_repo);
    let output = Command::new("git")
        .args([
            "ls-remote",
            "--refs",
            "--tags",
            "--sort=-version:refname",
            &remote,
        ])
        .output()
        .await
        .map_err(|_| {
            ServiceRouteError::from_message(StatusCode::BAD_GATEWAY, "cannot reach GitHub")
        })?;

    if !output.status.success() {
        return Err(ServiceRouteError::from_message(
            StatusCode::BAD_GATEWAY,
            "cannot reach GitHub",
        ));
    }

    let latest = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.split('\t').nth(1))
        .filter_map(|reference| reference.strip_prefix("refs/tags/"))
        .map(str::trim)
        .find(|tag| !tag.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| ServiceRouteError::from_message(StatusCode::BAD_GATEWAY, "no tags found"))?;

    Ok(json!({
        "latest": latest,
        "url": version_release_url(github_repo, &latest),
    }))
}

fn version_remote_ref(github_repo: &str) -> String {
    if looks_like_github_repo_slug(github_repo) {
        format!("https://github.com/{github_repo}.git")
    } else {
        github_repo.to_string()
    }
}

fn version_release_url(github_repo: &str, tag: &str) -> String {
    if looks_like_github_repo_slug(github_repo) {
        format!("https://github.com/{github_repo}/releases/tag/{tag}")
    } else {
        format!("{github_repo}#{tag}")
    }
}

fn looks_like_github_repo_slug(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('/')
        && !value.starts_with('.')
        && !value.contains("://")
        && value.matches('/').count() == 1
}

async fn parse_upload_multipart(
    mut multipart: Multipart,
) -> Result<UploadMultipartPayload, Response> {
    let mut payload = UploadMultipartPayload {
        session_name: None,
        original_name: None,
        file: None,
    };

    loop {
        let next_field = multipart.next_field().await;
        let field = match next_field {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(error) => return Err(json_error(StatusCode::BAD_REQUEST, &error.to_string())),
        };

        let field_name = field.name().unwrap_or_default().to_string();
        match field_name.as_str() {
            "session_name" => {
                let value = match field.text().await {
                    Ok(value) => value,
                    Err(error) => {
                        return Err(json_error(StatusCode::BAD_REQUEST, &error.to_string()));
                    }
                };
                payload.session_name = Some(value);
            }
            "originalName" => {
                let value = match field.text().await {
                    Ok(value) => value,
                    Err(error) => {
                        return Err(json_error(StatusCode::BAD_REQUEST, &error.to_string()));
                    }
                };
                payload.original_name = Some(value);
            }
            "file" => {
                let original_name = field.file_name().unwrap_or("upload.bin").to_string();
                let bytes = match field.bytes().await {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        return Err(json_error(StatusCode::BAD_REQUEST, &error.to_string()));
                    }
                };
                payload.file = Some(UploadMultipartFile {
                    original_name,
                    size: bytes.len(),
                    bytes: bytes.to_vec(),
                });
            }
            _ => {
                if let Err(error) = field.bytes().await {
                    return Err(json_error(StatusCode::BAD_REQUEST, &error.to_string()));
                }
            }
        }
    }

    Ok(payload)
}

async fn resolve_workspace_upload_destination(
    state: &AppState,
    session_name: Option<&str>,
) -> String {
    let workspace_root = state.workspace_root.as_ref().clone();
    let session_name = session_name.unwrap_or_default().trim().to_string();
    let runtime_result = state
        .runtime_manager
        .session_management_request(
            "listProjectChannels",
            json!({ "projectName": state.default_tmux_session.as_ref() }),
        )
        .await;

    let candidate = match runtime_result {
        Ok(Value::Object(payload)) => payload
            .get("channels")
            .and_then(Value::as_array)
            .and_then(|channels| {
                if !session_name.is_empty() {
                    channels.iter().find_map(|channel| {
                        let name = channel.get("name").and_then(Value::as_str)?;
                        if name != session_name {
                            return None;
                        }
                        channel
                            .get("cwd")
                            .and_then(Value::as_str)
                            .map(ToString::to_string)
                    })
                } else {
                    channels.iter().find_map(|channel| {
                        if channel.get("active").and_then(Value::as_bool) != Some(true) {
                            return None;
                        }
                        channel
                            .get("cwd")
                            .and_then(Value::as_str)
                            .map(ToString::to_string)
                    })
                }
            })
            .unwrap_or_else(|| workspace_root.clone()),
        _ => workspace_root.clone(),
    };

    if Path::new(&candidate).is_dir() {
        candidate
    } else {
        workspace_root
    }
}

async fn save_managed_upload_file(
    uploads_dir: &Path,
    file_buffer: &[u8],
    original_name: &str,
    preferred_name: Option<&str>,
    size: usize,
    overwrite: bool,
) -> Result<Value, ServiceRouteError> {
    let date_dir = Utc::now().format("%Y-%m-%d").to_string();
    let upload_dir = uploads_dir.join(&date_dir);
    fs::create_dir_all(&upload_dir).await.map_err(|error| {
        ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
    })?;

    let resolved_original_name = preferred_name.unwrap_or(original_name);
    let safe_name = sanitize_managed_upload_filename(resolved_original_name);
    let file_path = upload_dir.join(&safe_name);

    if !overwrite && file_path.is_file() {
        return Err(ServiceRouteError {
            status_code: StatusCode::CONFLICT,
            body: json!({
                "error": "file exists",
                "filename": safe_name,
                "message": format!("文件 \"{}\" 已存在", safe_name),
            }),
        });
    }

    fs::write(&file_path, file_buffer).await.map_err(|error| {
        ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
    })?;

    Ok(json!({
        "ok": true,
        "filename": safe_name,
        "url": format!("/uploads/{date_dir}/{}", safe_name),
        "fullPath": file_path.to_string_lossy().to_string(),
        "size": size,
        "originalName": resolved_original_name,
    }))
}

async fn list_managed_files(uploads_dir: &Path) -> Result<Value, ServiceRouteError> {
    let mut date_dirs = Vec::new();
    let mut root_entries = fs::read_dir(uploads_dir).await.map_err(|error| {
        ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
    })?;

    while let Some(entry) = root_entries.next_entry().await.map_err(|error| {
        ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
    })? {
        let file_type = entry.file_type().await.map_err(|error| {
            ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
        })?;
        if file_type.is_dir() {
            date_dirs.push(entry.file_name().to_string_lossy().to_string());
        }
    }
    date_dirs.sort_by(|left, right| right.cmp(left));

    let mut groups = Vec::new();
    for date_dir in date_dirs {
        let dir_path = uploads_dir.join(&date_dir);
        let mut file_entries = fs::read_dir(&dir_path).await.map_err(|error| {
            ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
        })?;
        let mut files = Vec::new();

        while let Some(entry) = file_entries.next_entry().await.map_err(|error| {
            ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
        })? {
            let file_type = entry.file_type().await.map_err(|error| {
                ServiceRouteError::from_message(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &error.to_string(),
                )
            })?;
            if !file_type.is_file() {
                continue;
            }

            let full_path = dir_path.join(entry.file_name());
            let metadata = entry.metadata().await.map_err(|error| {
                ServiceRouteError::from_message(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &error.to_string(),
                )
            })?;
            let modified = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or(0);

            files.push(json!({
                "name": entry.file_name().to_string_lossy().to_string(),
                "url": format!("/uploads/{date_dir}/{}", entry.file_name().to_string_lossy()),
                "fullPath": full_path.to_string_lossy().to_string(),
                "size": metadata.len(),
                "created": modified,
            }));
        }

        files.sort_by(|left, right| {
            right
                .get("created")
                .and_then(Value::as_u64)
                .cmp(&left.get("created").and_then(Value::as_u64))
        });
        if !files.is_empty() {
            groups.push(json!({
                "date": date_dir,
                "files": files,
            }));
        }
    }

    Ok(Value::Array(groups))
}

async fn delete_managed_file(
    uploads_dir: &Path,
    date: &str,
    filename: &str,
) -> Result<Value, ServiceRouteError> {
    let safe_date: String = date
        .chars()
        .filter(|character| character.is_ascii_digit() || *character == '-')
        .collect();
    let safe_filename = sanitize_workspace_upload_filename(filename);
    let file_path = uploads_dir.join(&safe_date).join(&safe_filename);

    if !file_path.starts_with(uploads_dir) {
        return Err(ServiceRouteError::from_message(
            StatusCode::BAD_REQUEST,
            "invalid path",
        ));
    }
    if !file_path.is_file() {
        return Err(ServiceRouteError::from_message(
            StatusCode::NOT_FOUND,
            "file not found",
        ));
    }

    fs::remove_file(&file_path).await.map_err(|error| {
        ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
    })?;
    Ok(json!({ "ok": true }))
}

async fn delete_all_managed_files(uploads_dir: &Path) -> Result<Value, ServiceRouteError> {
    let mut root_entries = fs::read_dir(uploads_dir).await.map_err(|error| {
        ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
    })?;
    let mut deleted_count = 0_u64;

    while let Some(entry) = root_entries.next_entry().await.map_err(|error| {
        ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
    })? {
        let file_type = entry.file_type().await.map_err(|error| {
            ServiceRouteError::from_message(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
        })?;
        if !file_type.is_dir() {
            continue;
        }

        let dir_path = entry.path();
        let mut files = match fs::read_dir(&dir_path).await {
            Ok(files) => files,
            Err(_) => continue,
        };

        while let Ok(Some(file)) = files.next_entry().await {
            let file_type = match file.file_type().await {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };
            if !file_type.is_file() {
                continue;
            }
            if fs::remove_file(file.path()).await.is_ok() {
                deleted_count += 1;
            }
        }

        let _ = fs::remove_dir(&dir_path).await;
    }

    Ok(json!({
        "ok": true,
        "deletedCount": deleted_count,
    }))
}

async fn handle_pty_websocket(mut socket: WebSocket, state: Arc<AppState>, query: WsQuery) {
    let token = query.token.unwrap_or_default();
    if token.is_empty() || !validate_auth_token::<AuthClaims>(&token, state.jwt_secret.as_ref()) {
        let _ = send_websocket_close(&mut socket, 4001, "unauthorized").await;
        return;
    }

    let session_name = query
        .session
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| state.default_tmux_session.as_ref().clone());
    let window_index = query
        .window
        .as_deref()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0);
    let Some(mut event_receiver) = state.runtime_manager.pty_broker_subscribe_events().await else {
        let _ = send_websocket_close(
            &mut socket,
            4004,
            "pty broker runtime executable not configured",
        )
        .await;
        return;
    };
    let connection_id = format!(
        "broker_conn_{}",
        state.ws_connection_counter.fetch_add(1, Ordering::SeqCst) + 1
    );

    let key = match state
        .runtime_manager
        .pty_broker_request(
            "attachConnection",
            json!({
                "connectionId": connection_id.clone(),
                "session": session_name,
                "windowIndex": window_index,
            }),
        )
        .await
    {
        Ok(Value::Object(payload)) => match payload.get("key").and_then(Value::as_str) {
            Some(key) if !key.is_empty() => key.to_string(),
            _ => {
                let _ =
                    send_websocket_close(&mut socket, 4004, "attach connection missing key").await;
                return;
            }
        },
        Ok(_) => {
            let _ = send_websocket_close(&mut socket, 4004, "attach connection failed").await;
            return;
        }
        Err(error) => {
            let _ = send_websocket_close(&mut socket, 4004, &error).await;
            return;
        }
    };

    let mut disconnect_notify: Option<&'static str> = None;

    loop {
        tokio::select! {
            maybe_message = socket.recv() => {
                match maybe_message {
                    Some(Ok(Message::Text(text))) => {
                        if let Err(error) = state.runtime_manager.pty_broker_notify(
                            "handleConnectionMessage",
                            json!({
                                "connectionId": connection_id.clone(),
                                "key": key.clone(),
                                "rawMessage": text.to_string(),
                            }),
                        ).await {
                            disconnect_notify = Some("errorConnection");
                            let _ = send_websocket_close(&mut socket, 1011, &error).await;
                            break;
                        }
                    }
                    Some(Ok(Message::Binary(data))) => {
                        if let Err(error) = state.runtime_manager.pty_broker_notify(
                            "handleConnectionMessage",
                            json!({
                                "connectionId": connection_id.clone(),
                                "key": key.clone(),
                                "rawMessage": String::from_utf8_lossy(&data).to_string(),
                            }),
                        ).await {
                            disconnect_notify = Some("errorConnection");
                            let _ = send_websocket_close(&mut socket, 1011, &error).await;
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) => {
                        disconnect_notify = Some("closeConnection");
                        break;
                    }
                    Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {}
                    Some(Err(error)) => {
                        eprintln!("WebSocket error: {error}");
                        disconnect_notify = Some("errorConnection");
                        break;
                    }
                    None => {
                        disconnect_notify = Some("closeConnection");
                        break;
                    }
                }
            }
            runtime_event = event_receiver.recv() => {
                match runtime_event {
                    Ok(event) => match event.event.as_str() {
                        "output" => {
                            if event
                                .params
                                .get("connectionId")
                                .and_then(Value::as_str)
                                != Some(connection_id.as_str())
                            {
                                continue;
                            }

                            let data = event
                                .params
                                .get("data")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string();
                            if socket.send(Message::Text(data.into())).await.is_err() {
                                disconnect_notify = Some("errorConnection");
                                break;
                            }
                        }
                        "fatal" => {
                            let reason = event
                                .params
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("pty broker unavailable");
                            let _ = send_websocket_close(&mut socket, 1011, reason).await;
                            break;
                        }
                        _ => {}
                    },
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => {
                        let _ = send_websocket_close(&mut socket, 1011, "pty broker unavailable")
                            .await;
                        break;
                    }
                }
            }
        }
    }

    if let Some(method) = disconnect_notify {
        let _ = state
            .runtime_manager
            .pty_broker_notify(
                method,
                json!({
                    "connectionId": connection_id.clone(),
                    "key": key.clone(),
                }),
            )
            .await;
    }
}

async fn send_websocket_close(socket: &mut WebSocket, code: u16, reason: &str) -> Result<(), ()> {
    socket
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: truncate_websocket_close_reason(reason).into(),
        })))
        .await
        .map_err(|_| ())
}

fn authorize(headers: &HeaderMap, state: &AppState) -> Result<(), ()> {
    let Some(auth_header) = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    else {
        return Err(());
    };

    let Some(token) = auth_header.strip_prefix("Bearer ") else {
        return Err(());
    };

    validate_auth_token::<AuthClaims>(token, state.jwt_secret.as_ref())
        .then_some(())
        .ok_or(())
}

fn require_auth(headers: &HeaderMap, state: &AppState) -> Option<Response> {
    authorize(headers, state)
        .err()
        .map(|_| json_error(StatusCode::UNAUTHORIZED, "unauthorized"))
}

async fn serve_index(state: &AppState) -> Response {
    let index_path = state.index_path();
    if !index_path.is_file() {
        return (
            StatusCode::NOT_FOUND,
            "Not found - run: cd frontend && npm run build",
        )
            .into_response();
    }

    serve_file(index_path).await
}

async fn serve_file(path: PathBuf) -> Response {
    match fs::read(&path).await {
        Ok(bytes) => {
            let mime = from_path(&path).first_or_octet_stream();
            let mut response = Response::new(Body::from(bytes));
            *response.status_mut() = StatusCode::OK;
            response.headers_mut().insert(
                CONTENT_TYPE,
                HeaderValue::from_str(mime.essence_str())
                    .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
            );
            response
        }
        Err(_) => json_error(StatusCode::NOT_FOUND, "not found"),
    }
}

fn normalize_runtime_status(value: Value) -> Value {
    let mut object = match value {
        Value::Object(object) => object,
        _ => {
            return runtime_error_status("nexus-server", "runtime returned non-object status");
        }
    };

    object.insert("mode".to_string(), Value::String("rust".to_string()));
    object
        .entry("source".to_string())
        .or_insert_with(|| Value::String("nexus-server".to_string()));
    Value::Object(object)
}

fn runtime_request_response(result: Result<Value, String>) -> Response {
    match result {
        Ok(payload) => Json(payload).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

fn runtime_unconfigured_status() -> Value {
    json!({
        "mode": "unconfigured",
        "ready": false,
        "source": "nexus-server",
        "error": "runtime executable not configured",
    })
}

fn runtime_error_status(source: &str, error: &str) -> Value {
    json!({
        "mode": "rust",
        "ready": false,
        "source": source,
        "error": error,
    })
}

fn log_runtime_ready(display_name: &str, status: &Value) {
    let source = status
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let version = status
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    println!("{display_name} runtime ready: {source}@{version}");
}

fn project_from_sources(body: Option<Json<ProjectBody>>, query_project: Option<String>) -> String {
    body.and_then(|Json(payload)| payload.project)
        .or(query_project)
        .unwrap_or_default()
}

async fn launch_window_via_runtime(
    state: &AppState,
    session_name: String,
    cwd: String,
    shell_type: &str,
    response_profile: Option<String>,
    update_session_cwd: bool,
    fallback_name: &str,
) -> Response {
    let window_name = build_window_name(&cwd, fallback_name);
    let shell_cmd = build_interactive_shell_command(
        state.project_root.as_ref(),
        state.proxy_vars.as_ref(),
        DEFAULT_INTERACTIVE_SHELL,
        shell_type,
        response_profile.as_deref(),
        &cwd,
        None,
    );

    match state
        .runtime_manager
        .window_launch_request(
            "launchWindow",
            json!({
                "sessionName": session_name.clone(),
                "cwd": cwd.clone(),
                "name": window_name.clone(),
                "shellCmd": shell_cmd,
                "defaultShellCmd": DEFAULT_INTERACTIVE_SHELL,
                "proxyVars": proxy_vars_json(state),
                "updateSessionCwd": update_session_cwd,
            }),
        )
        .await
    {
        Ok(_) => {}
        Err(error) => {
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, &error);
        }
    }

    if let Err(error) = remember_project_default(
        state.project_defaults_file.as_ref(),
        &cwd,
        shell_type,
        response_profile.as_deref(),
    )
    .await
    {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, &error);
    }

    Json(json!({
        "name": window_name,
        "cwd": cwd,
        "shell_type": shell_type,
        "profile": response_profile,
        "session": session_name,
    }))
    .into_response()
}

fn proxy_vars_json(state: &AppState) -> Value {
    Value::Object(
        state
            .proxy_vars
            .iter()
            .map(|(key, value)| (key.clone(), Value::String(value.clone())))
            .collect(),
    )
}

async fn list_all_session_names_from_runtime(state: &AppState) -> Vec<String> {
    match state
        .runtime_manager
        .session_management_request("listAllSessionNames", json!({}))
        .await
    {
        Ok(Value::Array(items)) => items
            .into_iter()
            .filter_map(|item| item.as_str().map(ToString::to_string))
            .collect(),
        _ => Vec::new(),
    }
}

async fn list_channel_names_from_runtime(state: &AppState, project_name: &str) -> Vec<String> {
    match state
        .runtime_manager
        .session_management_request(
            "listProjectChannels",
            json!({ "projectName": project_name }),
        )
        .await
    {
        Ok(Value::Object(payload)) => payload
            .get("channels")
            .and_then(Value::as_array)
            .map(|channels| {
                channels
                    .iter()
                    .filter_map(|channel| {
                        channel
                            .get("name")
                            .and_then(Value::as_str)
                            .map(ToString::to_string)
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

async fn resolve_session_cwd_from_runtime(state: &AppState, session_name: &str) -> String {
    match state
        .runtime_manager
        .session_management_request("getSessionCwd", json!({ "sessionName": session_name }))
        .await
    {
        Ok(Value::Object(payload)) => payload
            .get("cwd")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
            .unwrap_or_else(|| state.workspace_root.as_ref().clone()),
        _ => state.workspace_root.as_ref().clone(),
    }
}

async fn resolve_task_cwd_from_runtime(
    state: &AppState,
    tmux_session: &str,
    session_name: &str,
) -> String {
    if session_name.trim().is_empty() {
        return state.workspace_root.as_ref().clone();
    }

    match state
        .runtime_manager
        .session_management_request(
            "listProjectChannels",
            json!({ "projectName": tmux_session }),
        )
        .await
    {
        Ok(Value::Object(payload)) => payload
            .get("channels")
            .and_then(Value::as_array)
            .and_then(|channels| {
                channels.iter().find_map(|channel| {
                    let name = channel.get("name").and_then(Value::as_str)?;
                    if name != session_name {
                        return None;
                    }
                    channel
                        .get("cwd")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                        .map(ToString::to_string)
                })
            })
            .unwrap_or_else(|| state.workspace_root.as_ref().clone()),
        _ => state.workspace_root.as_ref().clone(),
    }
}

async fn capture_tmux_scrollback(
    session: &str,
    window_index: u32,
    lines: u32,
) -> Result<String, String> {
    let output = Command::new("tmux")
        .args([
            "capture-pane",
            "-p",
            "-S",
            &format!("-{lines}"),
            "-t",
            &format!("{session}:{window_index}"),
        ])
        .output()
        .await
        .map_err(|error| error.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "tmux capture-pane failed".to_string()
        } else {
            stderr
        });
    }

    let content = String::from_utf8_lossy(&output.stdout)
        .split('\n')
        .map(|line| line.trim_end().to_string())
        .collect::<Vec<_>>()
        .join("\n");
    Ok(content)
}

async fn read_toolbar_config_file(file_path: &Path) -> Value {
    match fs::read_to_string(file_path).await {
        Ok(raw) => serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null),
        Err(_) => Value::Null,
    }
}

async fn write_toolbar_config_file(file_path: &Path, payload: &Value) -> Result<(), String> {
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|error| error.to_string())?;
    }
    let content = serde_json::to_string(payload).map_err(|error| error.to_string())?;
    fs::write(file_path, content)
        .await
        .map_err(|error| error.to_string())
}

fn header_string(headers: &HeaderMap, key: &str) -> Option<String> {
    headers
        .get(key)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn forwarded_header_value(headers: &HeaderMap, key: &str) -> Option<String> {
    header_string(headers, key)
        .map(|value| value.split(',').next().unwrap_or("").trim().to_string())
}

fn json_value_to_string(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Number(number)) => Some(number.to_string()),
        _ => None,
    }
}

fn telegram_progress_message(session_name: &str, preview: Option<&str>) -> String {
    match preview.map(str::trim).filter(|value| !value.is_empty()) {
        Some(preview) => format!("⏳ *执行中*（session: `{session_name}`）\n```\n{preview}\n```"),
        None => format!("⏳ *执行中*（session: `{session_name}`）\n\n_等待输出..._"),
    }
}

fn telegram_done_message(session_name: &str, exit_code: Option<i32>, result: &str) -> String {
    let status = if exit_code == Some(0) { "✅" } else { "❌" };
    format!("{status} *执行完成*（session: `{session_name}`）\n```\n{result}\n```")
}

fn telegram_file_target(message: &TelegramMessage) -> Result<(String, String), String> {
    if let Some(photos) = message.photo.as_ref().filter(|photos| !photos.is_empty()) {
        let Some(photo) = photos.last() else {
            return Err("telegram photo missing".to_string());
        };
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        return Ok((photo.file_id.clone(), format!("tg_photo_{millis}.jpg")));
    }

    if let Some(document) = message.document.as_ref() {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        return Ok((
            document.file_id.clone(),
            document
                .file_name
                .clone()
                .unwrap_or_else(|| format!("tg_file_{millis}")),
        ));
    }

    Err("telegram file missing".to_string())
}

fn require_workspace_auth(
    headers: &HeaderMap,
    query_token: Option<&str>,
    state: &AppState,
) -> Option<Response> {
    if let Some(token) = query_token.filter(|value| !value.is_empty()) {
        if validate_auth_token::<AuthClaims>(token, state.jwt_secret.as_ref()) {
            return None;
        }
        return Some((StatusCode::UNAUTHORIZED, "unauthorized").into_response());
    }

    authorize(headers, state)
        .err()
        .map(|_| (StatusCode::UNAUTHORIZED, "unauthorized").into_response())
}

fn resolve_workspace_input_path(
    workspace_root: &str,
    input_path: Option<&str>,
    allow_empty: bool,
) -> Result<PathBuf, WorkspaceRouteError> {
    let mut resolved = input_path.unwrap_or_default().to_string();
    if !allow_empty && resolved.is_empty() {
        return Err(WorkspaceRouteError::new(
            StatusCode::BAD_REQUEST,
            "path required",
        ));
    }
    if resolved.is_empty() || resolved == "~" {
        resolved = workspace_root.to_string();
    }

    let normalized = if Path::new(&resolved).is_absolute() {
        normalize_path_lexically(Path::new(&resolved))
    } else {
        normalize_path_lexically(&PathBuf::from(workspace_root).join(resolved))
    };
    if path_contains_parent_marker(&normalized) {
        return Err(WorkspaceRouteError::new(
            StatusCode::FORBIDDEN,
            "invalid path",
        ));
    }

    Ok(normalized)
}

async fn resolve_workspace_serve_file_path(
    workspace_root: &str,
    query_path: Option<&str>,
    request_path: &str,
) -> Result<PathBuf, WorkspaceRouteError> {
    let full_path = if let Some(query_path) = query_path.filter(|value| !value.is_empty()) {
        let normalized = normalize_path_lexically(Path::new(query_path));
        if path_contains_parent_marker(&normalized) {
            return Err(WorkspaceRouteError::new(
                StatusCode::FORBIDDEN,
                "access denied: invalid path",
            ));
        }
        normalized
    } else {
        let relative_path =
            strip_leading_parent_components(&normalize_path_lexically(Path::new(request_path)));
        let candidate =
            normalize_path_lexically(&PathBuf::from(workspace_root).join(relative_path));
        if path_contains_parent_marker(&candidate) {
            return Err(WorkspaceRouteError::new(
                StatusCode::FORBIDDEN,
                "access denied: invalid path",
            ));
        }
        candidate
    };

    let metadata = fs::metadata(&full_path)
        .await
        .map_err(|_| WorkspaceRouteError::new(StatusCode::NOT_FOUND, "not found"))?;
    if !metadata.is_file() {
        return Err(WorkspaceRouteError::new(StatusCode::NOT_FOUND, "not found"));
    }

    Ok(full_path)
}

fn spawn_stderr_logger(display_name: &'static str, stderr: ChildStderr) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                eprintln!("{display_name} runtime stderr: {trimmed}");
            }
        }
    });
}

fn to_sse_event(frame: TaskSseFrame) -> SseEvent {
    let payload = serde_json::to_string(&frame.payload).unwrap_or_else(|_| "{}".to_string());
    SseEvent::default().event(frame.event).data(payload)
}

fn iso_timestamp_now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn json_error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

fn json_response(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                let _ = signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}
