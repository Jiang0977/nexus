use bcrypt::{DEFAULT_COST, hash};
use getrandom::getrandom;
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{self, Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

pub const LEGACY_DEFAULT_JWT_SECRET: &str =
    "fcea4c5c28bee4c9fa7adca25c947f87b2a7179202c824d185618d3b3bf2a333";
pub const LEGACY_DEFAULT_PASSWORD_HASH: &str =
    "$2b$12$5xRyI8a3yVhcCHqYP/Pdju/mKjxtxjWihXE1VpaXCdnuM6VUVNUsW";

const PASSWORD_CHARSET: &[u8] =
    b"abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*";

fn main() {
    if let Err(error) = run() {
        eprintln!("\x1b[31m✖ {error}\x1b[0m");
        process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let root = env::current_dir()
        .map_err(|error| format!("failed to determine current working directory: {error}"))?;

    let args: Vec<String> = env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!(
            "Usage: ./setup.sh [--configure-only] [--reset-password]\n\
            --configure-only  Generate credentials without installing services\n\
            --reset-password  Generate a new password and JWT secret (invalidates existing logins)"
        );
        return Ok(());
    }
    if args
        .iter()
        .any(|arg| arg != "--configure-only" && arg != "--reset-password")
    {
        return Err("Unknown option; run ./setup.sh --help".to_string());
    }
    let configure_only = args.iter().any(|arg| arg == "--configure-only");
    if !configure_only {
        ensure_tmux(&root)?;
        ensure_systemd_user(&root)?;
    }
    ensure_frontend_bundle(&root)?;
    if !configure_only {
        validate_native_session_cli(&root)?;
    }
    let generated_password =
        ensure_env_file(&root, args.iter().any(|arg| arg == "--reset-password"))?;
    // Display credentials before any service operation can fail. They are not recoverable
    // from the stored bcrypt hash, so delaying this until the completion banner loses them.
    if let Some(password) = &generated_password {
        println!("Password: {password}  (one-time generated, save now)");
    }
    if configure_only {
        println!("Configuration ready. Run bash start.sh for foreground use.");
        return Ok(());
    }
    install_native_session_cli(&root)?;
    install_user_units(&root)?;
    start_user_units(&root)?;
    print_completion_banner(generated_password.as_deref());
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
    if command_succeeds("systemctl", &["--user", "show-environment"], root) {
        ok("systemd available");
        return Ok(());
    }

    Err(
        "systemd user services are required. Install/enable systemd and retry, or start Nexus manually with bash ./start.sh".to_string(),
    )
}

fn generate_random_bytes(buf: &mut [u8]) -> Result<(), String> {
    getrandom(buf).map_err(|error| format!("failed to generate secure random bytes: {error}"))
}

fn generate_jwt_secret() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    generate_random_bytes(&mut bytes)?;
    let mut secret = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write;
        write!(&mut secret, "{byte:02x}").map_err(|error| error.to_string())?;
    }
    Ok(secret)
}

fn sample_password_char() -> Result<char, String> {
    let charset_len = PASSWORD_CHARSET.len();
    let limit = 256 - (256 % charset_len);
    let mut byte = [0u8; 1];
    loop {
        generate_random_bytes(&mut byte)?;
        let val = byte[0] as usize;
        if val < limit {
            return Ok(PASSWORD_CHARSET[val % charset_len] as char);
        }
    }
}

fn generate_secure_password() -> Result<String, String> {
    let length = 24;
    let mut password = String::with_capacity(length);
    for _ in 0..length {
        password.push(sample_password_char()?);
    }
    Ok(password)
}

fn hash_password(password: &str) -> Result<String, String> {
    hash(password, DEFAULT_COST)
        .map_err(|error| format!("failed to bcrypt hash generated password: {error}"))
}

fn is_insecure_jwt_secret(secret: &str) -> bool {
    let trimmed = secret.trim();
    trimmed.is_empty() || trimmed == LEGACY_DEFAULT_JWT_SECRET
}

fn is_insecure_password_hash(hash_val: &str) -> bool {
    let trimmed = hash_val.trim();
    trimmed.is_empty() || trimmed == LEGACY_DEFAULT_PASSWORD_HASH
}

#[derive(Debug, PartialEq, Eq)]
pub struct EnvProvisionOutcome {
    pub content: String,
    pub generated_password: Option<String>,
    pub replaced_jwt: bool,
    pub replaced_password: bool,
}

pub fn provision_env_content(
    raw_content: &str,
    is_new_file: bool,
) -> Result<EnvProvisionOutcome, String> {
    let mut lines: Vec<String> = raw_content.lines().map(|line| line.to_string()).collect();
    let mut found_jwt_idx = None;
    let mut current_jwt = String::new();
    let mut found_password_idx = None;
    let mut current_password_hash = String::new();

    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = trimmed.split_once('=') {
            let key = key.trim();
            let value = value.trim();
            if key == "JWT_SECRET" {
                found_jwt_idx = Some(index);
                current_jwt = value.to_string();
            } else if key == "ACC_PASSWORD_HASH" {
                found_password_idx = Some(index);
                current_password_hash = value.to_string();
            }
        }
    }

    let needs_jwt = is_new_file || found_jwt_idx.is_none() || is_insecure_jwt_secret(&current_jwt);
    let needs_password = is_new_file
        || found_password_idx.is_none()
        || is_insecure_password_hash(&current_password_hash);

    let mut generated_password = None;
    let replaced_jwt = needs_jwt;
    let replaced_password = needs_password;

    if needs_jwt {
        let new_jwt = generate_jwt_secret()?;
        if let Some(idx) = found_jwt_idx {
            lines[idx] = format!("JWT_SECRET={new_jwt}");
        } else {
            lines.push(format!("JWT_SECRET={new_jwt}"));
        }
    }

    if needs_password {
        let password = generate_secure_password()?;
        let password_hash = hash_password(&password)?;
        if let Some(idx) = found_password_idx {
            lines[idx] = format!("ACC_PASSWORD_HASH={password_hash}");
        } else {
            lines.push(format!("ACC_PASSWORD_HASH={password_hash}"));
        }
        generated_password = Some(password);
    }

    let mut result = lines.join("\n");
    if raw_content.ends_with('\n') || raw_content.is_empty() {
        result.push('\n');
    }

    Ok(EnvProvisionOutcome {
        content: result,
        generated_password,
        replaced_jwt,
        replaced_password,
    })
}

#[cfg(unix)]
fn open_atomic_temp_file(path: &Path) -> Result<File, std::io::Error> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
}

#[cfg(not(unix))]
fn open_atomic_temp_file(path: &Path) -> Result<File, std::io::Error> {
    OpenOptions::new().write(true).create_new(true).open(path)
}

#[cfg(unix)]
fn set_file_mode_0600(file_path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let permissions = fs::Permissions::from_mode(0o600);
    fs::set_permissions(file_path, permissions).map_err(|error| {
        format!(
            "failed to set permissions 0600 on {}: {error}",
            file_path.display()
        )
    })
}

#[cfg(not(unix))]
fn set_file_mode_0600(_file_path: &Path) -> Result<(), String> {
    Ok(())
}

fn atomic_write_env_file(target_file: &Path, content: &str) -> Result<(), String> {
    let parent_dir = target_file.parent().unwrap_or_else(|| Path::new("."));
    let pid = process::id();
    let mut random_suffix = [0u8; 8];
    let _ = generate_random_bytes(&mut random_suffix);
    let hex_suffix: String = random_suffix.iter().map(|b| format!("{b:02x}")).collect();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp_file_name = format!(".env.tmp.{pid}.{now}.{hex_suffix}");
    let temp_path = parent_dir.join(temp_file_name);

    let write_result = (|| -> Result<(), std::io::Error> {
        let mut file = open_atomic_temp_file(&temp_path)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        Ok(())
    })();

    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(format!(
            "failed to write temporary env file {}: {error}",
            temp_path.display()
        ));
    }

    if let Err(error) = set_file_mode_0600(&temp_path) {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }

    if let Err(error) = fs::rename(&temp_path, target_file) {
        let _ = fs::remove_file(&temp_path);
        return Err(format!(
            "failed to atomically replace {} with {}: {error}",
            target_file.display(),
            temp_path.display()
        ));
    }

    set_file_mode_0600(target_file)?;
    Ok(())
}

fn ensure_env_file(root: &Path, reset_credentials: bool) -> Result<Option<String>, String> {
    step("Setting up .env");
    let env_file = root.join(".env");
    let env_example = root.join(".env.example");

    let (content_to_parse, is_new) = if env_file.exists() {
        let existing = fs::read_to_string(&env_file)
            .map_err(|error| format!("failed to read existing {}: {error}", env_file.display()))?;
        (existing, false)
    } else {
        if !env_example.exists() {
            return Err(".env.example not found — repo may be incomplete".to_string());
        }
        let example_content = fs::read_to_string(&env_example)
            .map_err(|error| format!("failed to read {}: {error}", env_example.display()))?;
        (example_content, true)
    };

    let outcome = provision_env_content(&content_to_parse, is_new || reset_credentials)?;

    atomic_write_env_file(&env_file, &outcome.content)?;

    if is_new {
        ok(".env created with generated credentials (file permissions 0600)");
    } else if outcome.replaced_jwt || outcome.replaced_password {
        ok(".env updated: replaced insecure credentials (file permissions 0600)");
    } else {
        ok(".env already contains custom credentials (file permissions 0600)");
    }

    Ok(outcome.generated_password)
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
fn validate_native_session_cli(root: &Path) -> Result<(), String> {
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
    Ok(())
}

#[cfg(not(unix))]
fn validate_native_session_cli(_root: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn install_native_session_cli(root: &Path) -> Result<(), String> {
    use std::os::unix::fs::symlink;
    step("Installing native session CLI");
    validate_native_session_cli(root)?;
    let target = root.join("rust-runtime/target/release/nexus-native-session");

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

fn print_completion_banner(generated_password: Option<&str>) {
    let password_line = match generated_password {
        Some(_) => "Password: (shown above; save it before closing this terminal)".to_string(),
        None => "Password: (retained existing custom password)".to_string(),
    };

    println!(
        "\n\x1b[32m\n╔══════════════════════════════════════════════════════════╗\n║  Nexus setup complete!\n║\n║  URL:      http://127.0.0.1:59000\n║  {:<56}║\n║\n║  systemctl --user status nexus\n║  journalctl --user -u nexus -f\n╚══════════════════════════════════════════════════════════╝\n\x1b[0m",
        password_line
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn provisions_credentials_for_blank_env() {
        let raw = "HOST=127.0.0.1\nJWT_SECRET=\nACC_PASSWORD_HASH=\n";
        let outcome = provision_env_content(raw, false).expect("provision");
        assert!(outcome.replaced_jwt);
        assert!(outcome.replaced_password);
        let pass = outcome.generated_password.expect("password");
        assert!(!pass.is_empty());
        assert!(!outcome.content.contains("JWT_SECRET=\n"));
        assert!(!outcome.content.contains("ACC_PASSWORD_HASH=\n"));
    }

    #[test]
    fn replaces_legacy_default_credentials() {
        let raw = format!(
            "JWT_SECRET={LEGACY_DEFAULT_JWT_SECRET}\nACC_PASSWORD_HASH={LEGACY_DEFAULT_PASSWORD_HASH}\n"
        );
        let outcome = provision_env_content(&raw, false).expect("provision");
        assert!(outcome.replaced_jwt);
        assert!(outcome.replaced_password);
        assert!(!outcome.content.contains(LEGACY_DEFAULT_JWT_SECRET));
        assert!(!outcome.content.contains(LEGACY_DEFAULT_PASSWORD_HASH));
    }

    #[test]
    fn preserves_custom_credentials() {
        let raw = "JWT_SECRET=custom-secret-key-1234567890\nACC_PASSWORD_HASH=$2b$12$customhashvaluehere\n";
        let outcome = provision_env_content(raw, false).expect("provision");
        assert!(!outcome.replaced_jwt);
        assert!(!outcome.replaced_password);
        assert_eq!(outcome.generated_password, None);
        assert_eq!(outcome.content, raw);
    }

    #[test]
    fn secure_password_generation_uses_valid_charset_and_rejection_sampling() {
        for _ in 0..20 {
            let pass = generate_secure_password().expect("generated password");
            assert_eq!(pass.len(), 24);
            for ch in pass.chars() {
                assert!(
                    PASSWORD_CHARSET.contains(&(ch as u8)),
                    "invalid char in generated password: {ch}"
                );
            }
        }
    }

    #[test]
    fn atomic_write_env_file_creates_0600_file_and_replaces_content() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let env_path = temp_dir.path().join(".env");
        let initial_content = "KEY=old_value\n";
        fs::write(&env_path, initial_content).expect("write initial");

        let new_content = "KEY=new_atomic_value\n";
        atomic_write_env_file(&env_path, new_content).expect("atomic write");

        let read_back = fs::read_to_string(&env_path).expect("read back");
        assert_eq!(read_back, new_content);

        #[cfg(unix)]
        {
            let metadata = fs::metadata(&env_path).expect("metadata");
            let mode = metadata.permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn atomic_write_failure_preserves_old_env_file() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let env_path = temp_dir.path().join(".env");
        let original_content = "HOST=127.0.0.1\nACC_PASSWORD_HASH=original_untouched\n";
        fs::write(&env_path, original_content).expect("write initial");

        let non_existent_dir = temp_dir.path().join("missing_dir").join(".env");
        let res = atomic_write_env_file(&non_existent_dir, "NEW_CONTENT=failed");
        assert!(res.is_err());

        let read_back = fs::read_to_string(&env_path).expect("read back");
        assert_eq!(read_back, original_content);
    }
}
