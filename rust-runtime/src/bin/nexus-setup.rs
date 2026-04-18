use serde_json::to_string;
use std::env;
use std::fs;
use std::path::Path;
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

    check_node_version(&root)?;
    ensure_tmux(&root)?;
    ensure_env_file(&root)?;
    install_backend_dependencies(&root)?;
    build_frontend(&root)?;
    ensure_pm2(&root)?;
    write_ecosystem_config(&root)?;
    start_pm2(&root)?;
    ensure_tmux_session(&root)?;
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

fn capture_stdout(program: &str, args: &[&str], cwd: &Path) -> Result<String, String> {
    let output = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|error| format!("failed to run {program}: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("{program} exited with status {}", output.status)
        } else {
            format!("{program} failed: {stderr}")
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
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

fn parse_node_major(version: &str) -> Option<u32> {
    version
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()
        .and_then(|major| major.parse::<u32>().ok())
}

fn check_node_version(root: &Path) -> Result<(), String> {
    step("Checking Node.js version");
    let version = capture_stdout("node", &["--version"], root)?;
    let major = parse_node_major(&version)
        .ok_or_else(|| format!("failed to parse Node.js version output: {version}"))?;
    if major < 20 {
        return Err(format!(
            "Node.js 20+ required, found {version}. Install via: nvm install 20 && nvm use 20"
        ));
    }
    ok(&format!("Node.js {version}"));
    Ok(())
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

fn install_backend_dependencies(root: &Path) -> Result<(), String> {
    step("Installing backend dependencies");
    run_command_checked("npm", &["install"], root, "npm install failed")?;
    ok("Backend dependencies installed");
    Ok(())
}

fn build_frontend(root: &Path) -> Result<(), String> {
    step("Building frontend");
    let frontend_dir = root.join("frontend");
    run_command_checked(
        "npm",
        &["install"],
        &frontend_dir,
        "Frontend install failed",
    )?;
    run_command_checked(
        "npm",
        &["run", "build"],
        &frontend_dir,
        "Frontend build failed — check frontend/node_modules or run: cd frontend && npm install && npm run build",
    )?;
    ok("Frontend built");
    Ok(())
}

fn ensure_pm2(root: &Path) -> Result<(), String> {
    step("Checking PM2");
    if !command_succeeds("pm2", &["--version"], root) {
        println!("PM2 not found — installing globally...");
        run_command_checked(
            "npm",
            &["install", "-g", "pm2"],
            root,
            "Failed to install PM2 globally. Try: sudo npm install -g pm2",
        )?;
    }
    ok("PM2 available");
    Ok(())
}

fn ecosystem_config_content(root: &Path) -> Result<String, String> {
    let cwd = path_literal(root)?;
    Ok(format!(
        "module.exports = {{\n  apps: [{{\n    name: 'nexus',\n    script: 'bash',\n    args: ['./start.sh'],\n    cwd: {cwd},\n    instances: 1,\n    exec_mode: 'fork',\n    env: {{\n      NODE_ENV: 'production'\n    }},\n    error_file: './logs/nexus-error.log',\n    out_file: './logs/nexus-out.log',\n    log_file: './logs/nexus-combined.log',\n    time: true\n  }}]\n}};\n"
    ))
}

fn path_literal(path: &Path) -> Result<String, String> {
    let raw = path
        .to_str()
        .ok_or_else(|| format!("path is not valid UTF-8: {}", path.display()))?;
    to_string(raw).map_err(|error| format!("failed to serialize path {}: {error}", path.display()))
}

fn write_ecosystem_config(root: &Path) -> Result<(), String> {
    step("Writing ecosystem.config.cjs");
    let config_path = root.join("ecosystem.config.cjs");
    fs::write(&config_path, ecosystem_config_content(root)?)
        .map_err(|error| format!("failed to write {}: {error}", config_path.display()))?;
    fs::create_dir_all(root.join("logs"))
        .map_err(|error| format!("failed to create logs directory: {error}"))?;
    ok(&format!(
        "ecosystem.config.cjs written with cwd: {}",
        root.display()
    ));
    Ok(())
}

fn start_pm2(root: &Path) -> Result<(), String> {
    step("Starting Nexus with PM2");
    let _ = Command::new("pm2")
        .args(["delete", "nexus"])
        .current_dir(root)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status();
    run_command_checked(
        "pm2",
        &["start", "ecosystem.config.cjs"],
        root,
        "PM2 start failed — check logs: pm2 logs nexus",
    )?;
    let _ = Command::new("pm2")
        .args(["save"])
        .current_dir(root)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status();
    ok("Nexus started and saved");
    Ok(())
}

fn ensure_tmux_session(root: &Path) -> Result<(), String> {
    step("Ensuring tmux session \"main\" exists");
    if !command_succeeds("tmux", &["has-session", "-t", "main"], root) {
        run_command_checked(
            "tmux",
            &["new-session", "-d", "-s", "main"],
            root,
            "Failed to create tmux session \"main\"",
        )?;
        ok("tmux session \"main\" created");
        return Ok(());
    }
    ok("tmux session \"main\" already exists");
    Ok(())
}

fn print_completion_banner() {
    println!(
        "\n\x1b[32m\n╔══════════════════════════════════════════╗\n║  Nexus setup complete!\n║\n║  URL:      http://localhost:59000\n║  Password: nexus123  (change in .env)\n║\n║  pm2 status     — check process\n║  pm2 logs nexus — view logs\n╚══════════════════════════════════════════╝\n\x1b[0m"
    );
}
