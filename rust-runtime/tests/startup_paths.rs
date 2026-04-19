use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::Duration;

use tempfile::tempdir;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

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

#[test]
fn start_script_fails_when_vendored_bundle_is_missing() {
    let temp = tempdir().unwrap();
    let root = temp.path();
    fs::copy(repo_root().join("start.sh"), root.join("start.sh")).unwrap();
    fs::write(root.join(".env"), "JWT_SECRET=test\n").unwrap();

    let output = Command::new("bash")
        .arg("start.sh")
        .current_dir(root)
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
fn start_script_rebuilds_default_release_binaries_when_sources_are_newer() {
    let temp = tempdir().unwrap();
    let root = temp.path();
    let release_dir = root.join("rust-runtime/target/release");
    let source_dir = root.join("rust-runtime/src/bin");
    let bin_dir = root.join("bin");
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

    for binary in [
        "nexus-task-runtime",
        "nexus-pty-runtime",
        "nexus-window-launch-runtime",
        "nexus-session-runtime",
        "nexus-server",
    ] {
        write_executable(&release_dir.join(binary), "#!/usr/bin/env bash\nexit 0\n");
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

    let output = Command::new("bash")
        .arg("start.sh")
        .current_dir(root)
        .env("PATH", format!("{}:/usr/bin:/bin", bin_dir.display()))
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
