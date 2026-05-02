use std::path::PathBuf;

use tauri::State;

use crate::models::{AppError, CompileResult, SyntaxError};
use crate::AppState;

#[tauri::command]
pub async fn compile_code(
    code: String,
    filename: Option<String>,
    project_path: Option<String>,
    file_path: Option<String>,
    mode: Option<String>,
    state: State<'_, AppState>,
) -> Result<CompileResult, AppError> {
    let project_path_buf = project_path.map(PathBuf::from);
    let file_path_buf = file_path.map(PathBuf::from);

    state
        .compiler
        .compile(
            &code,
            filename.as_deref(),
            project_path_buf.as_deref(),
            file_path_buf.as_deref(),
            mode.as_deref(),
        )
        .await
}

#[tauri::command]
pub async fn check_syntax(
    code: String,
    state: State<'_, AppState>,
) -> Result<Vec<SyntaxError>, AppError> {
    state.compiler.check_syntax(&code).await
}

#[tauri::command]
pub async fn get_completions(
    code: String,
    prefix: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<String>, AppError> {
    state
        .compiler
        .get_completions(&code, prefix.as_deref())
        .await
}
