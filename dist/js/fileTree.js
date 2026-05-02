import { api } from './tauri.js';
import { appState } from './state.js';
import { editor, MAX_OPEN_FILE_BYTES } from './editor.js';
import { logger } from './logger.js';
import { confirmDialog, promptDialog, showToast } from './ui.js';
import {
    buildTreeIndex,
    collectAncestorPaths,
    flattenTree,
    getFileExtension,
    getFileName,
    getRelativePath,
    normalizePath,
    rafBatch,
    validateEntityName
} from './utils.js';

class FileTree {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.tree = [];
        this.nodes = new Map();
        this.normalizedNodes = new Map(); // normalized path -> real path
        this.parentMap = new Map();
        this.expanded = new Set();
        this.projectPath = null;
        this._renderScheduled = false;
        this._activeMenu = null;
        this._activeMenuCleanup = null;
    }

    _scheduleRender() {
        rafBatch('fileTree:render', () => this.render());
    }

    async loadProject(projectPath, options = {}) {
        this.projectPath = projectPath;
        const tree = await api.getFileTree(projectPath);
        this.tree = Array.isArray(tree) ? tree : [];
        appState.setWorkspaceTree(this.tree);

        const { index, parents } = buildTreeIndex(this.tree);
        this.nodes = index;
        this.parentMap = parents;
        this.normalizedNodes = new Map();
        for (const p of index.keys()) {
            this.normalizedNodes.set(normalizePath(p), p);
        }

        if (!options.preserveExpanded) {
            this.expanded.clear();
        }

        this.expandForCurrentFile();
        this.render();
    }

    render() {
        if (!this.container) {
            return;
        }

        this.container.innerHTML = '';

        if (!this.projectPath) {
            return;
        }

        if (!this.tree.length) {
            this.container.innerHTML = `
                <div class="empty-card">
                    <strong>Empty workspace.</strong>
                    <p>Create a file or folder to start shaping the project tree.</p>
                </div>
            `;
            return;
        }

        const fragment = document.createDocumentFragment();
        this.renderNodes(this.tree, fragment, []);
        this.container.appendChild(fragment);
    }

    renderNodes(nodes, container, ancestry) {
        for (let i = 0; i < nodes.length; i += 1) {
            const node = nodes[i];
            const isLast = i === nodes.length - 1;
            const row = this.createNodeRow(node, ancestry, isLast);
            container.appendChild(row);

            if (node.is_directory && this.expanded.has(node.path)) {
                const children = document.createElement('div');
                children.className = 'tree-children';
                if (node.children?.length) {
                    this.renderNodes(node.children, children, [...ancestry, !isLast]);
                } else {
                    const empty = document.createElement('div');
                    empty.className = 'tree-empty';
                    empty.textContent = 'Empty folder';
                    children.appendChild(empty);
                }
                container.appendChild(children);
            }
        }
    }

    createNodeRow(node, ancestry, isLast) {
        const row = document.createElement('div');
        row.className = `tree-item github-tree-item ${node.is_directory ? 'is-directory' : 'is-file'}`;
        row.dataset.path = node.path;
        row.dataset.nodeType = node.is_directory ? 'directory' : 'file';

        const guides = document.createElement('span');
        guides.className = 'tree-guides';
        ancestry.forEach(hasMore => {
            const guide = document.createElement('span');
            guide.className = `tree-guide ${hasMore ? 'continue' : 'empty'}`;
            guides.appendChild(guide);
        });
        const branch = document.createElement('span');
        branch.className = `tree-guide branch ${isLast ? 'last' : 'continue'}`;
        guides.appendChild(branch);

        const toggle = document.createElement('button');
        toggle.className = 'tree-toggle';
        toggle.type = 'button';
        toggle.setAttribute('aria-label', node.is_directory ? 'Toggle folder' : 'Open file');
        if (node.is_directory) {
            toggle.textContent = this.expanded.has(node.path) ? '▾' : '▸';
        }

        const icon = document.createElement('span');
        icon.className = `tree-icon ${node.is_directory ? 'folder' : 'file'}`;
        icon.textContent = node.is_directory ? '' : '•';

        const name = document.createElement('span');
        name.className = 'tree-name';
        name.textContent = node.name;

        row.append(guides, toggle, icon, name);

        if (normalizePath(appState.get('currentFile')?.path || '') === normalizePath(node.path)) {
            row.classList.add('active');
        }

        row.addEventListener('click', async event => {
            event.stopPropagation();

            if (node.is_directory) {
                if (event.target === toggle || event.target === row || event.target.classList?.contains('tree-name') || event.target.classList?.contains('tree-icon')) {
                    await this.toggleFolder(node.path);
                }
                return;
            }

            await this.openFile(node);
        });

        row.addEventListener('contextmenu', event => {
            event.preventDefault();
            this.showContextMenu(event.clientX, event.clientY, node);
        });

        return row;
    }

    async toggleFolder(path) {
        if (this.expanded.has(path)) {
            this.expanded.delete(path);
        } else {
            this.expanded.add(path);
        }

        this._scheduleRender();
    }

    expandForCurrentFile(path = appState.get('currentFile')?.path) {
        if (!path) {
            return;
        }

        collectAncestorPaths(path, this.parentMap).forEach(parent => {
            this.expanded.add(parent);
        });
    }

    async openFile(file) {
        try {
            let openFile = appState.getOpenFile(file.path);

            if (!openFile) {
                if (Number.isFinite(file.size) && file.size > MAX_OPEN_FILE_BYTES) {
                    showToast(`File is larger than 1 GB and cannot be opened.`, 'error');
                    logger.err(`Refused to open ${file.name}: ${file.size} bytes exceeds 1 GB.`);
                    return;
                }
                const content = await api.getFileContent(file.path);
                if (typeof content === 'string' && content.length > MAX_OPEN_FILE_BYTES) {
                    showToast('File is larger than 1 GB and cannot be opened.', 'error');
                    return;
                }
                openFile = {
                    file,
                    content: content || '',
                    savedContent: content || '',
                    dirty: false,
                    viewState: null
                };
                appState.setOpenFile(file.path, openFile);
            }

            appState.set('currentFile', file);
            appState.set('activeTab', file.path);
            editor.setContent(openFile.content, file.extension || 'c');

            if (openFile.viewState) {
                editor.editor?.scrollTo(openFile.viewState.left, openFile.viewState.top);
            }

            this.expandForCurrentFile(file.path);
            this.updateTabs();
            this._updateActiveTreeRow(file.path);
            logger.sys(`Opened ${file.name}`);
        } catch (error) {
            logger.err(`Failed to open ${file.name}`, {
                details: error?.message || String(error)
            });
        }
    }

    async openFilePath(path) {
        const normalizedPath = this.findKnownPath(path) || path;
        this.expandForCurrentFile(normalizePath(normalizedPath) === normalizePath(path) ? normalizedPath : path);
        this._scheduleRender();

        const file = this.nodes.get(normalizedPath) || {
            name: getFileName(normalizedPath),
            path: normalizedPath,
            size: 0,
            is_directory: false,
            modified: '',
            extension: getFileExtension(normalizedPath) || null
        };

        await this.openFile(file);
    }

    findKnownPath(path) {
        const target = normalizePath(path);
        return this.normalizedNodes.get(target) || '';
    }

    _updateActiveTreeRow(path) {
        if (!this.container) return;
        const targetNorm = normalizePath(path || '');
        this.container.querySelectorAll('.tree-item.active').forEach(el => el.classList.remove('active'));
        if (!targetNorm) return;
        this.container.querySelectorAll('.tree-item').forEach(el => {
            if (normalizePath(el.dataset.path || '') === targetNorm) {
                el.classList.add('active');
            }
        });
    }

    /**
     * Diff-update the tabs bar instead of rebuilding it on every change.
     * Adds new tabs, removes closed ones, and toggles classes (active/dirty)
     * on existing tabs without DOM thrashing.
     */
    updateTabs() {
        const container = document.getElementById('tabs-bar');
        if (!container) {
            return;
        }

        const openFiles = appState.get('openFiles');
        const activePath = appState.get('activeTab');
        const wantedPaths = new Set();

        // Mark which tabs we want to keep
        const existingByPath = new Map();
        container.querySelectorAll('.tab').forEach(tab => {
            existingByPath.set(tab.dataset.path, tab);
        });

        let cursor = container.firstChild;
        for (const [path, data] of openFiles.entries()) {
            wantedPaths.add(path);
            let tab = existingByPath.get(path);
            if (!tab) {
                tab = this.createTab(path, data);
                container.insertBefore(tab, cursor);
            } else {
                // Update active/dirty without rebuilding
                tab.classList.toggle('active', activePath === path);
                tab.classList.toggle('dirty', Boolean(data.dirty));
                // Update the visible name if it changed
                const nameEl = tab.querySelector('.tab-name');
                if (nameEl && nameEl.textContent !== data.file.name) {
                    nameEl.textContent = data.file.name;
                }
                if (tab !== cursor) {
                    container.insertBefore(tab, cursor);
                } else {
                    cursor = tab.nextSibling;
                }
            }
        }

        // Remove tabs no longer present
        existingByPath.forEach((tab, path) => {
            if (!wantedPaths.has(path)) {
                tab.remove();
            }
        });

        if (openFiles.size === 0) {
            editor.setContent('', 'txt');
            this._scheduleRender();
        }
    }

    createTab(path, data) {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'tab';
        tab.dataset.path = path;

        if (appState.get('activeTab') === path) {
            tab.classList.add('active');
        }

        if (data.dirty) {
            tab.classList.add('dirty');
        }

        const nameSpan = document.createElement('span');
        nameSpan.className = 'tab-name';
        nameSpan.textContent = data.file.name;

        const closeBtn = document.createElement('span');
        closeBtn.className = 'tab-close';
        closeBtn.dataset.path = path;
        closeBtn.setAttribute('aria-label', 'Close tab');
        closeBtn.textContent = 'x';

        tab.append(nameSpan, closeBtn);

        tab.addEventListener('click', () => this.switchTab(path));
        closeBtn.addEventListener('click', event => {
            event.stopPropagation();
            this.closeTab(path).catch(error => {
                logger.err(`Failed to close ${data.file.name}`, {
                    details: error?.message || String(error)
                });
            });
        });

        return tab;
    }

    async switchTab(path) {
        const data = appState.getOpenFile(path);
        if (!data) {
            return;
        }

        const currentFile = appState.get('currentFile');
        if (currentFile && currentFile.path !== path) {
            const currentData = appState.getOpenFile(currentFile.path);
            if (currentData) {
                appState.setOpenFile(currentFile.path, {
                    content: editor.getContent(),
                    viewState: editor.editor?.getScrollInfo() || currentData.viewState
                });
            }
        }

        appState.set('currentFile', data.file);
        appState.set('activeTab', path);
        editor.setContent(data.content, data.file.extension || 'c');

        if (data.viewState) {
            editor.editor?.scrollTo(data.viewState.left, data.viewState.top);
        }

        this.expandForCurrentFile(path);
        this.updateTabs();
        this._updateActiveTreeRow(path);
    }

    async closeTab(path) {
        const data = appState.getOpenFile(path);
        if (!data) {
            return;
        }

        if (data.dirty) {
            const shouldSave = await confirmDialog({
                title: `Save ${data.file.name}?`,
                message: 'This tab has unsaved changes.',
                confirmText: 'Save and close'
            });

            if (shouldSave) {
                await editor.saveFile(path, { silentToast: true, source: 'close-tab save' });
            }
        }

        appState.deleteOpenFile(path);

        const openFiles = appState.get('openFiles');
        if (openFiles.size === 0) {
            appState.set('currentFile', null);
            appState.set('activeTab', null);
        } else if (appState.get('activeTab') === path) {
            const firstPath = openFiles.keys().next().value;
            await this.switchTab(firstPath);
        }

        this.updateTabs();
    }

    async closeTabsMatching(pathPrefix) {
        const targetPrefix = normalizePath(pathPrefix);
        const openPaths = [...appState.get('openFiles').keys()];

        for (const path of openPaths) {
            if (normalizePath(path).startsWith(targetPrefix)) {
                appState.deleteOpenFile(path);
            }
        }

        const activePath = appState.get('activeTab');
        if (activePath && normalizePath(activePath).startsWith(targetPrefix)) {
            const nextPath = appState.get('openFiles').keys().next().value || null;
            if (nextPath) {
                await this.switchTab(nextPath);
            } else {
                appState.set('currentFile', null);
                appState.set('activeTab', null);
            }
        }
    }

    async refresh() {
        if (!this.projectPath) {
            return;
        }

        await this.loadProject(this.projectPath, { preserveExpanded: true });
        logger.info('File tree refreshed.');
    }

    getAllNodes() {
        return flattenTree(this.tree);
    }

    getHeaderSuggestions() {
        return this.getAllNodes()
            .filter(node => !node.is_directory)
            .filter(node => ['h', 'hpp', 'hh', 'hxx'].includes((node.extension || '').toLowerCase()))
            .map(node => getRelativePath(this.projectPath, node.path).replace(/\\/g, '/'))
            .sort((a, b) => a.localeCompare(b));
    }

    closeContextMenu() {
        if (this._activeMenu) {
            this._activeMenu.remove();
            this._activeMenu = null;
        }
        if (this._activeMenuCleanup) {
            this._activeMenuCleanup();
            this._activeMenuCleanup = null;
        }
    }

    showContextMenu(x, y, node) {
        this.closeContextMenu();

        const menu = document.createElement('div');
        menu.className = 'context-menu';
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;

        const items = [
            { label: 'Rename', action: () => this.renameNode(node) },
            { label: 'Delete', action: () => this.deleteNode(node) }
        ];

        if (node.is_directory) {
            items.unshift(
                { label: 'New File', action: () => this.createFileInFolder(node) },
                { label: 'New Folder', action: () => this.createFolderInFolder(node) }
            );
        }

        items.forEach(item => {
            const entry = document.createElement('button');
            entry.type = 'button';
            entry.className = 'context-menu-item';
            entry.textContent = item.label;
            entry.addEventListener('click', async () => {
                this.closeContextMenu();
                try {
                    await item.action();
                } catch (error) {
                    logger.err(`Context action failed: ${item.label}`, {
                        details: error?.message || String(error)
                    });
                }
            });
            menu.appendChild(entry);
        });

        document.body.appendChild(menu);
        this._activeMenu = menu;

        // Defer until after the current click event so the same click does not close it.
        const onDocClick = () => this.closeContextMenu();
        const onKey = event => {
            if (event.key === 'Escape') this.closeContextMenu();
        };
        const timer = setTimeout(() => {
            document.addEventListener('click', onDocClick);
            document.addEventListener('contextmenu', onDocClick);
            document.addEventListener('keydown', onKey);
        }, 0);

        this._activeMenuCleanup = () => {
            clearTimeout(timer);
            document.removeEventListener('click', onDocClick);
            document.removeEventListener('contextmenu', onDocClick);
            document.removeEventListener('keydown', onKey);
        };
    }

    async renameNode(node) {
        const newName = await promptDialog({
            title: `Rename ${node.name}`,
            message: 'Choose a new name.',
            label: 'Name',
            placeholder: node.name,
            initialValue: node.name,
            confirmText: 'Rename',
            validate: value => {
                if (value === node.name) {
                    return 'Enter a different name.';
                }
                return validateEntityName(value);
            }
        });

        if (!newName) {
            return;
        }

        try {
            const parentPath = node.path.replace(/[\\/][^\\/]+$/, '');
            const newPath = `${parentPath}${parentPath ? '\\' : ''}${newName}`;
            const oldPath = node.path;

            await api.renameFile(node.path, newName);
            await this.refresh();
            document.dispatchEvent(new CustomEvent('cat-editor:workspace-mutated'));

            if (node.is_directory) {
                await this.closeTabsMatching(oldPath);
            } else if (appState.getOpenFile(oldPath)) {
                const previous = appState.getOpenFile(oldPath);
                appState.deleteOpenFile(oldPath);
                if (previous) {
                    appState.setOpenFile(newPath, {
                        ...previous,
                        file: {
                            ...previous.file,
                            name: newName,
                            path: newPath,
                            extension: getFileExtension(newPath) || null
                        }
                    });
                    await this.openFilePath(newPath);
                }
            }

            logger.sys(`Renamed ${node.name} to ${newName}`);
            showToast(`Renamed to ${newName}`, 'success');
        } catch (error) {
            logger.err(`Rename failed for ${node.name}`, {
                details: error?.message || String(error)
            });
            showToast(`Rename failed: ${error.message}`, 'error');
        }
    }

    async deleteNode(node) {
        const confirmed = await confirmDialog({
            title: `Delete ${node.name}?`,
            message: 'The item will be moved to the recycle bin.',
            confirmText: 'Move to trash',
            tone: 'danger'
        });

        if (!confirmed) {
            return;
        }

        try {
            await api.deleteFile(node.path);
            await this.closeTabsMatching(node.is_directory ? `${node.path}/`.replace(/\//g, '\\') : node.path);
            await this.refresh();
            document.dispatchEvent(new CustomEvent('cat-editor:workspace-mutated'));
            logger.sys(`Moved ${node.name} to trash`);
            showToast(`${node.name} moved to trash`, 'success');
        } catch (error) {
            logger.err(`Delete failed for ${node.name}`, {
                details: error?.message || String(error)
            });
            showToast(`Delete failed: ${error.message}`, 'error');
        }
    }

    async createFileInFolder(folder) {
        const name = await promptDialog({
            title: `New file in ${folder.name}`,
            message: 'Create a file inside this folder.',
            label: 'File name',
            placeholder: 'main.c',
            confirmText: 'Create file',
            validate: validateEntityName
        });

        if (!name) {
            return;
        }

        try {
            const file = await api.createFile(folder.path, name);
            await this.refresh();
            await this.openFilePath(file.path);
            document.dispatchEvent(new CustomEvent('cat-editor:workspace-mutated'));
            logger.sys(`Created ${name}`, {
                context: folder.name
            });
            showToast(`${name} created`, 'success');
        } catch (error) {
            logger.err(`Create failed for ${name}`, {
                details: error?.message || String(error)
            });
            showToast(`Create failed: ${error.message}`, 'error');
        }
    }

    async createFolderInFolder(folder) {
        const name = await promptDialog({
            title: `New folder in ${folder.name}`,
            message: 'Create a folder inside this workspace.',
            label: 'Folder name',
            placeholder: 'include',
            confirmText: 'Create folder',
            validate: validateEntityName
        });

        if (!name) {
            return;
        }

        try {
            await api.createFolder(folder.path, name);
            this.expanded.add(folder.path);
            await this.refresh();
            document.dispatchEvent(new CustomEvent('cat-editor:workspace-mutated'));
            logger.sys(`Created folder ${name}`, {
                context: folder.name
            });
            showToast(`${name} created`, 'success');
        } catch (error) {
            logger.err(`Create failed for ${name}`, {
                details: error?.message || String(error)
            });
            showToast(`Create failed: ${error.message}`, 'error');
        }
    }
}

export const fileTree = new FileTree('file-tree');
