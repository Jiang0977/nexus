fn main() {
    if let Err(error) = nexus_rust_runtime::native_session_cli::run(std::env::args()) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
