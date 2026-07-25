use nexus_rust_runtime::child_runtime_protocol::{
    ProtocolOutput, RuntimeControl, RuntimeMessage, StdioProtocol,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartTaskParams {
    task_id: String,
    prompt: String,
    cwd: String,
    profile: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KillTaskParams {
    task_id: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RuntimeCapabilities {
    tasks: bool,
    admin: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ReadyPayload {
    ready: bool,
    source: &'static str,
    version: &'static str,
    capabilities: RuntimeCapabilities,
    running_tasks: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChunkEvent {
    task_id: String,
    chunk: String,
    is_err: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DoneEvent {
    task_id: String,
    exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_message: Option<String>,
}

#[derive(Clone)]
struct SharedState {
    children: Arc<Mutex<HashMap<String, Arc<Mutex<Child>>>>>,
    output: ProtocolOutput,
    running_tasks: Arc<AtomicUsize>,
}

impl SharedState {
    fn runtime_status(&self) -> ReadyPayload {
        ReadyPayload {
            ready: true,
            source: "nexus-task-runtime",
            version: env!("CARGO_PKG_VERSION"),
            capabilities: RuntimeCapabilities {
                tasks: true,
                admin: true,
            },
            running_tasks: self.running_tasks.load(Ordering::SeqCst),
        }
    }

    fn send_chunk(&self, task_id: &str, chunk: String, is_err: bool) {
        self.output.event(
            "chunk",
            ChunkEvent {
                task_id: task_id.to_string(),
                chunk,
                is_err,
            },
        );
    }

    fn send_done(&self, task_id: &str, exit_code: Option<i32>, error_message: Option<String>) {
        self.output.event(
            "done",
            DoneEvent {
                task_id: task_id.to_string(),
                exit_code,
                error_message,
            },
        );
    }

    fn remove_task(&self, task_id: &str) {
        if let Ok(mut children) = self.children.lock()
            && children.remove(task_id).is_some()
        {
            self.running_tasks.fetch_sub(1, Ordering::SeqCst);
        }
    }

    fn kill_task(&self, task_id: &str) {
        if let Ok(children) = self.children.lock()
            && let Some(child) = children.get(task_id)
            && let Ok(mut guard) = child.lock()
        {
            let _ = guard.kill();
        }
    }

    fn shutdown(&self) {
        let task_ids = if let Ok(children) = self.children.lock() {
            children.keys().cloned().collect::<Vec<_>>()
        } else {
            Vec::new()
        };

        for task_id in task_ids {
            self.kill_task(&task_id);
        }
    }
}

fn spawn_task(state: &SharedState, params: StartTaskParams) -> Result<(), String> {
    let mut command = Command::new("claude");
    command
        .arg("-p")
        .arg(&params.prompt)
        .arg("--dangerously-skip-permissions");
    if let Some(profile) = params.profile.as_ref()
        && !profile.is_empty()
    {
        command.arg("--profile").arg(profile);
    }

    command.current_dir(&params.cwd);
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    command.env_remove("HOST");

    if let Ok(proxy) = env::var("CLAUDE_PROXY")
        && !proxy.is_empty()
    {
        command.env("ALL_PROXY", &proxy);
        command.env("HTTPS_PROXY", &proxy);
        command.env("HTTP_PROXY", &proxy);
    }

    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child = Arc::new(Mutex::new(child));

    if let Ok(mut children) = state.children.lock() {
        children.insert(params.task_id.clone(), Arc::clone(&child));
        state.running_tasks.fetch_add(1, Ordering::SeqCst);
    }

    if let Some(stdout) = stdout {
        let task_id = params.task_id.clone();
        let state = state.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(text) => {
                        let mut chunk = text;
                        chunk.push('\n');
                        state.send_chunk(&task_id, chunk, false);
                    }
                    Err(_) => break,
                }
            }
        });
    }

    if let Some(stderr) = stderr {
        let task_id = params.task_id.clone();
        let state = state.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                match line {
                    Ok(text) => {
                        let mut chunk = text;
                        chunk.push('\n');
                        state.send_chunk(&task_id, chunk, true);
                    }
                    Err(_) => break,
                }
            }
        });
    }

    {
        let task_id = params.task_id.clone();
        let state = state.clone();
        thread::spawn(move || {
            let status = if let Ok(mut guard) = child.lock() {
                guard.wait().ok()
            } else {
                None
            };
            state.remove_task(&task_id);
            match status {
                Some(exit_status) => {
                    state.send_done(&task_id, exit_status.code(), None);
                }
                None => {
                    state.send_done(&task_id, None, Some("task wait failed".to_string()));
                }
            }
        });
    }

    Ok(())
}

fn main() {
    let (mut protocol, output) = StdioProtocol::start();
    let state = SharedState {
        children: Arc::new(Mutex::new(HashMap::new())),
        output: output.clone(),
        running_tasks: Arc::new(AtomicUsize::new(0)),
    };

    protocol.run(|message| {
        match message {
            RuntimeMessage::Request { id, method, params } => match method.as_str() {
                "ready" | "runtimeStatus" => {
                    state.output.success(id, state.runtime_status());
                }
                "startTask" => match serde_json::from_value::<StartTaskParams>(params) {
                    Ok(params) => match spawn_task(&state, params) {
                        Ok(()) => state.output.success(id, serde_json::json!({ "ok": true })),
                        Err(error) => state.output.failure(id, error),
                    },
                    Err(error) => state.output.failure(id, error.to_string()),
                },
                "shutdown" => {
                    state.shutdown();
                    state.output.success(id, serde_json::json!({ "ok": true }));
                    return RuntimeControl::Shutdown;
                }
                _ => {
                    state
                        .output
                        .failure(id, format!("unsupported method: {method}"));
                }
            },
            RuntimeMessage::Notify { method, params } => {
                if method == "killTask"
                    && let Ok(params) = serde_json::from_value::<KillTaskParams>(params)
                {
                    state.kill_task(&params.task_id);
                }
            }
        }
        RuntimeControl::Continue
    });

    state.shutdown();
    drop(state);
    drop(output);
    protocol.finish();
}
