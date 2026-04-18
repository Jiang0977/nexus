use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Sender};
use std::thread;

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
struct LaunchWindowParams {
    session_name: String,
    cwd: String,
    name: String,
    shell_cmd: String,
    default_shell_cmd: String,
    #[serde(default)]
    proxy_vars: HashMap<String, String>,
    #[serde(default)]
    update_session_cwd: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RuntimeCapabilities {
    launch: bool,
    admin: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ReadyPayload {
    ready: bool,
    source: &'static str,
    version: &'static str,
    capabilities: RuntimeCapabilities,
    launches: usize,
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

#[derive(Clone)]
struct SharedState {
    event_tx: Sender<String>,
    launches: Arc<AtomicUsize>,
}

impl SharedState {
    fn runtime_status(&self) -> ReadyPayload {
        ReadyPayload {
            ready: true,
            source: "nexus-window-launch-runtime",
            version: env!("CARGO_PKG_VERSION"),
            capabilities: RuntimeCapabilities {
                launch: true,
                admin: true,
            },
            launches: self.launches.load(Ordering::SeqCst),
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

fn run_tmux(args: &[String]) -> Result<(), String> {
    let output = Command::new("tmux")
        .args(args)
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        Err(stderr)
    } else {
        Err(format!("tmux command failed: {}", args.join(" ")))
    }
}

fn ensure_tmux_session(session: &str, default_shell_cmd: &str) -> Result<(), String> {
    if tmux_session_exists(session) {
        return Ok(());
    }

    run_tmux(&vec![
        "new-session".to_string(),
        "-d".to_string(),
        "-s".to_string(),
        session.to_string(),
        "-n".to_string(),
        "shell".to_string(),
        default_shell_cmd.to_string(),
    ])
}

fn set_tmux_env(session: &str, key: &str, value: &str) -> Result<(), String> {
    run_tmux(&vec![
        "set-environment".to_string(),
        "-t".to_string(),
        session.to_string(),
        key.to_string(),
        value.to_string(),
    ])
}

fn launch_window(state: &SharedState, params: LaunchWindowParams) -> Result<Value, String> {
    if params.update_session_cwd {
        set_tmux_env(&params.session_name, "NEXUS_CWD", &params.cwd)
            .map_err(|error| format!("failed to set NEXUS_CWD: {error}"))?;
    }

    ensure_tmux_session(&params.session_name, &params.default_shell_cmd)?;

    for (key, value) in params.proxy_vars {
        set_tmux_env(&params.session_name, &key, &value)?;
    }

    run_tmux(&vec![
        "new-window".to_string(),
        "-t".to_string(),
        params.session_name,
        "-c".to_string(),
        params.cwd,
        "-n".to_string(),
        params.name,
        params.shell_cmd,
    ])?;

    state.launches.fetch_add(1, Ordering::SeqCst);
    Ok(serde_json::json!({ "ok": true }))
}

fn main() {
    let (tx, rx) = mpsc::channel::<String>();
    let state = SharedState {
        event_tx: tx.clone(),
        launches: Arc::new(AtomicUsize::new(0)),
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
                    "launchWindow" => {
                        match serde_json::from_value::<LaunchWindowParams>(message.params) {
                            Ok(params) => match launch_window(&state, params) {
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
                    "shutdown" => {
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
            _ => {}
        }
    }

    drop(state);
    drop(tx);
    let _ = writer.join();
}
