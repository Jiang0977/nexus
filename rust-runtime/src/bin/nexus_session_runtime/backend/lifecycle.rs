use super::super::tmux_backend::TmuxSessionBackend;
use super::super::{
    AttachSessionWindowParams, CreateProjectChannelParams, CreateProjectParams,
    CreateResumeWindowParams, DeleteProjectParams, DeleteSessionWindowParams, RenameProjectParams,
    RenameSessionWindowParams, ResumeCodexSessionParams, SharedState,
};
use super::support::{
    CODEX_RESUME_SESSION_METADATA_KEY, cleanup_codex_runtime, native_backend_enabled,
    native_window_id, native_window_index, session_window_target, terminate_native_processes,
};
use nexus_rust_runtime::native_session_registry::NativeSessionRegistry;
use serde_json::{Value, json};
use std::sync::atomic::Ordering;

trait SessionLifecyclePort {
    fn create_project(&self, params: CreateProjectParams) -> Result<Value, String>;
    fn create_project_channel(&self, params: CreateProjectChannelParams) -> Result<Value, String>;
    fn create_resume_window(&self, params: CreateResumeWindowParams) -> Result<Value, String>;
    fn resume_codex_session(&self, params: ResumeCodexSessionParams) -> Result<Value, String>;
    fn rename_project(&self, params: RenameProjectParams) -> Result<Value, String>;
    fn delete_project(&self, params: DeleteProjectParams) -> Result<Value, String>;
    fn attach_session_window(&self, params: AttachSessionWindowParams) -> Result<Value, String>;
    fn rename_session_window(&self, params: RenameSessionWindowParams) -> Result<Value, String>;
    fn delete_session_window(&self, params: DeleteSessionWindowParams) -> Result<Value, String>;
}

pub(crate) struct SessionLifecycle {
    port: Box<dyn SessionLifecyclePort>,
}

impl SessionLifecycle {
    pub(crate) fn current() -> Result<Self, String> {
        Ok(Self {
            port: current_lifecycle_port()?,
        })
    }

    #[cfg(test)]
    fn with_port(port: Box<dyn SessionLifecyclePort>) -> Self {
        Self { port }
    }

    pub(crate) fn create_project(
        &self,
        state: &SharedState,
        params: CreateProjectParams,
    ) -> Result<Value, String> {
        let result = self.port.create_project(params)?;
        state.projects_created.fetch_add(1, Ordering::SeqCst);
        state.windows_created.fetch_add(1, Ordering::SeqCst);
        Ok(result)
    }

    pub(crate) fn create_project_channel(
        &self,
        state: &SharedState,
        params: CreateProjectChannelParams,
    ) -> Result<Value, String> {
        let result = self.port.create_project_channel(params)?;
        state.windows_created.fetch_add(1, Ordering::SeqCst);
        Ok(result)
    }

    pub(crate) fn create_resume_window(
        &self,
        state: &SharedState,
        params: CreateResumeWindowParams,
    ) -> Result<Value, String> {
        let result = self.port.create_resume_window(params)?;
        state.windows_created.fetch_add(1, Ordering::SeqCst);
        Ok(result)
    }

    pub(crate) fn resume_codex_session(
        &self,
        state: &SharedState,
        params: ResumeCodexSessionParams,
    ) -> Result<Value, String> {
        let result = self.port.resume_codex_session(params)?;
        state.windows_created.fetch_add(1, Ordering::SeqCst);
        Ok(result)
    }

    pub(crate) fn rename_project(&self, params: RenameProjectParams) -> Result<Value, String> {
        self.port.rename_project(params)
    }

    pub(crate) fn delete_project(&self, params: DeleteProjectParams) -> Result<Value, String> {
        self.port.delete_project(params)
    }

    pub(crate) fn attach_session_window(
        &self,
        params: AttachSessionWindowParams,
    ) -> Result<Value, String> {
        self.port.attach_session_window(params)
    }

    pub(crate) fn rename_session_window(
        &self,
        params: RenameSessionWindowParams,
    ) -> Result<Value, String> {
        self.port.rename_session_window(params)
    }

    pub(crate) fn delete_session_window(
        &self,
        params: DeleteSessionWindowParams,
    ) -> Result<Value, String> {
        self.port.delete_session_window(params)
    }
}

fn current_lifecycle_port() -> Result<Box<dyn SessionLifecyclePort>, String> {
    if native_backend_enabled() {
        Ok(Box::new(NativeLifecyclePort {
            registry: NativeSessionRegistry::open_default()?,
        }))
    } else {
        Ok(Box::new(TmuxLifecyclePort {
            backend: TmuxSessionBackend::new(),
            owner_session: super::super::env_or_default("TMUX_SESSION", "nexus"),
        }))
    }
}

struct TmuxLifecyclePort {
    backend: TmuxSessionBackend,
    owner_session: String,
}

impl TmuxLifecyclePort {
    fn mark_owned(&self, session: &str) {
        self.backend
            .mark_session_owned_by_current_instance(session, &self.owner_session);
    }
}

impl SessionLifecyclePort for TmuxLifecyclePort {
    fn create_project(&self, params: CreateProjectParams) -> Result<Value, String> {
        self.backend.run(&[
            "new-session".to_string(),
            "-d".to_string(),
            "-s".to_string(),
            params.session_name.clone(),
            "-n".to_string(),
            params.initial_window_name,
            "-c".to_string(),
            params.cwd.clone(),
            params.shell_cmd,
        ])?;
        self.backend
            .set_env(&params.session_name, "NEXUS_CWD", &params.cwd)?;
        self.backend
            .apply_proxy_vars(&params.session_name, params.proxy_vars)?;
        self.mark_owned(&params.session_name);
        Ok(json!({ "ok": true }))
    }

    fn create_project_channel(&self, params: CreateProjectChannelParams) -> Result<Value, String> {
        self.backend
            .ensure_session(&params.session_name, &params.default_shell_cmd)?;
        self.backend
            .apply_proxy_vars(&params.session_name, params.proxy_vars)?;
        self.backend.run(&[
            "new-window".to_string(),
            "-t".to_string(),
            params.session_name.clone(),
            "-c".to_string(),
            params.cwd,
            "-n".to_string(),
            params.channel_name,
            params.shell_cmd,
        ])?;
        self.mark_owned(&params.session_name);
        Ok(json!({ "ok": true }))
    }

    fn create_resume_window(&self, params: CreateResumeWindowParams) -> Result<Value, String> {
        self.backend
            .ensure_session(&params.session_name, &params.default_shell_cmd)?;
        self.backend
            .apply_proxy_vars(&params.session_name, params.proxy_vars)?;
        let output = self.backend.capture(&[
            "new-window".to_string(),
            "-P".to_string(),
            "-F".to_string(),
            "#{window_id}|#{window_index}|#{window_name}".to_string(),
            "-t".to_string(),
            params.session_name,
            "-c".to_string(),
            params.cwd,
            "-n".to_string(),
            params.window_name.clone(),
            params.shell_cmd,
        ])?;
        let mut parts = output.split('|');
        Ok(json!({
            "windowId": parts.next().unwrap_or_default(),
            "index": parts.next().unwrap_or_default().parse::<usize>().unwrap_or_default(),
            "name": params.window_name,
        }))
    }

    fn resume_codex_session(&self, params: ResumeCodexSessionParams) -> Result<Value, String> {
        let project_name = resume_project_name(&params);
        if project_name.is_empty() || !self.backend.session_exists(&project_name) {
            return Err("project not found".to_string());
        }
        self.backend
            .apply_proxy_vars(&project_name, params.proxy_vars)?;
        let output = self.backend.capture(&[
            "new-window".to_string(),
            "-P".to_string(),
            "-F".to_string(),
            "#{window_id}|#{window_index}|#{window_name}".to_string(),
            "-t".to_string(),
            project_name.clone(),
            "-c".to_string(),
            params.cwd,
            "-n".to_string(),
            params.window_name.clone(),
            params.shell_cmd,
        ])?;
        let mut parts = output.split('|');
        let window_id = parts.next().unwrap_or_default().to_string();
        let index = parts
            .next()
            .unwrap_or_default()
            .parse::<usize>()
            .unwrap_or_default();
        let window_target = if window_id.is_empty() {
            format!("{project_name}:{index}")
        } else {
            window_id
        };
        self.backend
            .mark_window_as_codex_resume_session(&window_target, &params.session_id)?;
        let _ = self.backend.run(&[
            "select-window".to_string(),
            "-t".to_string(),
            format!("{project_name}:{index}"),
        ]);
        let _ = self
            .backend
            .set_env(&project_name, "NEXUS_LAST_CHANNEL", &index.to_string());
        Ok(json!({
            "ok": true,
            "project": project_name,
            "channelIndex": index,
            "channelName": params.window_name,
            "sessionId": params.session_id,
        }))
    }

    fn rename_project(&self, params: RenameProjectParams) -> Result<Value, String> {
        self.backend.run(&[
            "rename-session".to_string(),
            "-t".to_string(),
            params.old_name.clone(),
            params.new_name.clone(),
        ])?;
        self.mark_owned(&params.new_name);
        Ok(json!({
            "ok": true,
            "oldName": params.old_name,
            "newName": params.new_name,
        }))
    }

    fn delete_project(&self, params: DeleteProjectParams) -> Result<Value, String> {
        let window_ids = self.backend.list_window_ids(&params.session_name);
        self.backend.run(&[
            "kill-session".to_string(),
            "-t".to_string(),
            params.session_name,
        ])?;
        for window_id in window_ids {
            cleanup_codex_runtime(&window_id);
        }
        Ok(json!({ "ok": true }))
    }

    fn attach_session_window(&self, params: AttachSessionWindowParams) -> Result<Value, String> {
        let index = params.index.as_string();
        self.backend.run(&[
            "select-window".to_string(),
            "-t".to_string(),
            session_window_target(&params.session_name, &params.index),
        ])?;
        self.backend
            .set_env(&params.session_name, "NEXUS_LAST_CHANNEL", &index)?;
        Ok(json!({ "ok": true }))
    }

    fn rename_session_window(&self, params: RenameSessionWindowParams) -> Result<Value, String> {
        self.backend.run(&[
            "rename-window".to_string(),
            "-t".to_string(),
            session_window_target(&params.session_name, &params.index),
            params.name.clone(),
        ])?;
        Ok(json!({ "ok": true, "name": params.name }))
    }

    fn delete_session_window(&self, params: DeleteSessionWindowParams) -> Result<Value, String> {
        let target = session_window_target(&params.session_name, &params.index);
        let window_id = self.backend.window_id(&target);
        if (params.create_fallback_shell || self.backend.count_windows(&params.session_name)? <= 1)
            && !params.default_shell_cmd.trim().is_empty()
        {
            self.backend.run(&[
                "new-window".to_string(),
                "-t".to_string(),
                params.session_name.clone(),
                "-n".to_string(),
                "shell".to_string(),
                params.default_shell_cmd,
            ])?;
        }
        self.backend
            .run(&["kill-window".to_string(), "-t".to_string(), target])?;
        cleanup_codex_runtime(&window_id);
        Ok(json!({ "ok": true }))
    }
}

struct NativeLifecyclePort {
    registry: NativeSessionRegistry,
}

impl SessionLifecyclePort for NativeLifecyclePort {
    fn create_project(&self, params: CreateProjectParams) -> Result<Value, String> {
        self.registry.create_project_with_launch_plan(
            &params.session_name,
            &params.cwd,
            &params.initial_window_name,
            &params.shell_cmd,
            params.launch_plan.as_ref(),
        )?;
        Ok(json!({ "ok": true }))
    }

    fn create_project_channel(&self, params: CreateProjectChannelParams) -> Result<Value, String> {
        self.registry.create_channel_with_launch_plan(
            &params.session_name,
            &params.cwd,
            &params.channel_name,
            &params.shell_cmd,
            params.launch_plan.as_ref(),
        )?;
        Ok(json!({ "ok": true }))
    }

    fn create_resume_window(&self, params: CreateResumeWindowParams) -> Result<Value, String> {
        let index = self.registry.create_channel_with_launch_plan(
            &params.session_name,
            &params.cwd,
            &params.window_name,
            &params.shell_cmd,
            params.launch_plan.as_ref(),
        )?;
        Ok(json!({
            "windowId": native_window_id(&params.session_name, index),
            "index": index,
            "name": params.window_name,
        }))
    }

    fn resume_codex_session(&self, params: ResumeCodexSessionParams) -> Result<Value, String> {
        let project_name = resume_project_name(&params);
        if project_name.is_empty() {
            return Err("project not found".to_string());
        }
        let index = self.registry.create_channel_with_launch_plan(
            &project_name,
            &params.cwd,
            &params.window_name,
            &params.shell_cmd,
            params.launch_plan.as_ref(),
        )?;
        self.registry.set_channel_metadata(
            &project_name,
            index,
            CODEX_RESUME_SESSION_METADATA_KEY,
            &params.session_id,
        )?;
        self.registry.activate_channel(&project_name, index)?;
        Ok(json!({
            "ok": true,
            "project": project_name,
            "channelIndex": index,
            "channelName": params.window_name,
            "sessionId": params.session_id,
        }))
    }

    fn rename_project(&self, params: RenameProjectParams) -> Result<Value, String> {
        self.registry
            .rename_project(&params.old_name, &params.new_name)?;
        Ok(json!({
            "ok": true,
            "oldName": params.old_name,
            "newName": params.new_name,
        }))
    }

    fn delete_project(&self, params: DeleteProjectParams) -> Result<Value, String> {
        let channels = self.registry.list_channels(&params.session_name)?;
        terminate_native_processes(
            &self
                .registry
                .running_processes_for_project(&params.session_name)?,
        )?;
        self.registry.delete_project(&params.session_name)?;
        for channel in channels {
            cleanup_codex_runtime(&native_window_id(&params.session_name, channel.index));
        }
        Ok(json!({ "ok": true }))
    }

    fn attach_session_window(&self, params: AttachSessionWindowParams) -> Result<Value, String> {
        self.registry
            .activate_channel(&params.session_name, native_window_index(&params.index)?)?;
        Ok(json!({ "ok": true }))
    }

    fn rename_session_window(&self, params: RenameSessionWindowParams) -> Result<Value, String> {
        self.registry.rename_channel(
            &params.session_name,
            native_window_index(&params.index)?,
            &params.name,
        )?;
        Ok(json!({ "ok": true, "name": params.name }))
    }

    fn delete_session_window(&self, params: DeleteSessionWindowParams) -> Result<Value, String> {
        let index = native_window_index(&params.index)?;
        if (params.create_fallback_shell
            || self.registry.list_channels(&params.session_name)?.len() <= 1)
            && !params.default_shell_cmd.trim().is_empty()
        {
            let cwd = self.registry.get_project_cwd(&params.session_name)?;
            self.registry.create_channel(
                &params.session_name,
                &cwd,
                "shell",
                &params.default_shell_cmd,
            )?;
        }
        terminate_native_processes(
            &self
                .registry
                .running_processes_for_channel(&params.session_name, index)?,
        )?;
        self.registry.delete_channel(&params.session_name, index)?;
        cleanup_codex_runtime(&native_window_id(&params.session_name, index));
        Ok(json!({ "ok": true }))
    }
}

fn resume_project_name(params: &ResumeCodexSessionParams) -> String {
    if !params.project_name.trim().is_empty() {
        params.project_name.trim().to_string()
    } else {
        params.session_name.trim().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::sync::atomic::AtomicUsize;

    struct FakeLifecyclePort;

    impl SessionLifecyclePort for FakeLifecyclePort {
        fn create_project(&self, _params: CreateProjectParams) -> Result<Value, String> {
            Ok(json!({ "ok": true, "source": "fake" }))
        }
        fn create_project_channel(
            &self,
            _params: CreateProjectChannelParams,
        ) -> Result<Value, String> {
            Ok(json!({ "ok": true }))
        }
        fn create_resume_window(&self, _params: CreateResumeWindowParams) -> Result<Value, String> {
            Ok(json!({ "windowId": "fake:1", "index": 1, "name": "fake" }))
        }
        fn resume_codex_session(&self, _params: ResumeCodexSessionParams) -> Result<Value, String> {
            Ok(json!({ "ok": true }))
        }
        fn rename_project(&self, _params: RenameProjectParams) -> Result<Value, String> {
            Ok(json!({ "ok": true }))
        }
        fn delete_project(&self, _params: DeleteProjectParams) -> Result<Value, String> {
            Ok(json!({ "ok": true }))
        }
        fn attach_session_window(
            &self,
            _params: AttachSessionWindowParams,
        ) -> Result<Value, String> {
            Ok(json!({ "ok": true }))
        }
        fn rename_session_window(
            &self,
            _params: RenameSessionWindowParams,
        ) -> Result<Value, String> {
            Ok(json!({ "ok": true }))
        }
        fn delete_session_window(
            &self,
            _params: DeleteSessionWindowParams,
        ) -> Result<Value, String> {
            Ok(json!({ "ok": true }))
        }
    }

    #[test]
    fn lifecycle_contract_accepts_a_local_fake_and_keeps_counters_in_the_deep_module() {
        let lifecycle = SessionLifecycle::with_port(Box::new(FakeLifecyclePort));
        let state = SharedState {
            projects_created: Arc::new(AtomicUsize::new(0)),
            windows_created: Arc::new(AtomicUsize::new(0)),
        };
        let result = lifecycle
            .create_project(
                &state,
                CreateProjectParams {
                    session_name: "fake".to_string(),
                    cwd: "/fake".to_string(),
                    initial_window_name: "shell".to_string(),
                    shell_cmd: "true".to_string(),
                    launch_plan: None,
                    proxy_vars: HashMap::new(),
                },
            )
            .expect("create");
        assert_eq!(result["source"], "fake");
        assert_eq!(state.projects_created.load(Ordering::SeqCst), 1);
        assert_eq!(state.windows_created.load(Ordering::SeqCst), 1);
    }
}
