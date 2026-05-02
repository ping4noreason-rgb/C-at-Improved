use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileInfo {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_directory: bool,
    pub modified: String,
    pub extension: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileTreeNode {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub extension: Option<String>,
    pub children: Vec<FileTreeNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectInfo {
    pub name: String,
    pub path: String,
    pub created: String,
    pub modified: String,
    pub file_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompileResult {
    pub success: bool,
    pub output: String,
    pub errors: Vec<String>,
    pub execution_time: u64,
    pub compiler: String,
    pub diagnostics: Vec<SyntaxError>,
    pub mode: String,
    pub binary_path: Option<String>,
    pub debugger: Option<String>,
    pub debugger_command: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyntaxError {
    pub file: Option<String>,
    pub line: usize,
    pub column: usize,
    pub message: String,
    pub error_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemInfo {
    pub ram_total: u64,
    pub ram_used: u64,
    pub ram_free: u64,
    pub ram_percent: u8,
    pub disk_total: u64,
    pub disk_used: u64,
    pub disk_free: u64,
    pub cpu_usage: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeStatus {
    pub compiler_available: bool,
    pub compiler_label: String,
    pub debugger_available: bool,
    pub debugger_label: String,
    pub cmake_available: bool,
    pub cmake_label: String,
    pub make_available: bool,
    pub make_label: String,
    pub formatter_available: bool,
    pub formatter_label: String,
    pub git_available: bool,
    pub package_managers: Vec<String>,
    pub project_roots: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalSessionInfo {
    pub session_id: String,
    pub shell: String,
    pub cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalOutputEvent {
    pub stream: String,
    pub text: String,
    pub kind: Option<String>,
    pub cwd: Option<String>,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitFileStatus {
    pub path: String,
    pub status: String,
    pub staged_status: String,
    pub unstaged_status: String,
    pub staged: bool,
    pub has_unstaged: bool,
    pub untracked: bool,
    pub deleted: bool,
    pub renamed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitStatusSummary {
    pub available: bool,
    pub repository: bool,
    pub repo_root: Option<String>,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub clean: bool,
    pub message: Option<String>,
    pub entries: Vec<GitFileStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandResult {
    pub success: bool,
    pub command: String,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildSystemStatus {
    pub kind: String,
    pub available: bool,
    pub detected: bool,
    pub configured: bool,
    pub config_path: Option<String>,
    pub build_dir: Option<String>,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceToolingStatus {
    pub preferred_build_system: Option<String>,
    pub cmake: BuildSystemStatus,
    pub make: BuildSystemStatus,
    pub formatter_available: bool,
    pub formatter_label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FormatResult {
    pub changed: bool,
    pub formatter: String,
    pub formatted_content: String,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Permission denied: {0}")]
    PermissionDenied(String),
    #[error("Path traversal detected: {0}")]
    PathTraversal(String),
    #[error("File not found: {0}")]
    NotFound(String),
    #[error("IO error: {0}")]
    Io(String),
    #[error("Compiler error: {0}")]
    Compiler(String),
    #[error("Build error: {0}")]
    Build(String),
    #[error("Terminal error: {0}")]
    Terminal(String),
    #[error("Git error: {0}")]
    Git(String),
    #[error("Package error: {0}")]
    Package(String),
    #[error("Format error: {0}")]
    Format(String),
    #[error("Window error: {0}")]
    Window(String),
    #[error("Timeout error: {0}")]
    Timeout(String),
    #[error("Invalid name: {0}")]
    InvalidName(String),
    #[error("Monitor error: {0}")]
    Monitor(String),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
