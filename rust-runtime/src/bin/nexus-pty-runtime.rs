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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use nexus_rust_runtime::native_session_registry::{NativeChannelLaunch, NativeSessionRegistry};

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

#[derive(Deserialize)]
struct Message {
    kind: String,
    id: Option<String>,
    method: Option<String>,
    #[serde(default)]
    params: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachConnectionParams {
    connection_id: String,
    session: String,
    window_index: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionNotifyParams {
    connection_id: String,
    key: String,
    raw_message: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotParams {
    session: String,
    window_index: u32,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachConnectionResult {
    key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotResult {
    connected: bool,
    output: String,
    clients: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    idle_ms: Option<u64>,
}

#[derive(Serialize)]
struct ResponseMessage<T>
where
    T: Serialize,
{
    kind: &'static str,
    id: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ResponseError>,
}

#[derive(Serialize)]
struct ResponseError {
    message: String,
}

#[derive(Serialize)]
struct EventMessage<T>
where
    T: Serialize,
{
    kind: &'static str,
    event: &'static str,
    params: T,
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
            native_scrollback_path,
            registry_backed_native,
        }
    }
}

#[derive(Clone)]
struct SharedState {
    ptys: Arc<Mutex<HashMap<String, Arc<PtyEntry>>>>,
    event_tx: Sender<String>,
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

    fn send_json<T>(&self, value: &T)
    where
        T: Serialize,
    {
        if let Ok(line) = serde_json::to_string(value) {
            let _ = self.event_tx.send(line);
        }
    }

    fn send_output(&self, connection_id: &str, data: String) {
        self.send_json(&EventMessage {
            kind: "event",
            event: "output",
            params: OutputEvent {
                connection_id: connection_id.to_string(),
                data,
            },
        });
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
            .arg(format!("command -v \"$1\" >/dev/null 2>&1"))
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

    if let Ok(registry) = NativeSessionRegistry::open_default()
        && let Ok(launch) = registry.channel_launch(session, window_index)
    {
        return native_command_from_launch(launch);
    }

    default_native_command_spec()
}

fn native_command_from_launch(launch: NativeChannelLaunch) -> Result<NativeCommandSpec, String> {
    if let Some(plan) = launch.launch_plan {
        return Ok(NativeCommandSpec {
            program: plan.program,
            args: plan.args,
            env: plan.env,
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
    fs::read_to_string(path)
        .map(|output| replay_output(&output))
        .unwrap_or_default()
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
            rows: rows.max(5),
            cols: cols.max(10),
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
        let mut buffer = [0_u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buffer[..n]).to_string();
                    entry.last_activity_ms.store(now_ms(), Ordering::SeqCst);
                    if let Ok(mut output) = entry.last_output.lock() {
                        output.push_str(&data);
                        trim_output(&mut output);
                    }
                    if let Some(path) = entry.native_scrollback_path.as_deref() {
                        append_native_scrollback(path, &data);
                    }
                    let clients = entry
                        .clients
                        .lock()
                        .map(|clients| clients.iter().cloned().collect::<Vec<_>>())
                        .unwrap_or_default();
                    for connection_id in clients {
                        state.send_output(&connection_id, data.clone());
                    }
                }
                Err(_) => break,
            }
        }
    });
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
) -> Result<(String, Arc<PtyEntry>), String> {
    if backend_mode() == BackendMode::Native {
        return ensure_native_window_pty(state, session, requested_window_index);
    }

    let target_window = resolve_attach_target(session, requested_window_index)?;
    let key = pty_key(session, target_window);

    if let Some(entry) = state.get_entry(&key) {
        return Ok((key, entry));
    }

    let grouped_session = grouped_session_name(&key);
    let create_result = (|| -> Result<Arc<PtyEntry>, String> {
        prepare_grouped_session(session, target_window, &grouped_session)?;

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: DEFAULT_ROWS,
                cols: DEFAULT_COLS,
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
        let entry = Arc::new(PtyEntry::new(
            pair.master,
            writer,
            killer,
            Some(grouped_session.clone()),
            None,
            false,
        ));

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
        return Ok((key, entry));
    }

    let create_result = (|| -> Result<Arc<PtyEntry>, String> {
        let command_spec = native_command_spec(session, window_index)?;
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

fn attach_connection(
    state: &SharedState,
    params: AttachConnectionParams,
) -> Result<AttachConnectionResult, String> {
    let (key, entry) = ensure_window_pty(state, &params.session, params.window_index)?;

    if let Ok(mut clients) = entry.clients.lock() {
        clients.insert(params.connection_id.clone());
    }
    entry.last_activity_ms.store(now_ms(), Ordering::SeqCst);

    let replay = entry
        .last_output
        .lock()
        .map(|output| replay_output(&output))
        .unwrap_or_default();

    if !replay.is_empty() {
        state.send_output(&params.connection_id, replay);
    }

    Ok(AttachConnectionResult { key })
}

fn handle_connection_message(state: &SharedState, params: ConnectionNotifyParams) {
    let Some(entry) = state.get_entry(&params.key) else {
        return;
    };

    let raw_message = params.raw_message.unwrap_or_default();
    let mut handled_resize = false;

    if let Ok(value) = serde_json::from_str::<Value>(&raw_message)
        && value.get("type").and_then(Value::as_str) == Some("resize")
    {
        let cols = value
            .get("cols")
            .and_then(Value::as_u64)
            .map(|value| value as u16);
        let rows = value
            .get("rows")
            .and_then(Value::as_u64)
            .map(|value| value as u16);
        if let (Some(cols), Some(rows)) = (cols, rows) {
            if let Ok(mut client_sizes) = entry.client_sizes.lock() {
                client_sizes.insert(params.connection_id, (cols, rows));
            }
            resize_entry(&entry, cols, rows);
            handled_resize = true;
        }
    }

    if handled_resize {
        entry.last_activity_ms.store(now_ms(), Ordering::SeqCst);
        return;
    }

    if let Ok(mut writer) = entry.writer.lock() {
        let _ = writer.write_all(raw_message.as_bytes());
        let _ = writer.flush();
    }
    entry.last_activity_ms.store(now_ms(), Ordering::SeqCst);
}

fn close_connection(state: &SharedState, params: ConnectionNotifyParams) {
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
        if entry.registry_backed_native {
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

fn get_output_snapshot(state: &SharedState, params: SnapshotParams) -> SnapshotResult {
    let key = pty_key(&params.session, params.window_index);
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
            output,
            clients: 0,
            idle_ms: None,
        };
    };

    SnapshotResult {
        connected: true,
        output: entry
            .last_output
            .lock()
            .map(|output| output.clone())
            .unwrap_or_default(),
        clients: entry
            .clients
            .lock()
            .map(|clients| clients.len())
            .unwrap_or(0),
        idle_ms: Some(now_ms().saturating_sub(entry.last_activity_ms.load(Ordering::SeqCst))),
    }
}

fn send_response<T>(
    state: &SharedState,
    id: String,
    ok: bool,
    result: Option<T>,
    error: Option<String>,
) where
    T: Serialize,
{
    state.send_json(&ResponseMessage {
        kind: "response",
        id,
        ok,
        result,
        error: error.map(|message| ResponseError { message }),
    });
}

fn main() {
    if backend_mode() == BackendMode::Tmux {
        cleanup_stale_grouped_sessions();
    } else {
        reconcile_native_processes_on_startup();
    }

    let (tx, rx) = mpsc::channel::<String>();
    let state = SharedState {
        ptys: Arc::new(Mutex::new(HashMap::new())),
        event_tx: tx.clone(),
    };

    let writer = thread::spawn(move || {
        let stdout = io::stdout();
        let mut handle = stdout.lock();
        while let Ok(line) = rx.recv() {
            if handle.write_all(line.as_bytes()).is_err() {
                break;
            }
            if handle.write_all(b"\n").is_err() {
                break;
            }
            if handle.flush().is_err() {
                break;
            }
        }
    });

    let stdin = io::stdin();
    let reader = BufReader::new(stdin.lock());

    for line in reader.lines() {
        let line = match line {
            Ok(value) => value,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }

        let message: Message = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("invalid request: {error}");
                continue;
            }
        };

        match message.kind.as_str() {
            "request" => {
                let id = message.id.unwrap_or_default();
                let method = message.method.unwrap_or_default();
                match method.as_str() {
                    "ready" | "runtimeStatus" => {
                        send_response(&state, id, true, Some(state.runtime_status()), None);
                    }
                    "attachConnection" => {
                        match serde_json::from_value::<AttachConnectionParams>(message.params) {
                            Ok(params) => match attach_connection(&state, params) {
                                Ok(result) => send_response(&state, id, true, Some(result), None),
                                Err(error) => {
                                    send_response::<Value>(&state, id, false, None, Some(error))
                                }
                            },
                            Err(error) => send_response::<Value>(
                                &state,
                                id,
                                false,
                                None,
                                Some(error.to_string()),
                            ),
                        }
                    }
                    "getOutputSnapshot" => {
                        match serde_json::from_value::<SnapshotParams>(message.params) {
                            Ok(params) => send_response(
                                &state,
                                id,
                                true,
                                Some(get_output_snapshot(&state, params)),
                                None,
                            ),
                            Err(error) => send_response::<Value>(
                                &state,
                                id,
                                false,
                                None,
                                Some(error.to_string()),
                            ),
                        }
                    }
                    "shutdown" => {
                        state.shutdown();
                        send_response(
                            &state,
                            id,
                            true,
                            Some(serde_json::json!({ "ok": true })),
                            None,
                        );
                        break;
                    }
                    _ => {
                        send_response::<Value>(
                            &state,
                            id,
                            false,
                            None,
                            Some(format!("unsupported method: {method}")),
                        );
                    }
                }
            }
            "notify" => {
                let method = message.method.unwrap_or_default();
                match method.as_str() {
                    "handleConnectionMessage" => {
                        if let Ok(params) =
                            serde_json::from_value::<ConnectionNotifyParams>(message.params)
                        {
                            handle_connection_message(&state, params);
                        }
                    }
                    "closeConnection" | "errorConnection" => {
                        if let Ok(params) =
                            serde_json::from_value::<ConnectionNotifyParams>(message.params)
                        {
                            close_connection(&state, params);
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    state.shutdown();
    drop(state);
    drop(tx);
    let _ = writer.join();
}

#[cfg(test)]
mod tests {
    use super::{
        MAX_OUTPUT_BUFFER, NATIVE_SCROLLBACK_FILE_CAP, RECENT_OUTPUT_REPLAY, replay_output,
        safe_scrollback_component, trim_native_scrollback, trim_output,
    };
    use std::fs;

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
}
