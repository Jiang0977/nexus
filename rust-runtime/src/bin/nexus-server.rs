use std::error::Error;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    nexus_rust_runtime::server::run().await
}
