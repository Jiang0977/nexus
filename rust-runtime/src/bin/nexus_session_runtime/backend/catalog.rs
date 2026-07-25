use super::super::tmux_backend::TmuxSessionBackend;
use super::super::{
    ActivateProjectParams, GetSessionCwdParams, ListProjectChannelsParams, ListSessionWindowsParams,
};
use super::native_backend_enabled;
use nexus_rust_runtime::native_session_registry::NativeSessionRegistry;
use serde_json::{Value, json};

trait SessionCatalogPort {
    fn resolve_existing_project_path(&self, project_name: &str) -> Result<String, String>;
    fn list_sessions(&self) -> Result<Value, String>;
    fn list_all_session_names(&self) -> Result<Value, String>;
    fn list_projects(&self) -> Result<Value, String>;
    fn get_session_cwd(&self, params: GetSessionCwdParams) -> Result<Value, String>;
    fn list_project_channels(&self, params: ListProjectChannelsParams) -> Result<Value, String>;
    fn list_session_windows(&self, params: ListSessionWindowsParams) -> Result<Value, String>;
    fn activate_project(&self, params: ActivateProjectParams) -> Result<Value, String>;
}

pub(crate) struct SessionCatalog {
    port: Box<dyn SessionCatalogPort>,
}

impl SessionCatalog {
    pub(crate) fn current() -> Result<Self, String> {
        Ok(Self {
            port: current_catalog_port()?,
        })
    }

    #[cfg(test)]
    fn with_port(port: Box<dyn SessionCatalogPort>) -> Self {
        Self { port }
    }

    pub(crate) fn resolve_existing_project_path(
        &self,
        project_name: &str,
    ) -> Result<String, String> {
        self.port.resolve_existing_project_path(project_name)
    }

    pub(crate) fn list_sessions(&self) -> Result<Value, String> {
        self.port.list_sessions()
    }

    pub(crate) fn list_all_session_names(&self) -> Result<Value, String> {
        self.port.list_all_session_names()
    }

    pub(crate) fn list_projects(&self) -> Result<Value, String> {
        self.port.list_projects()
    }

    pub(crate) fn get_session_cwd(&self, params: GetSessionCwdParams) -> Result<Value, String> {
        self.port.get_session_cwd(params)
    }

    pub(crate) fn list_project_channels(
        &self,
        params: ListProjectChannelsParams,
    ) -> Result<Value, String> {
        self.port.list_project_channels(params)
    }

    pub(crate) fn list_session_windows(
        &self,
        params: ListSessionWindowsParams,
    ) -> Result<Value, String> {
        self.port.list_session_windows(params)
    }

    pub(crate) fn activate_project(&self, params: ActivateProjectParams) -> Result<Value, String> {
        self.port.activate_project(params)
    }
}

fn current_catalog_port() -> Result<Box<dyn SessionCatalogPort>, String> {
    let current_session = super::super::env_or_default("TMUX_SESSION", "nexus");
    let workspace_root = super::super::env_or_default("WORKSPACE_ROOT", "");
    if native_backend_enabled() {
        Ok(Box::new(NativeCatalogPort {
            registry: NativeSessionRegistry::open_default()?,
            current_session,
            workspace_root,
        }))
    } else {
        Ok(Box::new(TmuxCatalogPort {
            backend: TmuxSessionBackend::new(),
            current_session,
            workspace_root,
        }))
    }
}

struct TmuxCatalogPort {
    backend: TmuxSessionBackend,
    current_session: String,
    workspace_root: String,
}

impl SessionCatalogPort for TmuxCatalogPort {
    fn resolve_existing_project_path(&self, project_name: &str) -> Result<String, String> {
        let project_name = project_name.trim();
        if project_name.is_empty() || !self.backend.session_exists(project_name) {
            return Err("project not found".to_string());
        }
        Ok(self
            .backend
            .resolve_project_path(project_name, &self.workspace_root))
    }

    fn list_sessions(&self) -> Result<Value, String> {
        Ok(Value::Array(
            self.backend
                .list_discoverable_sessions(&self.current_session, &self.workspace_root)
                .into_iter()
                .map(|session| {
                    json!({
                        "name": session.name,
                        "windows": session.windows,
                        "attached": session.attached,
                    })
                })
                .collect(),
        ))
    }

    fn list_all_session_names(&self) -> Result<Value, String> {
        Ok(Value::Array(
            self.backend
                .list_all_session_names()?
                .into_iter()
                .map(Value::String)
                .collect(),
        ))
    }

    fn list_projects(&self) -> Result<Value, String> {
        let mut projects = self
            .backend
            .list_discoverable_sessions(&self.current_session, &self.workspace_root)
            .into_iter()
            .map(|session| {
                json!({
                    "name": session.name,
                    "path": if session.path.is_empty() {
                        self.workspace_root.clone()
                    } else {
                        session.path
                    },
                    "active": session.name == self.current_session,
                    "channelCount": session.windows,
                })
            })
            .collect::<Vec<_>>();
        projects.reverse();
        Ok(Value::Array(projects))
    }

    fn get_session_cwd(&self, params: GetSessionCwdParams) -> Result<Value, String> {
        let session_name = normalized_session_name(params.session_name, &self.current_session);
        let cwd = self
            .backend
            .resolve_project_path(&session_name, &self.workspace_root);
        Ok(cwd_payload(&self.workspace_root, cwd))
    }

    fn list_project_channels(&self, params: ListProjectChannelsParams) -> Result<Value, String> {
        let project_name = params.project_name.trim().to_string();
        let stdout = self.backend.capture(&[
            "list-windows".to_string(),
            "-t".to_string(),
            project_name.clone(),
            "-F".to_string(),
            "#{window_index}|#{window_name}|#{window_active}|#{pane_current_path}".to_string(),
        ])?;
        let mut channels = stdout
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| {
                let mut parts = line.splitn(4, '|');
                json!({
                    "index": parts.next().unwrap_or("0").trim().parse::<usize>().unwrap_or(0),
                    "name": parts.next().unwrap_or(""),
                    "active": parts.next().unwrap_or("").trim() == "1",
                    "cwd": parts.next().unwrap_or(""),
                })
            })
            .collect::<Vec<_>>();
        channels.reverse();
        Ok(json!({ "project": project_name, "channels": channels }))
    }

    fn list_session_windows(&self, params: ListSessionWindowsParams) -> Result<Value, String> {
        let session_name = normalized_session_name(params.session_name, &self.current_session);
        let windows = self
            .backend
            .capture(&[
                "list-windows".to_string(),
                "-t".to_string(),
                session_name.clone(),
                "-F".to_string(),
                "#{window_index}|#{window_name}|#{window_active}".to_string(),
            ])?
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| {
                let mut parts = line.splitn(3, '|');
                json!({
                    "index": parts.next().unwrap_or("0").trim().parse::<usize>().unwrap_or(0),
                    "name": parts.next().unwrap_or(""),
                    "active": parts.next().unwrap_or("").trim() == "1",
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({ "session": session_name, "windows": windows }))
    }

    fn activate_project(&self, params: ActivateProjectParams) -> Result<Value, String> {
        let project_name = params.project_name.trim().to_string();
        if project_name.is_empty() || !self.backend.session_exists(&project_name) {
            return Err("project not found".to_string());
        }
        let mut last_channel = self
            .backend
            .read_env_value(&project_name, "NEXUS_LAST_CHANNEL")
            .parse::<usize>()
            .ok();
        if let Some(candidate) = last_channel {
            let candidate = candidate.to_string();
            let valid = self
                .backend
                .capture(&[
                    "list-windows".to_string(),
                    "-t".to_string(),
                    project_name.clone(),
                    "-F".to_string(),
                    "#I".to_string(),
                ])
                .map(|output| output.lines().any(|line| line.trim() == candidate))
                .unwrap_or(false);
            if !valid {
                last_channel = None;
            }
        }
        Ok(json!({
            "active": true,
            "project": project_name,
            "lastChannel": last_channel,
        }))
    }
}

struct NativeCatalogPort {
    registry: NativeSessionRegistry,
    current_session: String,
    workspace_root: String,
}

impl SessionCatalogPort for NativeCatalogPort {
    fn resolve_existing_project_path(&self, project_name: &str) -> Result<String, String> {
        let project_name = project_name.trim();
        if project_name.is_empty() {
            Err("project not found".to_string())
        } else {
            self.registry.get_project_cwd(project_name)
        }
    }

    fn list_sessions(&self) -> Result<Value, String> {
        Ok(Value::Array(
            self.registry
                .list_projects()?
                .into_iter()
                .map(|project| {
                    json!({
                        "name": project.name,
                        "windows": project.channel_count,
                        "attached": false,
                    })
                })
                .collect(),
        ))
    }

    fn list_all_session_names(&self) -> Result<Value, String> {
        Ok(Value::Array(
            self.registry
                .list_projects()?
                .into_iter()
                .map(|project| Value::String(project.name))
                .collect(),
        ))
    }

    fn list_projects(&self) -> Result<Value, String> {
        Ok(Value::Array(
            self.registry
                .list_projects()?
                .into_iter()
                .map(|project| {
                    json!({
                        "name": project.name,
                        "path": project.cwd,
                        "active": false,
                        "channelCount": project.channel_count,
                    })
                })
                .collect(),
        ))
    }

    fn get_session_cwd(&self, params: GetSessionCwdParams) -> Result<Value, String> {
        let session_name = normalized_session_name(params.session_name, &self.current_session);
        let cwd = self.registry.get_project_cwd(&session_name)?;
        Ok(cwd_payload(&self.workspace_root, cwd))
    }

    fn list_project_channels(&self, params: ListProjectChannelsParams) -> Result<Value, String> {
        let project_name = params.project_name.trim().to_string();
        let channels = self
            .registry
            .list_channels(&project_name)?
            .into_iter()
            .map(|channel| {
                json!({
                    "index": channel.index,
                    "name": channel.name,
                    "active": channel.active,
                    "cwd": channel.cwd,
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({ "project": project_name, "channels": channels }))
    }

    fn list_session_windows(&self, params: ListSessionWindowsParams) -> Result<Value, String> {
        let session_name = normalized_session_name(params.session_name, &self.current_session);
        let windows = self
            .registry
            .list_channels(&session_name)?
            .into_iter()
            .rev()
            .map(|channel| {
                json!({
                    "index": channel.index,
                    "name": channel.name,
                    "active": channel.active,
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({ "session": session_name, "windows": windows }))
    }

    fn activate_project(&self, params: ActivateProjectParams) -> Result<Value, String> {
        let project_name = params.project_name.trim().to_string();
        let last_channel = self
            .registry
            .list_channels(&project_name)?
            .iter()
            .find(|channel| channel.active)
            .map(|channel| channel.index as usize);
        Ok(json!({
            "active": true,
            "project": project_name,
            "lastChannel": last_channel,
        }))
    }
}

fn normalized_session_name(value: Option<String>, default: &str) -> String {
    let value = value
        .unwrap_or_else(|| default.to_string())
        .trim()
        .to_string();
    if value.is_empty() {
        default.to_string()
    } else {
        value
    }
}

fn cwd_payload(workspace_root: &str, cwd: String) -> Value {
    let relative = if !workspace_root.is_empty() && cwd.starts_with(workspace_root) {
        cwd[workspace_root.len()..]
            .trim_start_matches('/')
            .to_string()
    } else {
        String::new()
    };
    json!({ "cwd": cwd, "relative": relative })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeCatalogPort;

    impl SessionCatalogPort for FakeCatalogPort {
        fn resolve_existing_project_path(&self, project_name: &str) -> Result<String, String> {
            Ok(format!("/fake/{project_name}"))
        }
        fn list_sessions(&self) -> Result<Value, String> {
            Ok(json!([{ "name": "fake", "windows": 1, "attached": false }]))
        }
        fn list_all_session_names(&self) -> Result<Value, String> {
            Ok(json!(["fake"]))
        }
        fn list_projects(&self) -> Result<Value, String> {
            Ok(json!([{ "name": "fake", "path": "/fake", "active": true, "channelCount": 1 }]))
        }
        fn get_session_cwd(&self, _params: GetSessionCwdParams) -> Result<Value, String> {
            Ok(json!({ "cwd": "/fake", "relative": "fake" }))
        }
        fn list_project_channels(
            &self,
            _params: ListProjectChannelsParams,
        ) -> Result<Value, String> {
            Ok(json!({ "project": "fake", "channels": [] }))
        }
        fn list_session_windows(&self, _params: ListSessionWindowsParams) -> Result<Value, String> {
            Ok(json!({ "session": "fake", "windows": [] }))
        }
        fn activate_project(&self, _params: ActivateProjectParams) -> Result<Value, String> {
            Ok(json!({ "active": true, "project": "fake", "lastChannel": 0 }))
        }
    }

    #[test]
    fn catalog_contract_accepts_a_local_fake_without_os_dependencies() {
        let catalog = SessionCatalog::with_port(Box::new(FakeCatalogPort));
        assert_eq!(
            catalog.resolve_existing_project_path("demo").expect("path"),
            "/fake/demo"
        );
        assert_eq!(
            catalog.list_projects().expect("projects")[0]["name"],
            "fake"
        );
    }
}
