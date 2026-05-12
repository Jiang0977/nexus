use std::env;
use std::path::Path;

pub fn normalize_shell_type(raw: Option<&str>) -> String {
    match raw.unwrap_or_default() {
        "claude" => "claude".to_string(),
        "codex" => "codex".to_string(),
        _ => "bash".to_string(),
    }
}

pub fn uses_claude_profile(shell_type: &str) -> bool {
    shell_type == "claude"
}

pub fn uses_codex_profile(shell_type: &str) -> bool {
    shell_type == "codex"
}

pub fn uses_shell_profile(shell_type: &str) -> bool {
    uses_claude_profile(shell_type) || uses_codex_profile(shell_type)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeShellLaunchPlan {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: String,
}

pub fn build_native_shell_launch_plan(
    project_root: &Path,
    proxy_vars: &[(String, String)],
    shell_type: &str,
    profile: Option<&str>,
    cwd: &str,
    resume_session_id: Option<&str>,
) -> Option<NativeShellLaunchPlan> {
    if uses_codex_profile(shell_type) {
        return Some(NativeShellLaunchPlan {
            program: "bash".to_string(),
            args: vec![
                project_root
                    .join("nexus-run-codex.sh")
                    .to_string_lossy()
                    .to_string(),
                profile.unwrap_or("").to_string(),
                cwd.to_string(),
                resume_session_id.unwrap_or("").to_string(),
            ],
            env: proxy_vars.to_vec(),
            cwd: cwd.to_string(),
        });
    }

    if uses_claude_profile(shell_type)
        && let Some(profile) = profile.filter(|value| !value.is_empty())
    {
        return Some(NativeShellLaunchPlan {
            program: "bash".to_string(),
            args: vec![
                project_root
                    .join("nexus-run-claude.sh")
                    .to_string_lossy()
                    .to_string(),
                profile.to_string(),
                cwd.to_string(),
            ],
            env: proxy_vars.to_vec(),
            cwd: cwd.to_string(),
        });
    }

    if uses_shell_profile(shell_type) {
        return None;
    }

    Some(NativeShellLaunchPlan {
        program: default_native_shell_program(),
        args: default_native_shell_args(),
        env: proxy_vars.to_vec(),
        cwd: cwd.to_string(),
    })
}

fn default_native_shell_program() -> String {
    if let Some(shell) = non_empty_env("NEXUS_NATIVE_SHELL") {
        return shell;
    }

    if cfg!(windows) {
        return non_empty_env("SHELL")
            .or_else(|| non_empty_env("COMSPEC"))
            .unwrap_or_else(|| "pwsh".to_string());
    }

    non_empty_env("SHELL").unwrap_or_else(|| {
        if cfg!(target_os = "macos") {
            "/bin/zsh".to_string()
        } else {
            "/bin/bash".to_string()
        }
    })
}

fn default_native_shell_args() -> Vec<String> {
    if cfg!(windows) {
        let program = default_native_shell_program().to_ascii_lowercase();
        if program.contains("pwsh") || program.contains("powershell") {
            return vec!["-NoLogo".to_string()];
        }
        return Vec::new();
    }

    vec!["-i".to_string()]
}

fn non_empty_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub fn build_interactive_shell_command(
    project_root: &Path,
    proxy_vars: &[(String, String)],
    default_interactive_shell: &str,
    shell_type: &str,
    profile: Option<&str>,
    cwd: &str,
    resume_session_id: Option<&str>,
) -> String {
    let proxy_prefix = build_proxy_export_prefix(proxy_vars);
    let mut command = default_interactive_shell.to_string();

    if uses_claude_profile(shell_type) {
        command = match profile.filter(|value| !value.is_empty()) {
            Some(profile) => {
                let run_script = project_root.join("nexus-run-claude.sh");
                wrap_interactive_shell_command(&format!(
                    "bash {} {} {}",
                    shell_quote(&run_script.to_string_lossy()),
                    shell_quote(profile),
                    shell_quote(cwd),
                ))
            }
            None => {
                wrap_interactive_shell_command("claude --dangerously-skip-permissions; exec zsh -i")
            }
        };
    } else if uses_codex_profile(shell_type) {
        let run_script = project_root.join("nexus-run-codex.sh");
        command = wrap_interactive_shell_command(&format!(
            "bash {} {} {} {}",
            shell_quote(&run_script.to_string_lossy()),
            shell_quote(profile.unwrap_or("")),
            shell_quote(cwd),
            shell_quote(resume_session_id.unwrap_or("")),
        ));
    }

    if proxy_prefix.is_empty() {
        command
    } else {
        format!("{proxy_prefix}; {command}")
    }
}

pub fn build_window_name(cwd: &str, fallback_name: &str) -> String {
    let name = cwd.trim_matches('/').replace('/', "-");
    if name.is_empty() {
        fallback_name.to_string()
    } else {
        name
    }
}

pub fn derive_project_session_name(cwd: &str) -> String {
    let mut project_name = cwd.trim_matches('/').replace('/', "-");
    if project_name.is_empty() {
        project_name = "home".to_string();
    }

    let safe_name = project_name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '-'
            }
        })
        .take(50)
        .collect::<String>();

    if safe_name.is_empty() {
        "project".to_string()
    } else {
        safe_name
    }
}

pub fn derive_initial_window_name(cwd: &str, profile: Option<&str>) -> String {
    let dir_name = cwd
        .trim_matches('/')
        .split('/')
        .rfind(|segment| !segment.is_empty())
        .unwrap_or("~");

    match profile.filter(|value| !value.is_empty()) {
        Some(profile) => format!("{dir_name}-{profile}"),
        None => dir_name.to_string(),
    }
}

pub fn next_available_name(base_name: &str, existing_names: &[String]) -> String {
    let mut candidate = base_name.to_string();
    let mut counter = 1;
    while existing_names.iter().any(|existing| existing == &candidate) {
        candidate = format!("{base_name}-{counter}");
        counter += 1;
    }
    candidate
}

fn shell_quote(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

fn build_proxy_export_prefix(proxy_vars: &[(String, String)]) -> String {
    proxy_vars
        .iter()
        .map(|(key, value)| format!("export {key}={}", shell_quote(value)))
        .collect::<Vec<_>>()
        .join("; ")
}

fn wrap_interactive_shell_command(command: &str) -> String {
    format!("unset HOST; {command}")
}

#[cfg(test)]
mod tests {
    use super::{
        build_interactive_shell_command, build_window_name, derive_initial_window_name,
        derive_project_session_name, next_available_name, normalize_shell_type,
    };
    use std::path::Path;

    #[test]
    fn normalizes_shell_types() {
        assert_eq!(normalize_shell_type(Some("claude")), "claude");
        assert_eq!(normalize_shell_type(Some("codex")), "codex");
        assert_eq!(normalize_shell_type(Some("zsh")), "bash");
    }

    #[test]
    fn builds_window_and_project_names() {
        assert_eq!(
            build_window_name("/workspace/apps/demo", "shell"),
            "workspace-apps-demo"
        );
        assert_eq!(
            derive_project_session_name("/workspace/demo"),
            "workspace-demo"
        );
        assert_eq!(
            derive_initial_window_name("/workspace/demo", Some("work")),
            "demo-work"
        );
        assert_eq!(
            next_available_name("review", &["review".to_string(), "review-1".to_string()]),
            "review-2"
        );
    }

    #[test]
    fn builds_codex_command_with_proxy_exports() {
        let command = build_interactive_shell_command(
            Path::new("/repo"),
            &[("HTTPS_PROXY".to_string(), "http://proxy.local".to_string())],
            "unset HOST; exec zsh -i",
            "codex",
            Some("work"),
            "/workspace/demo",
            Some("session-1"),
        );

        assert!(command.contains("export HTTPS_PROXY=\"http://proxy.local\""));
        assert!(command.contains("nexus-run-codex.sh"));
        assert!(command.contains("\"work\""));
        assert!(command.contains("\"/workspace/demo\""));
        assert!(command.contains("\"session-1\""));
    }
}
