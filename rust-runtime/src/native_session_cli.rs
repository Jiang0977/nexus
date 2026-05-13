use crate::native_session_registry::{NativeProcessInstance, NativeSessionRegistry};
use crate::runtime_config::{
    NATIVE_PTY_SUPERVISOR_SOCKET_ENV, resolve_native_pty_supervisor_socket,
};
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const CONNECT_TIMEOUT_MS: u64 = 2_000;

#[derive(Deserialize)]
struct WireResponse {
    id: String,
    ok: bool,
    #[serde(default)]
    result: Value,
    error: Option<WireError>,
}

#[derive(Deserialize)]
struct WireError {
    message: String,
}

pub fn run(args: impl IntoIterator<Item = String>) -> Result<(), String> {
    let mut args = args.into_iter();
    let _program = args.next();
    match args.next().as_deref() {
        Some("list") | Some("ls") => list_sessions(),
        Some("attach") | Some("a") => {
            let session = args.next().ok_or_else(|| usage())?;
            let channel = args
                .next()
                .as_deref()
                .map(str::parse::<u32>)
                .transpose()
                .map_err(|_| "channel index must be an integer".to_string())?
                .unwrap_or(0);
            attach_session(&session, channel)
        }
        Some("help") | Some("--help") | Some("-h") | None => Err(usage()),
        Some(command) => Err(format!("unsupported command: {command}\n\n{}", usage())),
    }
}

fn usage() -> String {
    "usage:\n  nexus-native-session list\n  nexus-native-session attach <project> [channel-index]"
        .to_string()
}

fn list_sessions() -> Result<(), String> {
    let registry = NativeSessionRegistry::open_default()?;
    let mut running = BTreeMap::<(String, u32), Vec<NativeProcessInstance>>::new();
    for process in registry.running_processes()? {
        running
            .entry((process.project_name.clone(), process.channel_index))
            .or_default()
            .push(process);
    }

    let projects = registry.list_projects()?;
    let mut stdout = io::stdout().lock();
    if projects.is_empty() {
        writeln!(stdout, "no native sessions").map_err(|error| error.to_string())?;
        return Ok(());
    }

    for project in projects {
        writeln!(
            stdout,
            "{}\tchannels={}\tcwd={}",
            project.name, project.channel_count, project.cwd
        )
        .map_err(|error| error.to_string())?;
        for channel in registry.list_channels(&project.name)? {
            let key = (project.name.clone(), channel.index);
            let status = running
                .get(&key)
                .and_then(|processes| processes.first())
                .map(|process| format!("running pid={}", process.os_pid.unwrap_or(0)))
                .unwrap_or_else(|| "idle".to_string());
            let active = if channel.active { "*" } else { " " };
            writeln!(
                stdout,
                "  {active}{}\t{}\t{}\tcwd={}",
                channel.index, channel.name, status, channel.cwd
            )
            .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn attach_session(session: &str, channel: u32) -> Result<(), String> {
    let socket_path = native_supervisor_socket_path()?;
    #[cfg(unix)]
    {
        attach_session_unix(&socket_path, session, channel)
    }
    #[cfg(not(unix))]
    {
        let _ = (socket_path, session, channel);
        Err("native session attach is only implemented on Unix".to_string())
    }
}

fn native_supervisor_socket_path() -> Result<PathBuf, String> {
    if let Ok(value) = env::var(NATIVE_PTY_SUPERVISOR_SOCKET_ENV) {
        let value = value.trim();
        if !value.is_empty() {
            return Ok(PathBuf::from(value));
        }
    }

    let project_root = crate::config::resolve_project_root()?;
    let dotenv = crate::config::load_dotenv(&project_root);
    let data_dir = crate::config::resolve_data_dir(&project_root, &dotenv);
    Ok(resolve_native_pty_supervisor_socket(
        &project_root,
        &data_dir,
        &dotenv,
    ))
}

#[cfg(unix)]
fn attach_session_unix(socket_path: &Path, session: &str, channel: u32) -> Result<(), String> {
    let connection_id = format!("native-cli-{}-{}", std::process::id(), now_ms());
    let stream = connect_unix(socket_path)?;
    let mut writer = stream.try_clone().map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(stream);
    let request_id = "attach-1";
    write_json(
        &mut writer,
        &serde_json::json!({
            "kind": "request",
            "id": request_id,
            "method": "attachConnection",
            "params": {
                "connectionId": connection_id,
                "session": session,
                "windowIndex": channel,
            },
        }),
    )?;

    let key = wait_for_attach_response(&mut reader, request_id)?;
    let stop = Arc::new(AtomicBool::new(false));
    let output_stop = Arc::clone(&stop);
    let output = thread::spawn(move || read_output(reader, output_stop));

    let _raw_mode = TerminalRawMode::enable_if_tty();
    let mut stdin = io::stdin().lock();
    let mut buffer = [0_u8; 4096];
    while !stop.load(Ordering::SeqCst) {
        let count = stdin.read(&mut buffer).map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        let raw_message = String::from_utf8_lossy(&buffer[..count]).to_string();
        write_json(
            &mut writer,
            &serde_json::json!({
                "kind": "notify",
                "method": "handleConnectionMessage",
                "params": {
                    "connectionId": connection_id,
                    "key": key,
                    "rawMessage": raw_message,
                },
            }),
        )?;
    }

    stop.store(true, Ordering::SeqCst);
    let _ = write_json(
        &mut writer,
        &serde_json::json!({
            "kind": "notify",
            "method": "closeConnection",
            "params": {
                "connectionId": connection_id,
                "key": key,
                "rawMessage": "",
            },
        }),
    );
    let _ = writer.shutdown(std::net::Shutdown::Both);
    let _ = output.join();
    Ok(())
}

#[cfg(unix)]
fn connect_unix(socket_path: &Path) -> Result<std::os::unix::net::UnixStream, String> {
    use std::os::unix::net::UnixStream;

    let start = Instant::now();
    loop {
        match UnixStream::connect(socket_path) {
            Ok(stream) => return Ok(stream),
            Err(error) => {
                if start.elapsed() >= Duration::from_millis(CONNECT_TIMEOUT_MS) {
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

fn wait_for_attach_response<R: BufRead>(
    reader: &mut R,
    request_id: &str,
) -> Result<String, String> {
    let mut line = String::new();
    loop {
        line.clear();
        let bytes = reader
            .read_line(&mut line)
            .map_err(|error| error.to_string())?;
        if bytes == 0 {
            return Err("native pty supervisor closed attach connection".to_string());
        }
        if line.trim().is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(line.trim()).map_err(|error| error.to_string())?;
        if value.get("kind").and_then(Value::as_str) == Some("event") {
            write_event_output(&value)?;
            continue;
        }
        if value.get("kind").and_then(Value::as_str) != Some("response") {
            continue;
        }
        let response: WireResponse =
            serde_json::from_value(value).map_err(|error| error.to_string())?;
        if response.id != request_id {
            continue;
        }
        if !response.ok {
            return Err(response
                .error
                .map(|error| error.message)
                .unwrap_or_else(|| "native pty attach failed".to_string()));
        }
        return response
            .result
            .get("key")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "native pty attach response missing key".to_string());
    }
}

fn read_output<R: BufRead>(mut reader: R, stop: Arc<AtomicBool>) {
    let mut line = String::new();
    while !stop.load(Ordering::SeqCst) {
        line.clear();
        let bytes = match reader.read_line(&mut line) {
            Ok(bytes) => bytes,
            Err(_) => break,
        };
        if bytes == 0 {
            break;
        }
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if value.get("kind").and_then(Value::as_str) == Some("event") {
            let _ = write_event_output(&value);
        }
    }
}

fn write_event_output(value: &Value) -> Result<(), String> {
    if value.get("event").and_then(Value::as_str) != Some("output") {
        return Ok(());
    }
    let data = value
        .get("params")
        .and_then(|params| params.get("data"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut stdout = io::stdout().lock();
    stdout
        .write_all(data.as_bytes())
        .map_err(|error| error.to_string())?;
    stdout.flush().map_err(|error| error.to_string())
}

fn write_json(writer: &mut impl Write, value: &Value) -> Result<(), String> {
    let line = serde_json::to_string(value).map_err(|error| error.to_string())?;
    writer
        .write_all(line.as_bytes())
        .map_err(|error| error.to_string())?;
    writer.write_all(b"\n").map_err(|error| error.to_string())?;
    writer.flush().map_err(|error| error.to_string())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

struct TerminalRawMode {
    original: Option<String>,
}

impl TerminalRawMode {
    fn enable_if_tty() -> Self {
        if !stdin_is_tty() || !stdout_is_tty() {
            return Self { original: None };
        }
        let original = stty_capture(["-g"]);
        if original.is_some() {
            let _ = run_stty(["raw", "-echo"]);
        }
        Self { original }
    }
}

impl Drop for TerminalRawMode {
    fn drop(&mut self) {
        if let Some(original) = self.original.as_deref() {
            let _ = run_stty([original]);
        }
    }
}

fn stdin_is_tty() -> bool {
    fs::metadata("/dev/stdin")
        .map(|metadata| metadata.file_type().is_char_device())
        .unwrap_or(false)
}

fn stdout_is_tty() -> bool {
    fs::metadata("/dev/stdout")
        .map(|metadata| metadata.file_type().is_char_device())
        .unwrap_or(false)
}

fn stty_capture<const N: usize>(args: [&str; N]) -> Option<String> {
    std::process::Command::new("stty")
        .args(args)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|value| !value.is_empty())
}

fn run_stty<const N: usize>(args: [&str; N]) -> Result<(), String> {
    std::process::Command::new("stty")
        .args(args)
        .status()
        .map_err(|error| error.to_string())
        .and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err("stty failed".to_string())
            }
        })
}

trait FileTypeExt {
    fn is_char_device(&self) -> bool;
}

impl FileTypeExt for fs::FileType {
    fn is_char_device(&self) -> bool {
        #[cfg(unix)]
        {
            use std::os::unix::fs::FileTypeExt as UnixFileTypeExt;
            UnixFileTypeExt::is_char_device(self)
        }
        #[cfg(not(unix))]
        {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::usage;

    #[test]
    fn usage_names_list_and_attach() {
        let usage = usage();
        assert!(usage.contains("list"));
        assert!(usage.contains("attach <project> [channel-index]"));
    }
}
