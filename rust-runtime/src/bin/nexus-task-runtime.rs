use nexus_rust_runtime::child_runtime_protocol::{
    ProtocolOutput, RuntimeControl, RuntimeMessage, StdioProtocol,
};
use nexus_rust_runtime::codex_home::CodexHomeConfig;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[cfg(unix)]
fn prepare_task_home(task_home: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    fs::create_dir_all(task_home)
        .map_err(|e| format!("failed to create task home {}: {e}", task_home.display()))?;
    fs::set_permissions(task_home, fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("failed to set 0700 on {}: {e}", task_home.display()))?;
    Ok(())
}

#[cfg(not(unix))]
fn prepare_task_home(task_home: &Path) -> Result<(), String> {
    fs::create_dir_all(task_home)
        .map_err(|e| format!("failed to create task home {}: {e}", task_home.display()))
}

#[cfg(unix)]
fn secure_task_home(task_home: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let dir_perm = fs::Permissions::from_mode(0o700);
    fs::set_permissions(task_home, dir_perm.clone())
        .map_err(|e| format!("failed to set 0700 on {}: {e}", task_home.display()))?;

    let codex_dir = task_home.join(".codex");
    if codex_dir.exists() {
        fs::set_permissions(&codex_dir, dir_perm)
            .map_err(|e| format!("failed to set 0700 on {}: {e}", codex_dir.display()))?;
    }

    let file_perm = fs::Permissions::from_mode(0o600);
    for secret_file in ["auth.json", "config.toml"] {
        let path = codex_dir.join(secret_file);
        if path.exists() {
            fs::set_permissions(&path, file_perm.clone())
                .map_err(|e| format!("failed to set 0600 on {}: {e}", path.display()))?;
        }
    }

    Ok(())
}

#[cfg(not(unix))]
fn secure_task_home(_task_home: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path)
        .map(|meta| meta.is_file() && (meta.permissions().mode() & 0o111 != 0))
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    fs::metadata(path)
        .map(|meta| meta.is_file())
        .unwrap_or(false)
}

const DANGEROUS_BYPASS_FLAG: &[u8] = b"--dangerously-bypass-approvals-and-sandbox";
const MAX_SCAN_BYTES: u64 = 32 * 1024;

fn contains_dangerous_bypass_flag(path: &Path) -> bool {
    use std::io::Read;

    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return false,
    };

    let mut reader = file.take(MAX_SCAN_BYTES);
    let mut buffer = Vec::new();
    if reader.read_to_end(&mut buffer).is_err() {
        return false;
    }

    buffer
        .windows(DANGEROUS_BYPASS_FLAG.len())
        .any(|window| window == DANGEROUS_BYPASS_FLAG)
}

pub(crate) fn select_safe_codex_candidate(raw_output: &str) -> Result<PathBuf, String> {
    let mut seen = std::collections::HashSet::new();
    for line in raw_output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let path = PathBuf::from(trimmed);
        if !seen.insert(path.clone()) {
            continue;
        }
        if is_executable(&path) && !contains_dangerous_bypass_flag(&path) {
            return Ok(path);
        }
    }

    Err("no safe codex executable found in PATH".to_string())
}

pub(crate) fn resolve_task_codex_executable() -> Result<PathBuf, String> {
    if let Ok(override_bin) = env::var("NEXUS_TASK_CODEX_EXECUTABLE") {
        let trimmed = override_bin.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            if is_executable(&path) {
                return Ok(path);
            }
            return Err(format!(
                "invalid NEXUS_TASK_CODEX_EXECUTABLE: {trimmed} is not an executable file"
            ));
        }
    }

    let output = Command::new("bash")
        .args(["-lc", "which -a codex"])
        .output()
        .map_err(|e| format!("failed to invoke bash to resolve codex executable: {e}"))?;

    if !output.status.success() {
        return Err("no codex executable found in PATH".to_string());
    }

    let stdout_str = String::from_utf8_lossy(&output.stdout);
    select_safe_codex_candidate(&stdout_str)
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StartTaskParams {
    task_id: String,
    prompt: String,
    cwd: String,
    #[serde(default)]
    engine: Option<String>,
    profile: Option<String>,
    #[serde(default)]
    codex_task_home: Option<String>,
    #[serde(default)]
    codex_configs_dir: Option<String>,
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

pub(crate) fn build_task_command(
    params: &StartTaskParams,
    source_home: Option<&Path>,
) -> Result<(Command, Option<PathBuf>), String> {
    let engine = params
        .engine
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("claude");

    match engine {
        "claude" => {
            let mut command = Command::new("claude");
            command
                .arg("-p")
                .arg(&params.prompt)
                .arg("--dangerously-skip-permissions");
            if let Some(profile) = params.profile.as_ref().filter(|p| !p.is_empty()) {
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

            Ok((command, None))
        }
        "codex" => {
            let task_home = if let Some(ref home_str) = params.codex_task_home {
                PathBuf::from(home_str)
            } else {
                env::temp_dir().join(format!("codex-task-runtime-{}", params.task_id))
            };

            let config = match params.profile.as_deref().filter(|p| !p.is_empty()) {
                Some(profile_id) => {
                    let configs_dir = params
                        .codex_configs_dir
                        .as_deref()
                        .map(PathBuf::from)
                        .ok_or_else(|| {
                            "codex configs dir required when profile is specified".to_string()
                        })?;
                    let config_file = configs_dir.join(format!("{profile_id}.json"));
                    CodexHomeConfig::read_file(&config_file)?
                }
                None => {
                    if let Some(source_home) = source_home {
                        CodexHomeConfig::read_global(source_home).unwrap_or_default()
                    } else {
                        CodexHomeConfig::default()
                    }
                }
            };

            if let Err(error) = prepare_task_home(&task_home) {
                let _ = fs::remove_dir_all(&task_home);
                return Err(error);
            }
            if let Err(error) = config.materialize(&task_home, &params.cwd, source_home) {
                let _ = fs::remove_dir_all(&task_home);
                return Err(error);
            }
            if let Err(error) = secure_task_home(&task_home) {
                let _ = fs::remove_dir_all(&task_home);
                return Err(format!(
                    "failed to secure task home {}: {error}",
                    task_home.display()
                ));
            }

            let task_codex_home = task_home.join(".codex");
            let codex_bin = match resolve_task_codex_executable() {
                Ok(bin) => bin,
                Err(error) => {
                    let _ = fs::remove_dir_all(&task_home);
                    return Err(error);
                }
            };
            let mut command = Command::new(&codex_bin);
            command
                .arg("--ask-for-approval")
                .arg("never")
                .arg("exec")
                .arg("--sandbox")
                .arg("workspace-write")
                .arg("--ephemeral")
                .arg("--skip-git-repo-check")
                .arg("--color")
                .arg("never")
                .arg("-C")
                .arg(&params.cwd)
                .arg("--")
                .arg(&params.prompt);

            command.current_dir(&params.cwd);
            command.stdin(Stdio::null());
            command.stdout(Stdio::piped());
            command.stderr(Stdio::piped());
            command.env_remove("HOST");
            command.env("HOME", &task_home);
            command.env("CODEX_HOME", &task_codex_home);
            command.env("LANG", "C.UTF-8");
            command.env("LC_ALL", "C.UTF-8");

            if let Ok(proxy) = env::var("NEXUS_PROXY")
                .or_else(|_| env::var("CLAUDE_PROXY"))
                .or_else(|_| env::var("HTTPS_PROXY"))
                .or_else(|_| env::var("HTTP_PROXY"))
                && !proxy.is_empty()
            {
                command.env("ALL_PROXY", &proxy);
                command.env("HTTPS_PROXY", &proxy);
                command.env("HTTP_PROXY", &proxy);
                command.env("http_proxy", &proxy);
                command.env("https_proxy", &proxy);
            }

            Ok((command, Some(task_home)))
        }
        unknown => Err(format!("unknown task engine: {unknown}")),
    }
}

pub(crate) fn wait_for_child_exit(
    child: &Arc<Mutex<Child>>,
    poll_interval: Duration,
) -> Option<std::process::ExitStatus> {
    loop {
        {
            let mut guard = child.lock().ok()?;
            match guard.try_wait() {
                Ok(Some(status)) => return Some(status),
                Ok(None) => {}
                Err(_) => return None,
            }
        }
        thread::sleep(poll_interval);
    }
}

fn spawn_task(state: &SharedState, params: StartTaskParams) -> Result<(), String> {
    let source_home = env::var("HOME")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from);

    let (mut command, cleanup_home) = build_task_command(&params, source_home.as_deref())?;

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            if let Some(ref home_path) = cleanup_home {
                let _ = fs::remove_dir_all(home_path);
            }
            return Err(error.to_string());
        }
    };
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
            // ponytail: 25ms poll interval balances prompt kill response vs CPU overhead
            let status = wait_for_child_exit(&child, Duration::from_millis(25));
            state.remove_task(&task_id);
            if let Some(ref home_path) = cleanup_home {
                let _ = fs::remove_dir_all(home_path);
            }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;
    use tempfile::tempdir;

    static ENV_LOCK: StdMutex<()> = StdMutex::new(());

    struct ScopedEnv {
        key: &'static str,
        original: Option<String>,
    }

    impl ScopedEnv {
        fn set(key: &'static str, value: &Path) -> Self {
            let original = env::var(key).ok();
            unsafe {
                env::set_var(key, value);
            }
            Self { key, original }
        }

        fn set_str(key: &'static str, value: &str) -> Self {
            let original = env::var(key).ok();
            unsafe {
                env::set_var(key, value);
            }
            Self { key, original }
        }
    }

    impl Drop for ScopedEnv {
        fn drop(&mut self) {
            unsafe {
                match &self.original {
                    Some(v) => env::set_var(self.key, v),
                    None => env::remove_var(self.key),
                }
            }
        }
    }

    #[test]
    fn build_task_command_defaults_to_claude_with_expected_args() {
        let params = StartTaskParams {
            task_id: "task-1".to_string(),
            prompt: "hello claude".to_string(),
            cwd: "/workspace/project".to_string(),
            engine: None,
            profile: Some("claude-prof".to_string()),
            codex_task_home: None,
            codex_configs_dir: None,
        };

        let (cmd, cleanup_home) = build_task_command(&params, None).unwrap();
        assert!(cleanup_home.is_none());
        assert_eq!(cmd.get_program(), "claude");
        let args: Vec<_> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert_eq!(
            args,
            vec![
                "-p",
                "hello claude",
                "--dangerously-skip-permissions",
                "--profile",
                "claude-prof"
            ]
        );
        assert_eq!(
            cmd.get_current_dir().unwrap(),
            Path::new("/workspace/project")
        );
    }

    #[test]
    fn build_task_command_codex_materializes_home_and_builds_exec_args() {
        let _guard = ENV_LOCK.lock().unwrap();
        let bin_dir = tempdir().unwrap();
        let fake_codex = bin_dir.path().join("fake-codex");
        fs::write(
            &fake_codex,
            "#!/bin/sh
exit 0
",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&fake_codex, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let _env_guard = ScopedEnv::set("NEXUS_TASK_CODEX_EXECUTABLE", &fake_codex);

        let dir = tempdir().unwrap();
        let configs_dir = dir.path().join("codex-configs");
        fs::create_dir_all(&configs_dir).unwrap();
        let profile_path = configs_dir.join("openai.json");
        fs::write(
            &profile_path,
            serde_json::json!({
                "OPENAI_API_KEY": "sk-test",
                "MODEL": "o3",
            })
            .to_string(),
        )
        .unwrap();

        let task_home = dir.path().join("task-home-1");
        let params = StartTaskParams {
            task_id: "task-codex-1".to_string(),
            prompt: "hello codex".to_string(),
            cwd: "/workspace/project".to_string(),
            engine: Some("codex".to_string()),
            profile: Some("openai".to_string()),
            codex_task_home: Some(task_home.to_string_lossy().to_string()),
            codex_configs_dir: Some(configs_dir.to_string_lossy().to_string()),
        };

        let (cmd, cleanup_home) = build_task_command(&params, None).unwrap();
        assert_eq!(cleanup_home, Some(task_home.clone()));
        assert_eq!(cmd.get_program(), fake_codex.as_os_str());
        let args: Vec<_> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert_eq!(
            args,
            vec![
                "--ask-for-approval",
                "never",
                "exec",
                "--sandbox",
                "workspace-write",
                "--ephemeral",
                "--skip-git-repo-check",
                "--color",
                "never",
                "-C",
                "/workspace/project",
                "--",
                "hello codex"
            ]
        );
        assert!(
            !args.iter().any(|a| a.contains("dangerously")),
            "codex command must not contain bypass flags"
        );
        let envs: std::collections::HashMap<_, _> = cmd
            .get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().to_string(),
                    v.map(|s| s.to_string_lossy().to_string()),
                )
            })
            .collect();
        assert_eq!(
            envs.get("HOME"),
            Some(&Some(task_home.to_string_lossy().to_string()))
        );
        assert_eq!(
            envs.get("CODEX_HOME"),
            Some(&Some(
                task_home.join(".codex").to_string_lossy().to_string()
            ))
        );
        assert!(task_home.join(".codex").join("config.toml").exists());
        assert!(task_home.join(".codex").join("auth.json").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let home_meta = fs::metadata(&task_home).unwrap();
            assert_eq!(home_meta.permissions().mode() & 0o777, 0o700);

            let codex_meta = fs::metadata(task_home.join(".codex")).unwrap();
            assert_eq!(codex_meta.permissions().mode() & 0o777, 0o700);

            let config_meta = fs::metadata(task_home.join(".codex/config.toml")).unwrap();
            assert_eq!(config_meta.permissions().mode() & 0o777, 0o600);

            let auth_meta = fs::metadata(task_home.join(".codex/auth.json")).unwrap();
            assert_eq!(auth_meta.permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn spawn_task_cleans_up_home_on_spawn_failure() {
        let dir = tempdir().unwrap();
        let task_home = dir.path().join("spawn-fail-home");
        let params = StartTaskParams {
            task_id: "task-fail".to_string(),
            prompt: "test".to_string(),
            cwd: "/nonexistent-directory-that-fails-exec".to_string(),
            engine: Some("codex".to_string()),
            profile: None,
            codex_task_home: Some(task_home.to_string_lossy().to_string()),
            codex_configs_dir: None,
        };

        let (_protocol, output) = StdioProtocol::start();
        let state = SharedState {
            children: Arc::new(Mutex::new(HashMap::new())),
            output,
            running_tasks: Arc::new(AtomicUsize::new(0)),
        };
        let result = spawn_task(&state, params);
        assert!(result.is_err());
        assert!(!task_home.exists());
    }

    #[test]
    fn build_task_command_cleans_up_home_when_materialization_fails() {
        let dir = tempdir().unwrap();
        let blocker_file = dir.path().join("unwritable-file");
        fs::write(&blocker_file, "blocking").unwrap();

        let task_home = blocker_file.join("task-home");
        let params = StartTaskParams {
            task_id: "task-fail-mat".to_string(),
            prompt: "test".to_string(),
            cwd: "/workspace".to_string(),
            engine: Some("codex".to_string()),
            profile: None,
            codex_task_home: Some(task_home.to_string_lossy().to_string()),
            codex_configs_dir: None,
        };

        let result = build_task_command(&params, None);
        assert!(result.is_err());
        assert!(!task_home.exists());
        assert!(blocker_file.exists());
    }

    #[test]
    fn build_task_command_cleans_up_home_when_executable_resolution_fails() {
        let _guard = ENV_LOCK.lock().unwrap();
        let _env_guard =
            ScopedEnv::set_str("NEXUS_TASK_CODEX_EXECUTABLE", "/nonexistent/codex/bin");
        let dir = tempdir().unwrap();
        let task_home = dir.path().join("task-home-bad-bin");
        let params = StartTaskParams {
            task_id: "task-fail-bin".to_string(),
            prompt: "test".to_string(),
            cwd: "/workspace".to_string(),
            engine: Some("codex".to_string()),
            profile: None,
            codex_task_home: Some(task_home.to_string_lossy().to_string()),
            codex_configs_dir: None,
        };
        let result = build_task_command(&params, None);
        assert!(result.is_err());
        assert!(!task_home.exists());
    }

    #[test]
    fn waiter_allows_kill_and_reaping_of_running_child() {
        // Spawn a long-running child (sleep 30)
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("timeout");
            c.arg("30");
            c
        } else {
            let mut c = Command::new("sleep");
            c.arg("30");
            c
        };
        let child = Arc::new(Mutex::new(cmd.spawn().expect("spawn long running child")));

        let child_for_wait = Arc::clone(&child);
        let wait_handle =
            thread::spawn(move || wait_for_child_exit(&child_for_wait, Duration::from_millis(10)));

        // Give the waiter thread a moment to start polling try_wait
        thread::sleep(Duration::from_millis(50));

        // Attempt kill under mutex lock - should succeed promptly without blocking
        let kill_started = std::time::Instant::now();
        {
            let mut guard = child.lock().expect("lock child for kill");
            guard.kill().expect("kill child");
        }
        assert!(
            kill_started.elapsed() < Duration::from_secs(2),
            "kill took too long to acquire child lock"
        );

        // Waiter thread should promptly reap exit status
        let exit_status = wait_handle.join().expect("join waiter thread");
        assert!(exit_status.is_some(), "expected exit status after kill");
    }

    #[test]
    fn build_task_command_rejects_unknown_engine() {
        let params = StartTaskParams {
            task_id: "task-invalid".to_string(),
            prompt: "do something".to_string(),
            cwd: "/workspace".to_string(),
            engine: Some("unsupported".to_string()),
            profile: None,
            codex_task_home: None,
            codex_configs_dir: None,
        };

        let result = build_task_command(&params, None);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("unknown task engine"));
    }

    #[test]
    fn build_task_command_codex_places_double_dash_before_subcommand_or_dash_prompts() {
        let _guard = ENV_LOCK.lock().unwrap();
        let bin_dir = tempdir().unwrap();
        let fake_codex = bin_dir.path().join("fake-codex");
        fs::write(
            &fake_codex,
            "#!/bin/sh
exit 0
",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&fake_codex, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let _env_guard = ScopedEnv::set("NEXUS_TASK_CODEX_EXECUTABLE", &fake_codex);

        let dir = tempdir().unwrap();
        let task_home = dir.path().join("task-home-flags");

        for prompt in [
            "review",
            "resume",
            "--dangerously-skip-permissions",
            "-m hello",
        ] {
            let params = StartTaskParams {
                task_id: "task-flags".to_string(),
                prompt: prompt.to_string(),
                cwd: "/workspace/project".to_string(),
                engine: Some("codex".to_string()),
                profile: None,
                codex_task_home: Some(task_home.to_string_lossy().to_string()),
                codex_configs_dir: None,
            };

            let (cmd, _cleanup) = build_task_command(&params, None).unwrap();
            let args: Vec<_> = cmd
                .get_args()
                .map(|a| a.to_string_lossy().to_string())
                .collect();
            assert_eq!(
                args,
                vec![
                    "--ask-for-approval",
                    "never",
                    "exec",
                    "--sandbox",
                    "workspace-write",
                    "--ephemeral",
                    "--skip-git-repo-check",
                    "--color",
                    "never",
                    "-C",
                    "/workspace/project",
                    "--",
                    prompt
                ]
            );
            let dash_dash_pos = args.iter().position(|a| a == "--").unwrap();
            assert_eq!(dash_dash_pos, args.len() - 2);
            assert_eq!(args.last().unwrap(), prompt);
        }
    }

    #[test]
    fn resolve_task_codex_executable_honors_valid_override_and_rejects_invalid() {
        let _guard = ENV_LOCK.lock().unwrap();
        let bin_dir = tempdir().unwrap();
        let valid_bin = bin_dir.path().join("custom-codex");
        fs::write(
            &valid_bin,
            "#!/bin/sh
exit 0
",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&valid_bin, fs::Permissions::from_mode(0o755)).unwrap();
        }

        {
            let _env_guard = ScopedEnv::set("NEXUS_TASK_CODEX_EXECUTABLE", &valid_bin);
            assert_eq!(resolve_task_codex_executable().unwrap(), valid_bin);
        }

        {
            let _env_guard =
                ScopedEnv::set_str("NEXUS_TASK_CODEX_EXECUTABLE", "/nonexistent/codex/bin");
            assert!(resolve_task_codex_executable().is_err());
        }
    }
    #[test]
    fn select_safe_codex_candidate_skips_bypass_wrappers_and_picks_safe_executable() {
        let dir = tempdir().unwrap();
        let bypass_wrapper = dir.path().join("bypass-wrapper");
        fs::write(
            &bypass_wrapper,
            "#!/bin/sh\nexec real-codex --dangerously-bypass-approvals-and-sandbox \"$@\"\n",
        )
        .unwrap();

        let non_executable = dir.path().join("safe-non-exec");
        fs::write(
            &non_executable,
            "#!/bin/sh
exit 0
",
        )
        .unwrap();

        let safe_candidate = dir.path().join("safe-codex");
        fs::write(
            &safe_candidate,
            "#!/usr/bin/env node
console.log('ok');
",
        )
        .unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&bypass_wrapper, fs::Permissions::from_mode(0o755)).unwrap();
            fs::set_permissions(&non_executable, fs::Permissions::from_mode(0o644)).unwrap();
            fs::set_permissions(&safe_candidate, fs::Permissions::from_mode(0o755)).unwrap();
        }

        let raw_candidates = format!(
            "{}
{}
{}
{}
{}
",
            bypass_wrapper.display(),
            bypass_wrapper.display(),
            non_executable.display(),
            safe_candidate.display(),
            safe_candidate.display()
        );

        let selected = select_safe_codex_candidate(&raw_candidates).unwrap();
        assert_eq!(selected, safe_candidate);
    }

    #[test]
    fn select_safe_codex_candidate_fails_when_only_bypass_or_non_executable_exist() {
        let dir = tempdir().unwrap();
        let bypass_wrapper = dir.path().join("bypass-wrapper");
        fs::write(
            &bypass_wrapper,
            "#!/bin/sh\nexec real-codex --dangerously-bypass-approvals-and-sandbox \"$@\"\n",
        )
        .unwrap();

        let non_executable = dir.path().join("safe-non-exec");
        fs::write(
            &non_executable,
            "#!/bin/sh
exit 0
",
        )
        .unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&bypass_wrapper, fs::Permissions::from_mode(0o755)).unwrap();
            fs::set_permissions(&non_executable, fs::Permissions::from_mode(0o644)).unwrap();
        }

        let raw_candidates = format!(
            "{}
{}
/nonexistent/path/codex
",
            bypass_wrapper.display(),
            non_executable.display()
        );

        let result = select_safe_codex_candidate(&raw_candidates);
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            "no safe codex executable found in PATH"
        );

        let empty_result = select_safe_codex_candidate(
            "

",
        );
        assert!(empty_result.is_err());
    }
}
