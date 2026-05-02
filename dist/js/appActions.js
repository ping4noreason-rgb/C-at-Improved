import { escapeHtml, validateEntityName, validatePackageName } from './utils.js';

export function createAppActions(context) {
    const {
        api,
        appState,
        editor,
        fileTree,
        logger,
        powerShellTerminal,
        promptDialog,
        formDialog,
        showToast,
        markActiveProject
    } = context;

    return {
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

                if (runtimeStatus?.cmake_available || runtimeStatus?.make_available) {
                    logger.info('Project build tools detected.', {
                        context: [runtimeStatus.cmake_label, runtimeStatus.make_label]
                            .filter(value => value && value !== 'Not available')
                            .join(', ')
                    });
                } else {
                    logger.info('No CMake or Make toolchain detected for project builds.');
                }

                if (runtimeStatus?.formatter_available) {
                    logger.info(`Formatter detected: ${runtimeStatus.formatter_label}`);
                } else {
                    logger.info('No formatter detected. Install clang-format to enable code formatting.');
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
        },

        async loadProjects(openProject) {
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

                if (!projects?.length) {
                    logger.info('No saved projects found. Create one to initialize the workspace list.');
                    container.innerHTML = `
                        <div class="empty-card">
                            <strong>No projects found.</strong>
                            <p>Create the first project and it will stay available across launches.</p>
                            <button id="create-first-project" class="primary-btn" type="button">Create Project</button>
                        </div>
                    `;
                    document.getElementById('create-first-project')?.addEventListener('click', () => {
                        context.createProject(openProject).catch(error => {
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

                    item.addEventListener('click', () => openProject(project));
                    container.appendChild(item);
                });

                markActiveProject(currentProject?.path || '');
            } catch (error) {
                logger.err('Failed to load project list.', {
                    details: error?.message || String(error)
                });
            }
        },

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
        },

        async openProject(project) {
            appState.clearOpenFiles();
            appState.set('currentFile', null);
            appState.set('activeTab', null);
            appState.clearProblems();
            appState.setGitStatus(null);
            appState.setWorkspaceTooling(null);
            appState.set('currentProject', project);

            await fileTree.loadProject(project.path);
            markActiveProject(project.path);
            await powerShellTerminal.setWorkingDirectory(project.path).catch(() => {});
            await context.refreshGitStatus(true);
            await context.refreshWorkspaceTooling(true);

            logger.sys(`Opened workspace ${project.name}`, {
                context: `${project.file_count || 0} files detected`
            });
            showToast(`${project.name} opened`, 'success');
        },

        async createProject(openProject) {
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
                project = await context.ensureProjectScaffold(project || { name });

                await context.loadProjects(openProject);
                await openProject(project);

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
        },

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
                await fileTree.openFilePath(file.path);
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
        },

        async refreshProblems() {
            const currentFile = appState.get('currentFile');
            if (!currentFile) {
                showToast('Open a file before refreshing problems.', 'error');
                return;
            }

            await editor.checkSyntax(editor.getContent(), currentFile.name, {
                reportSuccess: true
            });
        },

        async refreshGitStatus(silent = false) {
            const project = appState.get('currentProject');
            if (!project?.path) {
                appState.setGitStatus(null);
                return;
            }

            try {
                const status = await api.getGitStatus(project.path);
                appState.setGitStatus(status);
            } catch (error) {
                if (!silent) {
                    logger.err('Failed to load Git status.', {
                        details: error?.message || String(error)
                    });
                }
            }
        },

        async refreshWorkspaceTooling(silent = false) {
            const project = appState.get('currentProject');
            if (!project?.path) {
                appState.setWorkspaceTooling(null);
                return;
            }

            try {
                const tooling = await api.getWorkspaceTooling(project.path);
                appState.setWorkspaceTooling(tooling);
            } catch (error) {
                if (!silent) {
                    logger.err('Failed to load workspace tooling.', {
                        details: error?.message || String(error)
                    });
                }
            }
        },

        logCommandResult(title, result) {
            const details = [result.command, result.stdout, result.stderr]
                .filter(Boolean)
                .join('\n\n');

            if (result.success) {
                logger.info(title, { details });
            } else {
                logger.err(title, { details });
            }
        },

        async initGitRepository() {
            const project = appState.get('currentProject');
            if (!project?.path) {
                showToast('Open a workspace before initializing Git.', 'error');
                return;
            }

            const result = await api.initGitRepository(project.path);
            context.logCommandResult('Git init', result);
            await context.refreshGitStatus();
            showToast(result.success ? 'Git repository initialized.' : 'Git init failed.', result.success ? 'success' : 'error');
        },

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
            context.logCommandResult(`Git ${action}`, result);
            await context.refreshGitStatus(true);
            if (action === 'pull') {
                await fileTree.refresh().catch(() => {});
            }
            showToast(result.success ? `Git ${action} completed.` : `Git ${action} failed.`, result.success ? 'success' : 'error');
        },

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
                        placeholder: 'Refactor workspace tree rendering'
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
            context.logCommandResult('Git commit', result);
            await context.refreshGitStatus(true);
            showToast(result.success ? 'Commit created.' : 'Commit failed.', result.success ? 'success' : 'error');
        },

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
            context.logCommandResult(`Install ${values.packageName}`, result);
            showToast(result.success ? `Installed ${values.packageName}.` : `Failed to install ${values.packageName}.`, result.success ? 'success' : 'error');
        },

        async configureProjectBuild(mode = 'debug') {
            const project = appState.get('currentProject');
            const tooling = appState.get('workspaceTooling');

            if (!project?.path || !tooling?.preferred_build_system) {
                showToast('No supported build system detected for this workspace.', 'error');
                return;
            }

            const result = await api.configureProjectBuild(project.path, tooling.preferred_build_system, mode);
            context.logCommandResult('Project configure', result);
            await context.refreshWorkspaceTooling(true);
            showToast(result.success ? 'Project configure completed.' : 'Project configure failed.', result.success ? 'success' : 'error');
        },

        async buildProject(mode = 'debug') {
            const project = appState.get('currentProject');
            const tooling = appState.get('workspaceTooling');

            if (!project?.path || !tooling?.preferred_build_system) {
                showToast('No supported build system detected for this workspace.', 'error');
                return;
            }

            const result = await api.buildProject(project.path, tooling.preferred_build_system, mode);
            context.logCommandResult('Project build', result);
            await context.refreshWorkspaceTooling(true);
            showToast(result.success ? 'Project build completed.' : 'Project build failed.', result.success ? 'success' : 'error');
        }
    };
}
