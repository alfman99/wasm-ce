import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Append-only audit trail. Every mutation the agent performs lands here, whether or not
 * it succeeded, so the human has a record of what touched their page.
 */

export type AuditKind =
  | 'attach'
  | 'detach'
  | 'write'
  | 'freeze'
  | 'hook'
  | 'scan'
  | 'trace'
  | 'patch'
  | 'speed'
  | 'approval'
  /** Emitted by the extension for watch add/remove. */
  | 'watch'
  /** A tab reloaded on purpose, so the next instantiation picks up hooks or patches. */
  | 'reload'
  /** Named addresses added, removed or cleared. */
  | 'bookmark';

export interface AuditEntry {
  kind: AuditKind;
  tabId?: number;
  summary: string;
  detail?: unknown;
  ok: boolean;
}

/** A line as it was appended: the entry plus the timestamp `record` stamped on it. */
export type AuditLine = { at: string } & AuditEntry;

/**
 * Live listeners. The DevTools panel cannot read `audit.jsonl` (a browser has no filesystem),
 * so the server mirrors every written line over the bridge; keeping the listener list here
 * means the file stays the only producer and there is nothing to keep in sync.
 */
const listeners = new Set<(line: AuditLine) => void>();

export function onRecord(handler: (line: AuditLine) => void): void {
  listeners.add(handler);
}

export function auditDir(): string {
  return process.env.WASMCHEAT_HOME ?? join(homedir(), '.wasmcheat');
}

export function auditPath(): string {
  return join(auditDir(), 'audit.jsonl');
}

export async function record(entry: AuditEntry): Promise<void> {
  const payload: AuditLine = { at: new Date().toISOString(), ...entry };
  const line = JSON.stringify(payload) + '\n';
  try {
    await mkdir(auditDir(), { recursive: true });
    await appendFile(auditPath(), line, 'utf8');
  } catch (error) {
    // Auditing must never break the tool call it is observing; surface it on stderr only.
    process.stderr.write(`[wasmcheat] audit write failed: ${(error as Error).message}\n`);
    return;
  }
  for (const handler of listeners) {
    try {
      handler(payload);
    } catch {
      // A throwing listener must not lose a line that is already on disk.
    }
  }
}

export async function tail(limit = 50): Promise<string[]> {
  try {
    const text = await readFile(auditPath(), 'utf8');
    const lines = text.split('\n').filter((line) => line.trim().length > 0);
    return lines.slice(-Math.max(1, Math.min(limit, 1000)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
