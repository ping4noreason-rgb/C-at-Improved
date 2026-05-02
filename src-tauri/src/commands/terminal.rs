use std::path::PathBuf;

use tauri::State;

use crate::models::{AppError, TerminalOutputEvent, TerminalSessionInfo};
use crate::AppState;

#[tauri::command]
pub async fn create_terminal_session(
    initial_cwd: Option<String>,
    state: State<'_, AppState>,
) -> Result<TerminalSessionInfo, AppError> {
    let cwd = initial_cwd.map(PathBuf::from);
    state
        .terminal
        .create_session(cwd.as_deref())
        .await
}

#[tauri::command]
pub async fn execute_terminal_command(
    session_id: String,
    input: String,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    state.terminal.execute(&session_id, &input).await
}

#[tauri::command]
pub async fn set_terminal_cwd(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<String, AppError> {
    state
        .terminal
        .set_cwd(&session_id, PathBuf::from(path).as_path())
        .await
}

#[tauri::command]
pub async fn drain_terminal_output(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<TerminalOutputEvent>, AppError> {
    state.terminal.drain_output(&session_id).await
}

#[tauri::command]
pub async fn close_terminal_session(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    state.terminal.close_session(&session_id).await
}
