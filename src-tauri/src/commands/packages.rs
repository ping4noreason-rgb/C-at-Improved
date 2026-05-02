use std::path::PathBuf;

use tauri::State;

use crate::models::{AppError, CommandResult};
use crate::AppState;

#[tauri::command]
pub async fn install_package(
    project_path: String,
    manager: String,
    package_name: String,
    state: State<'_, AppState>,
) -> Result<CommandResult, AppError> {
    state
        .packages
        .install(
            PathBuf::from(project_path).as_path(),
            &manager,
            &package_name,
        )
        .await
}
