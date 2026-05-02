use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use regex::Regex;
use tokio::sync::oneshot;

use crate::models::{AppError, CommandResult, GitFileStatus, GitStatusSummary};
use crate::utils::path_validator::PathValidator;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub struct GitService {
    git_path: Option<PathBuf>,
    worker: Arc<GitWorker>,
}

enum GitTaskKind {
    Status {
        project_path: PathBuf,
    },
    RunCommand {
        project_path: PathBuf,
        args: Vec<String>,
    },
}

enum GitTaskResponse {
    Status(Result<GitStatusSummary, AppError>),
    Command(Result<CommandResult, AppError>),
}

struct GitTask {
    kind: GitTaskKind,
    response: oneshot::Sender<GitTaskResponse>,
}

struct GitWorker {
    tx: Mutex<Option<std::sync::mpsc::Sender<GitTask>>>,
    running: AtomicBool,
    git_path: Option<PathBuf>,
}

impl GitService {
    pub fn new() -> Self {
        let git_path = which::which("git").ok();
        let worker = Arc::new(GitWorker::new(git_path.clone()));
        worker.ensure_running();
        Self {
            git_path,
            worker,
        }
    }

    pub fn is_available(&self) -> bool {
        self.git_path.is_some()
    }

    pub async fn status(&self, project_path: &Path) -> Result<GitStatusSummary, AppError> {
        let valid_path = PathValidator::validate_directory_path(project_path)?;

        let Some(_) = self.git_path.as_ref() else {
            return Ok(GitStatusSummary {
                available: false,
                repository: false,
                repo_root: None,
                branch: None,
                upstream: None,
                ahead: 0,
                behind: 0,
                clean: true,
                message: Some("Git was not found in PATH.".to_string()),
                entries: Vec::new(),
            });
        };

        self.dispatch_status(valid_path, Duration::from_secs(8)).await
    }

    pub async fn init_repo(&self, project_path: &Path) -> Result<CommandResult, AppError> {
        self.run_git_command(project_path, &["init"]).await
    }

    pub async fn stage_all(&self, project_path: &Path) -> Result<CommandResult, AppError> {
        self.run_git_command(project_path, &["add", "-A"]).await
    }

    pub async fn commit(
        &self,
        project_path: &Path,
        message: &str,
    ) -> Result<CommandResult, AppError> {
        let trimmed = message.trim();
        if trimmed.is_empty() {
            return Err(AppError::Git("Commit message cannot be empty.".to_string()));
        }

        self.run_git_command(project_path, &["commit", "-m", trimmed]).await
    }

    pub async fn pull(&self, project_path: &Path) -> Result<CommandResult, AppError> {
        self.run_git_command(project_path, &["pull", "--stat"]).await
    }

    pub async fn push(&self, project_path: &Path) -> Result<CommandResult, AppError> {
        self.run_git_command(project_path, &["push"]).await
    }

    async fn run_git_command(
        &self,
        project_path: &Path,
        args: &[&str],
    ) -> Result<CommandResult, AppError> {
        let valid_path = PathValidator::validate_directory_path(project_path)?;
        self.git_path
            .as_ref()
            .ok_or_else(|| AppError::Git("Git was not found in PATH.".to_string()))?;
        let owned_args = args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>();

        // Push/pull can take longer; other commands should be fast
        let is_network_op = owned_args.first().map(|a| a == "pull" || a == "push").unwrap_or(false);
        let timeout_secs = if is_network_op { 60 } else { 10 };

        self.dispatch_command(valid_path, owned_args, Duration::from_secs(timeout_secs))
            .await
    }

    async fn dispatch_status(
        &self,
        project_path: PathBuf,
        timeout: Duration,
    ) -> Result<GitStatusSummary, AppError> {
        let (tx, rx) = oneshot::channel();
        let task = GitTask {
            kind: GitTaskKind::Status { project_path },
            response: tx,
        };
        self.worker.send(task)?;
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(GitTaskResponse::Status(result))) => result,
            Ok(Ok(_)) => Err(AppError::Git("Git worker returned invalid status response.".to_string())),
            Ok(Err(_)) => Err(AppError::Git("Git worker closed unexpectedly while loading status.".to_string())),
            Err(_) => Err(AppError::Timeout(
                "Git status timed out after 8 seconds. Is git waiting for credentials?".to_string(),
            )),
        }
    }

    async fn dispatch_command(
        &self,
        project_path: PathBuf,
        args: Vec<String>,
        timeout: Duration,
    ) -> Result<CommandResult, AppError> {
        let (tx, rx) = oneshot::channel();
        let task = GitTask {
            kind: GitTaskKind::RunCommand { project_path, args },
            response: tx,
        };
        self.worker.send(task)?;
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(GitTaskResponse::Command(result))) => result,
            Ok(Ok(_)) => Err(AppError::Git("Git worker returned invalid command response.".to_string())),
            Ok(Err(_)) => Err(AppError::Git("Git worker closed unexpectedly while executing command.".to_string())),
            Err(_) => Err(AppError::Timeout(format!(
                "Git command timed out after {} seconds",
                timeout.as_secs()
            ))),
        }
    }

    fn status_blocking(git_path: &Path, project_path: &Path) -> Result<GitStatusSummary, AppError> {
        let repo_root = Self::discover_repo_root(git_path, project_path)?;
        let Some(repo_root) = repo_root else {
            return Ok(GitStatusSummary {
                available: true,
                repository: false,
                repo_root: None,
                branch: None,
                upstream: None,
                ahead: 0,
                behind: 0,
                clean: true,
                message: Some("Workspace is not a Git repository yet.".to_string()),
                entries: Vec::new(),
            });
        };

        let output = Self::run_git_raw(git_path, &repo_root, &["status", "--short", "--branch", "--untracked-files=normal"])?;
        if !output.status.success() {
            return Err(AppError::Git(
                String::from_utf8_lossy(&output.stderr).trim().to_string(),
            ));
        }

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let mut lines = stdout.lines();
        let branch_line = lines.next().unwrap_or_default();
        let (branch, upstream, ahead, behind) = Self::parse_branch_line(branch_line);
        let entries = lines
            .filter_map(Self::parse_status_line)
            .collect::<Vec<_>>();

        Ok(GitStatusSummary {
            available: true,
            repository: true,
            repo_root: Some(repo_root.to_string_lossy().to_string()),
            branch,
            upstream,
            ahead,
            behind,
            clean: entries.is_empty(),
            message: None,
            entries,
        })
    }

    fn discover_repo_root(
        git_path: &Path,
        project_path: &Path,
    ) -> Result<Option<PathBuf>, AppError> {
        let output = Self::run_git_raw(git_path, project_path, &["rev-parse", "--show-toplevel"])?;
        if output.status.success() {
            let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if root.is_empty() {
                return Ok(None);
            }

            return Ok(Some(PathBuf::from(root)));
        }

        let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
        if stderr.contains("not a git repository") {
            return Ok(None);
        }

        Err(AppError::Git(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ))
    }

    fn run_git_process(
        git_path: &Path,
        cwd: &Path,
        args: &[String],
    ) -> Result<CommandResult, AppError> {
        let arg_refs = args.iter().map(String::as_str).collect::<Vec<_>>();
        let output = Self::run_git_raw(git_path, cwd, &arg_refs)?;

        Ok(CommandResult {
            success: output.status.success(),
            command: format!(
                "git -C \"{}\" {}",
                cwd.display(),
                args.join(" ")
            ),
            stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
            exit_code: output.status.code(),
        })
    }

    fn run_git_raw(
        git_path: &Path,
        cwd: &Path,
        args: &[&str],
    ) -> Result<std::process::Output, AppError> {
        let mut command = Command::new(git_path);
        command.args(args).current_dir(cwd);

        // Prevent git from waiting for terminal input (credentials, etc.)
        // This is the primary cause of hangs on the Git panel
        command.env("GIT_TERMINAL_PROMPT", "0");
        command.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes -o StrictHostKeyChecking=no");

        #[cfg(target_os = "windows")]
        command.creation_flags(CREATE_NO_WINDOW);

        command
            .output()
            .map_err(|error| AppError::Git(format!("Failed to execute git: {}", error)))
    }

    fn parse_branch_line(line: &str) -> (Option<String>, Option<String>, u32, u32) {
        if !line.starts_with("##") {
            return (None, None, 0, 0);
        }

        let normalized = line.trim_start_matches("##").trim();
        let meta_regex = Regex::new(r"\[(?P<meta>[^\]]+)\]").unwrap();
        let meta = meta_regex
            .captures(normalized)
            .and_then(|captures| captures.name("meta"))
            .map(|value| value.as_str().to_string())
            .unwrap_or_default();

        let branch_segment = normalized
            .split('[')
            .next()
            .unwrap_or_default()
            .trim();

        let normalized_branch = if let Some(value) = branch_segment.strip_prefix("No commits yet on ") {
            value.trim()
        } else if branch_segment.eq_ignore_ascii_case("HEAD (no branch)") {
            "detached"
        } else {
            branch_segment
        };

        let (branch, upstream) = if let Some((local, remote)) = normalized_branch.split_once("...") {
            (Some(local.trim().to_string()), Some(remote.trim().to_string()))
        } else if normalized_branch.is_empty() {
            (None, None)
        } else {
            (Some(normalized_branch.to_string()), None)
        };

        let ahead_regex = Regex::new(r"ahead (?P<count>\d+)").unwrap();
        let behind_regex = Regex::new(r"behind (?P<count>\d+)").unwrap();

        let ahead = ahead_regex
            .captures(&meta)
            .and_then(|captures| captures.name("count"))
            .and_then(|value| value.as_str().parse::<u32>().ok())
            .unwrap_or(0);
        let behind = behind_regex
            .captures(&meta)
            .and_then(|captures| captures.name("count"))
            .and_then(|value| value.as_str().parse::<u32>().ok())
            .unwrap_or(0);

        (branch, upstream, ahead, behind)
    }

    fn parse_status_line(line: &str) -> Option<GitFileStatus> {
        if line.len() < 3 {
            return None;
        }

        let chars = line.chars().collect::<Vec<_>>();
        let staged_char = *chars.first()?;
        let unstaged_char = *chars.get(1)?;
        let raw_path = line.get(3..)?.trim();
        let path = raw_path
            .split(" -> ")
            .last()
            .unwrap_or(raw_path)
            .trim()
            .to_string();

        Some(GitFileStatus {
            path,
            status: format!("{}{}", staged_char, unstaged_char).trim().to_string(),
            staged_status: staged_char.to_string(),
            unstaged_status: unstaged_char.to_string(),
            staged: staged_char != ' ' && staged_char != '?',
            has_unstaged: unstaged_char != ' ',
            untracked: staged_char == '?' && unstaged_char == '?',
            deleted: staged_char == 'D' || unstaged_char == 'D',
            renamed: staged_char == 'R' || unstaged_char == 'R',
        })
    }
}

impl GitWorker {
    fn new(git_path: Option<PathBuf>) -> Self {
        Self {
            tx: Mutex::new(None),
            running: AtomicBool::new(false),
            git_path,
        }
    }

    fn send(&self, task: GitTask) -> Result<(), AppError> {
        self.ensure_running();
        let guard = self
            .tx
            .lock()
            .map_err(|_| AppError::Git("Git worker lock poisoned.".to_string()))?;
        let tx = guard
            .as_ref()
            .ok_or_else(|| AppError::Git("Git worker is unavailable.".to_string()))?;
        tx.send(task)
            .map_err(|_| AppError::Git("Git worker queue is unavailable.".to_string()))
    }

    fn ensure_running(&self) {
        if self.running.load(Ordering::SeqCst) {
            return;
        }
        let mut guard = match self.tx.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        if self.running.load(Ordering::SeqCst) {
            return;
        }
        let (tx, rx) = std::sync::mpsc::channel::<GitTask>();
        *guard = Some(tx);
        self.running.store(true, Ordering::SeqCst);
        let git_path = self.git_path.clone();
        thread::spawn(move || {
            for task in rx {
                let response = match task.kind {
                    GitTaskKind::Status { project_path } => {
                        let result = if let Some(path) = git_path.as_deref() {
                            GitService::status_blocking(path, &project_path)
                        } else {
                            Ok(GitStatusSummary {
                                available: false,
                                repository: false,
                                repo_root: None,
                                branch: None,
                                upstream: None,
                                ahead: 0,
                                behind: 0,
                                clean: true,
                                message: Some("Git was not found in PATH.".to_string()),
                                entries: Vec::new(),
                            })
                        };
                        GitTaskResponse::Status(result)
                    }
                    GitTaskKind::RunCommand { project_path, args } => {
                        let result = if let Some(path) = git_path.as_deref() {
                            GitService::run_git_process(path, &project_path, &args)
                        } else {
                            Err(AppError::Git("Git was not found in PATH.".to_string()))
                        };
                        GitTaskResponse::Command(result)
                    }
                };
                let _ = task.response.send(response);
            }
        });
    }
}
