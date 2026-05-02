# Cat Editor
## A lightweight, cross-platform code editor optimized for C/C++ development with integrated build tools, Git support, and PowerShell terminal.

![License](https://img.shields.io/badge/license-AGPLv3-blue.svg)
![Rust](https://img.shields.io/badge/rust-1.70+-orange.svg)
![Tauri](https://img.shields.io/badge/Tauri-2.0-blue.svg)

## Overview
Cat Editor is a modern desktop code editor built with Tauri (Rust backend + JavaScript frontend), designed to provide a fast, native experience for C/C++ developers. It combines a clean interface with powerful features including real-time syntax checking, project management, Git integration, and an embedded PowerShell terminal.
> **Status:** Stable for daily use | Active development | Known issues (see below)

## KNOWN ISSUES
![Known Issues](https://img.shields.io/badge/issues-3%20known-yellow)
1. **No folder creation** 🟡 Medium priority
   - Symptoms: No folder creation button
   - Workaround: Create a folder in explorer of projects
   - Fix planned: next release (v0.2.0)
2. **Terminal instability** 🔴 High priority
   - Symptoms: Terminal crashes after 5-10 commands, becomes unresponsive
   - Workaround: Restart terminal with `Ctrl+Shift+\` or reopen project
   - Fix planned: Next release (v0.2.0)
3. **Git problem** 🟢 Low priority
   - Symptoms: When the Git tab is opened, the panel displays files from the entire filesystem instead of just the project.
   - Workaround: unfortunately no workaround :(
   - Fix planned: Next 2 release (v0.3.0)

## Features

Core Editor
1. Syntax highlighting for C/C++ with CodeMirror
2. Smart code completion (Ctrl+Space) with keyword and identifier suggestions
3. Real-time syntax checking with compiler integration
4. Multi-tab editing with dirty state tracking
5. Auto-save with configurable delays
6. File formatting via clang-format

## Project Management
1. Project-based workspace organization
2. File tree navigation with folder expansion
3. File operations: create, rename, delete, move to trash
4. Import files/folders via drag & drop or file picker
5. Keep projects persisted across sessions

## Build System Integration
1. Automatic build system detection (CMake, Make)
2. One-click build & run (Ctrl+R)
3. Debug build support (Ctrl+Shift+D)
4. Compiler detection (GCC, Clang, TCC)
5. Build output capture with error parsing

## Git Integration
1. Repository status overview
2. Stage all changes with one click
3. Commit with message dialog
4. Pull/Push remote operations
5. Visual file status display

## Terminal
1. Embedded PowerShell terminal (Windows)
2. Command history with arrow key navigation
3. Working directory sync with active project
4. Debugger command execution from editor

## UI/UX
1. Dark/light theme toggle with persistence
2. Custom window controls (minimize, maximize, close)
3. Collapsible sidebar (Ctrl+B)
4. Resizable output panel with drag handle
5. Toast notifications for operations
6. Keyboard shortcuts for common actions

## Screenshots
<img width="800" alt="Main editor window" src="https://github.com/user-attachments/assets/7255dafb-0751-4b93-8817-6a187764de53" loading="lazy">
<img width="800" alt="Standard README file" src="https://github.com/user-attachments/assets/6ebaf931-d100-46a4-9d23-785ee512f64c" loading="lazy">
<img width="800" alt="Toolchain" src="https://github.com/user-attachments/assets/62a5fc6a-e9bb-4f5d-8efc-58eef7d21a10" loading="lazy">
<img width="800" alt="Error showing interface" src="https://github.com/user-attachments/assets/bffc8882-6397-4f99-b8f1-d64120b6ef42" loading="lazy">
<img width="800" alt="Git interface" src="https://github.com/user-attachments/assets/a1d18140-9c48-4f21-806a-7e83df1e0895" loading="lazy">

# Architecture

## Frontend (/dist/js/)
| Module | Responsibility |
|--------|----------------|
| **app.js** | Main application orchestrator, event binding, state subscription |
| **editor.js** | CodeMirror wrapper with auto-save, syntax checking, formatting |
| **fileTree.js** | File tree rendering, navigation, context menus |
| **terminal.js** | PowerShell terminal session management, I/O polling |
| **state.js** | Central reactive state store (output, problems, git, files) |
| **tauri.js** | Tauri IPC bridge with fallback mock implementation |
| **logger.js** | Log aggregation with severity levels (SYS/INFO/ERR) |
| **ui.js** | Modal dialogs, toasts, form/prompt helpers |
| **fileImport.js** | Drag & drop file/folder import with structure preservation |
| **editorHints.js** | Smart autocomplete (keywords, identifiers, snippets, backend) |
| **appActions.js** | Project, Git, build, package operations |
| **appRenderers.js** | Output, problems, Git, run tools rendering |
| **utils.js** | Path normalization, debounce/throttle, validation helpers |

## Backend (/src-tauri/src/)
| Module | Responsibility |
|--------|----------------|
| **main.rs** | Application entry point, service initialization, command registration |
| **commands/** | Tauri command handlers (filesystem, compiler, git, terminal, etc.) |
| **models/types.rs** | Serialization models (FileInfo, CompileResult, GitStatus, etc.) |
| **services/build_service.rs** | CMake/Make detection, project configuration, compilation |
| **services/compiler_service.rs** | Compiler detection (GCC/Clang/TCC), syntax checking, completions |
| **services/file_service.rs** | File read/write, project scaffolding, tree building |
| **services/git_service.rs** | Git operations with async worker to prevent UI freezes |
| **services/terminal_service.rs** | PowerShell session lifecycle, I/O piping, CWD tracking |
| **services/trash_service.rs** | Safe file deletion (OS recycle bin) |
| **services/monitor_service.rs** | System resource monitoring (RAM, CPU, disk) |
| **services/package_service.rs** | Package manager detection (vcpkg, npm, pip, etc.) |
| **utils/path_validator.rs** | Path sanitization, project root resolution |

## Key Design Decisions
1. Async Worker for Git - Git operations run in a background thread to prevent UI freezes during network operations
2. Lazy File Loading - Files >256KB load incrementally to maintain responsiveness
3. Debounced Auto-Save - 3-second delay after typing stops to reduce disk I/O
4. Output Batching - UI updates batched via requestAnimationFrame to prevent layout thrashing
5. Path Validation - All file paths validated against project roots to prevent directory traversal attacks

## Keyboard Shortcuts
| Shortcut | Action |
|----------|--------|
| **Ctrl+S** | Save current file |
| **Ctrl+R** | Run/compile current file |
| **Ctrl+Shift+D** | Debug build |
| **Ctrl+W** | Close current tab |
| **Ctrl+Tab** | Next tab |
| **Ctrl+Shift+Tab** | Previous tab |
| **Ctrl+B** | Toggle sidebar |
| **Ctrl+`** | Toggle terminal panel |
| **Ctrl+P** | Quick file open |
| **Ctrl+Space** | Show completions |
| **Shift+Alt+F** | Format code |
| **Ctrl+F** | Find |
| **Ctrl+H** | Replace |

## Installation

### Prerequisites
1. Rust (1.70+)
2. Node.js (for frontend assets)
3. Tauri CLI: cargo install tauri-cli

## Build from Source
1. Clone repository:
   ```bash
   git clone https://github.com/ping4noreason-rgb/cat-editor.git
   cd cat-editor
2. Build frontend (if you have React/Vue frontend)
3. Or copy dist files to /dist folder
4. Build Tauri application:
   ```bash
   cargo tauri build

5. Running in Development:
   ```bash
   cargo tauri dev

# Configuration
## Project Roots
### Projects are stored in:
1. Windows: %LOCALAPPDATA%\Cat Editor\Projects\
2. Linux: ~/.local/share/Cat Editor/Projects/
3. macOS: ~/Library/Application Support/Cat Editor/Projects/

## Supported Compilers
1. GCC (MinGW on Windows)
2. Clang
3. TCC (Tiny C Compiler)

## Supported Build Systems
1. CMake (with automatic configure)
2. Make (direct build)

## Package Managers
1. vcpkg
2. npm
3. pnpm
4. yarn
5. pip
6. cargo
7. winget
8. choco
9. scoop

## License
AGPL V3 License - see LICENSE file for details.

## Acknowledgments
1. Tauri - Framework for building desktop apps
2. CodeMirror - Web-based code editor component
3. sysinfo - System information crate
4. trash - Cross-platform trash/recycle bin
