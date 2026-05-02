import { api } from './tauri.js';
import { appState } from './state.js';
import { installSmartHints } from './editorHints.js';
import { logger } from './logger.js';
import { powerShellTerminal } from './terminal.js';
import { showToast } from './ui.js';
import { debounce, formatBytes, normalizePath, safeByteLength } from './utils.js';

export const MAX_OPEN_FILE_BYTES = 1024 * 1024 * 1024;
const LAZY_LOAD_THRESHOLD = 256 * 1024;
const LAZY_LOAD_CHUNK_BYTES = 256 * 1024;

// Timing constants for debounced operations - tuned for responsiveness without excessive delay
const AUTO_SAVE_DELAY_MS = 3000;      // 3 seconds after user stops typing before auto-saving (debounced to avoid excessive saves on large files)
const SYNTAX_CHECK_DELAY_MS = 2000;   // 2 seconds without changes before running syntax check (separate from auto-save to avoid blocking on large files)
const SYNTAX_CHECK_DEBOUNCE_MS = 500; // Minimal interval between syntax checks to prevent spamming on large files

class EditorWrapper {
    constructor(elementId) {
        this.element = document.getElementById(elementId);
        this.editor = null;
        this.saveTimeout = null;
        this.syntaxTimeout = null;
        this.refreshTimeout = null;
        this.isApplyingExternalContent = false;
        this.compilerHintShown = false;
        this.problemLineClasses = [];
        this.lastProblemSignature = '';
        this.smartHintsInstalled = false;
        this._syntaxPending = false;
        this._lastSyntaxCheck = 0;
        this._unsubscribers = [];
        this._scheduleSizeUpdate = debounce(() => this._updateFileSizeNow(), 120);
    }

    async init() {
        if (!this.element) {
            logger.err('Editor mount node missing.');
            return null;
        }

        this.editor = CodeMirror.fromTextArea(this.element, {
            lineNumbers: true,
            lineWrapping: false,
            tabSize: 4,
            indentUnit: 4,
            indentWithTabs: false,
            fixedGutter: true,
            electricChars: true,
            mode: 'text/x-csrc',
            theme: 'one-dark',
            autoCloseBrackets: true,
            matchBrackets: true,
            gutters: ['CodeMirror-linenumbers', 'CodeMirror-lint-markers'],
            scrollbarStyle: 'native',
            viewportMargin: 50,
            extraKeys: {
                Tab(cm) {
                    if (cm.somethingSelected()) {
                        cm.indentSelection('add');
                    } else {
                        cm.replaceSelection('    ', 'end');
                    }
                },
                'Ctrl-Space': () => this.showCompletions(),
                'Ctrl-S': () => this.save(),
                'Ctrl-R': () => this.compile(),
                'Ctrl-Shift-D': () => this.debug(),
                'Shift-Alt-F': () => this.formatCode(),
                'Ctrl-Z': 'undo',
                'Ctrl-Y': 'redo',
                'Ctrl-F': 'findPersistent',
                'Ctrl-H': 'replace'
            }
        });

        this._cursorEl = document.getElementById('cursor-pos');
        const updateCursor = () => {
            if (!this._cursorEl || !this.editor) return;
            const cursor = this.editor.getCursor();
            this._cursorEl.textContent = `Ln ${cursor.line + 1}, Col ${cursor.ch + 1}`;
        };
        this._scheduleCursorUpdate = debounce(updateCursor, 16);
        this.editor.on('cursorActivity', () => this._scheduleCursorUpdate());

        this.editor.on('change', () => {
            this.handleChangeThrottled();
        });

        this._unsubscribers.push(
            appState.subscribe('problems', problems => {
                this.applyProblemMarkers(problems);
            })
        );

        this._initRefreshTimer = setTimeout(() => {
            this._initRefreshTimer = null;
            if (!this.editor) return;
            this.editor.setSize('100%', '100%');
            this.editor.refresh();
            this._updateFileSizeNow();
        }, 80);

        logger.sys('Editor surface initialized.');
        return this.editor;
    }

    // Throttled version of handleChange - prevents UI freeze on rapid typing
    handleChangeThrottled = debounce(() => {
        this.handleChange();
    }, 50);

    handleChange() {
        if (this.isApplyingExternalContent) {
            this._scheduleSizeUpdate();
            return;
        }

        const currentFile = appState.get('currentFile');
        if (!currentFile) return;

        const openFile = appState.getOpenFile(currentFile.path);
        if (!openFile) return;

        const content = this.editor.getValue();
        
        // Fast path: only update dirty flag without heavy operations
        const wasDirty = openFile.dirty;
        const dirty = content !== openFile.savedContent;

        if (wasDirty !== dirty) {
            appState.setOpenFile(currentFile.path, { dirty, content });
            this.updateTabDirty(currentFile.path, dirty);
        } else if (content !== openFile.content) {
            // Only update content without triggering full re-render
            appState.setOpenFile(currentFile.path, { content });
        }

        // Debounced auto-save - only after user stops typing
        if (this.saveTimeout) clearTimeout(this.saveTimeout);
        this.saveTimeout = setTimeout(() => {
            this.saveTimeout = null;
            this.autoSave().catch(e => logger.err('Auto-save failed', { details: e.message }));
        }, AUTO_SAVE_DELAY_MS);

        // Debounced syntax check - separate from auto-save
        if (this.syntaxTimeout) clearTimeout(this.syntaxTimeout);
        this.syntaxTimeout = setTimeout(() => {
            this.syntaxTimeout = null;
            const now = Date.now();
            if (now - this._lastSyntaxCheck >= SYNTAX_CHECK_DEBOUNCE_MS) {
                this._lastSyntaxCheck = now;
                this.checkSyntax(this.editor.getValue(), currentFile.name, { reportSuccess: false })
                    .catch(e => logger.err('Syntax check failed', { details: e.message }));
            }
        }, SYNTAX_CHECK_DELAY_MS);

        this._scheduleSizeUpdate();
    }

    // Manual completion trigger (Ctrl+Space)
    async showCompletions() {
        if (!this.editor) return;
        
        const cursor = this.editor.getCursor();
        const token = this.editor.getTokenAt(cursor);
        const prefix = token.string.slice(0, cursor.ch - token.start);
        
        try {
            const completions = await api.getCompletions(this.editor.getValue(), prefix);
            if (!completions?.length) return;
            
            this.editor.showHint({
                hint: () => ({
                    list: completions.map(c => ({ text: c, displayText: c })),
                    from: CodeMirror.Pos(cursor.line, token.start),
                    to: CodeMirror.Pos(cursor.line, cursor.ch)
                }),
                completeSingle: true,
                alignWithWord: true
            });
        } catch (e) {
            logger.err('Completions failed', { details: e.message });
        }
    }

    updateTabDirty(path, dirty) {
        const selector = `.tab[data-path="${CSS.escape(path)}"]`;
        const tab = document.querySelector(selector);
        if (tab) {
            tab.classList.toggle('dirty', Boolean(dirty));
        }
    }

    async autoSave() {
        const currentFile = appState.get('currentFile');
        if (!currentFile) return;

        const openFile = appState.getOpenFile(currentFile.path);
        if (!openFile || !openFile.dirty) return;

        await this.saveFile(currentFile.path, { silentToast: true, source: 'auto-save' });
    }

    async save() {
        const currentFile = appState.get('currentFile');
        if (!currentFile) {
            showToast('Open a file before saving.', 'error');
            return;
        }
        await this.saveFile(currentFile.path);
    }

    async saveFile(path, options = {}) {
        const openFile = appState.getOpenFile(path);
        if (!openFile) return;

        const activePath = appState.get('currentFile')?.path;
        const content = path === activePath ? this.editor.getValue() : openFile.content;
        const saveBtn = document.getElementById('save-btn');
        const originalText = saveBtn?.textContent || 'Save';

        if (saveBtn && path === activePath) {
            saveBtn.textContent = 'Saving...';
            saveBtn.disabled = true;
        }

        // Clear pending timeouts to avoid race conditions
        if (this.saveTimeout) clearTimeout(this.saveTimeout);
        if (this.syntaxTimeout) clearTimeout(this.syntaxTimeout);
        this.saveTimeout = null;
        this.syntaxTimeout = null;

        try {
            await api.saveFile(path, content);

            appState.setOpenFile(path, {
                content,
                savedContent: content,
                dirty: false,
                viewState: path === activePath ? this.editor.getScrollInfo() : openFile.viewState
            });

            this.updateTabDirty(path, false);
            document.dispatchEvent(new CustomEvent('cat-editor:workspace-mutated'));
            logger.sys(`Saved ${openFile.file.name}`, {
                context: options.source === 'auto-save' ? 'auto-save' : 'manual save'
            });

            if (!options.silentToast) {
                showToast(`Saved ${openFile.file.name}`, 'success');
            }

            // Only run syntax check on manual save
            if (path === activePath && options.source !== 'auto-save') {
                await this.checkSyntax(content, openFile.file.name, { reportSuccess: true });
            }
        } catch (error) {
            logger.err(`Save failed for ${openFile.file.name}`, {
                details: error?.message || String(error)
            });
            showToast(`Save failed: ${error.message}`, 'error');
        } finally {
            if (saveBtn && path === activePath) {
                saveBtn.textContent = originalText;
                saveBtn.disabled = false;
            }
        }
    }

    async checkSyntax(code, filename = 'current file', options = {}) {
        const runtimeStatus = appState.get('runtimeStatus');
        const currentFile = appState.get('currentFile');
        
        if (runtimeStatus && !runtimeStatus.compiler_available) {
            if (!this.compilerHintShown && options.reportSuccess !== false) {
                logger.info('Syntax checks are disabled because no C compiler is installed.');
                this.compilerHintShown = true;
            }
            return;
        }

        if (this._syntaxPending) return;
        this._syntaxPending = true;

        try {
            const errors = await api.checkSyntax(code);
            const problems = this.normalizeProblems(errors, currentFile?.path);
            const signature = problems.map(p =>
                `${p.file}|${p.line}|${p.column}|${p.errorType}|${p.message}`
            ).join('\n');

            appState.setProblems(problems);
            this.lastProblemSignature = signature;

            if (problems.length > 0) {
                if (options.reportSuccess !== false || signature !== this.lastProblemSignature) {
                    logger.err(`Syntax issues found in ${filename}.`, {
                        details: this.formatProblemDetails(problems),
                        problems
                    });
                }
            } else if (options.reportSuccess !== false) {
                this.lastProblemSignature = '';
                logger.info(`Syntax check passed for ${filename}.`);
            }
        } catch (error) {
            logger.err('Syntax check failed.', {
                details: error?.message || String(error)
            });
        } finally {
            this._syntaxPending = false;
        }
    }

    _cancelLazyLoad() {
        if (this._lazyLoadHandle) {
            cancelAnimationFrame(this._lazyLoadHandle);
            this._lazyLoadHandle = null;
        }
        this._lazyLoadToken = null;
    }

    setContent(content, language = 'c') {
        if (!this.editor) return;

        this._cancelLazyLoad();

        const text = content == null ? '' : String(content);
        const useLazy = text.length > LAZY_LOAD_THRESHOLD;

        const heavyMode = text.length > LAZY_LOAD_THRESHOLD * 8;
        if (heavyMode) {
            this.editor.setOption('mode', 'text/plain');
            this.editor.setOption('autoCloseBrackets', false);
            this.editor.setOption('matchBrackets', false);
            this.editor.setOption('viewportMargin', 10);
        } else {
            this.editor.setOption('autoCloseBrackets', true);
            this.editor.setOption('matchBrackets', true);
            this.editor.setOption('viewportMargin', 50);
        }

        const normalizedLanguage = (language || 'txt').toLowerCase();
        const mode = heavyMode
            ? 'text/plain'
            : ['c', 'h'].includes(normalizedLanguage)
                ? 'text/x-csrc'
                : ['cpp', 'cxx', 'cc', 'hpp', 'hh', 'hxx'].includes(normalizedLanguage)
                    ? 'text/x-c++src'
                    : 'text/plain';

        if (this.editor.getOption('mode') !== mode) {
            this.editor.setOption('mode', mode);
        }

        const languageLabel = document.getElementById('file-lang');
        if (languageLabel) {
            languageLabel.textContent = heavyMode
                ? `${normalizedLanguage.toUpperCase()} (large)`
                : normalizedLanguage.toUpperCase();
        }

        this.isApplyingExternalContent = true;
        try {
            this.clearProblemMarkers();

            if (!useLazy) {
                this.editor.setValue(text);
            } else {
                const firstChunk = text.slice(0, LAZY_LOAD_CHUNK_BYTES);
                this.editor.setValue(firstChunk);

                const token = Symbol('lazy-load');
                this._lazyLoadToken = token;
                let offset = firstChunk.length;

                const step = () => {
                    if (this._lazyLoadToken !== token || !this.editor) return;
                    if (offset >= text.length) {
                        this._lazyLoadHandle = null;
                        this._lazyLoadToken = null;
                        this._updateFileSizeNow();
                        if (heavyMode) {
                            logger.info(`Loaded large file (${formatBytes(safeByteLength(text))}). Heavy features disabled for responsiveness.`);
                        }
                        return;
                    }
                    this.isApplyingExternalContent = true;
                    try {
                        const chunk = text.slice(offset, offset + LAZY_LOAD_CHUNK_BYTES);
                        const lastLine = this.editor.lastLine();
                        const lastCh = this.editor.getLine(lastLine).length;
                        this.editor.replaceRange(chunk, { line: lastLine, ch: lastCh });
                        offset += chunk.length;
                    } finally {
                        this.isApplyingExternalContent = false;
                    }
                    this._lazyLoadHandle = requestAnimationFrame(step);
                };
                this._lazyLoadHandle = requestAnimationFrame(step);
            }
        } finally {
            this.isApplyingExternalContent = false;
        }

        if (heavyMode) {
            this.compilerHintShown = true;
        }

        this.applyProblemMarkers(appState.get('problems') || []);
        this._updateFileSizeNow();

        if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
        this.refreshTimeout = setTimeout(() => {
            this.refreshTimeout = null;
            this.editor?.refresh();
        }, 30);
    }

    getContent() {
        return this.editor?.getValue() || '';
    }

    _updateFileSizeNow() {
        const fileSize = document.getElementById('file-size');
        if (!fileSize || !this.editor) return;
        const text = this.editor.getValue();
        fileSize.textContent = formatBytes(safeByteLength(text));
    }

    updateFileSize() {
        this._scheduleSizeUpdate();
    }

    async compile(options = {}) {
        const currentFile = appState.get('currentFile');
        const currentProject = appState.get('currentProject');
        if (!currentFile) {
            showToast('Open a file before running.', 'error');
            return;
        }

        const mode = options.mode === 'debug' ? 'debug' : 'run';
        const currentOpenFile = appState.getOpenFile(currentFile.path);
        if (currentOpenFile?.dirty) {
            await this.saveFile(currentFile.path, { silentToast: true, source: `${mode} pre-run save` });
        }

        const code = this.editor.getValue();
        const targetButton = document.getElementById(mode === 'debug' ? 'debug-btn' : 'compile-btn');
        const originalText = targetButton?.textContent || (mode === 'debug' ? 'Debug' : 'Run');

        if (targetButton) {
            targetButton.textContent = mode === 'debug' ? 'Debugging...' : 'Running...';
            targetButton.disabled = true;
        }

        logger.sys(`${mode === 'debug' ? 'Debugging' : 'Running'} ${currentFile.name}`, {
            context: currentProject?.name || 'workspace'
        });

        try {
            const result = await api.compile(code, currentFile.name, {
                projectPath: currentProject?.path,
                filePath: currentFile.path,
                mode
            });

            const diagnostics = this.normalizeProblems(result?.diagnostics, currentFile.path);

            if (result.success) {
                appState.clearProblems();
                this.clearProblemMarkers();

                if (mode === 'debug') {
                    logger.info(`${result.compiler || 'Compiler'} prepared a debug build.`, {
                        details: result.output || 'Debug build completed.'
                    });

                    if (result.debugger_command) {
                        await powerShellTerminal.setWorkingDirectory(currentProject?.path || '');
                        await powerShellTerminal.runDebugCommand(result.debugger_command);
                        showToast('Debug session started in terminal.', 'success');
                    } else {
                        showToast('Debug build is ready, but no debugger was found.', 'error');
                    }
                } else {
                    logger.info(`${result.compiler || 'Compiler'} finished in ${result.execution_time} ms`, {
                        details: result.output || 'Program completed with no terminal output.'
                    });
                    showToast('Run completed successfully.', 'success');
                }
            } else {
                appState.setProblems(diagnostics);
                if (diagnostics.length > 0) {
                    this.applyProblemMarkers(diagnostics, { revealFirst: true });
                }

                logger.err(mode === 'debug' ? 'Debug build failed.' : 'Compilation failed.', {
                    details: Array.isArray(result.errors) ? result.errors.join('\n\n') : String(result.errors || ''),
                    problems: diagnostics,
                    context: result.compiler || ''
                });
                showToast(mode === 'debug' ? 'Debug build failed.' : 'Compilation failed.', 'error');
            }
        } catch (error) {
            const message = error?.message || String(error);
            if (message.includes('No C compiler found')) {
                logger.err('Compilation unavailable on this machine.', {
                    details: message
                });
                showToast('Install GCC, Clang, or TCC to use Run.', 'error');
            } else {
                logger.err(mode === 'debug' ? 'Debug pipeline crashed.' : 'Compilation pipeline crashed.', {
                    details: message
                });
                showToast(`${mode === 'debug' ? 'Debug' : 'Compilation'} error: ${message}`, 'error');
            }
        } finally {
            if (targetButton) {
                targetButton.textContent = originalText;
                targetButton.disabled = false;
            }
        }
    }

    async debug() {
        await this.compile({ mode: 'debug' });
    }

    async formatCode() {
        const currentFile = appState.get('currentFile');
        const runtimeStatus = appState.get('runtimeStatus');
        if (!currentFile) {
            showToast('Open a file before formatting.', 'error');
            return;
        }

        if (!runtimeStatus?.formatter_available) {
            showToast('Install clang-format to use code formatting.', 'error');
            return;
        }

        try {
            const result = await api.formatSourceFile(currentFile.path, this.editor.getValue());
            if (!result.changed) {
                showToast('File is already formatted.', 'success');
                return;
            }

            const cursor = this.editor.getCursor();
            const scroll = this.editor.getScrollInfo();
            const openFile = appState.getOpenFile(currentFile.path);

            this.isApplyingExternalContent = true;
            try {
                this.editor.setValue(result.formatted_content);
            } finally {
                this.isApplyingExternalContent = false;
            }
            this.editor.setCursor(cursor);
            this.editor.scrollTo(scroll.left, scroll.top);
            this._updateFileSizeNow();

            if (openFile) {
                appState.setOpenFile(currentFile.path, {
                    content: result.formatted_content,
                    dirty: true
                });
                this.updateTabDirty(currentFile.path, true);
            }

            await this.saveFile(currentFile.path, {
                silentToast: true,
                source: 'format'
            });

            logger.info(`Formatted ${currentFile.name} with ${result.formatter}.`, {
                details: result.stderr || result.stdout || 'Formatting completed successfully.'
            });
            showToast(`Formatted ${currentFile.name}`, 'success');
        } catch (error) {
            logger.err(`Format failed for ${currentFile.name}`, {
                details: error?.message || String(error)
            });
            showToast(`Format failed: ${error.message}`, 'error');
        }
    }

    normalizeProblems(problems, fallbackFilePath = '') {
        const result = (Array.isArray(problems) ? problems : [])
            .map(problem => ({
                file: problem.file || fallbackFilePath || '',
                line: Number(problem.line || 0),
                column: Number(problem.column || 0),
                message: String(problem.message || 'Unknown problem'),
                errorType: String(problem.error_type || problem.errorType || 'error')
            }))
            .filter(problem => Number.isFinite(problem.line));
        
        // Fix off-by-one: convert compiler's 1-indexed to 0-indexed if needed
        return result.map(p => ({
            ...p,
            line: p.line > 0 ? p.line - 1 : p.line
        }));
    }

    formatProblemDetails(problems) {
        return problems.map(problem => {
            const fileLabel = problem.file ? `${problem.file}:` : '';
            return `${fileLabel}${problem.line + 1}:${problem.column + 1} ${problem.errorType}: ${problem.message}`;
        }).join('\n');
    }

    clearProblemMarkers() {
        if (!this.editor) return;

        this.editor.clearGutter('CodeMirror-lint-markers');
        this.problemLineClasses.forEach(problem => {
            try {
                this.editor.removeLineClass(problem.line, 'wrap', problem.className);
            } catch (_error) {
                // line may have been removed; ignore
            }
        });
        this.problemLineClasses = [];
    }

    applyProblemMarkers(problems, options = {}) {
        if (!this.editor) return;

        this.clearProblemMarkers();

        const currentPath = normalizePath(appState.get('currentFile')?.path || '');
        const visibleProblems = (Array.isArray(problems) ? problems : []).filter(problem => {
            if (!problem.file) return true;
            return normalizePath(problem.file) === currentPath;
        });

        const lineCount = this.editor.lineCount();

        visibleProblems.forEach(problem => {
            if (problem.line < 0 || problem.line >= lineCount) return;

            const isWarning = problem.errorType.toLowerCase().includes('warning');
            const marker = document.createElement('div');
            marker.className = isWarning
                ? 'CodeMirror-lint-marker-warning'
                : 'CodeMirror-lint-marker-error';
            marker.textContent = isWarning ? '!' : 'x';
            marker.title = `${problem.errorType}: ${problem.message}`;
            this.editor.setGutterMarker(problem.line, 'CodeMirror-lint-markers', marker);

            const className = isWarning ? 'cm-problem-line-warning' : 'cm-problem-line-error';
            this.editor.addLineClass(problem.line, 'wrap', className);
            this.problemLineClasses.push({ line: problem.line, className });
        });

        if (options.revealFirst && visibleProblems[0]) {
            this.revealProblem(visibleProblems[0]);
        }
    }

    revealProblem(problem) {
        if (!this.editor || !problem) return;

        const cursor = {
            line: Math.max(0, problem.line || 0),
            ch: Math.max(0, problem.column || 0)
        };

        this.editor.focus();
        this.editor.setCursor(cursor);
        this.editor.scrollIntoView(cursor, 120);
    }

    enableSmartHints(fileTree) {
        if (this.smartHintsInstalled || !this.editor || !fileTree) return;
        installSmartHints(this.editor, fileTree, appState, this);
        this.smartHintsInstalled = true;
    }
}

export const editor = new EditorWrapper('editor');