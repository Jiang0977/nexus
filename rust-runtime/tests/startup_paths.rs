use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::Duration;

use tempfile::tempdir;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::os::unix::fs::symlink;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

#[cfg(unix)]
fn write_executable(path: &Path, content: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, content).unwrap();
    let mut perms = fs::metadata(path).unwrap().permissions();
    perms.set_mode(0o755);
    fs::set_permissions(path, perms).unwrap();
}

fn collect_root_relative_paths(html: &str) -> BTreeSet<String> {
    let mut paths = BTreeSet::new();
    for needle in ["href=\"/", "src=\"/"] {
        let mut rest = html;
        while let Some(start) = rest.find(needle) {
            let value = &rest[start + needle.len()..];
            if let Some(end) = value.find('"') {
                paths.insert(format!("/{}", &value[..end]));
                rest = &value[end..];
            } else {
                break;
            }
        }
    }
    paths
}

fn resolve_served_path(repo_root: &Path, request_path: &str) -> PathBuf {
    let relative = request_path.trim_start_matches('/');
    let public_path = repo_root.join("public").join(relative);
    if public_path.is_file() {
        return public_path;
    }
    repo_root.join("frontend/dist").join(relative)
}

fn write_depfile(binary: &Path, deps: &[&Path]) {
    let depfile = binary.with_extension("d");
    let body = deps
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(" ");
    fs::write(depfile, format!("{}: {body}\n", binary.display())).unwrap();
}

fn scrub_runtime_env(command: &mut Command) -> &mut Command {
    command
        .env_remove("CARGO_HOME")
        .env_remove("NEXUS_SERVER_EXECUTABLE")
        .env_remove("NEXUS_TASK_RUNNER_RUST_EXECUTABLE")
        .env_remove("NEXUS_PTY_BROKER_RUST_EXECUTABLE")
        .env_remove("NEXUS_WINDOW_LAUNCH_RUST_EXECUTABLE")
        .env_remove("NEXUS_SESSION_MANAGEMENT_RUST_EXECUTABLE")
}

#[test]
fn start_script_fails_when_vendored_bundle_is_missing() {
    let temp = tempdir().unwrap();
    let root = temp.path();
    fs::copy(repo_root().join("start.sh"), root.join("start.sh")).unwrap();
    fs::write(root.join(".env"), "JWT_SECRET=test\n").unwrap();

    let output = scrub_runtime_env(Command::new("bash").arg("start.sh").current_dir(root))
        .output()
        .unwrap();

    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    assert!(!output.status.success());
    assert!(combined.contains("缺少 vendored 前端资源 frontend/dist/index.html"));
}

#[test]
fn start_script_rebuilds_only_binaries_whose_depfile_inputs_are_newer() {
    let temp = tempdir().unwrap();
    let root = temp.path();
    let release_dir = root.join("rust-runtime/target/release");
    let source_dir = root.join("rust-runtime/src/bin");
    let shared_src = root.join("rust-runtime/src");
    let bin_dir = root.join("bin");
    let cargo_log = root.join("cargo.log");

    fs::copy(repo_root().join("start.sh"), root.join("start.sh")).unwrap();
    fs::write(root.join(".env"), "JWT_SECRET=test\n").unwrap();
    fs::create_dir_all(root.join("frontend/dist")).unwrap();
    fs::write(root.join("frontend/dist/index.html"), "<!doctype html>\n").unwrap();
    fs::create_dir_all(&release_dir).unwrap();
    fs::create_dir_all(&source_dir).unwrap();
    fs::create_dir_all(&shared_src).unwrap();
    fs::write(
        root.join("rust-runtime/Cargo.toml"),
        "[package]\nname=\"stub\"\n",
    )
    .unwrap();
    fs::write(root.join("rust-runtime/Cargo.lock"), "version = 3\n").unwrap();
    fs::write(shared_src.join("lib.rs"), "// shared lib\n").unwrap();
    fs::write(source_dir.join("nexus-task-runtime.rs"), "// task\n").unwrap();
    fs::write(source_dir.join("nexus-pty-runtime.rs"), "// pty\n").unwrap();
    fs::write(
        source_dir.join("nexus-window-launch-runtime.rs"),
        "// launch\n",
    )
    .unwrap();
    fs::write(source_dir.join("nexus-session-runtime.rs"), "// session\n").unwrap();
    fs::write(source_dir.join("nexus-server.rs"), "// server\n").unwrap();
    fs::write(source_dir.join("nexus-setup.rs"), "// setup only\n").unwrap();

    for binary in [
        "nexus-task-runtime",
        "nexus-pty-runtime",
        "nexus-window-launch-runtime",
        "nexus-session-runtime",
        "nexus-server",
    ] {
        let binary_path = release_dir.join(binary);
        write_executable(&binary_path, "#!/usr/bin/env bash\nexit 0\n");
        let source_name = format!("{binary}.rs");
        let binary_source = source_dir.join(source_name);
        write_depfile(
            &binary_path,
            &[shared_src.join("lib.rs").as_path(), binary_source.as_path()],
        );
    }

    thread::sleep(Duration::from_millis(1100));
    fs::write(
        source_dir.join("nexus-server.rs"),
        "// newer than compiled binaries\n",
    )
    .unwrap();

    write_executable(
        &bin_dir.join("cargo"),
        &format!(
            "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> {:?}\nexit 0\n",
            cargo_log
        ),
    );

    let output = scrub_runtime_env(
        Command::new("bash")
            .arg("start.sh")
            .current_dir(root)
            .env("PATH", format!("{}:/usr/bin:/bin", bin_dir.display())),
    )
    .output()
    .unwrap();

    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    assert!(output.status.success(), "start.sh failed:\n{combined}");

    let cargo_log = fs::read_to_string(&cargo_log).unwrap();
    assert!(cargo_log.contains("--manifest-path rust-runtime/Cargo.toml --release"));
    assert!(cargo_log.contains("--bin nexus-server"));
    assert!(!cargo_log.contains("--bin nexus-task-runtime"));
    assert!(!cargo_log.contains("--bin nexus-pty-runtime"));
    assert!(!cargo_log.contains("--bin nexus-window-launch-runtime"));
    assert!(!cargo_log.contains("--bin nexus-session-runtime"));
}

#[test]
fn start_script_ignores_unrelated_rust_sources_when_depfiles_are_present() {
    let temp = tempdir().unwrap();
    let root = temp.path();
    let release_dir = root.join("rust-runtime/target/release");
    let source_dir = root.join("rust-runtime/src/bin");
    let shared_src = root.join("rust-runtime/src");
    let bin_dir = root.join("bin");
    let cargo_log = root.join("cargo.log");

    fs::copy(repo_root().join("start.sh"), root.join("start.sh")).unwrap();
    fs::write(root.join(".env"), "JWT_SECRET=test\n").unwrap();
    fs::create_dir_all(root.join("frontend/dist")).unwrap();
    fs::write(root.join("frontend/dist/index.html"), "<!doctype html>\n").unwrap();
    fs::create_dir_all(&release_dir).unwrap();
    fs::create_dir_all(&source_dir).unwrap();
    fs::create_dir_all(&shared_src).unwrap();
    fs::write(
        root.join("rust-runtime/Cargo.toml"),
        "[package]\nname=\"stub\"\n",
    )
    .unwrap();
    fs::write(root.join("rust-runtime/Cargo.lock"), "version = 3\n").unwrap();
    fs::write(shared_src.join("lib.rs"), "// shared lib\n").unwrap();
    fs::write(source_dir.join("nexus-task-runtime.rs"), "// task\n").unwrap();
    fs::write(source_dir.join("nexus-pty-runtime.rs"), "// pty\n").unwrap();
    fs::write(
        source_dir.join("nexus-window-launch-runtime.rs"),
        "// launch\n",
    )
    .unwrap();
    fs::write(source_dir.join("nexus-session-runtime.rs"), "// session\n").unwrap();
    fs::write(source_dir.join("nexus-server.rs"), "// server\n").unwrap();
    fs::write(source_dir.join("nexus-setup.rs"), "// setup only\n").unwrap();

    for binary in [
        "nexus-task-runtime",
        "nexus-pty-runtime",
        "nexus-window-launch-runtime",
        "nexus-session-runtime",
        "nexus-server",
    ] {
        let binary_path = release_dir.join(binary);
        write_executable(&binary_path, "#!/usr/bin/env bash\nexit 0\n");
        let source_name = format!("{binary}.rs");
        let binary_source = source_dir.join(source_name);
        write_depfile(
            &binary_path,
            &[shared_src.join("lib.rs").as_path(), binary_source.as_path()],
        );
    }

    thread::sleep(Duration::from_millis(1100));
    fs::write(
        source_dir.join("nexus-setup.rs"),
        "// newer than compiled binaries but unrelated\n",
    )
    .unwrap();

    write_executable(
        &bin_dir.join("cargo"),
        &format!(
            "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> {:?}\nexit 0\n",
            cargo_log
        ),
    );

    let output = scrub_runtime_env(
        Command::new("bash")
            .arg("start.sh")
            .current_dir(root)
            .env("PATH", format!("{}:/usr/bin:/bin", bin_dir.display())),
    )
    .output()
    .unwrap();

    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    assert!(output.status.success(), "start.sh failed:\n{combined}");
    assert!(!cargo_log.exists(), "unexpected rebuild triggered");
}

#[test]
fn start_script_falls_back_to_home_cargo_bin_when_path_lacks_cargo() {
    let temp = tempdir().unwrap();
    let root = temp.path();
    let release_dir = root.join("rust-runtime/target/release");
    let source_dir = root.join("rust-runtime/src/bin");
    let cargo_home = root.join(".cargo");
    let path_bin = root.join("path-bin");
    let cargo_log = root.join("cargo.log");

    fs::copy(repo_root().join("start.sh"), root.join("start.sh")).unwrap();
    fs::write(root.join(".env"), "JWT_SECRET=test\n").unwrap();
    fs::create_dir_all(root.join("frontend/dist")).unwrap();
    fs::write(root.join("frontend/dist/index.html"), "<!doctype html>\n").unwrap();
    fs::create_dir_all(&release_dir).unwrap();
    fs::create_dir_all(&source_dir).unwrap();
    fs::write(
        root.join("rust-runtime/Cargo.toml"),
        "[package]\nname=\"stub\"\n",
    )
    .unwrap();
    fs::write(root.join("rust-runtime/Cargo.lock"), "version = 3\n").unwrap();
    fs::write(source_dir.join("nexus-server.rs"), "// server\n").unwrap();
    fs::create_dir_all(&path_bin).unwrap();

    for tool in ["dirname", "grep", "tail", "tr", "sed", "find"] {
        symlink(format!("/usr/bin/{tool}"), path_bin.join(tool)).unwrap();
    }

    write_executable(
        &cargo_home.join("bin/cargo"),
        &format!(
            "#!/usr/bin/bash\nprintf '%s\\n' \"$*\" >> {:?}\nrelease_dir=\"$(pwd)/rust-runtime/target/release\"\n/usr/bin/mkdir -p \"$release_dir\"\nwhile [ \"$#\" -gt 0 ]; do\n  if [ \"$1\" = \"--bin\" ] && [ \"$#\" -ge 2 ]; then\n    shift\n    bin_name=\"$1\"\n    printf '#!/usr/bin/bash\\nexit 0\\n' > \"$release_dir/$bin_name\"\n    /usr/bin/chmod +x \"$release_dir/$bin_name\"\n  fi\n  shift\ndone\nexit 0\n",
            cargo_log
        ),
    );

    let output = scrub_runtime_env(
        Command::new("/usr/bin/bash")
            .arg("start.sh")
            .current_dir(root)
            .env("HOME", root)
            .env("PATH", path_bin),
    )
    .output()
    .unwrap();

    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    assert!(output.status.success(), "start.sh failed:\n{combined}");

    let cargo_log = fs::read_to_string(&cargo_log).unwrap();
    assert!(cargo_log.contains("--manifest-path rust-runtime/Cargo.toml --release"));
    assert!(cargo_log.contains("--bin nexus-task-runtime"));
    assert!(cargo_log.contains("--bin nexus-pty-runtime"));
    assert!(cargo_log.contains("--bin nexus-window-launch-runtime"));
    assert!(cargo_log.contains("--bin nexus-session-runtime"));
    assert!(cargo_log.contains("--bin nexus-server"));
}

#[test]
fn vendored_frontend_bundle_references_existing_served_files() {
    let repo = repo_root();
    let html = fs::read_to_string(repo.join("frontend/dist/index.html")).unwrap();
    let assets = collect_root_relative_paths(&html);

    assert!(
        !assets.is_empty(),
        "index.html should reference served assets"
    );

    for asset in &assets {
        let resolved = resolve_served_path(&repo, asset);
        assert!(
            resolved.is_file(),
            "missing served asset for {asset}: {}",
            resolved.display()
        );
    }

    let manifest = fs::read_to_string(repo.join("public/manifest.json")).unwrap();
    assert!(manifest.contains("\"src\": \"/icon.svg\""));
    assert!(repo.join("public/icon.svg").is_file());
}
