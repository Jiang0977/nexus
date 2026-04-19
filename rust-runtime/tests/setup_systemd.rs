use std::fs;
use std::path::Path;
use std::process::Command;

use tempfile::tempdir;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

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

#[cfg(unix)]
#[test]
fn nexus_setup_installs_systemd_units_without_node_or_pm2() {
    let temp = tempdir().unwrap();
    let root = temp.path();
    let home = root.join("home");
    let bin_dir = root.join("bin");
    let log_file = root.join("command.log");

    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(root.join("frontend/dist")).unwrap();
    fs::create_dir_all(root.join("scripts")).unwrap();
    fs::write(
        root.join(".env.example"),
        "JWT_SECRET=test\nACC_PASSWORD_HASH=test\nWORKSPACE_ROOT=/tmp\n",
    )
    .unwrap();
    fs::write(root.join("frontend/dist/index.html"), "<!doctype html>\n").unwrap();
    fs::write(root.join("start.sh"), "#!/usr/bin/bash\nexit 0\n").unwrap();
    write_executable(
        &root.join("scripts/nexus-tmux-service.sh"),
        "#!/usr/bin/bash\nexit 0\n",
    );

    write_executable(
        &bin_dir.join("systemctl"),
        &format!(
            "#!/usr/bin/bash\nprintf 'systemctl %s\\n' \"$*\" >> {:?}\nexit 0\n",
            log_file
        ),
    );
    write_executable(
        &bin_dir.join("tmux"),
        &format!(
            "#!/usr/bin/bash\nprintf 'tmux %s\\n' \"$*\" >> {:?}\ncase \"$1\" in\n  -V) exit 0 ;;\n  has-session) exit 1 ;;\n  new-session) exit 0 ;;\n  *) exit 0 ;;\nesac\n",
            log_file
        ),
    );

    let output = Command::new(env!("CARGO_BIN_EXE_nexus-setup"))
        .current_dir(root)
        .env("HOME", &home)
        .env("USER", "tester")
        .env("SHELL", "/bin/bash")
        .env("LANG", "C.UTF-8")
        .env("LC_ALL", "C.UTF-8")
        .env("PATH", format!("{}:/usr/bin:/bin", bin_dir.display()))
        .output()
        .unwrap();

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "setup failed\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );

    assert!(root.join(".env").is_file());

    let nexus_service =
        fs::read_to_string(home.join(".config/systemd/user/nexus.service")).unwrap();
    assert!(nexus_service.contains("Description=Nexus service"));
    assert!(nexus_service.contains("ExecStart=/usr/bin/bash"));
    assert!(nexus_service.contains("start.sh"));
    assert!(!nexus_service.contains("pm2"));
    assert!(!nexus_service.contains("node"));

    let tmux_service =
        fs::read_to_string(home.join(".config/systemd/user/nexus-tmux.service")).unwrap();
    assert!(tmux_service.contains("Persistent tmux server for Nexus"));
    assert!(tmux_service.contains("nexus-tmux-service.sh"));
    assert!(!tmux_service.contains("pm2"));
    assert!(!tmux_service.contains("node"));

    let log = fs::read_to_string(&log_file).unwrap();
    assert!(log.contains("systemctl --user daemon-reload"));
    assert!(log.contains("systemctl --user enable --now nexus-tmux.service"));
    assert!(log.contains("systemctl --user enable --now nexus.service"));
    assert!(log.contains("tmux has-session -t main"));
    assert!(log.contains("tmux new-session -d -s main"));

    assert!(stdout.contains("systemctl --user status nexus"));
    assert!(stdout.contains("Nexus setup complete"));
}
