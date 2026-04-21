use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_COLS: u16 = 120;
const DEFAULT_ROWS: u16 = 30;
const MAX_OUTPUT_BUFFER: usize = 10_000;
const RECENT_OUTPUT_REPLAY: usize = 2_000;
const TMUX_CLIENT_TERM: &str = "xterm-256color";

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

struct PtyEntry {
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
    clients: Mutex<HashSet<String>>,
    client_sizes: Mutex<HashMap<String, (u16, u16)>>,
    last_output: Mutex<String>,
    last_activity_ms: AtomicU64,
}

impl PtyEntry {
    fn new(
        master: Box<dyn portable_pty::MasterPty + Send>,
        writer: Box<dyn Write + Send>,
        killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
    ) -> Self {
        Self {
            master: Mutex::new(master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            clients: Mutex::new(HashSet::new()),
            client_sizes: Mutex::new(HashMap::new()),
            last_output: Mutex::new(String::new()),
            last_activity_ms: AtomicU64::new(now_ms()),
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

fn pty_key(session: &str, window_index: u32) -> String {
    format!("{}:{}", session, window_index)
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

fn resolve_attach_target(session: &str, requested_window_index: u32) -> Result<u32, String> {
    if !tmux_session_exists(session) {
        return Err("session_missing".to_string());
    }

    let windows = list_window_indices(session);
    if windows.is_empty() {
        return Err("window_missing".to_string());
    }
    if windows.contains(&requested_window_index) {
        return Ok(requested_window_index);
    }

    Ok(windows[0])
}

fn kill_entry(entry: &Arc<PtyEntry>) {
    if let Ok(mut killer) = entry.killer.lock() {
        let _ = killer.kill();
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
) {
    thread::spawn(move || {
        let _ = child.wait();
        state.remove_entry_if_same(&key, &entry);
    });
}

fn ensure_window_pty(
    state: &SharedState,
    session: &str,
    requested_window_index: u32,
) -> Result<(String, Arc<PtyEntry>), String> {
    let target_window = resolve_attach_target(session, requested_window_index)?;
    let key = pty_key(session, target_window);

    if let Some(entry) = state.get_entry(&key) {
        return Ok((key, entry));
    }

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
    command.arg(format!("{}:{}", session, target_window));
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
    let entry = Arc::new(PtyEntry::new(pair.master, writer, killer));

    state.insert_entry(key.clone(), Arc::clone(&entry));
    start_pty_reader(state.clone(), Arc::clone(&entry), reader);
    start_pty_waiter(state.clone(), key.clone(), Arc::clone(&entry), child);

    Ok((key, entry))
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
        return SnapshotResult {
            connected: false,
            output: String::new(),
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
    use super::{MAX_OUTPUT_BUFFER, RECENT_OUTPUT_REPLAY, replay_output, trim_output};

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
}
