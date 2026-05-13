use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const NATIVE_SESSION_DB_ENV: &str = "NEXUS_NATIVE_SESSION_DB";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeProject {
    pub name: String,
    pub cwd: String,
    pub active_channel_index: Option<u32>,
    pub channel_count: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeChannel {
    pub project_name: String,
    pub index: u32,
    pub name: String,
    pub cwd: String,
    pub shell_cmd: String,
    pub active: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeChannelLaunch {
    pub cwd: String,
    pub shell_cmd: String,
    pub launch_plan: Option<NativeLaunchPlan>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeLaunchPlan {
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub cwd: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeProcessInstance {
    pub id: i64,
    pub project_name: String,
    pub channel_index: u32,
    pub status: String,
    pub os_pid: Option<u32>,
    pub platform_handle: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub exit_code: Option<i32>,
    pub start_fingerprint: String,
}

pub struct NativeSessionRegistry {
    connection: Connection,
}

impl NativeSessionRegistry {
    pub fn open_default() -> Result<Self, String> {
        Self::open(default_registry_path())
    }

    pub fn open(path: PathBuf) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let connection = Connection::open(path).map_err(|error| error.to_string())?;
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(|error| error.to_string())?;
        connection
            .pragma_update(None, "synchronous", "NORMAL")
            .map_err(|error| error.to_string())?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(|error| error.to_string())?;
        connection
            .busy_timeout(Duration::from_millis(1_000))
            .map_err(|error| error.to_string())?;
        let registry = Self { connection };
        registry.init_schema()?;
        Ok(registry)
    }

    fn init_schema(&self) -> Result<(), String> {
        self.connection
            .execute_batch(
                "
                CREATE TABLE IF NOT EXISTS native_projects (
                  name TEXT PRIMARY KEY,
                  cwd TEXT NOT NULL,
                  active_channel_index INTEGER,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS native_channels (
                  project_name TEXT NOT NULL,
                  channel_index INTEGER NOT NULL,
                  name TEXT NOT NULL,
                  cwd TEXT NOT NULL,
                  shell_cmd TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  PRIMARY KEY(project_name, channel_index),
                  FOREIGN KEY(project_name) REFERENCES native_projects(name) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS process_instances (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  project_name TEXT NOT NULL,
                  channel_index INTEGER NOT NULL,
                  status TEXT NOT NULL,
                  os_pid INTEGER,
                  platform_handle TEXT,
                  started_at TEXT NOT NULL,
                  ended_at TEXT,
                  exit_code INTEGER,
                  start_fingerprint TEXT NOT NULL,
                  FOREIGN KEY(project_name, channel_index)
                    REFERENCES native_channels(project_name, channel_index)
                    ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS channel_metadata (
                  project_name TEXT NOT NULL,
                  channel_index INTEGER NOT NULL,
                  key TEXT NOT NULL,
                  value TEXT NOT NULL,
                  PRIMARY KEY(project_name, channel_index, key),
                  FOREIGN KEY(project_name, channel_index)
                    REFERENCES native_channels(project_name, channel_index)
                    ON DELETE CASCADE
                );
                ",
            )
            .map_err(|error| error.to_string())?;
        self.ensure_native_channel_launch_columns()
    }

    fn ensure_native_channel_launch_columns(&self) -> Result<(), String> {
        for (name, definition) in [
            ("launch_program", "TEXT"),
            ("launch_args_json", "TEXT"),
            ("launch_env_json", "TEXT"),
            ("launch_cwd", "TEXT"),
            ("shell_type", "TEXT"),
            ("profile", "TEXT"),
        ] {
            if !self.column_exists("native_channels", name)? {
                match self.connection.execute(
                    &format!("ALTER TABLE native_channels ADD COLUMN {name} {definition}"),
                    [],
                ) {
                    Ok(_) => {}
                    Err(error)
                        if error
                            .to_string()
                            .to_ascii_lowercase()
                            .contains("duplicate column") => {}
                    Err(error) => return Err(error.to_string()),
                }
            }
        }
        Ok(())
    }

    fn column_exists(&self, table: &str, column: &str) -> Result<bool, String> {
        let mut statement = self
            .connection
            .prepare(&format!("PRAGMA table_info({table})"))
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| error.to_string())?;
        for row in rows {
            if row.map_err(|error| error.to_string())? == column {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn create_project(
        &self,
        name: &str,
        cwd: &str,
        initial_channel_name: &str,
        shell_cmd: &str,
    ) -> Result<(), String> {
        self.create_project_with_launch_plan(name, cwd, initial_channel_name, shell_cmd, None)
    }

    pub fn create_project_with_launch_plan(
        &self,
        name: &str,
        cwd: &str,
        initial_channel_name: &str,
        shell_cmd: &str,
        launch_plan: Option<&NativeLaunchPlan>,
    ) -> Result<(), String> {
        let name = clean_required(name, "project name required")?;
        let cwd = clean_required(cwd, "cwd required")?;
        let channel_name = clean_required(initial_channel_name, "channel name required")?;
        let shell_cmd = clean_required(shell_cmd, "shell command required")?;
        let stored_plan = StoredLaunchPlan::from_launch_plan(launch_plan)?;
        let now = timestamp();

        self.connection
            .execute(
                "
                INSERT INTO native_projects
                  (name, cwd, active_channel_index, created_at, updated_at)
                VALUES (?1, ?2, 0, ?3, ?3)
                ",
                params![name, cwd, now],
            )
            .map_err(|error| error.to_string())?;
        self.connection
            .execute(
                "
                INSERT INTO native_channels
                  (project_name, channel_index, name, cwd, shell_cmd, launch_program, launch_args_json, launch_env_json, launch_cwd, created_at, updated_at)
                VALUES (?1, 0, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
                ",
                params![
                    name,
                    channel_name,
                    cwd,
                    shell_cmd,
                    stored_plan.program,
                    stored_plan.args_json,
                    stored_plan.env_json,
                    stored_plan.cwd,
                    now
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn create_channel(
        &self,
        project_name: &str,
        cwd: &str,
        channel_name: &str,
        shell_cmd: &str,
    ) -> Result<u32, String> {
        self.create_channel_with_launch_plan(project_name, cwd, channel_name, shell_cmd, None)
    }

    pub fn create_channel_with_launch_plan(
        &self,
        project_name: &str,
        cwd: &str,
        channel_name: &str,
        shell_cmd: &str,
        launch_plan: Option<&NativeLaunchPlan>,
    ) -> Result<u32, String> {
        let project_name = clean_required(project_name, "project name required")?;
        let cwd = clean_required(cwd, "cwd required")?;
        let channel_name = clean_required(channel_name, "channel name required")?;
        let shell_cmd = clean_required(shell_cmd, "shell command required")?;
        let stored_plan = StoredLaunchPlan::from_launch_plan(launch_plan)?;
        let exists = self
            .connection
            .query_row(
                "SELECT 1 FROM native_projects WHERE name = ?1",
                params![project_name],
                |_| Ok(()),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .is_some();
        if !exists {
            return Err("project not found".to_string());
        }

        let next_index = self
            .connection
            .query_row(
                "
                SELECT COALESCE(MAX(channel_index), -1) + 1
                FROM native_channels
                WHERE project_name = ?1
                ",
                params![project_name],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| error.to_string())? as u32;
        let now = timestamp();

        self.connection
            .execute(
                "
                INSERT INTO native_channels
                  (project_name, channel_index, name, cwd, shell_cmd, launch_program, launch_args_json, launch_env_json, launch_cwd, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
                ",
                params![
                    project_name,
                    next_index,
                    channel_name,
                    cwd,
                    shell_cmd,
                    stored_plan.program,
                    stored_plan.args_json,
                    stored_plan.env_json,
                    stored_plan.cwd,
                    now
                ],
            )
            .map_err(|error| error.to_string())?;
        self.connection
            .execute(
                "
                UPDATE native_projects
                SET active_channel_index = ?2, updated_at = ?3
                WHERE name = ?1
                ",
                params![project_name, next_index, now],
            )
            .map_err(|error| error.to_string())?;

        Ok(next_index)
    }

    pub fn list_projects(&self) -> Result<Vec<NativeProject>, String> {
        let mut statement = self
            .connection
            .prepare(
                "
                SELECT p.name, p.cwd, p.active_channel_index, COUNT(c.channel_index) AS channel_count
                FROM native_projects p
                LEFT JOIN native_channels c ON c.project_name = p.name
                GROUP BY p.name, p.cwd, p.active_channel_index, p.created_at
                ORDER BY p.created_at DESC, p.name DESC
                ",
            )
            .map_err(|error| error.to_string())?;

        let rows = statement
            .query_map([], |row| {
                let active_channel_index = row
                    .get::<_, Option<i64>>(2)?
                    .and_then(|value| u32::try_from(value).ok());
                Ok(NativeProject {
                    name: row.get(0)?,
                    cwd: row.get(1)?,
                    active_channel_index,
                    channel_count: row.get::<_, i64>(3)? as u32,
                })
            })
            .map_err(|error| error.to_string())?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub fn get_project_cwd(&self, project_name: &str) -> Result<String, String> {
        self.connection
            .query_row(
                "SELECT cwd FROM native_projects WHERE name = ?1",
                params![project_name],
                |row| row.get(0),
            )
            .map_err(|_| "project not found".to_string())
    }

    pub fn rename_project(&self, old_name: &str, new_name: &str) -> Result<(), String> {
        let old_name = clean_required(old_name, "old project name required")?;
        let new_name = clean_required(new_name, "new project name required")?;
        if old_name == new_name {
            self.require_project(old_name)?;
            return Ok(());
        }
        self.require_project(old_name)?;
        if self.project_exists(new_name)? {
            return Err("project already exists".to_string());
        }

        let now = timestamp();
        self.connection
            .execute(
                "
                INSERT INTO native_projects
                  (name, cwd, active_channel_index, created_at, updated_at)
                SELECT ?2, cwd, active_channel_index, created_at, ?3
                FROM native_projects
                WHERE name = ?1
                ",
                params![old_name, new_name, now],
            )
            .map_err(|error| error.to_string())?;
        self.connection
            .execute(
                "
                UPDATE native_channels
                SET project_name = ?2, updated_at = ?3
                WHERE project_name = ?1
                ",
                params![old_name, new_name, now],
            )
            .map_err(|error| error.to_string())?;
        self.connection
            .execute(
                "DELETE FROM native_projects WHERE name = ?1",
                params![old_name],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn delete_project(&self, project_name: &str) -> Result<(), String> {
        let project_name = clean_required(project_name, "project name required")?;
        self.require_project(project_name)?;
        self.connection
            .execute(
                "DELETE FROM native_channels WHERE project_name = ?1",
                params![project_name],
            )
            .map_err(|error| error.to_string())?;
        self.connection
            .execute(
                "DELETE FROM native_projects WHERE name = ?1",
                params![project_name],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn list_channels(&self, project_name: &str) -> Result<Vec<NativeChannel>, String> {
        let active_channel_index = self
            .connection
            .query_row(
                "SELECT active_channel_index FROM native_projects WHERE name = ?1",
                params![project_name],
                |row| row.get::<_, Option<i64>>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "project not found".to_string())?
            .and_then(|value| u32::try_from(value).ok());
        let mut statement = self
            .connection
            .prepare(
                "
                SELECT channel_index, name, cwd, shell_cmd
                FROM native_channels
                WHERE project_name = ?1
                ORDER BY channel_index DESC
                ",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![project_name], |row| {
                let index = row.get::<_, i64>(0)? as u32;
                Ok(NativeChannel {
                    project_name: project_name.to_string(),
                    index,
                    name: row.get(1)?,
                    cwd: row.get(2)?,
                    shell_cmd: row.get(3)?,
                    active: Some(index) == active_channel_index,
                })
            })
            .map_err(|error| error.to_string())?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub fn channel_launch(
        &self,
        project_name: &str,
        channel_index: u32,
    ) -> Result<NativeChannelLaunch, String> {
        self.connection
            .query_row(
                "
                SELECT cwd, shell_cmd, launch_program, launch_args_json, launch_env_json, launch_cwd
                FROM native_channels
                WHERE project_name = ?1 AND channel_index = ?2
                ",
                params![project_name, channel_index],
                |row| {
                    let launch_plan = launch_plan_from_row(row, 2)?;
                    Ok(NativeChannelLaunch {
                        cwd: row.get(0)?,
                        shell_cmd: row.get(1)?,
                        launch_plan,
                    })
                },
            )
            .map_err(|_| "channel not found".to_string())
    }

    pub fn set_channel_metadata(
        &self,
        project_name: &str,
        channel_index: u32,
        key: &str,
        value: &str,
    ) -> Result<(), String> {
        let project_name = clean_required(project_name, "project name required")?;
        let key = clean_required(key, "metadata key required")?;
        self.connection
            .execute(
                "
                INSERT INTO channel_metadata
                  (project_name, channel_index, key, value)
                VALUES (?1, ?2, ?3, ?4)
                ON CONFLICT(project_name, channel_index, key)
                DO UPDATE SET value = excluded.value
                ",
                params![project_name, channel_index, key, value],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn list_channels_by_metadata(
        &self,
        project_name: &str,
        key: &str,
        value: &str,
    ) -> Result<Vec<NativeChannel>, String> {
        let project_name = clean_required(project_name, "project name required")?;
        let key = clean_required(key, "metadata key required")?;
        self.require_project(project_name)?;
        let active_channel_index = self.active_channel_index(project_name)?;
        let mut statement = self
            .connection
            .prepare(
                "
                SELECT c.channel_index, c.name, c.cwd, c.shell_cmd
                FROM native_channels c
                INNER JOIN channel_metadata m
                  ON m.project_name = c.project_name
                 AND m.channel_index = c.channel_index
                WHERE c.project_name = ?1
                  AND m.key = ?2
                  AND m.value = ?3
                ORDER BY c.channel_index ASC
                ",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![project_name, key, value], |row| {
                let index = row.get::<_, i64>(0)? as u32;
                Ok(NativeChannel {
                    project_name: project_name.to_string(),
                    index,
                    name: row.get(1)?,
                    cwd: row.get(2)?,
                    shell_cmd: row.get(3)?,
                    active: Some(index) == active_channel_index,
                })
            })
            .map_err(|error| error.to_string())?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub fn record_process_running(
        &self,
        project_name: &str,
        channel_index: u32,
        os_pid: Option<u32>,
        platform_handle: Option<&str>,
    ) -> Result<i64, String> {
        let project_name = clean_required(project_name, "project name required")?;
        self.require_channel(project_name, channel_index)?;
        let started_at = timestamp();
        let start_fingerprint = format!(
            "{}:{}:{}",
            os_pid
                .map(|pid| pid.to_string())
                .unwrap_or_else(|| "unknown-pid".to_string()),
            project_name,
            started_at
        );
        self.connection
            .execute(
                "
                INSERT INTO process_instances
                  (project_name, channel_index, status, os_pid, platform_handle, started_at, start_fingerprint)
                VALUES (?1, ?2, 'running', ?3, ?4, ?5, ?6)
                ",
                params![
                    project_name,
                    channel_index,
                    os_pid.map(i64::from),
                    platform_handle,
                    started_at,
                    start_fingerprint,
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(self.connection.last_insert_rowid())
    }

    pub fn mark_process_exited(
        &self,
        process_instance_id: i64,
        exit_code: i32,
    ) -> Result<(), String> {
        let changed = self
            .connection
            .execute(
                "
                UPDATE process_instances
                SET status = 'exited', ended_at = ?2, exit_code = ?3
                WHERE id = ?1
                ",
                params![process_instance_id, timestamp(), exit_code],
            )
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            return Err("process instance not found".to_string());
        }
        Ok(())
    }

    pub fn latest_process_instance(
        &self,
        project_name: &str,
        channel_index: u32,
    ) -> Result<Option<NativeProcessInstance>, String> {
        self.connection
            .query_row(
                "
                SELECT id, project_name, channel_index, status, os_pid, platform_handle, started_at, ended_at, exit_code, start_fingerprint
                FROM process_instances
                WHERE project_name = ?1 AND channel_index = ?2
                ORDER BY id DESC
                LIMIT 1
                ",
                params![project_name, channel_index],
                |row| {
                    Ok(NativeProcessInstance {
                        id: row.get(0)?,
                        project_name: row.get(1)?,
                        channel_index: row.get::<_, i64>(2)? as u32,
                        status: row.get(3)?,
                        os_pid: row
                            .get::<_, Option<i64>>(4)?
                            .and_then(|value| u32::try_from(value).ok()),
                        platform_handle: row.get(5)?,
                        started_at: row.get(6)?,
                        ended_at: row.get(7)?,
                        exit_code: row
                            .get::<_, Option<i64>>(8)?
                            .and_then(|value| i32::try_from(value).ok()),
                        start_fingerprint: row.get(9)?,
                    })
                },
            )
            .optional()
            .map_err(|error| error.to_string())
    }

    pub fn running_processes_for_channel(
        &self,
        project_name: &str,
        channel_index: u32,
    ) -> Result<Vec<NativeProcessInstance>, String> {
        self.process_instances_where(
            "
            SELECT id, project_name, channel_index, status, os_pid, platform_handle, started_at, ended_at, exit_code, start_fingerprint
            FROM process_instances
            WHERE project_name = ?1 AND channel_index = ?2 AND status = 'running'
            ORDER BY id DESC
            ",
            params![project_name, channel_index],
        )
    }

    pub fn running_processes_for_project(
        &self,
        project_name: &str,
    ) -> Result<Vec<NativeProcessInstance>, String> {
        self.process_instances_where(
            "
            SELECT id, project_name, channel_index, status, os_pid, platform_handle, started_at, ended_at, exit_code, start_fingerprint
            FROM process_instances
            WHERE project_name = ?1 AND status = 'running'
            ORDER BY channel_index ASC, id DESC
            ",
            params![project_name],
        )
    }

    pub fn running_processes(&self) -> Result<Vec<NativeProcessInstance>, String> {
        self.process_instances_where(
            "
            SELECT id, project_name, channel_index, status, os_pid, platform_handle, started_at, ended_at, exit_code, start_fingerprint
            FROM process_instances
            WHERE status = 'running'
            ORDER BY project_name ASC, channel_index ASC, id DESC
            ",
            [],
        )
    }

    pub fn mark_process_status(
        &self,
        process_instance_id: i64,
        status: &str,
    ) -> Result<(), String> {
        let status = clean_required(status, "process status required")?;
        let changed = self
            .connection
            .execute(
                "
                UPDATE process_instances
                SET status = ?2, ended_at = ?3
                WHERE id = ?1
                ",
                params![process_instance_id, status, timestamp()],
            )
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            return Err("process instance not found".to_string());
        }
        Ok(())
    }

    fn process_instances_where<P>(
        &self,
        sql: &str,
        params: P,
    ) -> Result<Vec<NativeProcessInstance>, String>
    where
        P: rusqlite::Params,
    {
        let mut statement = self
            .connection
            .prepare(sql)
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params, native_process_instance_from_row)
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub fn activate_channel(&self, project_name: &str, channel_index: u32) -> Result<(), String> {
        let project_name = clean_required(project_name, "project name required")?;
        self.require_channel(project_name, channel_index)?;
        self.connection
            .execute(
                "
                UPDATE native_projects
                SET active_channel_index = ?2, updated_at = ?3
                WHERE name = ?1
                ",
                params![project_name, channel_index, timestamp()],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn rename_channel(
        &self,
        project_name: &str,
        channel_index: u32,
        name: &str,
    ) -> Result<(), String> {
        let project_name = clean_required(project_name, "project name required")?;
        let name = clean_required(name, "channel name required")?;
        self.require_channel(project_name, channel_index)?;
        self.connection
            .execute(
                "
                UPDATE native_channels
                SET name = ?3, updated_at = ?4
                WHERE project_name = ?1 AND channel_index = ?2
                ",
                params![project_name, channel_index, name, timestamp()],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn delete_channel(&self, project_name: &str, channel_index: u32) -> Result<(), String> {
        let project_name = clean_required(project_name, "project name required")?;
        self.require_channel(project_name, channel_index)?;
        let channel_count = self.channel_count(project_name)?;
        if channel_count <= 1 {
            return Err("cannot delete last native channel".to_string());
        }

        self.connection
            .execute(
                "
                DELETE FROM native_channels
                WHERE project_name = ?1 AND channel_index = ?2
                ",
                params![project_name, channel_index],
            )
            .map_err(|error| error.to_string())?;

        let active_channel_index = self.active_channel_index(project_name)?;
        if active_channel_index == Some(channel_index) {
            let replacement = self
                .connection
                .query_row(
                    "
                    SELECT MAX(channel_index)
                    FROM native_channels
                    WHERE project_name = ?1
                    ",
                    params![project_name],
                    |row| row.get::<_, Option<i64>>(0),
                )
                .map_err(|error| error.to_string())?
                .and_then(|value| u32::try_from(value).ok());
            self.connection
                .execute(
                    "
                    UPDATE native_projects
                    SET active_channel_index = ?2, updated_at = ?3
                    WHERE name = ?1
                    ",
                    params![project_name, replacement, timestamp()],
                )
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    fn project_exists(&self, project_name: &str) -> Result<bool, String> {
        self.connection
            .query_row(
                "SELECT 1 FROM native_projects WHERE name = ?1",
                params![project_name],
                |_| Ok(()),
            )
            .optional()
            .map(|row| row.is_some())
            .map_err(|error| error.to_string())
    }

    fn require_project(&self, project_name: &str) -> Result<(), String> {
        if self.project_exists(project_name)? {
            Ok(())
        } else {
            Err("project not found".to_string())
        }
    }

    fn require_channel(&self, project_name: &str, channel_index: u32) -> Result<(), String> {
        self.connection
            .query_row(
                "
                SELECT 1
                FROM native_channels
                WHERE project_name = ?1 AND channel_index = ?2
                ",
                params![project_name, channel_index],
                |_| Ok(()),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "channel not found".to_string())
    }

    fn channel_count(&self, project_name: &str) -> Result<u32, String> {
        self.connection
            .query_row(
                "
                SELECT COUNT(*)
                FROM native_channels
                WHERE project_name = ?1
                ",
                params![project_name],
                |row| row.get::<_, i64>(0),
            )
            .map(|count| count as u32)
            .map_err(|error| error.to_string())
    }

    fn active_channel_index(&self, project_name: &str) -> Result<Option<u32>, String> {
        self.connection
            .query_row(
                "SELECT active_channel_index FROM native_projects WHERE name = ?1",
                params![project_name],
                |row| row.get::<_, Option<i64>>(0),
            )
            .map(|value| value.and_then(|value| u32::try_from(value).ok()))
            .map_err(|_| "project not found".to_string())
    }
}

pub fn default_registry_path() -> PathBuf {
    if let Ok(path) = env::var(NATIVE_SESSION_DB_ENV) {
        let path = path.trim();
        if !path.is_empty() {
            return PathBuf::from(path);
        }
    }

    data_dir().join("native-sessions").join("session.db")
}

fn data_dir() -> PathBuf {
    let configured = env::var("NEXUS_DATA_DIR")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "data".to_string());
    let candidate = PathBuf::from(configured);
    if candidate.is_absolute() {
        candidate
    } else {
        env::current_dir()
            .unwrap_or_else(|_| Path::new(".").to_path_buf())
            .join(candidate)
    }
}

fn clean_required<'a>(value: &'a str, message: &str) -> Result<&'a str, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(message.to_string());
    }
    Ok(value)
}

struct StoredLaunchPlan {
    program: Option<String>,
    args_json: Option<String>,
    env_json: Option<String>,
    cwd: Option<String>,
}

impl StoredLaunchPlan {
    fn from_launch_plan(plan: Option<&NativeLaunchPlan>) -> Result<Self, String> {
        let Some(plan) = plan else {
            return Ok(Self {
                program: None,
                args_json: None,
                env_json: None,
                cwd: None,
            });
        };

        let program = clean_required(&plan.program, "launch program required")?.to_string();
        let args_json = serde_json::to_string(&plan.args).map_err(|error| error.to_string())?;
        let env_json = serde_json::to_string(&plan.env).map_err(|error| error.to_string())?;
        let cwd = plan
            .cwd
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string);

        Ok(Self {
            program: Some(program),
            args_json: Some(args_json),
            env_json: Some(env_json),
            cwd,
        })
    }
}

fn launch_plan_from_row(
    row: &Row<'_>,
    start_index: usize,
) -> rusqlite::Result<Option<NativeLaunchPlan>> {
    let program = row
        .get::<_, Option<String>>(start_index)?
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let Some(program) = program else {
        return Ok(None);
    };

    let args_json = row
        .get::<_, Option<String>>(start_index + 1)?
        .unwrap_or_else(|| "[]".to_string());
    let env_json = row
        .get::<_, Option<String>>(start_index + 2)?
        .unwrap_or_else(|| "{}".to_string());
    let cwd = row
        .get::<_, Option<String>>(start_index + 3)?
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let args = serde_json::from_str::<Vec<String>>(&args_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            start_index + 1,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })?;
    let env = serde_json::from_str::<HashMap<String, String>>(&env_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            start_index + 2,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })?;

    Ok(Some(NativeLaunchPlan {
        program,
        args,
        env,
        cwd,
    }))
}

fn native_process_instance_from_row(row: &Row<'_>) -> rusqlite::Result<NativeProcessInstance> {
    Ok(NativeProcessInstance {
        id: row.get(0)?,
        project_name: row.get(1)?,
        channel_index: row.get::<_, i64>(2)? as u32,
        status: row.get(3)?,
        os_pid: row
            .get::<_, Option<i64>>(4)?
            .and_then(|value| u32::try_from(value).ok()),
        platform_handle: row.get(5)?,
        started_at: row.get(6)?,
        ended_at: row.get(7)?,
        exit_code: row
            .get::<_, Option<i64>>(8)?
            .and_then(|value| i32::try_from(value).ok()),
        start_fingerprint: row.get(9)?,
    })
}

fn timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}
