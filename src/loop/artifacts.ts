import { readdirSync, readFileSync, mkdirSync, writeFileSync, unlinkSync, lstatSync, existsSync, renameSync, mkdtempSync, rmdirSync } from 'node:fs';
import { join, dirname, resolve, relative, sep, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { pathAllowed } from './runtime.js';

const SKIP = new Set(['.git', '.wan', 'node_modules']);
export function inventory(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function visit(folder: string) {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP.has(entry.name)) continue;
      const full = join(folder, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Artifact symlinks require explicit handling: ${full}`);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) result[relative(root, full).split(sep).join('/')] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  }
  visit(root);
  return result;
}

export function ownsPath(path: string, ownership: string[]): boolean {
  if (!path || path.startsWith('/') || path.split('/').includes('..') || path.includes('\\')) return false;
  return pathAllowed(path, ownership);
}

function safeDestination(root: string, path: string): string {
  if (!ownsPath(path, ['**'])) throw new Error(`Unsafe artifact path: ${path}`);
  const dest = resolve(root, path);
  let parent = dirname(dest);
  while (parent !== resolve(root)) {
    try { if (lstatSync(parent).isSymbolicLink()) throw new Error(`Symlink destination: ${parent}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const next = dirname(parent);
    if (next === parent) throw new Error('Artifact path escaped workspace.');
    parent = next;
  }
  try { if (lstatSync(dest).isSymbolicLink()) throw new Error(`Symlink destination: ${dest}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return dest;
}

export function copyArtifacts(source: string, target: string): Record<string, string> {
  const files = inventory(source);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const path of Object.keys(files)) {
    const destination = safeDestination(target, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, readFileSync(join(source, path)), { mode: lstatSync(join(source, path)).mode & 0o777 });
  }
  return files;
}

export function integrateArtifacts(source: string, target: string, base: Record<string, string>, ownership: string[]): string[] {
  recoverArtifactTransaction(target);
  const next = inventory(source), current = inventory(target);
  const changed = [...new Set([...Object.keys(base), ...Object.keys(next)])].filter(path => base[path] !== next[path]);
  // Check every path and conflict before writing any file.
  for (const path of changed) {
    if (!ownsPath(path, ownership)) throw new Error(`Assignment changed unowned artifact: ${path}`);
    if (current[path] !== base[path] && current[path] !== next[path]) throw new Error(`Artifact integration conflict: ${path}`);
    safeDestination(target, path);
  }
  const stage = mkdtempSync(join(dirname(target), `.${basename(target)}-stage-`));
  copyArtifacts(target, stage);
  for (const path of changed.filter(path => !(path in next)).sort((a, b) => b.length - a.length)) {
    if (!existsSync(join(stage, path))) continue;
    unlinkSync(join(stage, path));
    let parent = dirname(join(stage, path));
    while (parent !== stage && readdirSync(parent).length === 0) { rmdirSync(parent); parent = dirname(parent); }
  }
  for (const path of changed.filter(path => path in next)) {
    const destination = safeDestination(stage, path);
    if (existsSync(destination) && lstatSync(destination).isDirectory()) {
      if (readdirSync(destination).length) throw new Error(`Artifact transition would discard unowned children: ${path}`);
      rmdirSync(destination);
    }
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, readFileSync(join(source, path)), { mode: lstatSync(join(source, path)).mode & 0o777 });
  }
  const backup = `${stage}-previous`;
  const journal = join(dirname(target), `.${basename(target)}.transaction.json`);
  writeFileSync(journal, JSON.stringify({ target, stage, backup }), { flag: 'wx', mode: 0o600 });
  renameSync(target, backup);
  renameSync(stage, target);
  unlinkSync(journal);
  return changed;
}

/** Finish the recorded directory swap after a crash; preserve the prior snapshot. */
export function recoverArtifactTransaction(target: string): void {
  const journal = join(dirname(target), `.${basename(target)}.transaction.json`);
  if (!existsSync(journal)) return;
  const transaction = JSON.parse(readFileSync(journal, 'utf8'));
  if (transaction.target !== target || dirname(transaction.stage) !== dirname(target) || transaction.backup !== `${transaction.stage}-previous`) throw new Error('Invalid artifact transaction; manual inspection required.');
  if (!existsSync(target)) {
    if (existsSync(transaction.stage)) renameSync(transaction.stage, target);
    else if (existsSync(transaction.backup)) renameSync(transaction.backup, target);
    else throw new Error('Artifact transaction lost its source snapshots.');
  }
  unlinkSync(journal);
}
