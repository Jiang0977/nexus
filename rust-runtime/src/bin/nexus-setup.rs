use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{self, Command, Stdio};

fn main() {
    if let Err(error) = run() {
        eprintln!("\x1b[31m✖ {error}\x1b[0m");
        process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let root = env::current_dir()
        .map_err(|error| format!("failed to determine current working directory: {error}"))?;

    ensure_tmux(&root)?;
    ensure_systemd_user(&root)?;
    ensure_env_file(&root)?;
    ensure_frontend_bundle(&root)?;
    install_native_session_cli(&root)?;
    install_user_units(&root)?;
    start_user_units(&root)?;
    print_completion_banner();
    Ok(())
}

fn step(message: &str) {
    println!("\n\x1b[36m▶ {message}\x1b[0m");
}

fn ok(message: &str) {
    println!("\x1b[32m✔ {message}\x1b[0m");
}

fn command_succeeds(program: &str, args: &[&str], cwd: &Path) -> bool {
    Command::new(program)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn run_command_checked(
    program: &str,
    args: &[&str],
    cwd: &Path,
    failure_message: &str,
) -> Result<(), String> {
    let status = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .map_err(|error| format!("failed to run {program}: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(failure_message.to_string())
    }
}

fn ensure_tmux(root: &Path) -> Result<(), String> {
    step("Checking tmux");
    if !command_succeeds("tmux", &["-V"], root) {
        println!("tmux not found — attempting install...");
        if command_succeeds("apt-get", &["--version"], root) {
            run_command_checked(
                "sudo",
                &["apt-get", "install", "-y", "tmux"],
                root,
                "Failed to install tmux automatically. Install it manually: sudo apt install tmux  OR  brew install tmux",
            )?;
        } else if command_succeeds("brew", &["--version"], root) {
            run_command_checked(
                "brew",
                &["install", "tmux"],
                root,
                "Failed to install tmux automatically. Install it manually: sudo apt install tmux  OR  brew install tmux",
            )?;
        } else {
            return Err(
                "tmux not found. Install it manually: sudo apt install tmux  OR  brew install tmux"
                    .to_string(),
            );
        }
    }
    ok("tmux available");
    Ok(())
}

fn ensure_systemd_user(root: &Path) -> Result<(), String> {
    step("Checking systemd user services");
    if command_succeeds("systemctl", &["--user", "--version"], root)
        || command_succeeds("systemctl", &["--version"], root)
    {
        ok("systemd available");
        return Ok(());
    }

    Err(
        "systemd user services are required. Install/enable systemd and retry, or start Nexus manually with bash ./start.sh".to_string(),
    )
}

fn ensure_env_file(root: &Path) -> Result<(), String> {
    step("Setting up .env");
    let env_file = root.join(".env");
    if env_file.exists() {
        ok(".env already exists — skipping");
        return Ok(());
    }

    let env_example = root.join(".env.example");
    if !env_example.exists() {
        return Err(".env.example not found — repo may be incomplete".to_string());
    }

    fs::copy(&env_example, &env_file).map_err(|error| {
        format!(
            "failed to copy {} to {}: {error}",
            env_example.display(),
            env_file.display()
        )
    })?;
    ok(".env created from .env.example (default password: nexus123)");
    Ok(())
}

fn ensure_frontend_bundle(root: &Path) -> Result<(), String> {
    step("Checking vendored frontend bundle");
    let index = root.join("frontend").join("dist").join("index.html");
    if !index.exists() {
        return Err(
            "vendored frontend bundle is missing at frontend/dist/index.html — repo may be incomplete"
                .to_string(),
        );
    }
    ok("frontend/dist present");
    Ok(())
}

fn current_user() -> String {
    env::var("USER").unwrap_or_else(|_| "unknown".to_string())
}

fn current_home() -> Result<PathBuf, String> {
    env::var("HOME")
        .map(PathBuf::from)
        .map_err(|_| "HOME is not set; cannot install systemd user units".to_string())
}

fn current_shell() -> String {
    env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
}

fn current_lang() -> String {
    env::var("LANG").unwrap_or_else(|_| "C.UTF-8".to_string())
}

fn current_lc_all() -> String {
    env::var("LC_ALL").unwrap_or_else(|_| current_lang())
}

fn current_path() -> String {
    env::var("PATH").unwrap_or_else(|_| {
        "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin".to_string()
    })
}

#[cfg(unix)]
fn install_native_session_cli(root: &Path) -> Result<(), String> {
    use std::os::unix::fs::symlink;

    step("Installing native session CLI");
    let target = root
        .join("rust-runtime")
        .join("target")
        .join("release")
        .join("nexus-native-session");
    if !target.is_file() {
        return Err(format!(
            "native session CLI is missing at {}. Build it first with: cargo build --manifest-path rust-runtime/Cargo.toml --release --bin nexus-native-session",
            target.display()
        ));
    }

    let bin_dir = current_home()?.join(".local").join("bin");
    fs::create_dir_all(&bin_dir)
        .map_err(|error| format!("failed to create {}: {error}", bin_dir.display()))?;
    let link = bin_dir.join("nexus-native-session");
    if link.exists() || link.symlink_metadata().is_ok() {
        fs::remove_file(&link)
            .map_err(|error| format!("failed to replace {}: {error}", link.display()))?;
    }
    symlink(&target, &link).map_err(|error| {
        format!(
            "failed to install {} -> {}: {error}",
            link.display(),
            target.display()
        )
    })?;
    ok(&format!(
        "native session CLI installed at {}",
        link.display()
    ));
    Ok(())
}

#[cfg(not(unix))]
fn install_native_session_cli(_root: &Path) -> Result<(), String> {
    Ok(())
}

fn user_systemd_dir() -> Result<PathBuf, String> {
    Ok(current_home()?.join(".config").join("systemd").join("user"))
}

fn systemd_quote(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

fn bash_path() -> &'static str {
    "/usr/bin/bash"
}

fn nexus_service_content(root: &Path) -> Result<String, String> {
    let root = root
        .to_str()
        .ok_or_else(|| format!("path is not valid UTF-8: {}", root.display()))?;
    let home = current_home()?;
    let home = home
        .to_str()
        .ok_or_else(|| format!("path is not valid UTF-8: {}", home.display()))?;
    let start_script = format!("{root}/start.sh");

    Ok(format!(
        "[Unit]\nDescription=Nexus service\nAfter=network-online.target nexus-tmux.service\nWants=network-online.target nexus-tmux.service\n\n[Service]\nType=simple\nWorkingDirectory={}\nEnvironment=HOME={}\nEnvironment=USER={}\nEnvironment=SHELL={}\nEnvironment=LANG={}\nEnvironment=LC_ALL={}\nEnvironment=PATH={}\nExecStart={} {}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=20\nKillMode=control-group\n\n[Install]\nWantedBy=default.target\n",
        systemd_quote(root),
        systemd_quote(home),
        systemd_quote(&current_user()),
        systemd_quote(&current_shell()),
        systemd_quote(&current_lang()),
        systemd_quote(&current_lc_all()),
        systemd_quote(&current_path()),
        bash_path(),
        systemd_quote(&start_script),
    ))
}

fn nexus_tmux_service_content(root: &Path) -> Result<String, String> {
    let root = root
        .to_str()
        .ok_or_else(|| format!("path is not valid UTF-8: {}", root.display()))?;
    let home = current_home()?;
    let home = home
        .to_str()
        .ok_or_else(|| format!("path is not valid UTF-8: {}", home.display()))?;
    let tmux_script = format!("{root}/scripts/nexus-tmux-service.sh");

    Ok(format!(
        "[Unit]\nDescription=Persistent tmux server for Nexus\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory={}\nEnvironment=HOME={}\nEnvironment=USER={}\nEnvironment=SHELL={}\nEnvironment=LANG={}\nEnvironment=LC_ALL={}\nEnvironment=PATH={}\nExecStart={} {} start-foreground\nExecStartPost={} {} ensure-session\nExecStop={} {} stop\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=20\nKillMode=control-group\n\n[Install]\nWantedBy=default.target\n",
        systemd_quote(root),
        systemd_quote(home),
        systemd_quote(&current_user()),
        systemd_quote(&current_shell()),
        systemd_quote(&current_lang()),
        systemd_quote(&current_lc_all()),
        systemd_quote(&current_path()),
        bash_path(),
        systemd_quote(&tmux_script),
        bash_path(),
        systemd_quote(&tmux_script),
        bash_path(),
        systemd_quote(&tmux_script),
    ))
}

fn nexus_native_pty_service_content(root: &Path) -> Result<String, String> {
    let root = root
        .to_str()
        .ok_or_else(|| format!("path is not valid UTF-8: {}", root.display()))?;
    let home = current_home()?;
    let home = home
        .to_str()
        .ok_or_else(|| format!("path is not valid UTF-8: {}", home.display()))?;
    let supervisor_script = format!("{root}/scripts/nexus-native-pty-service.sh");

    Ok(format!(
        "[Unit]\nDescription=Persistent native PTY supervisor for Nexus\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory={}\nEnvironment=HOME={}\nEnvironment=USER={}\nEnvironment=SHELL={}\nEnvironment=LANG={}\nEnvironment=LC_ALL={}\nEnvironment=PATH={}\nExecStart={} {}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=20\nKillMode=control-group\n\n[Install]\nWantedBy=default.target\n",
        systemd_quote(root),
        systemd_quote(home),
        systemd_quote(&current_user()),
        systemd_quote(&current_shell()),
        systemd_quote(&current_lang()),
        systemd_quote(&current_lc_all()),
        systemd_quote(&current_path()),
        bash_path(),
        systemd_quote(&supervisor_script),
    ))
}

fn install_user_units(root: &Path) -> Result<(), String> {
    step("Installing systemd user units");
    let systemd_dir = user_systemd_dir()?;
    fs::create_dir_all(&systemd_dir)
        .map_err(|error| format!("failed to create {}: {error}", systemd_dir.display()))?;

    let nexus_service = systemd_dir.join("nexus.service");
    let tmux_service = systemd_dir.join("nexus-tmux.service");
    let native_pty_service = systemd_dir.join("nexus-native-pty.service");

    fs::write(&nexus_service, nexus_service_content(root)?)
        .map_err(|error| format!("failed to write {}: {error}", nexus_service.display()))?;
    fs::write(&tmux_service, nexus_tmux_service_content(root)?)
        .map_err(|error| format!("failed to write {}: {error}", tmux_service.display()))?;
    fs::write(&native_pty_service, nexus_native_pty_service_content(root)?)
        .map_err(|error| format!("failed to write {}: {error}", native_pty_service.display()))?;

    ok(&format!(
        "installed user units in {}",
        systemd_dir.display()
    ));
    Ok(())
}

fn start_user_units(root: &Path) -> Result<(), String> {
    step("Starting Nexus with systemd user services");
    run_command_checked(
        "systemctl",
        &["--user", "daemon-reload"],
        root,
        "Failed to reload systemd user daemon",
    )?;
    run_command_checked(
        "systemctl",
        &["--user", "enable", "--now", "nexus-tmux.service"],
        root,
        "Failed to enable/start nexus-tmux.service",
    )?;
    run_command_checked(
        "systemctl",
        &["--user", "enable", "--now", "nexus-native-pty.service"],
        root,
        "Failed to enable/start nexus-native-pty.service",
    )?;
    run_command_checked(
        "systemctl",
        &["--user", "enable", "--now", "nexus.service"],
        root,
        "Failed to enable/start nexus.service",
    )?;
    ok("systemd user services enabled and started");
    Ok(())
}

fn print_completion_banner() {
    println!(
        "\n\x1b[32m\n╔══════════════════════════════════════════╗\n║  Nexus setup complete!\n║\n║  URL:      http://localhost:59000\n║  Password: nexus123  (change in .env)\n║\n║  systemctl --user status nexus\n║  journalctl --user -u nexus -f\n╚══════════════════════════════════════════╝\n\x1b[0m"
    );
}
