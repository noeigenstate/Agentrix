import type { FileEntry } from '../../shared/types';

// Entries the explorer quiets. Caches, tool state and temp files are dimmed and can be hidden; lock files are generated
// but read now and then, so they are only dimmed. `target` and `.vscode` stay normal: one is any folder's name, the other holds settings people edit.
const cacheDirectory = /^(node_modules|dist|build|out|release|coverage|\.test-output|\.venv|venv|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox|\.cache|\.model-downloads|\.next|\.nuxt|\.turbo|\.parcel-cache|\.gradle|\.idea)$/i;
const tempFile = /^(\.DS_Store|Thumbs\.db|desktop\.ini)$|\.(log|tmp|pyc)$/i;
const lockFile = /^(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock)$/i;

export const isCache = (entry: FileEntry) => (entry.kind === 'directory' ? cacheDirectory : tempFile).test(entry.name);
export const isQuiet = (entry: FileEntry) => isCache(entry) || lockFile.test(entry.name);
