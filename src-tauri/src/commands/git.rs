use std::path::PathBuf;

use tauri::State;

use crate::models::{AppError, CommandResult, GitStatusSummary};
use crate::AppState;

#[tauri::command]
pub async fn get_git_status(
    project_path: String,
    state: State<'_, AppState>,
) -> Result<GitStatusSummary, AppError> {
    state
        .git
        .status(PathBuf::from(project_path).as_path())
        .await
}

#[tauri::command]
pub async fn init_git_repository(
    project_path: String,
    state: State<'_, AppState>,
) -> Result<CommandResult, AppError> {
    state
        .git
        .init_repo(PathBuf::from(project_path).as_path())
        .await
}

#[tauri::command]
pub async fn git_stage_all(
    project_path: String,
    state: State<'_, AppState>,
) -> Result<CommandResult, AppError> {
    state
        .git
        .stage_all(PathBuf::from(project_path).as_path())
        .await
}

#[tauri::command]
pub async fn git_commit(
    project_path: String,
    message: String,
    state: State<'_, AppState>,
) -> Result<CommandResult, AppError> {
    state
        .git
        .commit(PathBuf::from(project_path).as_path(), &message)
        .await
}

#[tauri::command]
pub async fn git_pull(
    project_path: String,
    state: State<'_, AppState>,
) -> Result<CommandResult, AppError> {
    state
        .git
        .pull(PathBuf::from(project_path).as_path())
        .await
}

#[tauri::command]
pub async fn git_push(
    project_path: String,
    state: State<'_, AppState>,
) -> Result<CommandResult, AppError> {
    state
        .git
        .push(PathBuf::from(project_path).as_path())
        .await
}
