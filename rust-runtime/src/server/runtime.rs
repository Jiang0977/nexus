const DEFAULT_INTERACTIVE_SHELL: &str = "unset HOST; exec zsh -i";
const TOKEN_TTL_SECONDS: u64 = 30 * 24 * 60 * 60;
const DEFAULT_TASK_HISTORY_LIMIT: usize = 50;
const DEFAULT_MAX_TASKS: usize = 200;
const MAX_TASK_OUTPUT_LENGTH: usize = 10_000;
const MAX_TASK_ERROR_LENGTH: usize = 1_000;
const MAX_TASK_PROMPT_LENGTH: usize = 1_000;
const OUTPUT_SNAPSHOT_FALLBACK_LINES: u32 = 200;
const OUTPUT_SNAPSHOT_FALLBACK_IDLE_MS: u64 = 4_000;
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
            "Not found - vendored frontend bundle missing at frontend/dist/index.html",
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

async fn resolve_session_output_snapshot(
    runtime_result: Result<Value, String>,
    session: &str,
    window_index: u32,
) -> Result<Value, String> {
    let mut snapshot = match runtime_result? {
        Value::Object(object) => object,
        payload => return Ok(payload),
    };

    let connected = snapshot
        .get("connected")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let output = snapshot
        .get("output")
        .and_then(Value::as_str)
        .unwrap_or_default();

    if connected || !output.is_empty() {
        return Ok(Value::Object(snapshot));
    }

    let Ok(scrollback) =
        capture_tmux_scrollback(session, window_index, OUTPUT_SNAPSHOT_FALLBACK_LINES).await
    else {
        return Ok(Value::Object(snapshot));
    };

    if scrollback.is_empty() {
        return Ok(Value::Object(snapshot));
    }

    snapshot.insert("connected".to_string(), Value::Bool(true));
    snapshot.insert("output".to_string(), Value::String(scrollback));
    snapshot.insert("clients".to_string(), json!(0));
    snapshot.insert(
        "idleMs".to_string(),
        json!(OUTPUT_SNAPSHOT_FALLBACK_IDLE_MS),
    );

    Ok(Value::Object(snapshot))
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
