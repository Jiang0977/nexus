use nexus_rust_runtime::child_runtime_protocol::{
    ProtocolOutput, RuntimeControl, RuntimeMessage, StdioProtocol,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

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

#[derive(Clone)]
struct SharedState {
    output: ProtocolOutput,
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

    run_tmux(&[
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
    run_tmux(&[
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

    run_tmux(&[
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
    let (mut protocol, output) = StdioProtocol::start();
    let state = SharedState {
        output: output.clone(),
        launches: Arc::new(AtomicUsize::new(0)),
    };

    protocol.run(|message| {
        match message {
            RuntimeMessage::Request { id, method, params } => match method.as_str() {
                "ready" | "runtimeStatus" => {
                    state.output.success(id, state.runtime_status());
                }
                "launchWindow" => match serde_json::from_value::<LaunchWindowParams>(params) {
                    Ok(params) => match launch_window(&state, params) {
                        Ok(result) => state.output.success(id, result),
                        Err(error) => state.output.failure(id, error),
                    },
                    Err(error) => state.output.failure(id, error.to_string()),
                },
                "shutdown" => {
                    state.output.success(id, serde_json::json!({ "ok": true }));
                    return RuntimeControl::Shutdown;
                }
                _ => {
                    state
                        .output
                        .failure(id, format!("unsupported method: {method}"));
                }
            },
            RuntimeMessage::Notify { .. } => {}
        }
        RuntimeControl::Continue
    });

    drop(state);
    drop(output);
    protocol.finish();
}
