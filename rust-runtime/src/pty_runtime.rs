use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs::{self, OpenOptions};
use std::hash::{Hash, Hasher};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::child_runtime_protocol::{
    JsonLineWriter, ProtocolOutput as ChildProtocolOutput, RuntimeControl, RuntimeMessage,
    StdioProtocol, dispatch_lines, parse_response, write_notify, write_request,
};
use crate::native_session_registry::{NativeChannelLaunch, NativeSessionRegistry};
use crate::sanitize::{clamp_output_snapshot_tail_chars, truncate_tail};

const DEFAULT_COLS: u16 = 120;
const DEFAULT_ROWS: u16 = 30;
const MAX_OUTPUT_BUFFER: usize = 10_000;
const RECENT_OUTPUT_REPLAY: usize = 2_000;
const NATIVE_SCROLLBACK_FILE_CAP: usize = 256_000;
const TMUX_CLIENT_TERM: &str = "xterm-256color";
const ATTACH_TARGET_RETRY_ATTEMPTS: usize = 8;
const ATTACH_TARGET_RETRY_DELAY_MS: u64 = 75;
const NATIVE_BACKEND_ENV: &str = "NEXUS_SESSION_BACKEND";
const NATIVE_PROGRAM_ENV: &str = "NEXUS_NATIVE_PTY_PROGRAM";
const NATIVE_ARGS_ENV: &str = "NEXUS_NATIVE_PTY_ARGS";
const NATIVE_CWD_ENV: &str = "NEXUS_NATIVE_PTY_CWD";
const NATIVE_SCROLLBACK_DIR_ENV: &str = "NEXUS_NATIVE_SCROLLBACK_DIR";
const NATIVE_SUPERVISOR_SOCKET_ENV: &str = "NEXUS_NATIVE_PTY_SUPERVISOR_SOCKET";
const SUPERVISOR_CONNECT_TIMEOUT_MS: u64 = 2_000;
const NATIVE_PTY_TERM: &str = "xterm-256color";
const NATIVE_PTY_COLORTERM: &str = "truecolor";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachConnectionParams {
    connection_id: String,
    session: String,
    window_index: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cols: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    rows: Option<u16>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionNotifyParams {
    connection_id: String,
    key: String,
    raw_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    raw_bytes: Option<Vec<u8>>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotParams {
    session: String,
    window_index: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tail_chars: Option<u32>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RuntimeCapabilities {
    terminal: bool,
    admin: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ReadyPayload {
    ready: bool,
    source: &'static str,
    version: &'static str,
    capabilities: RuntimeCapabilities,
    running_ptys: usize,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachConnectionResult {
    key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    replay_policy: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotResult {
    connected: bool,
    output: String,
    clients: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    idle_ms: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputEvent {
    connection_id: String,
    data: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum BackendMode {
    Tmux,
    Native,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LastClientPolicy {
    KillNonPersistentPty,
    KeepPty,
}

struct NativeCommandSpec {
    program: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    cwd: Option<PathBuf>,
    registry_backed: bool,
}

struct PtyEntry {
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
    clients: Mutex<HashSet<String>>,
    client_sizes: Mutex<HashMap<String, (u16, u16)>>,
    last_output: Mutex<String>,
    last_activity_ms: AtomicU64,
    grouped_session: Option<String>,
    tmux_channel_key: Option<String>,
    native_scrollback_path: Option<PathBuf>,
    registry_backed_native: bool,
}

impl PtyEntry {
    fn new(
        master: Box<dyn portable_pty::MasterPty + Send>,
        writer: Box<dyn Write + Send>,
        killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
        grouped_session: Option<String>,
        native_scrollback_path: Option<PathBuf>,
        registry_backed_native: bool,
    ) -> Self {
        Self {
            master: Mutex::new(master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            clients: Mutex::new(HashSet::new()),
            client_sizes: Mutex::new(HashMap::new()),
            last_output: Mutex::new(String::new()),
            last_activity_ms: AtomicU64::new(now_ms()),
            grouped_session,
            tmux_channel_key: None,
            native_scrollback_path,
            registry_backed_native,
        }
    }
}

#[derive(Clone)]
struct RuntimeOutput {
    sink: Arc<dyn OutputSink>,
}

impl RuntimeOutput {
    fn new(sink: Arc<dyn OutputSink>) -> Self {
        Self { sink }
    }

    fn send_output(&self, connection_id: &str, data: String) {
        self.sink.send_output(connection_id, data);
    }
}

trait OutputSink: Send + Sync {
    fn send_output(&self, connection_id: &str, data: String);
    fn send_closed(&self, _connection_id: &str) {}
}

struct ChannelOutputSink {
    output: ChildProtocolOutput,
}

impl ChannelOutputSink {
    fn new(output: ChildProtocolOutput) -> Self {
        Self { output }
    }
}

impl OutputSink for ChannelOutputSink {
    fn send_closed(&self, connection_id: &str) {
        self.output.event(
            "connectionClosed",
            serde_json::json!({ "connectionId": connection_id }),
        );
    }

    fn send_output(&self, connection_id: &str, data: String) {
        self.output.event(
            "output",
            OutputEvent {
                connection_id: connection_id.to_string(),
                data,
            },
        );
    }
}

#[derive(Clone, Default)]
struct ConnectionRoutes {
    routes: Arc<Mutex<HashMap<String, ChildProtocolOutput>>>,
}

impl ConnectionRoutes {
    fn bind(&self, connection_id: &str, output: ChildProtocolOutput) {
        if let Ok(mut routes) = self.routes.lock() {
            routes.insert(connection_id.to_string(), output);
        }
    }

    fn unbind(&self, connection_id: &str) {
        if let Ok(mut routes) = self.routes.lock() {
            routes.remove(connection_id);
        }
    }
}

impl OutputSink for ConnectionRoutes {
    fn send_output(&self, connection_id: &str, data: String) {
        let output = self
            .routes
            .lock()
            .ok()
            .and_then(|routes| routes.get(connection_id).cloned());
        if let Some(output) = output {
            output.event(
                "output",
                OutputEvent {
                    connection_id: connection_id.to_string(),
                    data,
                },
            );
        }
    }
}

#[derive(Clone)]
struct SharedState {
    ptys: Arc<Mutex<HashMap<String, Arc<PtyEntry>>>>,
    output: RuntimeOutput,
}

trait PtyHost {
    fn runtime_status(&self) -> ReadyPayload;
    fn attach_connection(
        &self,
        params: AttachConnectionParams,
    ) -> Result<AttachConnectionResult, String>;
    fn handle_connection_message(&self, params: ConnectionNotifyParams);
    fn close_connection(&self, params: ConnectionNotifyParams);
    fn detach_connection(&self, params: ConnectionNotifyParams);
    fn get_output_snapshot(&self, params: SnapshotParams) -> SnapshotResult;
    fn get_scrollback_snapshot(&self, params: SnapshotParams) -> SnapshotResult;
    fn shutdown(&self);
}

struct InProcessPtyHost {
    state: SharedState,
}

impl InProcessPtyHost {
    fn new(state: SharedState) -> Self {
        Self { state }
    }
}

impl PtyHost for InProcessPtyHost {
    fn runtime_status(&self) -> ReadyPayload {
        self.state.runtime_status()
    }

    fn attach_connection(
        &self,
        params: AttachConnectionParams,
    ) -> Result<AttachConnectionResult, String> {
        attach_connection(&self.state, params)
    }

    fn handle_connection_message(&self, params: ConnectionNotifyParams) {
        handle_connection_message(&self.state, params);
    }

    fn close_connection(&self, params: ConnectionNotifyParams) {
        close_connection(&self.state, params, LastClientPolicy::KillNonPersistentPty);
    }

    fn detach_connection(&self, params: ConnectionNotifyParams) {
        close_connection(&self.state, params, LastClientPolicy::KeepPty);
    }

    fn get_output_snapshot(&self, params: SnapshotParams) -> SnapshotResult {
        get_output_snapshot(&self.state, params)
    }

    fn get_scrollback_snapshot(&self, params: SnapshotParams) -> SnapshotResult {
        get_scrollback_snapshot(&self.state, params)
    }

    fn shutdown(&self) {
        self.state.shutdown();
    }
}

#[cfg(unix)]
struct SupervisorClientPtyHost {
    socket_path: PathBuf,
    output: ChildProtocolOutput,
    event_connections: Mutex<HashMap<String, SupervisorEventConnection>>,
}

#[cfg(unix)]
struct SupervisorEventConnection {
    shutdown: Arc<AtomicBool>,
    #[cfg(unix)]
    stream: Option<std::os::unix::net::UnixStream>,
    join: Option<thread::JoinHandle<()>>,
}

#[cfg(unix)]
impl SupervisorClientPtyHost {
    fn new(socket_path: PathBuf, output: ChildProtocolOutput) -> Self {
        Self {
            socket_path,
            output,
            event_connections: Mutex::new(HashMap::new()),
        }
    }

    fn request<T>(&self, method: &str, params: Value) -> Result<T, String>
    where
        T: for<'de> Deserialize<'de>,
    {
        let response = supervisor_request(&self.socket_path, method, params)?;
        serde_json::from_value(response).map_err(|error| error.to_string())
    }

    fn notify(&self, method: &str, params: Value) {
        let _ = supervisor_notify(&self.socket_path, method, params);
    }

    fn start_event_connection(
        &self,
        params: AttachConnectionParams,
    ) -> Result<AttachConnectionResult, String> {
        let connection_id = params.connection_id.clone();
        self.close_event_connection(&connection_id);

        let stream = supervisor_connect(&self.socket_path)?;
        let read_stream = stream.try_clone().map_err(|error| error.to_string())?;
        let mut write_stream = stream;
        let request_id = format!("attach-{}", now_ms());
        write_request(
            &mut write_stream,
            &request_id,
            "attachConnection",
            serde_json::to_value(params).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;

        let mut reader = BufReader::new(read_stream);
        let mut line = String::new();
        loop {
            line.clear();
            let bytes = reader
                .read_line(&mut line)
                .map_err(|error| error.to_string())?;
            if bytes == 0 {
                return Err("native pty supervisor closed attach connection".to_string());
            }
            let Some(response) = parse_response(line.trim()).map_err(|error| error.to_string())?
            else {
                let value: Value =
                    serde_json::from_str(line.trim()).map_err(|error| error.to_string())?;
                if value.get("kind").and_then(Value::as_str) == Some("event") {
                    self.output.forward_json_line(line.trim());
                }
                continue;
            };
            if response.id != request_id {
                continue;
            }
            let result =
                response.into_result(|| "native pty supervisor attach failed".to_string())?;
            let result: AttachConnectionResult =
                serde_json::from_value(result).map_err(|error| error.to_string())?;
            let shutdown = Arc::new(AtomicBool::new(false));
            let join =
                spawn_supervisor_event_reader(reader, self.output.clone(), Arc::clone(&shutdown));
            if let Ok(mut connections) = self.event_connections.lock() {
                connections.insert(
                    connection_id,
                    SupervisorEventConnection {
                        shutdown,
                        stream: Some(write_stream),
                        join: Some(join),
                    },
                );
            }
            return Ok(result);
        }
    }

    fn close_event_connection(&self, connection_id: &str) -> Option<SupervisorEventConnection> {
        self.event_connections
            .lock()
            .ok()
            .and_then(|mut connections| connections.remove(connection_id))
            .map(|mut connection| {
                connection.shutdown.store(true, Ordering::SeqCst);
                #[cfg(unix)]
                if let Some(stream) = connection.stream.take() {
                    let _ = stream.shutdown(std::net::Shutdown::Both);
                }
                if let Some(join) = connection.join.take() {
                    let _ = join.join();
                }
                connection
            })
    }
}

#[cfg(unix)]
impl PtyHost for SupervisorClientPtyHost {
    fn runtime_status(&self) -> ReadyPayload {
        supervisor_request(&self.socket_path, "runtimeStatus", serde_json::json!({}))
            .map(|value| {
                let capabilities = value.get("capabilities").cloned().unwrap_or_default();
                ReadyPayload {
                    ready: value.get("ready").and_then(Value::as_bool).unwrap_or(false),
                    source: "nexus-pty-runtime",
                    version: env!("CARGO_PKG_VERSION"),
                    capabilities: RuntimeCapabilities {
                        terminal: capabilities
                            .get("terminal")
                            .and_then(Value::as_bool)
                            .unwrap_or(true),
                        admin: capabilities
                            .get("admin")
                            .and_then(Value::as_bool)
                            .unwrap_or(true),
                    },
                    running_ptys: value
                        .get("runningPtys")
                        .and_then(Value::as_u64)
                        .and_then(|value| usize::try_from(value).ok())
                        .unwrap_or(0),
                }
            })
            .unwrap_or_else(|_| ReadyPayload {
                ready: false,
                source: "nexus-pty-runtime",
                version: env!("CARGO_PKG_VERSION"),
                capabilities: RuntimeCapabilities {
                    terminal: true,
                    admin: true,
                },
                running_ptys: 0,
            })
    }

    fn attach_connection(
        &self,
        params: AttachConnectionParams,
    ) -> Result<AttachConnectionResult, String> {
        self.start_event_connection(params)
    }

    fn handle_connection_message(&self, params: ConnectionNotifyParams) {
        self.notify(
            "handleConnectionMessage",
            serde_json::to_value(params).unwrap_or_default(),
        );
    }

    fn close_connection(&self, params: ConnectionNotifyParams) {
        let connection_id = params.connection_id.clone();
        self.notify(
            "closeConnection",
            serde_json::to_value(params).unwrap_or_default(),
        );
        let _ = self.close_event_connection(&connection_id);
    }

    fn detach_connection(&self, params: ConnectionNotifyParams) {
        self.close_connection(params);
    }

    fn get_output_snapshot(&self, params: SnapshotParams) -> SnapshotResult {
        self.request::<SnapshotResult>(
            "getOutputSnapshot",
            serde_json::to_value(params).unwrap_or_default(),
        )
        .unwrap_or_else(|_| SnapshotResult {
            connected: false,
            output: String::new(),
            clients: 0,
            idle_ms: None,
        })
    }

    fn get_scrollback_snapshot(&self, params: SnapshotParams) -> SnapshotResult {
        self.request::<SnapshotResult>(
            "getScrollbackSnapshot",
            serde_json::to_value(params).unwrap_or_default(),
        )
        .unwrap_or_else(|_| SnapshotResult {
            connected: false,
            output: String::new(),
            clients: 0,
            idle_ms: None,
        })
    }

    fn shutdown(&self) {
        let connections = self
            .event_connections
            .lock()
            .map(|connections| connections.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for connection_id in connections {
            let _ = self.close_event_connection(&connection_id);
        }
    }
}

impl SharedState {
    fn runtime_status(&self) -> ReadyPayload {
        ReadyPayload {
            ready: true,
            source: "nexus-pty-runtime",
            version: env!("CARGO_PKG_VERSION"),
            capabilities: RuntimeCapabilities {
                terminal: true,
                admin: true,
            },
            running_ptys: self.ptys.lock().map(|ptys| ptys.len()).unwrap_or(0),
        }
    }

    fn send_output(&self, connection_id: &str, data: String) {
        self.output.send_output(connection_id, data);
    }

    fn get_entry(&self, key: &str) -> Option<Arc<PtyEntry>> {
        self.ptys
            .lock()
            .ok()
            .and_then(|ptys| ptys.get(key).cloned())
    }

    fn insert_entry(&self, key: String, entry: Arc<PtyEntry>) {
        if let Ok(mut ptys) = self.ptys.lock() {
            ptys.insert(key, entry);
        }
    }

    fn remove_entry_if_same(&self, key: &str, expected: &Arc<PtyEntry>) {
        if let Ok(mut ptys) = self.ptys.lock() {
            let should_remove = ptys
                .get(key)
                .map(|current| Arc::ptr_eq(current, expected))
                .unwrap_or(false);
            if should_remove {
                ptys.remove(key);
            }
        }
    }

    fn remove_entry(&self, key: &str) -> Option<Arc<PtyEntry>> {
        self.ptys.lock().ok().and_then(|mut ptys| ptys.remove(key))
    }

    fn shutdown(&self) {
        let entries = self
            .ptys
            .lock()
            .map(|ptys| ptys.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();

        for entry in entries {
            kill_entry(&entry);
        }

        if let Ok(mut ptys) = self.ptys.lock() {
            ptys.clear();
        }
    }
}

fn backend_mode() -> BackendMode {
    match env::var(NATIVE_BACKEND_ENV)
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("native") => BackendMode::Native,
        _ => BackendMode::Tmux,
    }
}

fn split_args(value: &str) -> Vec<String> {
    value
        .split_whitespace()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn command_available(program: &str) -> bool {
    if program.trim().is_empty() {
        return false;
    }

    let output = if cfg!(windows) {
        Command::new("where")
            .arg(program)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
    } else {
        Command::new("sh")
            .arg("-c")
            .arg("command -v \"$1\" >/dev/null 2>&1")
            .arg("sh")
            .arg(program)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
    };

    output.map(|status| status.success()).unwrap_or(false)
}

fn native_command_spec(session: &str, window_index: u32) -> Result<NativeCommandSpec, String> {
    if let Ok(program) = env::var(NATIVE_PROGRAM_ENV) {
        let program = program.trim().to_string();
        if program.is_empty() {
            return Err(format!("{NATIVE_PROGRAM_ENV} is empty"));
        }
        return Ok(NativeCommandSpec {
            program,
            args: env::var(NATIVE_ARGS_ENV)
                .ok()
                .map(|value| split_args(&value))
                .unwrap_or_default(),
            env: HashMap::new(),
            cwd: native_cwd(),
            registry_backed: false,
        });
    }

    if let Ok(registry) = NativeSessionRegistry::open_default() {
        if let Ok(launch) = registry.channel_launch(session, window_index) {
            return native_command_from_launch(session, window_index, launch);
        }
        if let Ok(project_cwd) = registry.get_project_cwd(session) {
            let mut spec = default_native_command_spec()?;
            spec.cwd = Some(PathBuf::from(project_cwd));
            return Ok(spec);
        }
    }

    default_native_command_spec()
}

fn native_command_from_launch(
    session: &str,
    window_index: u32,
    launch: NativeChannelLaunch,
) -> Result<NativeCommandSpec, String> {
    if let Some(plan) = launch.launch_plan {
        let mut env = plan.env;
        let runtime_id = format!("native:{session}:{window_index}");
        env.entry("NEXUS_NATIVE_CHANNEL_ID".to_string())
            .or_insert_with(|| runtime_id.clone());
        env.entry("NEXUS_CODEX_RUNTIME_ID".to_string())
            .or_insert(runtime_id);
        return Ok(NativeCommandSpec {
            program: plan.program,
            args: plan.args,
            env,
            cwd: plan
                .cwd
                .map(PathBuf::from)
                .or(Some(PathBuf::from(launch.cwd))),
            registry_backed: true,
        });
    }

    let raw = launch.shell_cmd.trim();
    if raw.is_empty() {
        return default_native_command_spec().map(|mut spec| {
            spec.cwd = Some(PathBuf::from(launch.cwd));
            spec
        });
    }

    let normalized = raw.strip_prefix("exec ").unwrap_or(raw);
    let mut parts = split_args(normalized);
    if parts.is_empty() {
        return default_native_command_spec().map(|mut spec| {
            spec.cwd = Some(PathBuf::from(launch.cwd));
            spec
        });
    }

    let program = parts.remove(0);
    Ok(NativeCommandSpec {
        program,
        args: parts,
        env: HashMap::new(),
        cwd: Some(PathBuf::from(launch.cwd)),
        registry_backed: true,
    })
}

fn default_native_command_spec() -> Result<NativeCommandSpec, String> {
    if cfg!(windows) {
        for program in ["pwsh", "powershell.exe", "cmd.exe"] {
            if command_available(program) {
                return Ok(NativeCommandSpec {
                    program: program.to_string(),
                    args: Vec::new(),
                    env: HashMap::new(),
                    cwd: native_cwd(),
                    registry_backed: false,
                });
            }
        }
        return Err("no native shell found; tried pwsh, powershell.exe, cmd.exe".to_string());
    }

    if let Ok(shell) = env::var("SHELL") {
        let shell = shell.trim().to_string();
        if !shell.is_empty() {
            return Ok(NativeCommandSpec {
                program: shell,
                args: Vec::new(),
                env: HashMap::new(),
                cwd: native_cwd(),
                registry_backed: false,
            });
        }
    }

    let fallback_shells: &[&str] = if cfg!(target_os = "macos") {
        &["/bin/zsh", "/bin/bash", "/bin/sh"]
    } else {
        &["/bin/bash", "/bin/sh"]
    };
    for shell in fallback_shells {
        if PathBuf::from(shell).is_file() {
            return Ok(NativeCommandSpec {
                program: shell.to_string(),
                args: Vec::new(),
                env: HashMap::new(),
                cwd: native_cwd(),
                registry_backed: false,
            });
        }
    }

    Err("no native shell found".to_string())
}

fn utf8_locale() -> &'static str {
    if cfg!(target_os = "macos") {
        "en_US.UTF-8"
    } else {
        "C.UTF-8"
    }
}

fn effective_env_value(overrides: &HashMap<String, String>, key: &str) -> Option<String> {
    overrides
        .get(key)
        .cloned()
        .or_else(|| env::var(key).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn value_is_utf8_locale(value: &str) -> bool {
    let normalized = value.to_ascii_lowercase().replace('-', "");
    normalized.contains("utf8")
}

fn normalize_native_terminal_env(overrides: &mut HashMap<String, String>) {
    match overrides
        .get("TERM")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        Some(term) if term != "dumb" => {}
        _ => {
            overrides.insert("TERM".to_string(), NATIVE_PTY_TERM.to_string());
        }
    }

    if effective_env_value(overrides, "COLORTERM").is_none() {
        overrides.insert("COLORTERM".to_string(), NATIVE_PTY_COLORTERM.to_string());
    }

    for key in ["LANG", "LC_CTYPE"] {
        match effective_env_value(overrides, key) {
            Some(value) if value_is_utf8_locale(&value) => {}
            _ => {
                overrides.insert(key.to_string(), utf8_locale().to_string());
            }
        }
    }

    if matches!(
        effective_env_value(overrides, "LC_ALL"),
        Some(value) if !value_is_utf8_locale(&value)
    ) {
        overrides.insert("LC_ALL".to_string(), utf8_locale().to_string());
    }
}

fn native_cwd() -> Option<PathBuf> {
    env::var(NATIVE_CWD_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            env::var("WORKSPACE_ROOT")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        })
}

fn ensure_native_channel_attachable(
    registry: &NativeSessionRegistry,
    session: &str,
    window_index: u32,
) -> Result<(), String> {
    if let Some(instance) = registry.latest_process_instance(session, window_index)?
        && matches!(instance.status.as_str(), "starting" | "running")
    {
        return Err(format!("native channel process {}", instance.status));
    }
    Ok(())
}

fn process_alive(pid: u32) -> bool {
    if cfg!(windows) {
        let filter = format!("PID eq {pid}");
        return Command::new("tasklist")
            .args(["/FI", &filter])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .map(|output| {
                output.status.success()
                    && String::from_utf8_lossy(&output.stdout).contains(&pid.to_string())
            })
            .unwrap_or(false);
    }

    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn reconcile_native_processes_on_startup() {
    let Ok(registry) = NativeSessionRegistry::open_default() else {
        return;
    };
    let Ok(processes) = registry.running_processes() else {
        return;
    };

    for process in processes {
        let next_status = match process.os_pid {
            Some(pid) if process_alive(pid) => "orphaned",
            _ => "stale",
        };
        let _ = registry.mark_process_status(process.id, next_status);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn trim_output(output: &mut String) {
    if output.len() > MAX_OUTPUT_BUFFER {
        let mut keep_from = output.len().saturating_sub(MAX_OUTPUT_BUFFER);
        while keep_from < output.len() && !output.is_char_boundary(keep_from) {
            keep_from += 1;
        }
        output.drain(..keep_from);
    }
}

fn replay_output(output: &str) -> String {
    if output.len() <= RECENT_OUTPUT_REPLAY {
        return output.to_string();
    }

    let mut keep_from = output.len().saturating_sub(RECENT_OUTPUT_REPLAY);
    while keep_from < output.len() && !output.is_char_boundary(keep_from) {
        keep_from += 1;
    }
    output[keep_from..].to_string()
}

fn path_from_env_or_default(env_name: &str, default_relative: PathBuf) -> PathBuf {
    let configured = env::var(env_name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let candidate = configured.map(PathBuf::from).unwrap_or(default_relative);
    if candidate.is_absolute() {
        candidate
    } else {
        env::current_dir()
            .unwrap_or_else(|_| Path::new(".").to_path_buf())
            .join(candidate)
    }
}

fn native_data_dir() -> PathBuf {
    path_from_env_or_default("NEXUS_DATA_DIR", PathBuf::from("data"))
}

pub fn native_supervisor_socket_path() -> PathBuf {
    path_from_env_or_default(
        NATIVE_SUPERVISOR_SOCKET_ENV,
        native_data_dir()
            .join("native-sessions")
            .join("supervisor.sock"),
    )
}

fn native_supervisor_lock_path(socket_path: &Path) -> PathBuf {
    socket_path.with_extension("lock")
}

struct NativeSupervisorLock {
    path: PathBuf,
}

impl NativeSupervisorLock {
    fn acquire(path: PathBuf) -> Result<Self, String> {
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                let _ = writeln!(file, "{}", std::process::id());
                Ok(Self { path })
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                if stale_native_supervisor_lock(&path) {
                    let _ = fs::remove_file(&path);
                    return Self::acquire(path);
                }
                Err(format!(
                    "native pty supervisor lock already exists: {}",
                    path.display()
                ))
            }
            Err(error) => Err(format!(
                "failed to create native pty supervisor lock {}: {}",
                path.display(),
                error
            )),
        }
    }
}

impl Drop for NativeSupervisorLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn stale_native_supervisor_lock(path: &Path) -> bool {
    let Ok(contents) = fs::read_to_string(path) else {
        return false;
    };
    let Ok(pid) = contents.trim().parse::<u32>() else {
        return false;
    };
    !process_alive(pid)
}

fn configured_native_supervisor_socket_path() -> Option<PathBuf> {
    match env::var(NATIVE_SUPERVISOR_SOCKET_ENV) {
        Ok(value) => {
            let value = value.trim();
            if value.is_empty() {
                return None;
            }
            Some(PathBuf::from(value))
        }
        Err(_) => {
            let default_socket = native_supervisor_socket_path();
            if native_supervisor_socket_exists(&default_socket) {
                Some(default_socket)
            } else {
                None
            }
        }
    }
}

fn native_program_configured() -> bool {
    env::var(NATIVE_PROGRAM_ENV)
        .ok()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

#[cfg(unix)]
fn native_supervisor_socket_exists(path: &Path) -> bool {
    use std::os::unix::fs::FileTypeExt;

    fs::metadata(path)
        .map(|metadata| metadata.file_type().is_socket())
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn native_supervisor_socket_exists(path: &Path) -> bool {
    path.exists()
}

fn safe_scrollback_component(value: &str) -> String {
    let clean = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .chars()
        .take(80)
        .collect::<String>();

    if clean.is_empty() {
        "session".to_string()
    } else {
        clean
    }
}

fn stable_hash(value: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn native_scrollback_root() -> PathBuf {
    path_from_env_or_default(
        NATIVE_SCROLLBACK_DIR_ENV,
        native_data_dir().join("native-sessions").join("scrollback"),
    )
}

fn native_scrollback_path(session: &str, window_index: u32) -> PathBuf {
    let session_component = format!(
        "{}-{:x}",
        safe_scrollback_component(session),
        stable_hash(session)
    );
    native_scrollback_root()
        .join(session_component)
        .join(format!("{window_index}.log"))
}

fn trim_native_scrollback(path: &Path) {
    let Ok(metadata) = fs::metadata(path) else {
        return;
    };
    if metadata.len() <= NATIVE_SCROLLBACK_FILE_CAP as u64 {
        return;
    }

    let Ok(contents) = fs::read_to_string(path) else {
        return;
    };
    if contents.len() <= NATIVE_SCROLLBACK_FILE_CAP {
        return;
    }

    let mut keep_from = contents.len().saturating_sub(NATIVE_SCROLLBACK_FILE_CAP);
    while keep_from < contents.len() && !contents.is_char_boundary(keep_from) {
        keep_from += 1;
    }
    let _ = fs::write(path, &contents[keep_from..]);
}

fn append_native_scrollback(path: &Path, data: &str) {
    if data.is_empty() {
        return;
    }
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(data.as_bytes());
        let _ = file.flush();
        trim_native_scrollback(path);
    }
}

fn read_native_scrollback(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

fn pty_key(session: &str, window_index: u32) -> String {
    format!("{}:{}", session, window_index)
}

fn grouped_session_name(key: &str) -> String {
    let mut hasher = DefaultHasher::new();
    key.hash(&mut hasher);
    format!("nexus-pty-{}-{:x}", std::process::id(), hasher.finish())
}

fn is_grouped_session(session: &str) -> bool {
    session.trim().starts_with("nexus-pty-")
}

fn tmux_session_exists(session: &str) -> bool {
    Command::new("tmux")
        .args(["has-session", "-t", session])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn list_window_indices(session: &str) -> Vec<u32> {
    let output = Command::new("tmux")
        .args(["list-windows", "-t", session, "-F", "#I"])
        .output();

    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .collect()
}

fn run_tmux(args: &[String]) -> Result<(), String> {
    let output = Command::new("tmux")
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| error.to_string())?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        Err(format!("tmux {} failed", args.join(" ")))
    } else {
        Err(stderr)
    }
}

fn kill_grouped_session(session: &str) {
    let _ = Command::new("tmux")
        .args(["kill-session", "-t", session])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

fn cleanup_stale_grouped_sessions() {
    let output = Command::new("tmux")
        .args(["list-sessions", "-F", "#{session_name}|#{session_attached}"])
        .stdin(Stdio::null())
        .output();

    let Ok(output) = output else {
        return;
    };
    if !output.status.success() {
        return;
    }

    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut parts = line.splitn(2, '|');
        let session = parts.next().unwrap_or("").trim();
        let attached = parts.next().unwrap_or("0").trim();
        if is_grouped_session(session) && attached == "0" {
            kill_grouped_session(session);
        }
    }
}

fn prepare_grouped_session(
    source_session: &str,
    target_window: u32,
    grouped_session: &str,
) -> Result<(), String> {
    kill_grouped_session(grouped_session);
    run_tmux(&[
        "new-session".to_string(),
        "-d".to_string(),
        "-s".to_string(),
        grouped_session.to_string(),
        "-t".to_string(),
        source_session.to_string(),
    ])?;
    run_tmux(&[
        "select-window".to_string(),
        "-t".to_string(),
        format!("{}:{}", grouped_session, target_window),
    ])
}

fn resolve_attach_target(session: &str, requested_window_index: u32) -> Result<u32, String> {
    if !tmux_session_exists(session) {
        return Err("session_missing".to_string());
    }

    for attempt in 0..ATTACH_TARGET_RETRY_ATTEMPTS {
        let windows = list_window_indices(session);
        if windows.contains(&requested_window_index) {
            return Ok(requested_window_index);
        }

        if attempt + 1 < ATTACH_TARGET_RETRY_ATTEMPTS {
            thread::sleep(Duration::from_millis(ATTACH_TARGET_RETRY_DELAY_MS));
        }
    }

    Err("window_missing".to_string())
}

fn kill_entry(entry: &Arc<PtyEntry>) {
    if let Ok(mut killer) = entry.killer.lock() {
        let _ = killer.kill();
    }
    if let Some(grouped_session) = entry.grouped_session.as_deref() {
        kill_grouped_session(grouped_session);
    }
}

fn resize_entry(entry: &Arc<PtyEntry>, cols: u16, rows: u16) {
    if let Ok(master) = entry.master.lock() {
        let _ = master.resize(PtySize {
            rows: if entry.tmux_channel_key.is_some() {
                rows
            } else {
                rows.max(5)
            },
            cols: if entry.tmux_channel_key.is_some() {
                cols
            } else {
                cols.max(10)
            },
            pixel_width: 0,
            pixel_height: 0,
        });
    }
}

fn recompute_remaining_size(entry: &Arc<PtyEntry>) {
    let sizes = entry
        .client_sizes
        .lock()
        .map(|sizes| sizes.values().copied().collect::<Vec<_>>())
        .unwrap_or_default();
    if sizes.is_empty() {
        return;
    }

    let mut min_cols = u16::MAX;
    let mut min_rows = u16::MAX;
    for (cols, rows) in sizes {
        min_cols = min_cols.min(cols);
        min_rows = min_rows.min(rows);
    }

    if min_cols != u16::MAX && min_rows != u16::MAX {
        resize_entry(entry, min_cols, min_rows);
    }
}

fn start_pty_reader(state: SharedState, entry: Arc<PtyEntry>, mut reader: Box<dyn Read + Send>) {
    thread::spawn(move || {
        let mut decoder = crate::utf8_stream::Utf8StreamDecoder::new();
        let mut buffer = [0_u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    let data = decoder.finish();
                    if !data.is_empty() {
                        emit_pty_output(&data, &entry, &state);
                    }
                    break;
                }
                Ok(n) => {
                    let data = decoder.feed(&buffer[..n]);
                    entry.last_activity_ms.store(now_ms(), Ordering::SeqCst);
                    emit_pty_output(&data, &entry, &state);
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    let data = decoder.finish();
                    if !data.is_empty() {
                        emit_pty_output(&data, &entry, &state);
                    }
                    break;
                }
            }
        }
        // Preserve output/EOF order; the child waiter may run before the reader drains.
        if entry.tmux_channel_key.is_some()
            && let Ok(clients) = entry.clients.lock()
        {
            for connection_id in clients.iter() {
                state.output.sink.send_closed(connection_id);
            }
        }
    });
}

/// Route one decoded chunk through the same cache/persist/broadcast path
/// used per read. Empty decoded strings are skipped; pending UTF-8 bytes are
/// flushed by the caller via `decoder.finish()` at EOF/permanent error.
fn emit_pty_output(data: &str, entry: &PtyEntry, state: &SharedState) {
    if data.is_empty() {
        return;
    }
    if let Ok(mut output) = entry.last_output.lock() {
        output.push_str(data);
        trim_output(&mut output);
    }
    if let Some(path) = entry.native_scrollback_path.as_deref() {
        append_native_scrollback(path, data);
    }
    let clients = entry
        .clients
        .lock()
        .map(|clients| clients.iter().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    for connection_id in clients {
        state.send_output(&connection_id, data.to_string());
    }
}

fn start_pty_waiter(
    state: SharedState,
    key: String,
    entry: Arc<PtyEntry>,
    mut child: Box<dyn portable_pty::Child + Send>,
    native_process_instance_id: Option<i64>,
) {
    thread::spawn(move || {
        let exit_status = child.wait();
        if let Some(process_instance_id) = native_process_instance_id
            && let Ok(status) = exit_status.as_ref()
            && let Ok(registry) = NativeSessionRegistry::open_default()
        {
            let exit_code = i32::try_from(status.exit_code()).unwrap_or(i32::MAX);
            let _ = registry.mark_process_exited(process_instance_id, exit_code);
        }
        state.remove_entry_if_same(&key, &entry);
        if let Some(grouped_session) = entry.grouped_session.as_deref() {
            kill_grouped_session(grouped_session);
        }
    });
}

fn ensure_window_pty(
    state: &SharedState,
    session: &str,
    requested_window_index: u32,
    connection_id: &str,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<(String, Arc<PtyEntry>), String> {
    if backend_mode() == BackendMode::Native {
        return ensure_native_window_pty(state, session, requested_window_index);
    }

    let target_window = resolve_attach_target(session, requested_window_index)?;
    let key = format!(
        "tmux:{}",
        serde_json::json!([session, target_window, connection_id])
    );

    if let Some(entry) = state.get_entry(&key) {
        return Ok((key, entry));
    }

    let grouped_session = grouped_session_name(&key);
    let create_result = (|| -> Result<Arc<PtyEntry>, String> {
        prepare_grouped_session(session, target_window, &grouped_session)?;

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: rows.filter(|value| *value > 0).unwrap_or(DEFAULT_ROWS),
                cols: cols.filter(|value| *value > 0).unwrap_or(DEFAULT_COLS),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| error.to_string())?;

        let mut command = CommandBuilder::new("tmux");
        command.arg("attach-session");
        command.arg("-t");
        command.arg(grouped_session.clone());
        command.env("TERM", TMUX_CLIENT_TERM);

        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| error.to_string())?;
        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| error.to_string())?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| error.to_string())?;
        let killer = child.clone_killer();
        let mut entry = PtyEntry::new(
            pair.master,
            writer,
            killer,
            Some(grouped_session.clone()),
            None,
            false,
        );
        entry.tmux_channel_key = Some(pty_key(session, target_window));
        // Register before starting the reader: the initial redraw is not replayable.
        entry
            .clients
            .get_mut()
            .map_err(|error| error.to_string())?
            .insert(connection_id.to_string());
        let entry = Arc::new(entry);

        state.insert_entry(key.clone(), Arc::clone(&entry));
        start_pty_reader(state.clone(), Arc::clone(&entry), reader);
        start_pty_waiter(state.clone(), key.clone(), Arc::clone(&entry), child, None);

        Ok(entry)
    })();

    match create_result {
        Ok(entry) => Ok((key, entry)),
        Err(error) => {
            kill_grouped_session(&grouped_session);
            Err(error)
        }
    }
}

fn ensure_native_window_pty(
    state: &SharedState,
    session: &str,
    window_index: u32,
) -> Result<(String, Arc<PtyEntry>), String> {
    let key = pty_key(session, window_index);

    if let Some(entry) = state.get_entry(&key) {
        if can_reuse_native_pty(session, window_index, &entry) {
            return Ok((key, entry));
        }
        if let Some(stale_entry) = state.remove_entry(&key) {
            kill_entry(&stale_entry);
        }
        reset_native_scrollback(session, window_index);
    }

    let create_result = (|| -> Result<Arc<PtyEntry>, String> {
        let mut command_spec = native_command_spec(session, window_index)?;
        normalize_native_terminal_env(&mut command_spec.env);
        let registry = if command_spec.registry_backed {
            let registry = NativeSessionRegistry::open_default()?;
            ensure_native_channel_attachable(&registry, session, window_index)?;
            Some(registry)
        } else {
            None
        };
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: DEFAULT_ROWS,
                cols: DEFAULT_COLS,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| error.to_string())?;

        let mut command = CommandBuilder::new(command_spec.program);
        for arg in command_spec.args {
            command.arg(arg);
        }
        for (key, value) in command_spec.env {
            command.env(key, value);
        }
        if let Some(cwd) = command_spec.cwd {
            command.cwd(cwd);
        }

        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| error.to_string())?;
        let process_instance_id = if command_spec.registry_backed {
            let registry = registry
                .as_ref()
                .ok_or_else(|| "native registry unavailable".to_string())?;
            match registry.record_process_running(session, window_index, child.process_id(), None) {
                Ok(process_instance_id) => Some(process_instance_id),
                Err(error) => {
                    let _ = child.kill();
                    return Err(error);
                }
            }
        } else {
            None
        };
        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| error.to_string())?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| error.to_string())?;
        let killer = child.clone_killer();
        let entry = Arc::new(PtyEntry::new(
            pair.master,
            writer,
            killer,
            None,
            Some(native_scrollback_path(session, window_index)),
            command_spec.registry_backed,
        ));

        reset_native_scrollback(session, window_index);
        state.insert_entry(key.clone(), Arc::clone(&entry));
        start_pty_reader(state.clone(), Arc::clone(&entry), reader);
        start_pty_waiter(
            state.clone(),
            key.clone(),
            Arc::clone(&entry),
            child,
            process_instance_id,
        );

        Ok(entry)
    })();

    create_result.map(|entry| (key, entry))
}

fn native_registry_entry_is_current(session: &str, window_index: u32) -> bool {
    let Ok(registry) = NativeSessionRegistry::open_default() else {
        return false;
    };
    matches!(
        registry.latest_process_instance(session, window_index),
        Ok(Some(instance)) if instance.status == "running"
    )
}

fn can_reuse_native_pty(session: &str, window_index: u32, entry: &PtyEntry) -> bool {
    entry.registry_backed_native
        && NativeSessionRegistry::open_default()
            .ok()
            .and_then(|registry| registry.channel_launch(session, window_index).ok())
            .is_some()
        && native_registry_entry_is_current(session, window_index)
}

fn reset_native_scrollback(session: &str, window_index: u32) {
    let path = native_scrollback_path(session, window_index);
    if path.exists() {
        let _ = fs::write(path, "");
    }
}

fn attach_connection(
    state: &SharedState,
    params: AttachConnectionParams,
) -> Result<AttachConnectionResult, String> {
    let (key, entry) = ensure_window_pty(
        state,
        &params.session,
        params.window_index,
        &params.connection_id,
        params.cols,
        params.rows,
    )?;

    if let Ok(mut clients) = entry.clients.lock() {
        clients.insert(params.connection_id.clone());
    }
    entry.last_activity_ms.store(now_ms(), Ordering::SeqCst);

    let replay_policy = entry
        .tmux_channel_key
        .as_ref()
        .map(|_| "tmux-redraw".to_string());
    let replay = if replay_policy.is_none() {
        entry
            .last_output
            .lock()
            .map(|output| replay_output(&output))
            .unwrap_or_default()
    } else {
        String::new()
    };

    if !replay.is_empty() {
        state.send_output(&params.connection_id, replay);
    }

    Ok(AttachConnectionResult { key, replay_policy })
}

fn handle_connection_message(state: &SharedState, params: ConnectionNotifyParams) {
    let Some(entry) = state.get_entry(&params.key) else {
        return;
    };

    if let Some(bytes) = params.raw_bytes {
        if let Ok(mut writer) = entry.writer.lock() {
            let _ = writer.write_all(&bytes);
            let _ = writer.flush();
        }
        entry.last_activity_ms.store(now_ms(), Ordering::SeqCst);
        return;
    }

    let raw_message = params.raw_message.unwrap_or_default();

    if let Ok(value) = serde_json::from_str::<Value>(&raw_message)
        && value.get("type").and_then(Value::as_str) == Some("resize")
    {
        let cols = value
            .get("cols")
            .and_then(Value::as_u64)
            .and_then(|value| u16::try_from(value).ok())
            .filter(|value| *value > 0);
        let rows = value
            .get("rows")
            .and_then(Value::as_u64)
            .and_then(|value| u16::try_from(value).ok())
            .filter(|value| *value > 0);
        if let (Some(cols), Some(rows)) = (cols, rows) {
            if let Ok(mut client_sizes) = entry.client_sizes.lock() {
                client_sizes.insert(params.connection_id, (cols, rows));
            }
            resize_entry(&entry, cols, rows);
        }
        // Invalid control frames must never become application input.
        entry.last_activity_ms.store(now_ms(), Ordering::SeqCst);
        return;
    }

    if let Ok(mut writer) = entry.writer.lock() {
        let _ = writer.write_all(raw_message.as_bytes());
        let _ = writer.flush();
    }
    entry.last_activity_ms.store(now_ms(), Ordering::SeqCst);
}

fn close_connection(state: &SharedState, params: ConnectionNotifyParams, policy: LastClientPolicy) {
    let Some(entry) = state.get_entry(&params.key) else {
        return;
    };

    let remaining_clients = if let Ok(mut clients) = entry.clients.lock() {
        clients.remove(&params.connection_id);
        clients.len()
    } else {
        0
    };

    if let Ok(mut client_sizes) = entry.client_sizes.lock() {
        client_sizes.remove(&params.connection_id);
    }

    if remaining_clients == 0 {
        if entry.tmux_channel_key.is_none()
            && (entry.registry_backed_native || policy == LastClientPolicy::KeepPty)
        {
            entry.last_activity_ms.store(now_ms(), Ordering::SeqCst);
            return;
        }
        state.remove_entry_if_same(&params.key, &entry);
        kill_entry(&entry);
        return;
    }

    recompute_remaining_size(&entry);
    entry.last_activity_ms.store(now_ms(), Ordering::SeqCst);
}

fn bound_snapshot_output(output: String, tail_chars: Option<u32>) -> String {
    let Some(requested) = tail_chars else {
        return output;
    };
    truncate_tail(&output, clamp_output_snapshot_tail_chars(requested))
}

fn get_output_snapshot(state: &SharedState, params: SnapshotParams) -> SnapshotResult {
    let key = pty_key(&params.session, params.window_index);
    if backend_mode() == BackendMode::Tmux {
        let entries = state
            .ptys
            .lock()
            .map(|ptys| {
                ptys.values()
                    .filter(|entry| entry.tmux_channel_key.as_deref() == Some(key.as_str()))
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let latest = entries
            .iter()
            .max_by_key(|entry| entry.last_activity_ms.load(Ordering::SeqCst));
        return SnapshotResult {
            connected: !entries.is_empty(),
            output: bound_snapshot_output(
                latest
                    .and_then(|entry| entry.last_output.lock().ok().map(|output| output.clone()))
                    .unwrap_or_default(),
                params.tail_chars,
            ),
            clients: entries
                .iter()
                .map(|entry| {
                    entry
                        .clients
                        .lock()
                        .map(|clients| clients.len())
                        .unwrap_or(0)
                })
                .sum(),
            idle_ms: latest.map(|entry| {
                now_ms().saturating_sub(entry.last_activity_ms.load(Ordering::SeqCst))
            }),
        };
    }
    let Some(entry) = state.get_entry(&key) else {
        let output = if backend_mode() == BackendMode::Native {
            read_native_scrollback(&native_scrollback_path(
                &params.session,
                params.window_index,
            ))
        } else {
            String::new()
        };
        return SnapshotResult {
            connected: false,
            output: bound_snapshot_output(output, params.tail_chars),
            clients: 0,
            idle_ms: None,
        };
    };

    SnapshotResult {
        connected: true,
        output: bound_snapshot_output(
            entry
                .last_output
                .lock()
                .map(|output| output.clone())
                .unwrap_or_default(),
            params.tail_chars,
        ),
        clients: entry
            .clients
            .lock()
            .map(|clients| clients.len())
            .unwrap_or(0),
        idle_ms: Some(now_ms().saturating_sub(entry.last_activity_ms.load(Ordering::SeqCst))),
    }
}

fn get_scrollback_snapshot(state: &SharedState, params: SnapshotParams) -> SnapshotResult {
    if backend_mode() == BackendMode::Tmux {
        let mut snapshot = get_output_snapshot(state, params);
        snapshot.output.clear();
        return snapshot;
    }
    let output = if backend_mode() == BackendMode::Native {
        read_native_scrollback(&native_scrollback_path(
            &params.session,
            params.window_index,
        ))
    } else {
        String::new()
    };
    let key = pty_key(&params.session, params.window_index);
    let Some(entry) = state.get_entry(&key) else {
        return SnapshotResult {
            connected: false,
            output,
            clients: 0,
            idle_ms: None,
        };
    };

    SnapshotResult {
        connected: true,
        output,
        clients: entry
            .clients
            .lock()
            .map(|clients| clients.len())
            .unwrap_or(0),
        idle_ms: Some(now_ms().saturating_sub(entry.last_activity_ms.load(Ordering::SeqCst))),
    }
}

#[cfg(unix)]
fn supervisor_connect(socket_path: &Path) -> Result<std::os::unix::net::UnixStream, String> {
    use std::os::unix::net::UnixStream;

    let start = Instant::now();
    loop {
        match UnixStream::connect(socket_path) {
            Ok(stream) => return Ok(stream),
            Err(error) => {
                if start.elapsed() >= Duration::from_millis(SUPERVISOR_CONNECT_TIMEOUT_MS) {
                    return Err(format!(
                        "failed to connect native pty supervisor {}: {}",
                        socket_path.display(),
                        error
                    ));
                }
                thread::sleep(Duration::from_millis(25));
            }
        }
    }
}

#[cfg(not(unix))]
fn supervisor_connect(_socket_path: &Path) -> Result<(), String> {
    Err("native pty supervisor client is only implemented on Unix".to_string())
}

#[cfg(unix)]
fn supervisor_request(socket_path: &Path, method: &str, params: Value) -> Result<Value, String> {
    let mut stream = supervisor_connect(socket_path)?;
    let request_id = format!("req-{}", now_ms());
    write_request(&mut stream, &request_id, method, params).map_err(|error| error.to_string())?;

    let reader = BufReader::new(stream);
    for line in reader.lines() {
        let line = line.map_err(|error| error.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        let Some(response) = parse_response(&line).map_err(|error| error.to_string())? else {
            continue;
        };
        if response.id != request_id {
            continue;
        }
        return response.into_result(|| format!("native pty supervisor request failed: {method}"));
    }

    Err(format!(
        "native pty supervisor closed before response: {method}"
    ))
}

#[cfg(not(unix))]
fn supervisor_request(_socket_path: &Path, _method: &str, _params: Value) -> Result<Value, String> {
    Err("native pty supervisor client is only implemented on Unix".to_string())
}

#[cfg(unix)]
fn supervisor_notify(socket_path: &Path, method: &str, params: Value) -> Result<(), String> {
    let mut stream = supervisor_connect(socket_path)?;
    write_notify(&mut stream, method, params).map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn supervisor_notify(_socket_path: &Path, _method: &str, _params: Value) -> Result<(), String> {
    Err("native pty supervisor client is only implemented on Unix".to_string())
}

#[cfg(unix)]
fn spawn_supervisor_event_reader(
    mut reader: BufReader<std::os::unix::net::UnixStream>,
    output: ChildProtocolOutput,
    shutdown: Arc<AtomicBool>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        while !shutdown.load(Ordering::SeqCst) {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let value: Value = match serde_json::from_str(line.trim()) {
                        Ok(value) => value,
                        Err(_) => continue,
                    };
                    if value.get("kind").and_then(Value::as_str) == Some("event") {
                        output.forward_json_line(line.trim());
                    }
                }
                Err(_) => break,
            }
        }
    })
}

pub fn run_stdio_runtime() {
    if backend_mode() == BackendMode::Tmux {
        cleanup_stale_grouped_sessions();
    } else if configured_native_supervisor_socket_path().is_none() && !native_program_configured() {
        reconcile_native_processes_on_startup();
    }

    let (mut protocol, output) = StdioProtocol::start();
    let host = create_stdio_host(output.clone());

    protocol.run(|message| {
        match message {
            RuntimeMessage::Request { id, method, params } => match method.as_str() {
                "ready" | "runtimeStatus" => {
                    output.success(id, host.runtime_status());
                }
                "attachConnection" => {
                    match serde_json::from_value::<AttachConnectionParams>(params) {
                        Ok(params) => match host.attach_connection(params) {
                            Ok(result) => output.success(id, result),
                            Err(error) => output.failure(id, error),
                        },
                        Err(error) => output.failure(id, error.to_string()),
                    }
                }
                "getOutputSnapshot" => match serde_json::from_value::<SnapshotParams>(params) {
                    Ok(params) => output.success(id, host.get_output_snapshot(params)),
                    Err(error) => output.failure(id, error.to_string()),
                },
                "getScrollbackSnapshot" => match serde_json::from_value::<SnapshotParams>(params) {
                    Ok(params) => output.success(id, host.get_scrollback_snapshot(params)),
                    Err(error) => output.failure(id, error.to_string()),
                },
                "shutdown" => {
                    host.shutdown();
                    output.success(id, serde_json::json!({ "ok": true }));
                    return RuntimeControl::Shutdown;
                }
                _ => {
                    output.failure(id, format!("unsupported method: {method}"));
                }
            },
            RuntimeMessage::Notify { method, params } => match method.as_str() {
                "handleConnectionMessage" => {
                    if let Ok(params) = serde_json::from_value::<ConnectionNotifyParams>(params) {
                        host.handle_connection_message(params);
                    }
                }
                "closeConnection" | "errorConnection" => {
                    if let Ok(params) = serde_json::from_value::<ConnectionNotifyParams>(params) {
                        host.close_connection(params);
                    }
                }
                _ => {}
            },
        }
        RuntimeControl::Continue
    });

    host.shutdown();
    drop(host);
    drop(output);
    protocol.finish();
}

fn create_stdio_host(protocol_output: ChildProtocolOutput) -> Box<dyn PtyHost> {
    if backend_mode() == BackendMode::Native
        && let Some(host) = create_supervisor_client_host(protocol_output.clone())
    {
        return host;
    }

    let output = RuntimeOutput::new(Arc::new(ChannelOutputSink::new(protocol_output)));
    let state = SharedState {
        ptys: Arc::new(Mutex::new(HashMap::new())),
        output,
    };
    Box::new(InProcessPtyHost::new(state))
}

#[cfg(unix)]
fn create_supervisor_client_host(protocol_output: ChildProtocolOutput) -> Option<Box<dyn PtyHost>> {
    configured_native_supervisor_socket_path().map(|socket_path| {
        Box::new(SupervisorClientPtyHost::new(socket_path, protocol_output)) as Box<dyn PtyHost>
    })
}

#[cfg(not(unix))]
fn create_supervisor_client_host(
    _protocol_output: ChildProtocolOutput,
) -> Option<Box<dyn PtyHost>> {
    None
}

pub fn run_native_pty_supervisor() -> Result<(), String> {
    if backend_mode() == BackendMode::Tmux {
        return Err("native pty supervisor requires NEXUS_SESSION_BACKEND=native".to_string());
    }
    run_native_pty_supervisor_platform(native_supervisor_socket_path())
}

#[cfg(unix)]
fn run_native_pty_supervisor_platform(socket_path: PathBuf) -> Result<(), String> {
    use std::os::unix::net::UnixListener;

    if let Some(parent) = socket_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let lock_path = native_supervisor_lock_path(&socket_path);
    let _lock = NativeSupervisorLock::acquire(lock_path)?;
    reconcile_native_processes_on_startup();
    if socket_path.exists() {
        fs::remove_file(&socket_path).map_err(|error| error.to_string())?;
    }

    let listener = UnixListener::bind(&socket_path).map_err(|error| error.to_string())?;
    let routes = ConnectionRoutes::default();
    let output = RuntimeOutput::new(Arc::new(routes.clone()));
    let state = SharedState {
        ptys: Arc::new(Mutex::new(HashMap::new())),
        output,
    };
    let host: Arc<dyn PtyHost + Send + Sync> = Arc::new(InProcessPtyHost::new(state));
    let shutting_down = Arc::new(AtomicBool::new(false));

    for stream in listener.incoming() {
        let stream = match stream {
            Ok(stream) => stream,
            Err(error) => {
                if shutting_down.load(Ordering::SeqCst) {
                    break;
                }
                eprintln!("native pty supervisor accept failed: {error}");
                continue;
            }
        };
        let host = Arc::clone(&host);
        let routes = routes.clone();
        let shutting_down = Arc::clone(&shutting_down);
        thread::spawn(move || {
            handle_supervisor_client(stream, host, routes, shutting_down);
        });
    }

    host.shutdown();
    let _ = fs::remove_file(socket_path);
    Ok(())
}

#[cfg(not(unix))]
fn run_native_pty_supervisor_platform(_socket_path: PathBuf) -> Result<(), String> {
    Err("native pty supervisor socket is only implemented on Unix".to_string())
}

#[cfg(unix)]
fn handle_supervisor_client(
    stream: std::os::unix::net::UnixStream,
    host: Arc<dyn PtyHost + Send + Sync>,
    routes: ConnectionRoutes,
    shutting_down: Arc<AtomicBool>,
) {
    let writer_stream = match stream.try_clone() {
        Ok(writer) => writer,
        Err(error) => {
            eprintln!("native pty supervisor clone failed: {error}");
            return;
        }
    };
    let (writer, output) = JsonLineWriter::start(writer_stream);
    let mut bound_connections = Vec::new();

    dispatch_lines(BufReader::new(stream), &mut |message| {
        match message {
            RuntimeMessage::Request { id, method, params } => match method.as_str() {
                "ready" | "runtimeStatus" => output.success(id, host.runtime_status()),
                "attachConnection" => {
                    match serde_json::from_value::<AttachConnectionParams>(params) {
                        Ok(params) => {
                            routes.bind(&params.connection_id, output.clone());
                            if !bound_connections.contains(&params.connection_id) {
                                bound_connections.push(params.connection_id.clone());
                            }
                            match host.attach_connection(params) {
                                Ok(result) => output.success(id, result),
                                Err(error) => output.failure(id, error),
                            }
                        }
                        Err(error) => output.failure(id, error.to_string()),
                    }
                }
                "getOutputSnapshot" => match serde_json::from_value::<SnapshotParams>(params) {
                    Ok(params) => output.success(id, host.get_output_snapshot(params)),
                    Err(error) => output.failure(id, error.to_string()),
                },
                "getScrollbackSnapshot" => match serde_json::from_value::<SnapshotParams>(params) {
                    Ok(params) => output.success(id, host.get_scrollback_snapshot(params)),
                    Err(error) => output.failure(id, error.to_string()),
                },
                "shutdown" => {
                    host.shutdown();
                    shutting_down.store(true, Ordering::SeqCst);
                    output.success(id, serde_json::json!({ "ok": true }));
                    return RuntimeControl::Shutdown;
                }
                _ => output.failure(id, format!("unsupported method: {method}")),
            },
            RuntimeMessage::Notify { method, params } => match method.as_str() {
                "handleConnectionMessage" => {
                    if let Ok(params) = serde_json::from_value::<ConnectionNotifyParams>(params) {
                        host.handle_connection_message(params);
                    }
                }
                "closeConnection" | "errorConnection" => {
                    if let Ok(params) = serde_json::from_value::<ConnectionNotifyParams>(params) {
                        routes.unbind(&params.connection_id);
                        bound_connections.retain(|id| id != &params.connection_id);
                        host.detach_connection(params);
                    }
                }
                _ => {}
            },
        }
        RuntimeControl::Continue
    });

    for connection_id in bound_connections {
        routes.unbind(&connection_id);
    }
    drop(output);
    writer.finish();
}
#[cfg(test)]
mod tests {
    use super::{
        MAX_OUTPUT_BUFFER, NATIVE_SCROLLBACK_FILE_CAP, RECENT_OUTPUT_REPLAY, bound_snapshot_output,
        replay_output, safe_scrollback_component, trim_native_scrollback, trim_output,
    };
    use crate::sanitize::MAX_OUTPUT_SNAPSHOT_TAIL_CHARS;
    use std::fs;

    #[test]
    fn output_snapshot_tail_is_unicode_safe_and_clamped() {
        assert_eq!(bound_snapshot_output("abcdef".to_string(), None), "abcdef");
        assert_eq!(bound_snapshot_output("a中🙂z".to_string(), Some(2)), "🙂z");
        let long = "x".repeat(20_000);
        assert_eq!(
            bound_snapshot_output(long.clone(), Some(0)).chars().count(),
            MAX_OUTPUT_SNAPSHOT_TAIL_CHARS
        );
        assert_eq!(
            bound_snapshot_output(long, Some(50_000)).chars().count(),
            MAX_OUTPUT_SNAPSHOT_TAIL_CHARS
        );
    }

    #[test]
    fn trim_output_keeps_utf8_boundaries() {
        let mut output = format!("中{}", "a".repeat(MAX_OUTPUT_BUFFER - 2));
        trim_output(&mut output);

        assert_eq!(output, "a".repeat(MAX_OUTPUT_BUFFER - 2));
        assert!(output.len() <= MAX_OUTPUT_BUFFER);
    }

    #[test]
    fn replay_output_keeps_utf8_boundaries() {
        let output = format!(
            "{}为{}",
            "a".repeat(5),
            "b".repeat(RECENT_OUTPUT_REPLAY - 3)
        );
        let replay = replay_output(&output);

        assert!(replay.starts_with('为'));
        assert!(replay.len() <= RECENT_OUTPUT_REPLAY);
    }

    #[test]
    fn safe_scrollback_component_removes_path_separators() {
        assert_eq!(
            safe_scrollback_component("../bad/session name"),
            "bad_session_name"
        );
    }

    #[test]
    fn trim_native_scrollback_keeps_utf8_boundaries() {
        let path = std::env::temp_dir().join(format!(
            "nexus-native-scrollback-test-{}-{}.log",
            std::process::id(),
            super::now_ms()
        ));
        let content = format!("中{}", "a".repeat(NATIVE_SCROLLBACK_FILE_CAP - 2));
        fs::write(&path, content).unwrap();

        trim_native_scrollback(&path);

        let trimmed = fs::read_to_string(&path).unwrap();
        assert_eq!(trimmed, "a".repeat(NATIVE_SCROLLBACK_FILE_CAP - 2));
        assert!(trimmed.len() <= NATIVE_SCROLLBACK_FILE_CAP);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn binary_connection_notify_roundtrip() {
        let bytes = (0u8..=255u8).collect::<Vec<_>>();
        let params = super::ConnectionNotifyParams {
            connection_id: "conn1".to_string(),
            key: "k1".to_string(),
            raw_message: None,
            raw_bytes: Some(bytes.clone()),
        };
        let json = serde_json::to_value(&params).unwrap();
        assert_eq!(json["rawBytes"], serde_json::json!(bytes));
        assert!(json.get("raw_bytes").is_none());
        assert!(json["rawMessage"].is_null());
        let parsed: super::ConnectionNotifyParams = serde_json::from_value(json).unwrap();
        assert_eq!(parsed.raw_bytes, Some(bytes));
        assert!(parsed.raw_message.is_none());
    }

    #[test]
    fn binary_legacy_raw_message_absent_raw_bytes_stays_none() {
        let json = r#"{"connectionId":"c","key":"k","rawMessage":"hi"}"#;
        let params: super::ConnectionNotifyParams = serde_json::from_str(json).unwrap();
        assert_eq!(params.raw_message, Some("hi".to_string()));
        assert!(params.raw_bytes.is_none());
        let serialized = serde_json::to_value(params).unwrap();
        assert_eq!(serialized["rawMessage"], "hi");
        assert!(serialized.get("rawBytes").is_none());
    }
}
