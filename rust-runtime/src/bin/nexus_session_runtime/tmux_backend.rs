use std::collections::HashMap;
use std::process::{Command, Stdio};

pub(crate) struct DiscoverableSession {
    pub(crate) name: String,
    pub(crate) windows: usize,
    pub(crate) attached: bool,
    pub(crate) path: String,
}

pub(crate) struct CodexResumeWindow {
    pub(crate) window_id: String,
    pub(crate) index: usize,
    pub(crate) resume_session_id: String,
}

#[derive(Clone, Copy, Default)]
pub(crate) struct TmuxSessionBackend;

impl TmuxSessionBackend {
    pub(crate) fn new() -> Self {
        Self
    }

    pub(crate) fn session_exists(&self, session: &str) -> bool {
        Command::new("tmux")
            .args(["has-session", "-t", session])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    pub(crate) fn run(&self, args: &[String]) -> Result<(), String> {
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

    pub(crate) fn capture(&self, args: &[String]) -> Result<String, String> {
        let output = Command::new("tmux")
            .args(args)
            .output()
            .map_err(|error| error.to_string())?;
        if output.status.success() {
            return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
        }

        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if !stderr.is_empty() {
            Err(stderr)
        } else {
            Err(format!("tmux command failed: {}", args.join(" ")))
        }
    }

    pub(crate) fn read_env_value(&self, session: &str, key: &str) -> String {
        match self.capture(&[
            "show-environment".to_string(),
            "-t".to_string(),
            session.to_string(),
            key.to_string(),
        ]) {
            Ok(output) => output
                .strip_prefix(&format!("{}=", key))
                .unwrap_or("")
                .trim()
                .to_string(),
            Err(_) => String::new(),
        }
    }

    pub(crate) fn read_session_discovery_path(
        &self,
        session: &str,
        windows_count: usize,
    ) -> String {
        let session_path = self.read_env_value(session, "NEXUS_CWD");
        if !session_path.is_empty() {
            return session_path;
        }
        if windows_count == 0 {
            return String::new();
        }
        match self.capture(&[
            "list-windows".to_string(),
            "-t".to_string(),
            session.to_string(),
            "-F".to_string(),
            "#{pane_current_path}".to_string(),
        ]) {
            Ok(output) => output.lines().next().unwrap_or("").trim().to_string(),
            Err(_) => String::new(),
        }
    }

    pub(crate) fn resolve_project_path(&self, session_name: &str, workspace_root: &str) -> String {
        let env_cwd = self.read_env_value(session_name, "NEXUS_CWD");
        if !env_cwd.is_empty() {
            return env_cwd;
        }

        if let Ok(pane_path) = self.capture(&[
            "display-message".to_string(),
            "-t".to_string(),
            session_name.to_string(),
            "-p".to_string(),
            "#{pane_current_path}".to_string(),
        ]) && !pane_path.is_empty()
        {
            return pane_path;
        }

        workspace_root.to_string()
    }

    pub(crate) fn list_discoverable_sessions(
        &self,
        current_session: &str,
        workspace_root: &str,
    ) -> Vec<DiscoverableSession> {
        match self.capture(&[
            "list-sessions".to_string(),
            "-F".to_string(),
            "#{session_name}|#{session_windows}|#{session_attached}".to_string(),
        ]) {
            Ok(stdout) => stdout
                .lines()
                .filter(|line| !line.trim().is_empty())
                .filter_map(|line| {
                    let mut parts = line.splitn(3, '|');
                    let name = parts.next().unwrap_or("").trim().to_string();
                    if name.is_empty() || is_internal_session(&name) {
                        return None;
                    }
                    let windows = parts
                        .next()
                        .unwrap_or("0")
                        .trim()
                        .parse::<usize>()
                        .unwrap_or(0);
                    let attached = parts
                        .next()
                        .unwrap_or("0")
                        .trim()
                        .parse::<usize>()
                        .unwrap_or(0)
                        > 0;
                    let path = self.read_session_discovery_path(&name, windows);
                    Some(DiscoverableSession {
                        name,
                        windows,
                        attached,
                        path,
                    })
                })
                .collect(),
            Err(_) => vec![DiscoverableSession {
                name: current_session.to_string(),
                windows: 0,
                attached: false,
                path: workspace_root.to_string(),
            }],
        }
    }

    pub(crate) fn list_all_session_names(&self) -> Result<Vec<String>, String> {
        Ok(self
            .capture(&[
                "list-sessions".to_string(),
                "-F".to_string(),
                "#{session_name}".to_string(),
            ])?
            .lines()
            .map(|line| line.trim().to_string())
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>())
    }

    pub(crate) fn ensure_session(
        &self,
        session: &str,
        default_shell_cmd: &str,
    ) -> Result<(), String> {
        if self.session_exists(session) {
            return Ok(());
        }

        self.run(&[
            "new-session".to_string(),
            "-d".to_string(),
            "-s".to_string(),
            session.to_string(),
            "-n".to_string(),
            "shell".to_string(),
            default_shell_cmd.to_string(),
        ])
    }

    pub(crate) fn set_env(&self, session: &str, key: &str, value: &str) -> Result<(), String> {
        self.run(&[
            "set-environment".to_string(),
            "-t".to_string(),
            session.to_string(),
            key.to_string(),
            value.to_string(),
        ])
    }

    pub(crate) fn apply_proxy_vars(
        &self,
        session: &str,
        proxy_vars: HashMap<String, String>,
    ) -> Result<(), String> {
        for (key, value) in proxy_vars {
            self.set_env(session, &key, &value)?;
        }
        Ok(())
    }

    pub(crate) fn mark_session_owned_by_current_instance(
        &self,
        session: &str,
        owner_session: &str,
    ) {
        if owner_session.trim().is_empty() {
            return;
        }
        let _ = self.set_env(session, "NEXUS_OWNER_SESSION", owner_session);
    }

    pub(crate) fn list_window_ids(&self, session: &str) -> Vec<String> {
        self.capture(&[
            "list-windows".to_string(),
            "-t".to_string(),
            session.to_string(),
            "-F".to_string(),
            "#{window_id}".to_string(),
        ])
        .map(|output| {
            output
                .lines()
                .map(|line| line.trim().to_string())
                .filter(|line| !line.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
    }

    pub(crate) fn count_windows(&self, session: &str) -> Result<usize, String> {
        self.capture(&[
            "list-windows".to_string(),
            "-t".to_string(),
            session.to_string(),
            "-F".to_string(),
            "#{window_index}".to_string(),
        ])
        .map(|output| {
            output
                .lines()
                .filter(|line| !line.trim().is_empty())
                .count()
        })
    }

    pub(crate) fn window_id(&self, target: &str) -> String {
        self.capture(&[
            "display-message".to_string(),
            "-t".to_string(),
            target.to_string(),
            "-p".to_string(),
            "#{window_id}".to_string(),
        ])
        .unwrap_or_default()
    }

    pub(crate) fn mark_window_as_codex_resume_session(
        &self,
        window_target: &str,
        session_id: &str,
    ) -> Result<(), String> {
        if window_target.is_empty() || session_id.is_empty() {
            return Ok(());
        }

        self.run(&[
            "set-option".to_string(),
            "-w".to_string(),
            "-t".to_string(),
            window_target.to_string(),
            "@nexus_codex_resume_session_id".to_string(),
            session_id.to_string(),
        ])
    }

    pub(crate) fn list_codex_resume_windows_with_total(
        &self,
        session_name: &str,
    ) -> (Vec<CodexResumeWindow>, usize) {
        let output = self
            .capture(&[
                "list-windows".to_string(),
                "-t".to_string(),
                session_name.to_string(),
                "-F".to_string(),
                "#{window_id}|#{window_index}|#{@nexus_codex_resume_session_id}".to_string(),
            ])
            .unwrap_or_default();
        let total_windows = output
            .lines()
            .filter(|line| !line.trim().is_empty())
            .count();

        (parse_codex_resume_windows(&output), total_windows)
    }
}

fn is_internal_session(session: &str) -> bool {
    session.trim().starts_with("nexus-pty-")
}

fn parse_codex_resume_windows(output: &str) -> Vec<CodexResumeWindow> {
    output
        .lines()
        .filter_map(|raw_line| {
            let line = raw_line.trim();
            if line.is_empty() {
                return None;
            }
            let mut parts = line.splitn(3, '|');
            let window_id = parts.next().unwrap_or("").to_string();
            let index = parts.next().unwrap_or("").parse::<usize>().ok()?;
            let resume_session_id = parts.next().unwrap_or("").to_string();
            if window_id.is_empty() {
                return None;
            }
            Some(CodexResumeWindow {
                window_id,
                index,
                resume_session_id,
            })
        })
        .collect()
}
