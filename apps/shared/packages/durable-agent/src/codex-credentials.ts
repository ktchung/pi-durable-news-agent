// Dedicated credential store for this app. SQLite serializes rotating OAuth
// refreshes across API/login processes without inheriting Hermes credentials.
import { constants, closeSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";

export class CodexCredentials implements CredentialStore {
  private readonly db: DatabaseSync;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(file: string) {
    const path = resolve(file);
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const directory = lstatSync(dir);
    if (realpathSync(dir) !== dir || !directory.isDirectory() || directory.mode & 0o077)
      throw new Error("Codex auth directory must be private and not symlinked");
    const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    closeSync(fd);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.mode & 0o077)
      throw new Error("Codex auth store must be a private regular file");
    this.db = new DatabaseSync(path, { timeout: 0 });
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS credentials (provider TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
  }

  async read(id: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const row = this.db.prepare("SELECT value FROM credentials WHERE provider=?").get(id) as
      | { value: string }
      | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    return (
      this.db.prepare("SELECT provider, value FROM credentials").all() as {
        provider: string;
        value: string;
      }[]
    ).map((row) => ({
      providerId: row.provider,
      type: (JSON.parse(row.value) as Credential).type,
    }));
  }

  private async transaction<T>(fn: () => Promise<T>, options?: AuthOperationOptions): Promise<T> {
    const run = async () => {
      const signal = AbortSignal.any([
        AbortSignal.timeout(45000),
        ...(options?.signal ? [options.signal] : []),
      ]);
      while (true) {
        signal.throwIfAborted();
        try {
          this.db.exec("BEGIN IMMEDIATE");
          break;
        } catch (error) {
          if (!(error instanceof Error) || !/locked|busy/i.test(error.message)) throw error;
          await delay(50, undefined, { signal });
        }
      }
      try {
        const result = await fn();
        // Persist a successful token rotation even if cancellation arrived while
        // the provider was returning it; rolling it back would lose the grant.
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  modify(
    id: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ) {
    return this.transaction(async () => {
      const current = await this.read(id, options);
      const next = await fn(current);
      if (next !== undefined)
        this.db
          .prepare(
            "INSERT INTO credentials(provider,value) VALUES(?,?) ON CONFLICT(provider) DO UPDATE SET value=excluded.value",
          )
          .run(id, JSON.stringify(next));
      return next ?? current;
    }, options);
  }

  delete(id: string, options?: AuthOperationOptions): Promise<void> {
    return this.transaction(async () => {
      this.db.prepare("DELETE FROM credentials WHERE provider=?").run(id);
    }, options);
  }

  close() {
    this.db.close();
  }
}
