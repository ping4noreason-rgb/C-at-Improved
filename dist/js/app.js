import { initTauri, api, isNativeTauri } from './tauri.js';
import { appState } from './state.js';
import { editor } from './editor.js';
import { fileTree } from './fileTree.js';
import { logger } from './logger.js';
import { powerShellTerminal } from './terminal.js';
import { formDialog, promptDialog, showToast } from './ui.js';
import { installImportControls } from './fileImport.js';
import {
    escapeHtml,
    getFileName,
    normalizePath,
    rafBatch,
    validateEntityName,
    validatePackageName
} from './utils.js';

const DEFAULT_OUTPUT_HEIGHT = 260;
const MIN_OUTPUT_HEIGHT = 180;
const MAX_OUTPUT_HEIGHT_RATIO = 0.65;

class App {
    constructor() {
        this.monitorInterval = null;
        this.monitorFailed = false;
        this.theme = 'dark';
        this.outputResizing = false;
        this.workspaceRefreshTimer = null;
        this._gitRefreshing = false;
        this._lastRenderedOutputCount = 0;
        this._disposers = [];
        this._unloadHandler = null;
        this.init();
    }

    _track(unsubscribe) {
        if (typeof unsubscribe === 'function') {
            this._disposers.push(unsubscribe);
        }
        return unsubscribe;
    }

    dispose() {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
            this.monitorInterval = null;
        }
        if (this.workspaceRefreshTimer) {
            clearTimeout(this.workspaceRefreshTimer);
            this.workspaceRefreshTimer = null;
        }
        this._disposers.splice(0).forEach(fn => {
            try { fn(); } catch (_e) { /* noop */ }
        });
        powerShellTerminal.dispose().catch(() => {});
    }

    async init() {
        this.initTheme();
        this.initOutputState();

        await initTauri();
        await this.initRuntimeStatus();
        await editor.init();

        this.setupEvents();
        this.subscribeToState();
        await this.setupWindowControls();
        await powerShellTerminal.init();
        await this.loadProjects();

        fileTree.updateTabs();
        this.renderOutput();
        this.renderProblemsPanel();
        this.renderGitStatus();
        this.renderRunTools();
        this.syncOutputFilters();
        this.syncOutputVisibility();
        this.syncOutputView();
        this.syncSidebarView();
        this.applyOutputHeight();
        this.updateEditorEmptyState();
        this.updateWorkspaceLabels();
        await this.startSystemMonitor();

        installImportControls();

        logger.sys('Cat Editor is ready.');
        logger.info('Shortcuts: Ctrl+S save, Ctrl+R run, Ctrl+W close tab, Ctrl+Tab next tab, Ctrl+B sidebar, Ctrl+` terminal, Ctrl+P quick open.');
    }

    initOutputState() {
        const savedView = localStorage.getItem('cat-editor-output-view');
        const savedHeight = Number(localStorage.getItem('cat-editor-output-height'));
        const savedSidebar = localStorage.getItem('cat-editor-sidebar-view');

        if (savedView === 'terminal' || savedView === 'logs') {
            appState.set('outputView', savedView);
        }

        if (['explorer', 'problems', 'git', 'run'].includes(savedSidebar)) {
            appState.set('sidebarView', savedSidebar);
        }

        if (Number.isFinite(savedHeight) && savedHeight >= MIN_OUTPUT_HEIGHT) {
            appState.set('outputHeight', savedHeight);
        } else {
            appState.set('outputHeight', DEFAULT_OUTPUT_HEIGHT);
        }
    }

    async initRuntimeStatus() {
        try {
            const runtimeStatus = await api.getRuntimeStatus();
            appState.set('runtimeStatus', runtimeStatus);

            if (runtimeStatus?.project_roots?.length) {
                logger.info('Project storage ready.', {
                    context: runtimeStatus.project_roots.join(' | ')
                });
            }

            if (runtimeStatus?.compiler_available) {
                logger.info(`Compiler detected: ${runtimeStatus.compiler_label}`);
            } else {
                logger.info('No C compiler detected. Run/Syntax checks are limited until GCC, Clang, or TCC is installed.');
            }

            if (runtimeStatus?.debugger_available) {
                logger.info(`Debugger detected: ${runtimeStatus.debugger_label}`);
            } else {
                logger.info('No debugger detected. Debug mode can build symbols, but stepping requires GDB, LLDB, or CDB.');
            }

            if (runtimeStatus?.git_available) {
                logger.info('Git integration is available.');
            } else {
                logger.info('Git was not found in PATH. Install Git to enable repository actions.');
            }

            if (runtimeStatus?.package_managers?.length) {
                logger.info('Package managers detected.', {
                    context: runtimeStatus.package_managers.join(', ')
                });
            } else {
                logger.info('No supported package managers were detected. Library installation from the editor is disabled.');
            }
        } catch (error) {
            logger.err('Failed to load runtime status.', {
                details: error?.message || String(error)
            });
        }
    }

    setupEvents() {
        this.bindButton('save-btn', () => editor.save());
        this.bindButton('compile-btn', () => editor.compile());
        this.bindButton('debug-btn', () => editor.debug());
        this.bindButton('new-project-btn', () => this.createProject());
        this.bindButton('empty-new-project-btn', () => this.createProject());
        this.bindButton('new-file-btn', () => this.createNewFile());
        this.bindButton('empty-new-file-btn', () => this.createNewFile());
        this.bindButton('refresh-files-btn', () => fileTree.refresh());
        this.bindButton('toggle-output-btn', () => this.toggleOutput());
        this.bindButton('clear-output-btn', () => {
            this._lastRenderedOutputCount = 0;
            appState.clearOutput();
        });
        this.bindButton('theme-toggle-btn', () => this.toggleTheme());
        this.bindButton('refresh-problems-btn', () => this.refreshProblems());
        this.bindButton('refresh-git-btn', () => this.refreshGitStatus());
        this.bindButton('init-git-btn', () => this.initGitRepository());
        this.bindButton('git-stage-all-btn', () => this.runGitAction('stage'));
        this.bindButton('git-commit-btn', () => this.commitGitChanges());
        this.bindButton('git-pull-btn', () => this.runGitAction('pull'));
        this.bindButton('git-push-btn', () => this.runGitAction('push'));
        this.bindButton('run-panel-run-btn', () => editor.compile());
        this.bindButton('run-panel-debug-btn', () => editor.debug());
        this.bindButton('install-library-btn', () => this.installLibrary());
        this.bindButton('open-terminal-btn', () => {
            appState.set('outputView', 'terminal');
            appState.set('outputVisible', true);
            powerShellTerminal.focusInput();
        });

        document.querySelectorAll('[data-log-filter]').forEach(button => {
            button.addEventListener('click', () => {
                const filter = button.dataset.logFilter;
                appState.toggleOutputFilter(filter);
            });
        });

        document.querySelectorAll('[data-output-view]').forEach(button => {
            button.addEventListener('click', () => {
                const view = button.dataset.outputView;
                if (view === 'logs' || view === 'terminal') {
                    appState.set('outputView', view);
                }
            });
        });

        document.querySelectorAll('[data-activity]').forEach(button => {
            button.addEventListener('click', () => {
                const view = button.dataset.activity;
                if (['explorer', 'problems', 'git', 'run'].includes(view)) {
                    appState.set('sidebarView', view);
                }
            });
        });

        this.setupOutputResize();

        document.addEventListener('cat-editor:workspace-mutated', () => {
            this.scheduleWorkspaceRefresh();
        });

        window.addEventListener('keydown', event => {
            if (event.ctrlKey && event.key.toLowerCase() === 's') {
                event.preventDefault();
                editor.save().catch(error => {
                    logger.err('Save shortcut failed.', {
                        details: error?.message || String(error)
                    });
                });
            }

            if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'r') {
                event.preventDefault();
                editor.compile().catch(error => {
                    logger.err('Run shortcut failed.', {
                        details: error?.message || String(error)
                    });
                });
            }

            if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'd') {
                event.preventDefault();
                editor.debug().catch(error => {
                    logger.err('Debug shortcut failed.', {
                        details: error?.message || String(error)
                    });
                });
            }

            // Ctrl+W — close active tab
            if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'w') {
                event.preventDefault();
                const active = appState.get('currentFile');
                if (active?.path && typeof fileTree.closeTab === 'function') {
                    fileTree.closeTab(active.path).catch(() => {});
                }
            }

            // Ctrl+Tab / Ctrl+Shift+Tab — cycle through open tabs
            if (event.ctrlKey && event.key === 'Tab') {
                event.preventDefault();
                const open = [...appState.get('openFiles').values()];
                if (open.length > 1) {
                    const currentPath = appState.get('currentFile')?.path;
                    const idx = open.findIndex(of => of.file?.path === currentPath);
                    const dir = event.shiftKey ? -1 : 1;
                    const next = open[(idx + dir + open.length) % open.length];
                    if (next?.file) {
                        fileTree.openFile(next.file).catch(() => {});
                    }
                }
            }

            // Ctrl+B — toggle sidebar
            if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'b') {
                event.preventDefault();
                document.body.classList.toggle('sidebar-collapsed');
            }

            // Ctrl+` — toggle terminal/output panel
            if (event.ctrlKey && (event.key === '`' || event.code === 'Backquote')) {
                event.preventDefault();
                appState.set('outputView', 'terminal');
                appState.set('outputVisible', !appState.get('outputVisible'));
                if (appState.get('outputVisible')) {
                    powerShellTerminal.focusInput?.();
                }
            }

            // Ctrl+P — quick file open via prompt
            if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'p') {
                event.preventDefault();
                this.quickOpenFile().catch(error => {
                    logger.err('Quick open failed.', {
                        details: error?.message || String(error)
                    });
                });
            }
        });

        const beforeUnload = event => {
            const hasDirtyFiles = [...appState.get('openFiles').values()].some(file => file.dirty);
            if (!hasDirtyFiles) {
                return;
            }
            event.preventDefault();
            event.returnValue = 'You have unsaved changes. Are you sure you want to leave?';
        };
        const onUnload = () => this.dispose();

        window.addEventListener('beforeunload', beforeUnload);
        window.addEventListener('unload', onUnload);
        this._track(() => window.removeEventListener('beforeunload', beforeUnload));
        this._track(() => window.removeEventListener('unload', onUnload));
    }

    async quickOpenFile() {
        const project = appState.get('currentProject');
        if (!project?.path) {
            showToast('Open a workspace before searching files.', 'error');
            return;
        }

        const query = await promptDialog({
            title: 'Quick Open',
            message: 'Type part of a file name to open it.',
            label: 'File name',
            placeholder: 'main.c',
            confirmText: 'Open'
        });
        if (!query) return;

        const needle = query.trim().toLowerCase();
        const collect = () => {
            // Walk the tree state to gather every file node; falls back to the
            // currently open files when the tree hasn't been loaded yet.
            const out = [];
            const visit = node => {
                if (!node) return;
                if (!node.is_directory && node.name && node.path) out.push(node);
                (node.children || []).forEach(visit);
            };
            (fileTree.tree || []).forEach(visit);
            if (out.length === 0) {
                for (const of of appState.get('openFiles').values()) {
                    if (of?.file) out.push(of.file);
                }
            }
            return out;
        };
        const all = collect();
        const match = all.find(f => f.name?.toLowerCase().includes(needle))
            || all.find(f => normalizePath(f.path || '').toLowerCase().includes(needle));

        if (!match) {
            showToast(`No file matched "${query}".`, 'error');
            return;
        }
        await fileTree.openFile(match);
    }

    setupOutputResize() {
        const resizer = document.getElementById('output-resizer');
        const panel = document.getElementById('output-panel');
        if (!resizer || !panel) {
            return;
        }

        let startY = 0;
        let startHeight = 0;

        const onPointerMove = event => {
            if (!this.outputResizing) {
                return;
            }

            const delta = startY - event.clientY;
            const maxHeight = Math.round(window.innerHeight * MAX_OUTPUT_HEIGHT_RATIO);
            const nextHeight = Math.max(
                MIN_OUTPUT_HEIGHT,
                Math.min(maxHeight, startHeight + delta)
            );
            appState.set('outputHeight', nextHeight);
        };

        const stopResize = () => {
            if (!this.outputResizing) {
                return;
            }

            this.outputResizing = false;
            document.body.classList.remove('is-resizing-terminal');
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', stopResize);
        };

        resizer.addEventListener('pointerdown', event => {
            event.preventDefault();
            this.outputResizing = true;
            startY = event.clientY;
            startHeight = panel.getBoundingClientRect().height;
            document.body.classList.add('is-resizing-terminal');
            window.addEventListener('pointermove', onPointerMove);
            window.addEventListener('pointerup', stopResize);
        });
    }

    bindButton(id, handler) {
        document.getElementById(id)?.addEventListener('click', () => {
            Promise.resolve(handler()).catch(error => {
                logger.err(`Action failed: ${id}`, {
                    details: error?.message || String(error)
                });
                showToast(error?.message || 'Action failed', 'error');
            });
        });
    }

    subscribeToState() {
        // Batch every render through requestAnimationFrame so a burst of state
        // changes (e.g. opening multiple files, log floods) collapses into a
        // single paint instead of N synchronous reflows.
        const scheduleOutput = () => rafBatch('output', () => this.renderOutput());
        const scheduleProblems = () => rafBatch('problems', () => this.renderProblemsPanel());
        const scheduleTabs = () => rafBatch('tabs', () => fileTree.updateTabs());
        const scheduleEmptyState = () => rafBatch('empty', () => this.updateEditorEmptyState());
        const scheduleRunTools = () => rafBatch('runtools', () => this.renderRunTools());
        const scheduleGit = () => rafBatch('git', () => this.renderGitStatus());
        const scheduleLabels = () => rafBatch('labels', () => this.updateWorkspaceLabels());
        const scheduleTitle = () => rafBatch('title', () => this._updateDocumentTitle());

        this._track(appState.subscribe('output:append', scheduleOutput));
        this._track(appState.subscribe('output:reset', () => {
            this._lastRenderedOutputCount = 0;
            scheduleOutput();
        }));
        this._track(appState.subscribe('output', scheduleOutput));
        this._track(appState.subscribe('outputFilters', () => {
            this._lastRenderedOutputCount = 0;
            this.syncOutputFilters();
            scheduleOutput();
        }));
        this._track(appState.subscribe('outputVisible', () => this.syncOutputVisibility()));
        this._track(appState.subscribe('outputView', view => {
            localStorage.setItem('cat-editor-output-view', view);
            if (view === 'logs') {
                this._lastRenderedOutputCount = 0;
            }
            this.syncOutputView();
        }));
        this._track(appState.subscribe('sidebarView', view => {
            localStorage.setItem('cat-editor-sidebar-view', view);
            this.syncSidebarView();
            // Refresh Git status when switching to Git tab
            if (view === 'git') {
                this.refreshGitStatus({ silent: true }).catch(() => {});
            }
        }));
        this._track(appState.subscribe('outputHeight', height => {
            localStorage.setItem('cat-editor-output-height', String(height));
            this.applyOutputHeight();
        }));
        this._track(appState.subscribe('openFiles', () => {
            scheduleTabs();
            scheduleEmptyState();
            scheduleTitle();
        }));
        this._track(appState.subscribe('openFiles:meta', () => {
            scheduleTabs();
            scheduleTitle();
        }));
        this._track(appState.subscribe('currentFile', file => {
            const activeFileLabel = document.getElementById('active-file-label');
            if (activeFileLabel) {
                activeFileLabel.textContent = file?.name || 'No file selected';
            }
            scheduleEmptyState();
            scheduleProblems();
            scheduleTitle();
        }));
        this._track(appState.subscribe('currentProject', () => {
            scheduleLabels();
            scheduleRunTools();
            scheduleTitle();
            this.refreshGitStatus({ silent: true }).catch(error => {
                logger.err('Failed to refresh Git status.', {
                    details: error?.message || String(error)
                });
            });
        }));
        this._track(appState.subscribe('problems', () => {
            scheduleProblems();
            scheduleOutput();
        }));
        this._track(appState.subscribe('gitStatus', () => {
            scheduleGit();
            scheduleLabels();
        }));
        this._track(appState.subscribe('runtimeStatus', scheduleRunTools));
        this._track(appState.subscribe('terminalState', scheduleRunTools));
    }

    _updateDocumentTitle() {
        const project = appState.get('currentProject');
        const file = appState.get('currentFile');
        const dirty = typeof appState.countDirtyFiles === 'function'
            ? appState.countDirtyFiles()
            : 0;
        const parts = [];
        if (file?.name) parts.push(file.name);
        if (project?.name) parts.push(project.name);
        parts.push('Cat Editor');
        const prefix = dirty > 0 ? `(${dirty}) ` : '';
        document.title = prefix + parts.join(' — ');
    }

    async loadProjects() {
        try {
            const projects = await api.getProjects();
            const container = document.getElementById('project-list');
            const currentProject = appState.get('currentProject');
            const projectCount = document.getElementById('project-count');

            if (projectCount) {
                projectCount.textContent = String(projects.length);
            }

            if (!container) {
                return;
            }

            if (!projects || projects.length === 0) {
                logger.info('No saved projects found. Create one to initialize the workspace list.');
                container.innerHTML = `
                    <div class="empty-card">
                        <strong>No projects found.</strong>
                        <p>Create the first project and it will stay available across launches.</p>
                        <button id="create-first-project" class="primary-btn" type="button">Create Project</button>
                    </div>
                `;

                document.getElementById('create-first-project')?.addEventListener('click', () => {
                    this.createProject().catch(error => {
                        logger.err('Project creation dialog failed.', {
                            details: error?.message || String(error)
                        });
                    });
                });
                return;
            }

            logger.info(`Loaded ${projects.length} project(s).`);
            container.innerHTML = '';

            projects.forEach(project => {
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'project-item';
                item.dataset.path = project.path;

                if (currentProject?.path === project.path) {
                    item.classList.add('active');
                }

                item.innerHTML = `
                    <div class="project-main">
                        <span class="project-badge">PRJ</span>
                        <span class="project-name">${escapeHtml(project.name)}</span>
                    </div>
                    <span class="project-meta">${project.file_count || 0} files</span>
                `;

                item.addEventListener('click', () => {
                    this.openProject(project).catch(error => {
                        logger.err(`Unable to open ${project.name}`, {
                            details: error?.message || String(error)
                        });
                    });
                });

                container.appendChild(item);
            });

            this.markActiveProject(currentProject?.path || '');
        } catch (error) {
            logger.err('Failed to load project list.', {
                details: error?.message || String(error)
            });
        }
    }

    async openProject(project) {
        appState.clearOpenFiles();
        appState.set('currentFile', null);
        appState.set('activeTab', null);
        appState.clearProblems();
        appState.setGitStatus(null);
        appState.set('currentProject', project);

        await fileTree.loadProject(project.path);
        this.markActiveProject(project.path);
        this.updateWorkspaceLabels();
        await powerShellTerminal.setWorkingDirectory(project.path).catch(() => {});
        await this.refreshGitStatus({ silent: true }).catch(() => {});

        logger.sys(`Opened workspace ${project.name}`, {
            context: `${project.file_count || 0} files detected`
        });
        showToast(`${project.name} opened`, 'success');
    }

    async createProject() {
        const name = await promptDialog({
            title: 'Create Project',
            message: 'Give the new workspace a name. The editor will create a starter scaffold for you.',
            label: 'Project name',
            placeholder: 'hello-world',
            confirmText: 'Create project',
            validate: validateEntityName
        });

        if (!name) {
            return;
        }

        logger.sys(`Creating project ${name}`);

        try {
            let project = await api.createProject(name);
            project = await this.ensureProjectScaffold(project || { name });

            await this.loadProjects();
            await this.openProject(project);

            logger.info(`Project ready: ${name}`, {
                context: 'starter files created'
            });
            showToast(`Project ${name} created`, 'success');
        } catch (error) {
            logger.err(`Project creation failed for ${name}`, {
                details: error?.message || String(error)
            });
            showToast(`Create failed: ${error.message}`, 'error');
        }
    }

    async ensureProjectScaffold(project) {
        if (!project?.path) {
            return project;
        }

        const files = await api.getFiles(project.path);
        if (Array.isArray(files) && files.length > 0) {
            return project;
        }

        logger.info(`Project ${project.name} was empty. Rebuilding starter scaffold.`);

        await api.createFile(project.path, 'main.c');
        await api.createFile(project.path, 'README.md');

        const updatedFiles = await api.getFiles(project.path);
        return {
            ...project,
            file_count: updatedFiles.length
        };
    }

    async createNewFile() {
        const currentProject = appState.get('currentProject');
        if (!currentProject) {
            showToast('Open a workspace before creating files.', 'error');
            return;
        }

        const name = await promptDialog({
            title: 'Create File',
            message: `Add a new file inside ${currentProject.name}.`,
            label: 'File name',
            placeholder: 'main.c',
            confirmText: 'Create file',
            validate: validateEntityName
        });

        if (!name) {
            return;
        }

        try {
            const file = await api.createFile(currentProject.path, name);
            await fileTree.refresh();
            await fileTree.openFile(file);
            document.dispatchEvent(new CustomEvent('cat-editor:workspace-mutated'));
            logger.sys(`Created ${name}`, {
                context: currentProject.name
            });
            showToast(`${name} created`, 'success');
        } catch (error) {
            logger.err(`Create failed for ${name}`, {
                details: error?.message || String(error)
            });
            showToast(`Create failed: ${error.message}`, 'error');
        }
    }

    toggleOutput() {
        appState.set('outputVisible', !appState.get('outputVisible'));
    }

    markActiveProject(path) {
        document.querySelectorAll('.project-item').forEach(item => {
            item.classList.toggle('active', item.dataset.path === path);
        });
    }

    renderOutput() {
        const container = document.getElementById('output-content');
        if (!container) {
            return;
        }

        const output = appState.getVisibleOutput();

        // Full rebuild only when filters changed or output was cleared
        if (output.length < this._lastRenderedOutputCount) {
            this._lastRenderedOutputCount = 0;
            container.innerHTML = '';
        }

        // Show empty state only when nothing is visible
        if (output.length === 0) {
            if (container.children.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'terminal-empty';
                empty.innerHTML = `
                    <strong>No visible logs right now.</strong>
                    <p>Run an action or re-enable filtered log groups.</p>
                `;
                container.appendChild(empty);
            }
            return;
        }

        // Remove empty placeholder if present
        const placeholder = container.querySelector('.terminal-empty');
        if (placeholder) {
            placeholder.remove();
        }

        // Only append entries that haven't been rendered yet
        const newEntries = output.slice(this._lastRenderedOutputCount);
        if (newEntries.length === 0) {
            return;
        }

        const fragment = document.createDocumentFragment();

        newEntries.forEach(entry => {
            const row = document.createElement('div');
            row.className = `output-line level-${entry.level.toLowerCase()}`;

            const badge = document.createElement('span');
            badge.className = 'output-badge';
            badge.textContent = `[${entry.level}]`;

            const content = document.createElement('div');
            content.className = 'output-body';

            const head = document.createElement('div');
            head.className = 'output-head';

            const message = document.createElement('span');
            message.className = 'output-message';
            message.textContent = entry.message;

            const time = document.createElement('span');
            time.className = 'output-time';
            time.textContent = entry.timestamp;

            head.append(message, time);
            content.appendChild(head);

            if (entry.context) {
                const ctx = document.createElement('div');
                ctx.className = 'output-context';
                ctx.textContent = entry.context;
                content.appendChild(ctx);
            }

            if (entry.problems?.length) {
                const problemList = document.createElement('div');
                problemList.className = 'output-problems';

                entry.problems.forEach(problem => {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'problem-link';
                    button.textContent = this.formatProblemLabel(problem);
                    button.addEventListener('click', () => {
                        this.openProblem(problem).catch(error => {
                            logger.err('Failed to open problem location.', {
                                details: error?.message || String(error)
                            });
                        });
                    });
                    problemList.appendChild(button);
                });

                content.appendChild(problemList);
            }

            if (entry.details) {
                const details = document.createElement('pre');
                details.className = 'output-details';
                details.textContent = entry.details;
                content.appendChild(details);
            }

            row.append(badge, content);
            fragment.appendChild(row);
        });

        container.appendChild(fragment);
        this._lastRenderedOutputCount = output.length;
        container.scrollTop = container.scrollHeight;
    }

    renderProblemsPanel() {
        const container = document.getElementById('problem-list');
        const count = document.getElementById('problem-count');
        if (!container) {
            return;
        }

        const currentFile = appState.get('currentFile');
        const currentPath = normalizePath(currentFile?.path || '');
        const problems = appState.get('problems') || [];

        if (count) {
            count.textContent = String(problems.length);
        }

        container.innerHTML = '';

        if (problems.length === 0) {
            container.innerHTML = `
                <div class="empty-card">
                    <strong>No problems detected.</strong>
                    <p>Save the current file or run it to refresh diagnostics.</p>
                </div>
            `;
            return;
        }

        problems.forEach(problem => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'problem-item';
            if (normalizePath(problem.file || '') === currentPath) {
                item.classList.add('active');
            }

            item.innerHTML = `
                <div class="problem-item-head">
                    <span class="problem-kind ${problem.errorType.toLowerCase().includes('warning') ? 'warning' : 'error'}">
                        ${problem.errorType}
                    </span>
                    <span class="problem-location">${escapeHtml(this.formatProblemLocation(problem))}</span>
                </div>
                <div class="problem-message">${escapeHtml(problem.message)}</div>
            `;

            item.addEventListener('click', () => {
                this.openProblem(problem).catch(error => {
                    logger.err('Problem navigation failed.', {
                        details: error?.message || String(error)
                    });
                });
            });
            container.appendChild(item);
        });
    }

    async openProblem(problem) {
        if (!problem) {
            return;
        }

        const targetPath = problem.file || appState.get('currentFile')?.path || '';
        if (targetPath && normalizePath(targetPath) !== normalizePath(appState.get('currentFile')?.path || '')) {
            await fileTree.openFilePath(targetPath);
        }

        editor.revealProblem(problem);
        appState.set('sidebarView', 'problems');
    }

    syncOutputFilters() {
        document.querySelectorAll('[data-log-filter]').forEach(button => {
            const filter = button.dataset.logFilter;
            button.classList.toggle('active', appState.isOutputFilterEnabled(filter));
        });
    }

    syncOutputVisibility() {
        const isVisible = appState.get('outputVisible');
        document.getElementById('output-panel')?.classList.toggle('hidden', !isVisible);

        const toggleButton = document.getElementById('toggle-output-btn');
        if (toggleButton) {
            toggleButton.textContent = isVisible ? 'Hide Output' : 'Show Output';
        }
    }

    syncOutputView() {
        const view = appState.get('outputView');

        document.querySelectorAll('[data-output-view]').forEach(button => {
            button.classList.toggle('active', button.dataset.outputView === view);
        });

        document.querySelectorAll('[data-panel-view]').forEach(panel => {
            panel.classList.toggle('active', panel.dataset.panelView === view);
        });

        document.querySelectorAll('[data-panel-actions]').forEach(panel => {
            panel.classList.toggle('active', panel.dataset.panelActions === view);
        });
    }

    syncSidebarView() {
        const view = appState.get('sidebarView');

        document.querySelectorAll('[data-activity]').forEach(button => {
            button.classList.toggle('active', button.dataset.activity === view);
        });

        document.querySelectorAll('[data-sidebar-view]').forEach(panel => {
            panel.classList.toggle('active', panel.dataset.sidebarView === view);
        });
    }

    applyOutputHeight() {
        const panel = document.getElementById('output-panel');
        if (!panel) {
            return;
        }

        panel.style.height = `${appState.get('outputHeight') || DEFAULT_OUTPUT_HEIGHT}px`;
    }

    updateEditorEmptyState() {
        const hasOpenFile = Boolean(appState.get('currentFile'));
        document.getElementById('editor-empty-state')?.classList.toggle('hidden', hasOpenFile);
        document.querySelector('.editor-stage')?.classList.toggle('is-empty', !hasOpenFile);
    }

    updateWorkspaceLabels() {
        const project = appState.get('currentProject');
        const gitStatus = appState.get('gitStatus');
        const projectName = project?.name || 'No workspace selected';
        const branch = gitStatus?.repository ? gitStatus.branch || 'detached' : '';

        const workspaceName = document.getElementById('workspace-name');
        const activeProjectLabel = document.getElementById('active-project-label');
        const statusProject = document.getElementById('status-project');
        const gitBranch = document.getElementById('git-branch-label');

        if (workspaceName) {
            workspaceName.textContent = branch ? `${projectName} | ${branch}` : projectName;
        }

        if (activeProjectLabel) {
            activeProjectLabel.textContent = projectName === 'No workspace selected'
                ? 'Select a workspace to begin'
                : projectName;
        }

        if (statusProject) {
            statusProject.textContent = project
                ? `Project: ${project.name}${branch ? ` | Git: ${branch}` : ''}`
                : 'No project';
        }

        if (gitBranch) {
            gitBranch.textContent = branch || 'No repository';
        }
    }

    initTheme() {
        const storedTheme = localStorage.getItem('cat-editor-theme');
        this.theme = storedTheme === 'light' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', this.theme);
        this.syncThemeToggle();
    }

    toggleTheme() {
        this.theme = this.theme === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', this.theme);
        localStorage.setItem('cat-editor-theme', this.theme);
        this.syncThemeToggle();
        logger.info(`Theme switched to ${this.theme}.`);
    }

    syncThemeToggle() {
        const button = document.getElementById('theme-toggle-btn');
        if (!button) {
            return;
        }

        const isLight = this.theme === 'light';
        button.textContent = isLight ? 'Dark' : 'Light';
        button.title = isLight ? 'Switch to dark theme' : 'Switch to light theme';
        button.setAttribute('aria-label', button.title);
    }

    async setupWindowControls() {
        if (!isNativeTauri()) {
            document.body.classList.add('web-mode');
            logger.info('Native window controls are unavailable outside Tauri.');
            return;
        }

        this.bindButton('minimize-btn', () => api.minimizeWindow());
        this.bindButton('maximize-btn', () => this.toggleMaximize());
        this.bindButton('close-btn', () => api.closeWindow());

        await this.syncMaximizeButton();
    }

    async toggleMaximize() {
        try {
            await api.toggleMaximizeWindow();
            await this.syncMaximizeButton();
        } catch (error) {
            logger.err('Window maximize toggle failed.', {
                details: error?.message || String(error)
            });
            showToast('Unable to resize the window.', 'error');
        }
    }

    async syncMaximizeButton() {
        const button = document.getElementById('maximize-btn');
        if (!button || !isNativeTauri()) {
            return;
        }

        try {
            const maximized = await api.isMaximizedWindow();
            button.classList.toggle('is-active', Boolean(maximized));
            button.setAttribute('aria-label', maximized ? 'Restore' : 'Maximize');
            button.title = maximized ? 'Restore' : 'Maximize';
        } catch (error) {
            logger.err('Failed to sync maximize state.', {
                details: error?.message || String(error)
            });
        }
    }

    async startSystemMonitor() {
        const update = async () => {
            try {
                const info = await api.getSystemInfo();
                const metrics = document.getElementById('system-metrics');
                if (!info || !metrics) {
                    return;
                }

                const ramUsedGB = ((info.ram_used || 0) / 1024 / 1024 / 1024).toFixed(1);
                const ramTotalGB = ((info.ram_total || 0) / 1024 / 1024 / 1024).toFixed(1);
                const diskUsedGB = ((info.disk_used || 0) / 1024 / 1024 / 1024).toFixed(0);
                const diskTotalGB = ((info.disk_total || 0) / 1024 / 1024 / 1024).toFixed(0);
                metrics.textContent = `RAM ${ramUsedGB}/${ramTotalGB} GB | CPU ${Math.round(info.cpu_usage || 0)}% | Disk ${diskUsedGB}/${diskTotalGB} GB`;
                this.monitorFailed = false;
            } catch (error) {
                if (!this.monitorFailed) {
                    logger.err('System monitor update failed.', {
                        details: error?.message || String(error)
                    });
                }
                this.monitorFailed = true;
            }
        };

        await update();
        // 30s instead of 10s — system info doesn't need sub-minute resolution
        // and reduces wake-ups when the editor sits idle in the background.
        this.monitorInterval = setInterval(() => {
            update().catch(error => {
                logger.err('System monitor crashed.', {
                    details: error?.message || String(error)
                });
            });
        }, 30000);
    }

    scheduleWorkspaceRefresh() {
        if (this.workspaceRefreshTimer) {
            clearTimeout(this.workspaceRefreshTimer);
        }

        // 2 seconds debounce - git should not run on every keystroke/save
        this.workspaceRefreshTimer = setTimeout(() => {
            // Lazy loading: only refresh git if Git tab is active
            if (!this._gitRefreshing && appState.get('sidebarView') === 'git') {
                this.refreshGitStatus({ silent: true }).catch(() => {});
            }
        }, 2000);
    }

    async refreshProblems() {
        const currentFile = appState.get('currentFile');
        if (!currentFile) {
            showToast('Open a file before refreshing problems.', 'error');
            return;
        }

        await editor.checkSyntax(editor.getContent(), currentFile.name, {
            reportSuccess: true
        });
    }

    async refreshGitStatus(options = {}) {
        // Prevent concurrent git status calls - they can cause hangs
        if (this._gitRefreshing) {
            return;
        }

        const project = appState.get('currentProject');
        if (!project?.path) {
            appState.setGitStatus(null);
            return;
        }

        this._gitRefreshing = true;
        try {
            const status = await api.getGitStatus(project.path);
            appState.setGitStatus(status);
        } catch (error) {
            if (!options.silent) {
                logger.err('Failed to load Git status.', {
                    details: error?.message || String(error)
                });
            }
        } finally {
            this._gitRefreshing = false;
        }
    }

    renderGitStatus() {
        const status = appState.get('gitStatus');
        const project = appState.get('currentProject');
        const branch = document.getElementById('git-branch');
        const summary = document.getElementById('git-summary');
        const list = document.getElementById('git-status-list');
        const initButton = document.getElementById('init-git-btn');
        const stageButton = document.getElementById('git-stage-all-btn');
        const commitButton = document.getElementById('git-commit-btn');
        const pullButton = document.getElementById('git-pull-btn');
        const pushButton = document.getElementById('git-push-btn');

        if (branch) {
            branch.textContent = status?.repository
                ? (status.branch || 'detached')
                : 'No repository';
        }

        if (summary) {
            summary.textContent = !project
                ? 'Open a workspace to inspect repository status.'
                : !status
                    ? 'Loading repository status...'
                    : !status.available
                        ? 'Git is not available on this machine.'
                        : !status.repository
                            ? (status.message || 'Initialize a repository in this workspace.')
                            : status.clean
                                ? 'Working tree is clean.'
                                : `${status.entries.length} file(s) changed${status.ahead || status.behind ? ` | ahead ${status.ahead}, behind ${status.behind}` : ''}.`;
        }

        if (initButton) {
            initButton.disabled = !project || Boolean(status?.repository) || !status?.available;
        }
        if (stageButton) {
            stageButton.disabled = !project || !status?.repository || status.clean;
        }
        if (commitButton) {
            commitButton.disabled = !project || !status?.repository || status.clean;
        }
        if (pullButton) {
            pullButton.disabled = !project || !status?.repository;
        }
        if (pushButton) {
            pushButton.disabled = !project || !status?.repository;
        }

        if (!list) {
            return;
        }

        list.innerHTML = '';

        if (!project) {
            list.innerHTML = `
                <div class="empty-card">
                    <strong>No workspace open.</strong>
                    <p>Select a project to work with Git.</p>
                </div>
            `;
            return;
        }

        if (!status?.available) {
            list.innerHTML = `
                <div class="empty-card">
                    <strong>Git not found.</strong>
                    <p>Install Git and reopen the editor to enable repository actions.</p>
                </div>
            `;
            return;
        }

        if (!status.repository) {
            list.innerHTML = `
                <div class="empty-card">
                    <strong>No repository yet.</strong>
                    <p>Use the Init button to run <code>git init</code> for this workspace.</p>
                </div>
            `;
            return;
        }

        if (!status.entries?.length) {
            list.innerHTML = `
                <div class="empty-card">
                    <strong>Working tree clean.</strong>
                    <p>No staged or unstaged changes right now.</p>
                </div>
            `;
            return;
        }

        status.entries.forEach(entry => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'git-item';
            item.innerHTML = `
                <span class="git-item-status">${escapeHtml(entry.status || '--')}</span>
                <span class="git-item-path">${escapeHtml(entry.path)}</span>
                <span class="git-item-meta">${entry.untracked ? 'new' : entry.staged ? 'staged' : entry.has_unstaged ? 'modified' : 'changed'}</span>
            `;
            item.addEventListener('click', () => {
                if (!entry.deleted) {
                    const targetPath = status.repo_root
                        ? `${status.repo_root}\\${entry.path.replace(/\//g, '\\')}`
                        : entry.path;
                    fileTree.openFilePath(targetPath).catch(error => {
                        logger.err('Failed to open Git file.', {
                            details: error?.message || String(error)
                        });
                    });
                }
            });
            list.appendChild(item);
        });
    }

    async initGitRepository() {
        const project = appState.get('currentProject');
        if (!project?.path) {
            showToast('Open a workspace before initializing Git.', 'error');
            return;
        }

        const result = await api.initGitRepository(project.path);
        this.logCommandResult('Git init', result);
        await this.refreshGitStatus();
        showToast(result.success ? 'Git repository initialized.' : 'Git init failed.', result.success ? 'success' : 'error');
    }

    async runGitAction(action) {
        const project = appState.get('currentProject');
        if (!project?.path) {
            showToast('Open a workspace before using Git.', 'error');
            return;
        }

        const actionMap = {
            stage: () => api.gitStageAll(project.path),
            pull: () => api.gitPull(project.path),
            push: () => api.gitPush(project.path)
        };

        const runner = actionMap[action];
        if (!runner) {
            return;
        }

        const result = await runner();
        this.logCommandResult(`Git ${action}`, result);
        await this.refreshGitStatus({ silent: true });
        if (action === 'pull') {
            await fileTree.refresh().catch(() => {});
        }
        showToast(result.success ? `Git ${action} completed.` : `Git ${action} failed.`, result.success ? 'success' : 'error');
    }

    async commitGitChanges() {
        const project = appState.get('currentProject');
        if (!project?.path) {
            showToast('Open a workspace before committing.', 'error');
            return;
        }

        const values = await formDialog({
            title: 'Create Commit',
            message: 'Write the commit message that should be used for the current staged changes.',
            confirmText: 'Commit',
            fields: [
                {
                    id: 'message',
                    label: 'Commit message',
                    type: 'textarea',
                    rows: 3,
                    placeholder: 'Fix compiler diagnostics navigation'
                }
            ],
            validate: form => {
                if (!String(form.message || '').trim()) {
                    return 'Commit message cannot be empty.';
                }
                return '';
            }
        });

        if (!values?.message) {
            return;
        }

        const result = await api.gitCommit(project.path, values.message.trim());
        this.logCommandResult('Git commit', result);
        await this.refreshGitStatus({ silent: true });
        showToast(result.success ? 'Commit created.' : 'Commit failed.', result.success ? 'success' : 'error');
    }

    async installLibrary() {
        const project = appState.get('currentProject');
        const runtimeStatus = appState.get('runtimeStatus');
        const managers = runtimeStatus?.package_managers || [];

        if (!project?.path) {
            showToast('Open a workspace before installing libraries.', 'error');
            return;
        }

        if (!managers.length) {
            showToast('No supported package managers are available.', 'error');
            return;
        }

        const values = await formDialog({
            title: 'Install Library',
            message: 'Choose the package manager and package name to install directly from the editor.',
            confirmText: 'Install',
            fields: [
                {
                    id: 'manager',
                    label: 'Package manager',
                    type: 'select',
                    initialValue: managers[0],
                    options: managers.map(manager => ({
                        value: manager,
                        label: manager
                    }))
                },
                {
                    id: 'packageName',
                    label: 'Package name',
                    type: 'text',
                    placeholder: managers[0] === 'vcpkg' ? 'fmt' : 'lodash'
                }
            ],
            validate: form => validatePackageName(form.packageName)
        });

        if (!values?.manager || !values?.packageName) {
            return;
        }

        const result = await api.installPackage(project.path, values.manager, values.packageName.trim());
        this.logCommandResult(`Install ${values.packageName}`, result);
        showToast(result.success ? `Installed ${values.packageName}.` : `Failed to install ${values.packageName}.`, result.success ? 'success' : 'error');
    }

    logCommandResult(title, result) {
        const details = [result.command, result.stdout, result.stderr]
            .filter(Boolean)
            .join('\n\n');

        if (result.success) {
            logger.info(title, { details });
        } else {
            logger.err(title, { details });
        }
    }

    renderRunTools() {
        const runtimeStatus = appState.get('runtimeStatus');
        const terminalState = appState.get('terminalState') || {};
        const currentProject = appState.get('currentProject');

        const compiler = document.getElementById('runtime-compiler');
        const debuggerLabel = document.getElementById('runtime-debugger');
        const git = document.getElementById('runtime-git');
        const packages = document.getElementById('runtime-packages');
        const terminal = document.getElementById('runtime-terminal');
        const runButton = document.getElementById('run-panel-run-btn');
        const debugButton = document.getElementById('run-panel-debug-btn');
        const installButton = document.getElementById('install-library-btn');

        if (compiler) {
            compiler.textContent = runtimeStatus?.compiler_available
                ? runtimeStatus.compiler_label
                : 'Not available';
        }
        if (debuggerLabel) {
            debuggerLabel.textContent = runtimeStatus?.debugger_available
                ? runtimeStatus.debugger_label
                : 'Not available';
        }
        if (git) {
            git.textContent = runtimeStatus?.git_available ? 'Ready' : 'Not installed';
        }
        if (packages) {
            packages.textContent = runtimeStatus?.package_managers?.length
                ? runtimeStatus.package_managers.join(', ')
                : 'No supported managers';
        }
        if (terminal) {
            terminal.textContent = terminalState.running
                ? `Running in ${terminalState.cwd || 'shell'}`
                : terminalState.ready
                    ? `Ready in ${terminalState.cwd || 'shell'}`
                    : 'Terminal offline';
        }

        if (runButton) {
            runButton.disabled = !currentProject;
        }
        if (debugButton) {
            debugButton.disabled = !currentProject;
        }
        if (installButton) {
            installButton.disabled = !currentProject || !(runtimeStatus?.package_managers?.length);
        }
    }

    formatProblemLabel(problem) {
        return `${this.formatProblemLocation(problem)} | ${problem.message}`;
    }

    formatProblemLocation(problem) {
        const fileLabel = problem.file ? getFileName(problem.file) : 'current file';
        return `${fileLabel}:${Number(problem.line || 0) + 1}:${Number(problem.column || 0) + 1}`;
    }
}

new App();
