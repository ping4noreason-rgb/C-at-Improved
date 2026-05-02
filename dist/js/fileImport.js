import { api } from './tauri.js';
import { appState } from './state.js';
import { logger } from './logger.js';
import { showToast } from './ui.js';
import { fileTree } from './fileTree.js';
import { MAX_OPEN_FILE_BYTES } from './editor.js';
import { promptDialog } from './ui.js';
import { validateEntityName } from './utils.js';

const TEXT_EXTENSIONS = new Set([
    'c', 'h', 'cpp', 'cxx', 'cc', 'hpp', 'hh', 'hxx', 'inl',
    'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'jsonc', 'json5',
    'html', 'htm', 'css', 'scss', 'sass', 'less',
    'md', 'markdown', 'rst', 'txt', 'log', 'rtf',
    'py', 'pyw', 'rb', 'go', 'rs', 'java', 'kt', 'swift',
    'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd',
    'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env',
    'xml', 'svg', 'sql', 'gradle', 'cmake', 'mk',
    'gitignore', 'gitattributes', 'editorconfig',
    'lua', 'php', 'pl', 'pm', 'tcl', 'r'
]);

const SKIP_DIRS = new Set([
    'node_modules', '.git', '.svn', '.hg', '.idea', '.vscode',
    '__pycache__', '.next', '.nuxt', 'dist', 'build', 'target',
    '.cat-editor', '.DS_Store'
]);

function getExt(name) {
    const idx = name.lastIndexOf('.');
    return idx === -1 ? '' : name.slice(idx + 1).toLowerCase();
}

function isLikelyText(file) {
    if (!file) return false;
    const ext = getExt(file.name || '');
    if (TEXT_EXTENSIONS.has(ext)) return true;
    if (file.type && file.type.startsWith('text/')) return true;
    if (file.type && /(json|xml|javascript|typescript|yaml|toml)/i.test(file.type)) return true;
    // Files without extension and small size — try to import as text.
    if (!ext && file.size <= 1024 * 1024) return true;
    return false;
}

function joinPath(parent, name) {
    const cleanParent = String(parent || '').replace(/[\\/]+$/, '');
    const cleanName = String(name || '').replace(/^[\\/]+/, '');
    if (!cleanParent) return cleanName;
    return `${cleanParent}/${cleanName}`;
}

function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result || '');
        reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
        reader.readAsText(file);
    });
}

async function ensureFolder(parentPath, name) {
    try {
        return await api.createFolder(parentPath, name);
    } catch (error) {
        // If it already exists this is fine — many backends throw "already exists".
        const message = (error?.message || '').toLowerCase();
        if (message.includes('exist') || message.includes('already')) {
            return { name, path: joinPath(parentPath, name), is_directory: true };
        }
        throw error;
    }
}

async function ensureNestedFolder(rootPath, relativeDir) {
    const parts = String(relativeDir || '').split(/[\\/]+/).filter(Boolean);
    let cursor = rootPath;
    for (const part of parts) {
        if (SKIP_DIRS.has(part)) {
            // Caller decides whether to skip, but defensively guard here too.
            throw new Error(`Skipped directory: ${part}`);
        }
        await ensureFolder(cursor, part);
        cursor = joinPath(cursor, part);
    }
    return cursor;
}

/**
 * Imports a flat list of files (e.g. from <input multiple>) into the given
 * project, preserving any folder structure encoded in `webkitRelativePath`.
 */
async function importFileList(rootPath, files, options = {}) {
    const total = files.length;
    let imported = 0;
    let skipped = 0;
    const errors = [];
    const skipBig = options.skipBig !== false;

    for (let i = 0; i < files.length; i += 1) {
        const file = files[i];
        const relPath = file.webkitRelativePath || file.name;
        const normalized = String(relPath).replace(/\\/g, '/');
        const parts = normalized.split('/').filter(Boolean);

        if (parts.some(part => SKIP_DIRS.has(part))) {
            skipped += 1;
            continue;
        }

        const fileName = parts.pop();
        const dirParts = parts;

        if (file.size > MAX_OPEN_FILE_BYTES) {
            skipped += 1;
            errors.push(`${normalized} (${file.size} B exceeds 1 GB limit)`);
            continue;
        }

        if (!isLikelyText(file)) {
            if (skipBig && file.size > 4 * 1024 * 1024) {
                skipped += 1;
                continue;
            }
            // Try anyway for unknown extensions, but cap at 4 MB.
            if (file.size > 4 * 1024 * 1024) {
                skipped += 1;
                continue;
            }
        }

        try {
            let parentPath = rootPath;
            if (dirParts.length > 0) {
                parentPath = await ensureNestedFolder(rootPath, dirParts.join('/'));
            }
            await api.createFile(parentPath, fileName).catch(error => {
                const msg = (error?.message || '').toLowerCase();
                if (!(msg.includes('exist') || msg.includes('already'))) throw error;
            });
            const fullPath = joinPath(parentPath, fileName);
            const content = await readFileAsText(file);
            await api.saveFile(fullPath, content);
            imported += 1;

            if (options.onProgress) {
                options.onProgress(imported + skipped, total);
            }
        } catch (error) {
            errors.push(`${normalized}: ${error?.message || error}`);
        }

        // Yield to the event loop every 10 files so the UI stays responsive.
        if ((i & 0x0f) === 0x0f) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    return { imported, skipped, errors, total };
}

async function gatherEntries(items) {
    const out = [];

    async function readDirectory(reader, parentRel) {
        return new Promise((resolve, reject) => {
            reader.readEntries(entries => {
                Promise.all(entries.map(entry => walk(entry, parentRel)))
                    .then(() => resolve())
                    .catch(reject);
            }, reject);
        });
    }

    async function walk(entry, parentRel) {
        if (!entry) return;
        if (SKIP_DIRS.has(entry.name)) return;

        const relPath = parentRel ? `${parentRel}/${entry.name}` : entry.name;
        if (entry.isFile) {
            await new Promise((resolve, reject) => {
                entry.file(file => {
                    // Force webkitRelativePath shape for downstream code.
                    try {
                        Object.defineProperty(file, 'webkitRelativePath', {
                            value: relPath,
                            configurable: true
                        });
                    } catch (_e) { /* ignore */ }
                    out.push(file);
                    resolve();
                }, reject);
            });
        } else if (entry.isDirectory) {
            const reader = entry.createReader();
            // readEntries can return in batches — keep reading until empty.
            // eslint-disable-next-line no-constant-condition
            while (true) {
                const before = out.length;
                await readDirectory(reader, relPath);
                if (out.length === before) break;
            }
        }
    }

    for (const item of items) {
        const entry = typeof item.webkitGetAsEntry === 'function'
            ? item.webkitGetAsEntry()
            : null;
        if (entry) {
            await walk(entry, '');
        } else if (item.kind === 'file') {
            const file = item.getAsFile?.();
            if (file) out.push(file);
        }
    }

    return out;
}

async function ensureProjectForImport(folderName) {
    const existing = appState.get('currentProject');
    if (existing?.path) return existing;

    const proposedName = folderName || 'imported';
    const name = await promptDialog({
        title: 'Create project for import',
        message: 'Imported files will be placed inside this new project.',
        label: 'Project name',
        placeholder: proposedName,
        initialValue: proposedName,
        confirmText: 'Create & import',
        validate: validateEntityName
    });

    if (!name) return null;

    const project = await api.createProject(name);
    if (!project) throw new Error('Failed to create project');
    return project;
}

export async function importFilesIntoProject(files) {
    if (!files || files.length === 0) return;

    let project = appState.get('currentProject');
    if (!project?.path) {
        project = await ensureProjectForImport('imported');
        if (!project) return;
    }

    showToast(`Importing ${files.length} file(s)...`, 'info');
    logger.sys(`Import started: ${files.length} file(s) into ${project.name}`);

    const result = await importFileList(project.path, Array.from(files));
    await fileTree.refresh();
    document.dispatchEvent(new CustomEvent('cat-editor:workspace-mutated'));

    const tone = result.errors.length === 0 ? 'success' : 'error';
    const summary = `Imported ${result.imported}/${result.total}; skipped ${result.skipped}`;
    if (result.errors.length > 0) {
        logger.err(summary, { details: result.errors.slice(0, 50).join('\n') });
    } else {
        logger.info(summary);
    }
    showToast(summary, tone);
}

export async function importFolderIntoProject(files) {
    if (!files || files.length === 0) return;
    // The first file's webkitRelativePath starts with "<root-folder>/...".
    const firstRel = files[0].webkitRelativePath || files[0].name || '';
    const folderName = firstRel.split('/')[0] || 'imported';

    let project = appState.get('currentProject');
    if (!project?.path) {
        project = await ensureProjectForImport(folderName);
        if (!project) return;
    }

    showToast(`Importing folder "${folderName}"...`, 'info');
    logger.sys(`Folder import started: ${files.length} entries`);

    const result = await importFileList(project.path, Array.from(files));
    await fileTree.refresh();
    document.dispatchEvent(new CustomEvent('cat-editor:workspace-mutated'));

    const tone = result.errors.length === 0 ? 'success' : 'error';
    const summary = `Imported ${result.imported}/${result.total} from "${folderName}"; skipped ${result.skipped}`;
    if (result.errors.length > 0) {
        logger.err(summary, { details: result.errors.slice(0, 50).join('\n') });
    } else {
        logger.info(summary);
    }
    showToast(summary, tone);
}

export async function importFromDataTransfer(dataTransfer) {
    if (!dataTransfer) return;
    const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];
    let files;
    if (items.length > 0 && typeof items[0].webkitGetAsEntry === 'function') {
        files = await gatherEntries(items);
    } else {
        files = Array.from(dataTransfer.files || []);
    }

    if (files.length === 0) return;
    const hasFolders = files.some(f => (f.webkitRelativePath || '').includes('/'));

    if (hasFolders) {
        await importFolderIntoProject(files);
    } else {
        await importFilesIntoProject(files);
    }
}

/**
 * Wires the hidden file inputs and toolbar buttons added in index.html.
 * Call this once during app init.
 */
export function installImportControls() {
    const fileInput = document.getElementById('import-files-input');
    const folderInput = document.getElementById('import-folder-input');
    const importFilesBtn = document.getElementById('import-files-btn');
    const importFolderBtn = document.getElementById('import-folder-btn');

    if (fileInput) {
        fileInput.addEventListener('change', async () => {
            const files = Array.from(fileInput.files || []);
            fileInput.value = '';
            try {
                await importFilesIntoProject(files);
            } catch (error) {
                logger.err('File import failed.', {
                    details: error?.message || String(error)
                });
                showToast(error?.message || 'Import failed', 'error');
            }
        });
    }

    if (folderInput) {
        folderInput.addEventListener('change', async () => {
            const files = Array.from(folderInput.files || []);
            folderInput.value = '';
            try {
                await importFolderIntoProject(files);
            } catch (error) {
                logger.err('Folder import failed.', {
                    details: error?.message || String(error)
                });
                showToast(error?.message || 'Import failed', 'error');
            }
        });
    }

    if (importFilesBtn && fileInput) {
        importFilesBtn.addEventListener('click', () => fileInput.click());
    }

    if (importFolderBtn && folderInput) {
        importFolderBtn.addEventListener('click', () => folderInput.click());
    }

    // Drag & drop on the file tree area.
    const dropZone = document.getElementById('file-tree');
    if (dropZone) {
        const onDragOver = event => {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            dropZone.classList.add('is-drop-target');
        };
        const onDragLeave = () => dropZone.classList.remove('is-drop-target');
        const onDrop = async event => {
            event.preventDefault();
            dropZone.classList.remove('is-drop-target');
            try {
                await importFromDataTransfer(event.dataTransfer);
            } catch (error) {
                logger.err('Drop import failed.', {
                    details: error?.message || String(error)
                });
                showToast(error?.message || 'Drop import failed', 'error');
            }
        };
        dropZone.addEventListener('dragover', onDragOver);
        dropZone.addEventListener('dragleave', onDragLeave);
        dropZone.addEventListener('drop', onDrop);
    }
}
