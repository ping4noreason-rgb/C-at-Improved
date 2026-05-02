use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use regex::Regex;

use crate::models::{AppError, CommandResult};
use crate::utils::path_validator::PathValidator;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

struct PackageManagerSpec {
    name: &'static str,
    binaries: &'static [&'static str],
}

const PACKAGE_MANAGERS: &[PackageManagerSpec] = &[
    PackageManagerSpec {
        name: "vcpkg",
        binaries: &["vcpkg"],
    },
    PackageManagerSpec {
        name: "npm",
        binaries: &["npm"],
    },
    PackageManagerSpec {
        name: "pnpm",
        binaries: &["pnpm"],
    },
    PackageManagerSpec {
        name: "yarn",
        binaries: &["yarn"],
    },
    PackageManagerSpec {
        name: "pip",
        binaries: &["pip", "pip3"],
    },
    PackageManagerSpec {
        name: "cargo",
        binaries: &["cargo"],
    },
    PackageManagerSpec {
        name: "winget",
        binaries: &["winget"],
    },
    PackageManagerSpec {
        name: "choco",
        binaries: &["choco"],
    },
    PackageManagerSpec {
        name: "scoop",
        binaries: &["scoop"],
    },
];

pub struct PackageService;

impl PackageService {
    pub fn new() -> Self {
        Self
    }

    pub fn available_managers(&self) -> Vec<String> {
        let mut seen = HashSet::new();
        let mut managers = Vec::new();

        for spec in PACKAGE_MANAGERS {
            if Self::resolve_manager_binary(spec).is_some() && seen.insert(spec.name) {
                managers.push(spec.name.to_string());
            }
        }

        managers
    }

    pub async fn install(
        &self,
        project_path: &Path,
        manager: &str,
        package_name: &str,
    ) -> Result<CommandResult, AppError> {
        let valid_path = PathValidator::validate_directory_path(project_path)?;
        let trimmed_manager = manager.trim().to_ascii_lowercase();
        let trimmed_package = package_name.trim();

        Self::validate_package_name(trimmed_package)?;

        let spec = PACKAGE_MANAGERS
            .iter()
            .find(|spec| spec.name == trimmed_manager.as_str())
            .ok_or_else(|| AppError::Package(format!("Unsupported package manager: {}", manager)))?;
        let binary = Self::resolve_manager_binary(spec).ok_or_else(|| {
            AppError::Package(format!(
                "Package manager '{}' is not available on this machine.",
                spec.name
            ))
        })?;
        let args = Self::install_args(spec.name, trimmed_package);

        tokio::task::spawn_blocking(move || Self::run_install(binary, valid_path, args))
            .await
            .map_err(|error| AppError::Package(format!("Package install task failed: {}", error)))?
    }

    fn run_install(
        binary: PathBuf,
        cwd: PathBuf,
        args: Vec<String>,
    ) -> Result<CommandResult, AppError> {
        let mut command = Command::new(&binary);
        command.args(&args).current_dir(&cwd);

        #[cfg(target_os = "windows")]
        command.creation_flags(CREATE_NO_WINDOW);

        let output = command
            .output()
            .map_err(|error| AppError::Package(format!("Failed to start installer: {}", error)))?;

        Ok(CommandResult {
            success: output.status.success(),
            command: format!(
                "\"{}\" {}",
                binary.display(),
                args.join(" ")
            ),
            stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
            exit_code: output.status.code(),
        })
    }

    fn validate_package_name(package_name: &str) -> Result<(), AppError> {
        if package_name.is_empty() {
            return Err(AppError::Package("Package name cannot be empty.".to_string()));
        }

        let regex = Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._/@+\-]*$").unwrap();
        if !regex.is_match(package_name) {
            return Err(AppError::Package(
                "Package name contains unsupported characters.".to_string(),
            ));
        }

        Ok(())
    }

    fn install_args(manager: &str, package_name: &str) -> Vec<String> {
        match manager {
            "vcpkg" => vec!["install".to_string(), package_name.to_string()],
            "npm" => vec!["install".to_string(), package_name.to_string()],
            "pnpm" => vec!["add".to_string(), package_name.to_string()],
            "yarn" => vec!["add".to_string(), package_name.to_string()],
            "pip" => vec!["install".to_string(), package_name.to_string()],
            "cargo" => vec!["add".to_string(), package_name.to_string()],
            "winget" => vec![
                "install".to_string(),
                "--id".to_string(),
                package_name.to_string(),
                "-e".to_string(),
            ],
            "choco" => vec![
                "install".to_string(),
                package_name.to_string(),
                "-y".to_string(),
            ],
            "scoop" => vec!["install".to_string(), package_name.to_string()],
            _ => Vec::new(),
        }
    }

    fn resolve_manager_binary(spec: &PackageManagerSpec) -> Option<PathBuf> {
        spec.binaries
            .iter()
            .find_map(|binary| which::which(binary).ok())
    }
}
