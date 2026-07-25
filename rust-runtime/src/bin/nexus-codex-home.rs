use nexus_rust_runtime::codex_home::CodexHomeConfig;
use std::env;
use std::path::{Path, PathBuf};
use std::process;

fn main() {
    if let Err(error) = run() {
        eprintln!("[Nexus] {error}");
        process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args.len() < 3 {
        return Err("Usage: nexus-codex-home <config-file?> <home-dir> <project-path>".to_string());
    }

    let config_file = args[0].trim();
    let home_dir = args[1].trim();
    let project_path = args[2].trim();
    if home_dir.is_empty() || project_path.is_empty() {
        return Err("Usage: nexus-codex-home <config-file?> <home-dir> <project-path>".to_string());
    }

    let source_home = env::var("HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_default();
    let config = if config_file.is_empty() {
        CodexHomeConfig::read_global(&source_home).unwrap_or_default()
    } else {
        CodexHomeConfig::read_file(Path::new(config_file))?
    };

    config.materialize(
        Path::new(home_dir),
        project_path,
        Some(source_home.as_path()),
    )
}
