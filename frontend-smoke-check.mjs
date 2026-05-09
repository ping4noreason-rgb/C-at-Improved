import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const requiredFiles = [
  'dist/index.html',
  'dist/js/app.js',
  'dist/js/appRenderers.js',
  'dist/js/editor.js',
  'dist/js/tauri.js'
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

for (const rel of requiredFiles) {
  const full = path.join(root, rel);
  assert(fs.existsSync(full), `Missing required frontend file: ${rel}`);
  const stat = fs.statSync(full);
  assert(stat.isFile() && stat.size > 0, `Frontend file is empty: ${rel}`);
}

const appJs = fs.readFileSync(path.join(root, 'dist/js/app.js'), 'utf8');
assert(
  appJs.includes('resolveGitEntryPath'),
  'Git file open path resolver is missing from app.js'
);

const renderersJs = fs.readFileSync(path.join(root, 'dist/js/appRenderers.js'), 'utf8');
assert(
  renderersJs.includes('resolveGitEntryPath'),
  'Git file open path resolver is missing from appRenderers.js'
);

console.log('Frontend smoke-check passed.');
