import { DurableObject } from 'cloudflare:workers';
import { observeContainer } from './container-observer.ts';
import type { SnapshotFile } from './artifacts.ts';

export class RepositoryCheckContainer extends DurableObject<Env> {
  private execution: Promise<Awaited<ReturnType<typeof observeContainer>>> | null = null;
  protected verificationImage(): string { return this.ctx.container!.images.verifier; }
  async stop(): Promise<void> {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS attempt (id INTEGER PRIMARY KEY CHECK(id=1))');
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO attempt VALUES (1)');
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS cancellation (id INTEGER PRIMARY KEY CHECK(id=1))');
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO cancellation VALUES (1)');
    await this.ctx.container?.destroy();
    await this.execution?.catch(() => {});
    await this.ctx.container?.destroy();
    await this.ctx.storage.deleteAlarm();
  }
  async observe(files: SnapshotFile[], argv: string[], input: string, timeoutMs: number) {
    const container = this.ctx.container;
    if (!container) throw new Error('Repository verification container is not configured.');
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS attempt (id INTEGER PRIMARY KEY CHECK(id=1))');
    if (this.ctx.storage.sql.exec('SELECT id FROM attempt').toArray().length) throw new Error('This check attempt was already used. Request a new verification attempt.');
    this.ctx.storage.sql.exec('INSERT INTO attempt VALUES (1)');
    const execution = (async () => {
      // An alarm also reaps an instance if this Durable Object is interrupted.
      await this.ctx.storage.setAlarm(Date.now() + Math.min(timeoutMs, 60000) + 5000);
      this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS cancellation (id INTEGER PRIMARY KEY CHECK(id=1))');
      try {
        if (this.ctx.storage.sql.exec('SELECT id FROM cancellation').toArray().length) throw new Error('This verification attempt was cancelled.');
        return await observeContainer(container, this.verificationImage(), files, argv, input, timeoutMs);
      } finally { await container.destroy(); await this.ctx.storage.deleteAlarm(); }
    })();
    this.execution = execution;
    try { return await execution; }
    finally { if (this.execution === execution) this.execution = null; }
  }
  async alarm() { await this.ctx.container?.destroy(); }
}
