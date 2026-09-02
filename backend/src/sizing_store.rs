use std::path::{Path, PathBuf};

use tokio::fs;

use crate::{
    error::{AppError, AppResult},
    models::MarginSizingConfig,
};

#[derive(Clone)]
pub struct SizingStore {
    path: PathBuf,
}

impl SizingStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub async fn load(&self, fallback: MarginSizingConfig) -> AppResult<MarginSizingConfig> {
        match fs::read_to_string(&self.path).await {
            Ok(contents) => {
                let stored: MarginSizingConfig = serde_json::from_str(&contents)?;

                MarginSizingConfig::new(
                    stored.margin_pct,
                    stored.leverage_safety,
                    stored.max_leverage,
                )
                .map_err(AppError::Config)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(fallback),
            Err(error) => Err(AppError::Io(error)),
        }
    }

    pub async fn save(&self, config: &MarginSizingConfig) -> AppResult<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).await?;
        }

        let serialized = serde_json::to_vec_pretty(config)?;
        let temporary_path = temporary_path(&self.path);

        fs::write(&temporary_path, serialized).await?;
        fs::rename(&temporary_path, &self.path).await?;

        Ok(())
    }
}

fn temporary_path(path: &Path) -> PathBuf {
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(".tmp");
    PathBuf::from(temporary)
}
