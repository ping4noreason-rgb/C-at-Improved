function ensureModalRoot() {
    let root = document.getElementById('modal-root');
    if (!root) {
        root = document.createElement('div');
        root.id = 'modal-root';
        document.body.appendChild(root);
    }
    return root;
}

function closeModal(modal, resolve, value) {
    modal.remove();
    document.body.classList.remove('has-modal');
    resolve(value);
}

function buildModalShell({ title, message, content, confirmText, cancelText, tone = 'default' }) {
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.innerHTML = `
        <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title">
            <div class="modal-header">
                <div>
                    <div class="modal-eyebrow">${tone === 'danger' ? 'Careful' : 'Action'}</div>
                    <h2 id="modal-title">${title}</h2>
                </div>
                <button type="button" class="modal-close" aria-label="Close">x</button>
            </div>
            <p class="modal-message">${message}</p>
            <div class="modal-body"></div>
            <div class="modal-footer">
                <button type="button" class="ghost-btn modal-cancel">${cancelText || 'Cancel'}</button>
                <button type="button" class="primary-btn modal-confirm ${tone === 'danger' ? 'danger-btn' : ''}">${confirmText || 'Confirm'}</button>
            </div>
        </div>
    `;

    modal.querySelector('.modal-body')?.append(content);
    return modal;
}

function attachSharedModalHandlers(modal, resolve, fallbackValue = null) {
    const handleCancel = () => closeModal(modal, resolve, fallbackValue);
    modal.querySelector('.modal-close')?.addEventListener('click', handleCancel);
    modal.querySelector('.modal-cancel')?.addEventListener('click', handleCancel);
    modal.addEventListener('click', event => {
        if (event.target === modal) {
            handleCancel();
        }
    });

    const onKeyDown = event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            handleCancel();
        }
    };

    modal.__cleanupKeydown = onKeyDown;
    document.addEventListener('keydown', onKeyDown);
}

function cleanupSharedModalHandlers(modal) {
    if (modal.__cleanupKeydown) {
        document.removeEventListener('keydown', modal.__cleanupKeydown);
    }
}

export function promptDialog({
    title,
    message,
    label,
    placeholder = '',
    initialValue = '',
    confirmText = 'Confirm',
    validate
}) {
    return new Promise(resolve => {
        const form = document.createElement('div');
        form.className = 'modal-form';
        form.innerHTML = `
            <label class="modal-label" for="modal-input">${label}</label>
            <input id="modal-input" class="modal-input" type="text" autocomplete="off" spellcheck="false" />
            <div class="modal-error" aria-live="polite"></div>
        `;

        const input = form.querySelector('#modal-input');
        const error = form.querySelector('.modal-error');
        input.value = initialValue;
        input.placeholder = placeholder;

        const modal = buildModalShell({
            title,
            message,
            content: form,
            confirmText
        });

        const root = ensureModalRoot();
        document.body.classList.add('has-modal');
        root.appendChild(modal);
        attachSharedModalHandlers(modal, value => {
            cleanupSharedModalHandlers(modal);
            resolve(value);
        });

        const confirmButton = modal.querySelector('.modal-confirm');
        const submit = () => {
            const value = input.value.trim();
            const validationMessage = typeof validate === 'function' ? validate(value) : '';

            if (validationMessage) {
                error.textContent = validationMessage;
                input.focus();
                input.select();
                return;
            }

            cleanupSharedModalHandlers(modal);
            closeModal(modal, resolve, value);
        };

        confirmButton?.addEventListener('click', submit);
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                submit();
            }
        });

        requestAnimationFrame(() => {
            input.focus();
            input.select();
        });
    });
}

export function confirmDialog({
    title,
    message,
    confirmText = 'Confirm',
    cancelText = 'Cancel',
    tone = 'default'
}) {
    return new Promise(resolve => {
        const content = document.createElement('div');
        content.className = 'modal-note';
        content.textContent = tone === 'danger'
            ? 'This action cannot be undone from inside the editor.'
            : 'Please confirm to continue.';

        const modal = buildModalShell({
            title,
            message,
            content,
            confirmText,
            cancelText,
            tone
        });

        const root = ensureModalRoot();
        document.body.classList.add('has-modal');
        root.appendChild(modal);
        attachSharedModalHandlers(modal, value => {
            cleanupSharedModalHandlers(modal);
            resolve(value);
        }, false);

        modal.querySelector('.modal-confirm')?.addEventListener('click', () => {
            cleanupSharedModalHandlers(modal);
            closeModal(modal, resolve, true);
        });

        requestAnimationFrame(() => {
            modal.querySelector('.modal-confirm')?.focus();
        });
    });
}

export function formDialog({
    title,
    message,
    confirmText = 'Confirm',
    fields = [],
    validate
}) {
    return new Promise(resolve => {
        const form = document.createElement('div');
        form.className = 'modal-form';

        const controls = new Map();
        const error = document.createElement('div');
        error.className = 'modal-error';
        error.setAttribute('aria-live', 'polite');

        fields.forEach((field, index) => {
            const row = document.createElement('label');
            row.className = 'modal-form-row';

            const caption = document.createElement('span');
            caption.className = 'modal-label';
            caption.textContent = field.label || field.id;
            row.appendChild(caption);

            let control;
            if (field.type === 'select') {
                control = document.createElement('select');
                control.className = 'modal-input';
                (field.options || []).forEach(option => {
                    const entry = document.createElement('option');
                    entry.value = option.value;
                    entry.textContent = option.label;
                    if (option.value === field.initialValue) {
                        entry.selected = true;
                    }
                    control.appendChild(entry);
                });
            } else if (field.type === 'textarea') {
                control = document.createElement('textarea');
                control.className = 'modal-input modal-textarea';
                control.rows = field.rows || 4;
                control.spellcheck = false;
                control.value = field.initialValue || '';
            } else {
                control = document.createElement('input');
                control.className = 'modal-input';
                control.type = field.type || 'text';
                control.autocomplete = 'off';
                control.spellcheck = false;
                control.value = field.initialValue || '';
                control.placeholder = field.placeholder || '';
            }

            control.id = `modal-field-${field.id || index}`;
            if (field.placeholder && field.type === 'textarea') {
                control.placeholder = field.placeholder;
            }

            row.appendChild(control);
            form.appendChild(row);
            controls.set(field.id, control);
        });

        form.appendChild(error);

        const modal = buildModalShell({
            title,
            message,
            content: form,
            confirmText
        });

        const root = ensureModalRoot();
        document.body.classList.add('has-modal');
        root.appendChild(modal);
        attachSharedModalHandlers(modal, value => {
            cleanupSharedModalHandlers(modal);
            resolve(value);
        });

        const confirmButton = modal.querySelector('.modal-confirm');
        const submit = () => {
            const values = {};
            controls.forEach((control, id) => {
                values[id] = control.value;
            });

            const validationMessage = typeof validate === 'function'
                ? validate(values)
                : '';

            if (validationMessage) {
                error.textContent = validationMessage;
                const firstControl = controls.values().next().value;
                firstControl?.focus();
                return;
            }

            cleanupSharedModalHandlers(modal);
            closeModal(modal, resolve, values);
        };

        confirmButton?.addEventListener('click', submit);
        controls.forEach(control => {
            control.addEventListener('keydown', event => {
                if (event.key === 'Enter' && event.target.tagName !== 'TEXTAREA') {
                    event.preventDefault();
                    submit();
                }
            });
        });

        requestAnimationFrame(() => {
            controls.values().next().value?.focus?.();
        });
    });
}

const ACTIVE_TOASTS = new Set();
const MAX_TOASTS = 3;

function cleanupToast(toast) {
    if (!toast || toast.__cleaned) return;
    toast.__cleaned = true;
    if (toast.__hideTimer) clearTimeout(toast.__hideTimer);
    if (toast.__removeTimer) clearTimeout(toast.__removeTimer);
    toast.__hideTimer = null;
    toast.__removeTimer = null;
    ACTIVE_TOASTS.delete(toast);
    if (toast.parentNode) toast.parentNode.removeChild(toast);
}

export function showToast(message, tone = 'info') {
    while (ACTIVE_TOASTS.size >= MAX_TOASTS) {
        const oldest = ACTIVE_TOASTS.values().next().value;
        if (!oldest) break;
        cleanupToast(oldest);
    }

    const toast = document.createElement('div');
    toast.className = `toast ${tone === 'error' ? 'error' : tone === 'success' ? 'success' : ''}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    ACTIVE_TOASTS.add(toast);

    toast.__hideTimer = null;
    toast.__removeTimer = null;
    toast.__cleaned = false;

    requestAnimationFrame(() => {
        if (!toast.__cleaned) toast.classList.add('visible');
    });

    toast.__hideTimer = setTimeout(() => {
        toast.__hideTimer = null;
        toast.classList.remove('visible');
        toast.__removeTimer = setTimeout(() => {
            toast.__removeTimer = null;
            cleanupToast(toast);
        }, 200);
    }, 2600);
}
