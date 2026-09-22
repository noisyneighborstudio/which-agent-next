import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { configPath } from '../index.js';

/** Who a record claims to be. `hostId` is absent on records written before
 *  identities carried one, when a single host was the only mode. */
export interface Identity { pid: number; signature: string; hostId?: string }

let cached: string | undefined;
/** Stable for this machine. Persisted beside the config, never inside a run
 *  directory: a run directory may one day be shared between hosts, this is not. */
export function hostId(): string {
  if (cached) return cached;
  const path = join(dirname(configPath()), 'host-id');
  mkdirSync(dirname(path), { recursive: true });
  try { writeFileSync(path, randomUUID(), { mode: 0o600, flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  // Read back rather than trusting our own write, so racing first-runs agree.
  return cached = readFileSync(path, 'utf8').trim();
}

export function processSignature(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 1) return '';
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2000 }).trim(); }
  catch { return ''; }
}

export function ownsProcess(owner?: Identity): boolean {
  if (!owner?.signature) return false;
  // A record from another machine names a pid in a process table we cannot read,
  // where an unrelated local process may wear the same number. Never authenticate
  // it, and above all never derive kill authority from it.
  if (owner.hostId !== undefined && owner.hostId !== hostId()) return false;
  return processSignature(owner.pid) === owner.signature;
}

/** A lease lasts for the process lifetime, separate from the journal transaction lock. */
export function acquireLease(directory: string, name: string): () => void {
  const path = join(directory, `${name}.lease`);
  const token = randomUUID();
  const owner = { pid: process.pid, signature: processSignature(process.pid), hostId: hostId(), token };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(path, { mode: 0o700 });
      writeFileSync(join(path, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
      return () => {
        try {
          const current = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
          if (current.token === token) rmSync(path, { recursive: true });
        } catch { /* Another owner must never be removed. */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let current: typeof owner;
      try { current = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')); }
      catch { throw new Error(`${name} lease is being initialized or damaged; inspect ${path} before recovery.`); }
      if (ownsProcess(current)) throw new Error(`${name} already owns this run (pid ${current.pid}).`);
      // Rename atomically so a racing recovery cannot delete a newly acquired lease.
      const stale = `${path}.stale-${token}`;
      try { renameSync(path, stale); } catch { continue; }
      rmSync(stale, { recursive: true });
    }
  }
  throw new Error(`Could not acquire ${name} lease.`);
}
