use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[cfg(target_os = "windows")]
// use std::os::windows::process::CommandExt;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{Mutex, RwLock};
use tracing::{info, warn};
use uuid::Uuid;

use crate::models::{AppError, TerminalOutputEvent, TerminalSessionInfo};
use crate::utils::path_validator::PathValidator;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const READY_MARKER: &str = "__CAT_EDITOR_READY__";
const CWD_MARKER: &str = "__CAT_EDITOR_CWD__:";
const EXIT_MARKER: &str = "__CAT_EDITOR_EXIT__:";

struct TerminalSession {
    shell: String,
    process_id: u32,
    stdin: Arc<Mutex<ChildStdin>>,
    buffer: Arc<Mutex<Vec<TerminalOutputEvent>>>,
    current_dir: Arc<Mutex<String>>,
    closed: Arc<AtomicBool>,
}

pub struct TerminalService {
    sessions: Arc<RwLock<HashMap<String, Arc<TerminalSession>>>>,
}

impl TerminalService {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn create_session(
        &self,
        initial_cwd: Option<&Path>,
    ) -> Result<TerminalSessionInfo, AppError> {
        let cwd = Self::resolve_start_directory(initial_cwd)?;

        let mut command = Command::new(Self::powershell_binary());
        command
            .arg("-NoLogo")
            .arg("-NoProfile")
            .arg("-NoExit")
            .arg("-Command")
            .arg("-")
            .current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        
        #[cfg(target_os = "windows")]
        command.creation_flags(CREATE_NO_WINDOW);
        
        let mut child = command
            .spawn()
            .map_err(|e| AppError::Terminal(format!("Failed to start PowerShell: {}", e)))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AppError::Terminal("Failed to capture PowerShell stdin".to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::Terminal("Failed to capture PowerShell stdout".to_string()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| AppError::Terminal("Failed to capture PowerShell stderr".to_string()))?;

        let process_id = child.id().unwrap_or_default();
        let session_id = Uuid::new_v4().to_string();
        let shell = "Windows PowerShell".to_string();
        let cwd_string = cwd.to_string_lossy().to_string();

        let session = Arc::new(TerminalSession {
            shell: shell.clone(),
            process_id,
            stdin: Arc::new(Mutex::new(stdin)),
            buffer: Arc::new(Mutex::new(Vec::new())),
            current_dir: Arc::new(Mutex::new(cwd_string.clone())),
            closed: Arc::new(AtomicBool::new(false)),
        });

        self.spawn_reader(stdout, "stdout", Arc::clone(&session));
        self.spawn_reader(stderr, "stderr", Arc::clone(&session));

        self.sessions
            .write()
            .await
            .insert(session_id.clone(), Arc::clone(&session));

        self.write_internal(
            &session,
            &format!(
                "Write-Output '{}'\n{}\n",
                READY_MARKER,
                Self::terminal_state_probe()
            ),
        )
        .await?;

        info!("PowerShell terminal session created: {}", session_id);

        Ok(TerminalSessionInfo {
            session_id,
            shell,
            cwd: cwd_string,
        })
    }

    pub async fn execute(&self, session_id: &str, input: &str) -> Result<(), AppError> {
        let session = self.get_session(session_id).await?;
        let normalized = input.replace("\r\n", "\n");
        let normalized = normalized.trim_end_matches('\n');
        let payload = format!("{}\n{}\n", normalized, Self::terminal_state_probe());

        self.write_internal(&session, &payload).await
    }

    pub async fn set_cwd(&self, session_id: &str, path: &Path) -> Result<String, AppError> {
        let canonical = PathValidator::validate_directory_path(path)?;
        let command = format!(
            "Set-Location -LiteralPath '{}'",
            canonical.to_string_lossy().replace('\'', "''")
        );

        self.execute(session_id, &command).await?;
        Ok(canonical.to_string_lossy().to_string())
    }

    pub async fn drain_output(
        &self,
        session_id: &str,
    ) -> Result<Vec<TerminalOutputEvent>, AppError> {
        let session = self.get_session(session_id).await?;
        let mut buffer = session.buffer.lock().await;
        Ok(std::mem::take(&mut *buffer))
    }

    pub async fn close_session(&self, session_id: &str) -> Result<(), AppError> {
        let session = self.sessions.write().await.remove(session_id);
        if let Some(session) = session {
            if !session.closed.swap(true, Ordering::SeqCst) {
                if let Err(error) = self.write_internal(&session, "exit\n").await {
                    warn!("Failed to gracefully stop PowerShell session {}: {}", session_id, error);
                }

                let pid = session.process_id;
                tokio::task::spawn_blocking(move || {
                    let _ = std::process::Command::new("taskkill")
                        .args(["/PID", &pid.to_string(), "/T", "/F"])
                        .output();
                })
                .await
                .map_err(|e| AppError::Terminal(format!("Failed to stop terminal task: {}", e)))?;
            }
        }

        Ok(())
    }

    fn spawn_reader<R>(&self, reader: R, stream: &'static str, session: Arc<TerminalSession>)
    where
        R: tokio::io::AsyncRead + Unpin + Send + 'static,
    {
        tokio::spawn(async move {
            // Wrap entire reader in panic catch to prevent task from dying silently
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let rt = tokio::runtime::Handle::current();
                rt.block_on(async {
                    let mut lines = BufReader::new(reader).lines();

                    loop {
                        match lines.next_line().await {
                            Ok(Some(line)) => {
                                Self::push_line(Arc::clone(&session), stream, line).await;
                            }
                            Ok(None) => break,
                            Err(error) => {
                                warn!("Terminal stream read error on {}: {}", stream, error);
                                Self::push_event(
                                    &session,
                                    TerminalOutputEvent {
                                        stream: "stderr".to_string(),
                                        text: format!("Terminal stream error: {}", error),
                                        kind: Some("stream-error".to_string()),
                                        cwd: None,
                                        exit_code: None,
                                    },
                                )
                                .await;
                                break;
                            }
                        }
                    }
                })
            }));

            if let Err(_) = result {
                warn!("Reader task panicked for stream {}", stream);
            }

            if !session.closed.swap(true, Ordering::SeqCst) {
                Self::push_event(
                    &session,
                    TerminalOutputEvent {
                        stream: "meta".to_string(),
                        text: "PowerShell session ended.".to_string(),
                        kind: Some("session-ended".to_string()),
                        cwd: None,
                        exit_code: None,
                    },
                )
                .await;
            }
        });
    }

    async fn push_line(session: Arc<TerminalSession>, stream: &str, line: String) {
        if line == READY_MARKER {
            Self::push_event(
                &session,
                TerminalOutputEvent {
                    stream: "meta".to_string(),
                    text: format!("{} ready.", session.shell),
                    kind: Some("ready".to_string()),
                    cwd: Some(session.current_dir.lock().await.clone()),
                    exit_code: None,
                },
            )
            .await;
            return;
        }

        if let Some(cwd) = line.strip_prefix(CWD_MARKER) {
            *session.current_dir.lock().await = cwd.to_string();
            Self::push_event(
                &session,
                TerminalOutputEvent {
                    stream: "meta".to_string(),
                    text: format!("Working directory: {}", cwd),
                    kind: Some("cwd".to_string()),
                    cwd: Some(cwd.to_string()),
                    exit_code: None,
                },
            )
            .await;
            return;
        }

        if let Some(exit_code_text) = line.strip_prefix(EXIT_MARKER) {
            let exit_code = exit_code_text.trim().parse::<i32>().ok();
            let current_dir = session.current_dir.lock().await.clone();
            Self::push_event(
                &session,
                TerminalOutputEvent {
                    stream: if exit_code.unwrap_or_default() == 0 {
                        "meta".to_string()
                    } else {
                        "stderr".to_string()
                    },
                    text: format!(
                        "Command finished with exit code {}.",
                        exit_code.unwrap_or_default()
                    ),
                    kind: Some("command-complete".to_string()),
                    cwd: Some(current_dir),
                    exit_code,
                },
            )
            .await;
            return;
        }

        Self::push_event(
            &session,
            TerminalOutputEvent {
                stream: stream.to_string(),
                text: line,
                kind: None,
                cwd: None,
                exit_code: None,
            },
        )
        .await;
    }

    async fn push_event(session: &TerminalSession, event: TerminalOutputEvent) {
        session.buffer.lock().await.push(event);
    }

    async fn write_internal(
        &self,
        session: &TerminalSession,
        payload: &str,
    ) -> Result<(), AppError> {
        if session.closed.load(Ordering::SeqCst) {
            return Err(AppError::Terminal(
                "PowerShell session is no longer running".to_string(),
            ));
        }

        // Use timeout to prevent indefinite blocking if PowerShell is hung
        let write_result = tokio::time::timeout(
            Duration::from_secs(5),
            async {
                let mut stdin = session.stdin.lock().await;
                stdin.write_all(payload.as_bytes()).await?;
                stdin.flush().await?;
                Ok::<_, std::io::Error>(())
            },
        )
        .await;

        match write_result {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => {
                warn!("Failed to write to PowerShell: {}", e);
                session.closed.store(true, Ordering::SeqCst);
                Err(AppError::Terminal(format!("Failed to write to PowerShell: {}", e)))
            }
            Err(_) => {
                warn!("PowerShell write timeout - session may be hung");
                session.closed.store(true, Ordering::SeqCst);
                Err(AppError::Terminal(
                    "PowerShell write timeout (5s) - session may be hung".to_string(),
                ))
            }
        }
    }

    async fn get_session(&self, session_id: &str) -> Result<Arc<TerminalSession>, AppError> {
        self.sessions
            .read()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| AppError::Terminal(format!("Terminal session not found: {}", session_id)))
    }

    fn resolve_start_directory(initial_cwd: Option<&Path>) -> Result<PathBuf, AppError> {
        if let Some(path) = initial_cwd {
            return PathValidator::validate_directory_path(path);
        }

        if let Ok(root) = PathValidator::ensure_primary_root() {
            return Ok(root);
        }

        std::env::current_dir()
            .map_err(|e| AppError::Io(format!("Failed to determine working directory: {}", e)))
    }

    fn powershell_binary() -> &'static str {
        "powershell.exe"
    }

    fn cwd_probe_command() -> String {
        format!("Write-Output \"{}$((Get-Location).Path)\"", CWD_MARKER)
    }

    fn terminal_state_probe() -> String {
        format!(
            "$__cat_editor_exit = $LASTEXITCODE\n{}\nWrite-Output \"{}$($__cat_editor_exit)\"",
            Self::cwd_probe_command(),
            EXIT_MARKER
        )
    }
}
