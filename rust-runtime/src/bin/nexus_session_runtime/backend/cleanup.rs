use super::super::tmux_backend::{CodexResumeWindow, TmuxSessionBackend};
use super::support::{
    CODEX_RESUME_SESSION_METADATA_KEY, cleanup_codex_runtime, native_backend_enabled,
    native_window_id, terminate_native_processes,
};
use nexus_rust_runtime::native_session_registry::NativeSessionRegistry;

trait CodexSessionCleanupPort {
    fn close_resume_channels(
        &self,
        project_name: &str,
        session_id: &str,
        default_shell_cmd: &str,
    ) -> Result<Vec<usize>, String>;
}

pub(crate) struct CodexSessionCleanup {
    port: Box<dyn CodexSessionCleanupPort>,
}

impl CodexSessionCleanup {
    pub(crate) fn current() -> Result<Self, String> {
        Ok(Self {
            port: current_cleanup_port()?,
        })
    }

    #[cfg(test)]
    fn with_port(port: Box<dyn CodexSessionCleanupPort>) -> Self {
        Self { port }
    }

    pub(crate) fn close_resume_channels(
        &self,
        project_name: &str,
        session_id: &str,
        default_shell_cmd: &str,
    ) -> Result<Vec<usize>, String> {
        if project_name.is_empty() || session_id.is_empty() {
            return Ok(Vec::new());
        }
        self.port
            .close_resume_channels(project_name, session_id, default_shell_cmd)
    }
}

fn current_cleanup_port() -> Result<Box<dyn CodexSessionCleanupPort>, String> {
    if native_backend_enabled() {
        Ok(Box::new(NativeCleanupPort {
            registry: NativeSessionRegistry::open_default()?,
        }))
    } else {
        Ok(Box::new(TmuxCleanupPort {
            backend: TmuxSessionBackend::new(),
        }))
    }
}

struct TmuxCleanupPort {
    backend: TmuxSessionBackend,
}

impl CodexSessionCleanupPort for TmuxCleanupPort {
    fn close_resume_channels(
        &self,
        project_name: &str,
        session_id: &str,
        default_shell_cmd: &str,
    ) -> Result<Vec<usize>, String> {
        close_tmux_resume_windows(&self.backend, project_name, session_id, default_shell_cmd)
            .map(|windows| windows.into_iter().map(|window| window.index).collect())
    }
}

struct NativeCleanupPort {
    registry: NativeSessionRegistry,
}

impl CodexSessionCleanupPort for NativeCleanupPort {
    fn close_resume_channels(
        &self,
        project_name: &str,
        session_id: &str,
        default_shell_cmd: &str,
    ) -> Result<Vec<usize>, String> {
        let matched_channels = self.registry.list_channels_by_metadata(
            project_name,
            CODEX_RESUME_SESSION_METADATA_KEY,
            session_id,
        )?;
        if self.registry.list_channels(project_name)?.len() <= matched_channels.len()
            && !default_shell_cmd.trim().is_empty()
        {
            let cwd = self.registry.get_project_cwd(project_name)?;
            self.registry
                .create_channel(project_name, &cwd, "shell", default_shell_cmd)?;
        }
        let mut closed = Vec::with_capacity(matched_channels.len());
        for channel in matched_channels {
            terminate_native_processes(
                &self
                    .registry
                    .running_processes_for_channel(project_name, channel.index)?,
            )?;
            self.registry.delete_channel(project_name, channel.index)?;
            cleanup_codex_runtime(&native_window_id(project_name, channel.index));
            closed.push(channel.index as usize);
        }
        Ok(closed)
    }
}

fn close_tmux_resume_windows(
    backend: &TmuxSessionBackend,
    session_name: &str,
    session_id: &str,
    default_shell_cmd: &str,
) -> Result<Vec<CodexResumeWindow>, String> {
    let (windows, total_windows) = backend.list_codex_resume_windows_with_total(session_name);
    let matched_windows = windows
        .into_iter()
        .filter(|window| window.resume_session_id == session_id)
        .collect::<Vec<_>>();
    if matched_windows.is_empty() {
        return Ok(Vec::new());
    }
    if total_windows <= matched_windows.len() {
        backend.run(&[
            "new-window".to_string(),
            "-t".to_string(),
            session_name.to_string(),
            "-n".to_string(),
            "shell".to_string(),
            default_shell_cmd.to_string(),
        ])?;
    }
    for window in &matched_windows {
        backend.run(&[
            "kill-window".to_string(),
            "-t".to_string(),
            window.window_id.clone(),
        ])?;
        cleanup_codex_runtime(&window.window_id);
    }
    Ok(matched_windows)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeCleanupPort;

    impl CodexSessionCleanupPort for FakeCleanupPort {
        fn close_resume_channels(
            &self,
            _project_name: &str,
            _session_id: &str,
            _default_shell_cmd: &str,
        ) -> Result<Vec<usize>, String> {
            Ok(vec![2, 4])
        }
    }

    #[test]
    fn cleanup_contract_accepts_a_local_fake_without_process_dependencies() {
        let cleanup = CodexSessionCleanup::with_port(Box::new(FakeCleanupPort));
        assert_eq!(
            cleanup
                .close_resume_channels("demo", "session", "zsh")
                .expect("cleanup"),
            vec![2, 4]
        );
    }
}
