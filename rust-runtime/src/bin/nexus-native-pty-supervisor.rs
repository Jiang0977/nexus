fn main() {
    if let Err(error) = nexus_rust_runtime::pty_runtime::run_native_pty_supervisor() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
