import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Append-only audit trail. Every mutation the agent performs lands here, whether or not
 * it succeeded, so the human has a record of what touched their page.
 */

export type AuditKind = 'attach' | 'detach' | 'write' | 'freeze' | 'hook' | 'scan' | 'approval';

export interface AuditEntry {
  kind: AuditKind;
  tabId?: number;
  summary: string;
  detail?: unknown;
  ok: boolean;
}

export function auditDir(): string {
  return process.env.WASMCHEAT_HOME ?? join(homedir(), '.wasmcheat');
}

export function auditPath(): string {
  return join(auditDir(), 'audit.jsonl');
}

export async function record(entry: AuditEntry): Promise<void> {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n';
  try {
    await mkdir(auditDir(), { recursive: true });
    await appendFile(auditPath(), line, 'utf8');
  } catch (error) {
    // Auditing must never break the tool call it is observing; surface it on stderr only.
    process.stderr.write(`[wasmcheat] audit write failed: ${(error as Error).message}\n`);
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
