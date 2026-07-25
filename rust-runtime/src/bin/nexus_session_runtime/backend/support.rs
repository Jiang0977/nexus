use super::super::{WindowIndex, current_codex_runtime_dir};
use nexus_rust_runtime::native_session_registry::NativeProcessInstance;
use std::fs;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

pub(super) const CODEX_RESUME_SESSION_METADATA_KEY: &str = "@nexus_codex_resume_session_id";

pub(super) fn native_backend_enabled() -> bool {
    std::env::var("NEXUS_SESSION_BACKEND")
        .ok()
        .map(|value| value.trim().eq_ignore_ascii_case("native"))
        .unwrap_or(false)
}

pub(super) fn session_window_target(session: &str, index: &WindowIndex) -> String {
    format!("{}:{}", session, index.as_string())
}

pub(super) fn native_window_index(index: &WindowIndex) -> Result<u32, String> {
    index
        .as_string()
        .parse::<u32>()
        .map_err(|_| "invalid native window index".to_string())
}

pub(super) fn native_window_id(session_name: &str, channel_index: u32) -> String {
    format!("native:{session_name}:{channel_index}")
}

pub(super) fn cleanup_codex_runtime(window_id: &str) {
    if window_id.trim().is_empty() {
        return;
    }
    let safe_window_id = window_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>();
    let _ = fs::remove_dir_all(current_codex_runtime_dir().join(safe_window_id));
}

fn native_pid_alive(pid: u32) -> bool {
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

fn wait_for_native_pid_exit(pid: u32) -> bool {
    for _ in 0..20 {
        if !native_pid_alive(pid) {
            return true;
        }
        thread::sleep(Duration::from_millis(50));
    }
    !native_pid_alive(pid)
}

fn terminate_native_process(process: &NativeProcessInstance) -> Result<(), String> {
    let Some(pid) = process.os_pid else {
        return Ok(());
    };
    if !native_pid_alive(pid) {
        return Ok(());
    }
    let status = if cfg!(windows) {
        Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .status()
    } else {
        Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .status()
    }
    .map_err(|error| error.to_string())?;

    if status.success() && wait_for_native_pid_exit(pid) {
        Ok(())
    } else if !cfg!(windows) {
        let kill_status = Command::new("kill")
            .args(["-KILL", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .status()
            .map_err(|error| error.to_string())?;
        if kill_status.success() && wait_for_native_pid_exit(pid) {
            Ok(())
        } else {
            Err(format!(
                "failed to terminate native process pid {} for {}:{}",
                pid, process.project_name, process.channel_index
            ))
        }
    } else {
        Err(format!(
            "failed to terminate native process pid {} for {}:{}",
            pid, process.project_name, process.channel_index
        ))
    }
}

pub(super) fn terminate_native_processes(
    processes: &[NativeProcessInstance],
) -> Result<(), String> {
    let errors = processes
        .iter()
        .filter_map(|process| terminate_native_process(process).err())
        .collect::<Vec<_>>();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "native process cleanup failed: {}",
            errors.join("; ")
        ))
    }
}
