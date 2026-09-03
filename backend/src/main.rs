#[tokio::main]
async fn main() -> fyxtez_backend::AppResult<()> {
    fyxtez_backend::run_from_environment().await
}
