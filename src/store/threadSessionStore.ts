import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * thread_id → session_id のマッピングを JSON ファイルに永続化するストア。
 *
 * Discord bot では「スレッド = 会話」「opencode セッション = 会話コンテキスト」を
 * 1:1 で対応づける。bot 再起動後も同じスレッドを同じセッションに繋ぎ直せるよう、
 * メモリ上の Map をファイルにも書き出す。
 *
 * 依存ゼロ（Node 標準のみ）。将来 SQLite 等へ差し替える場合も同じインターフェースで置換可能。
 */
export class ThreadSessionStore {
  private readonly filePath: string;
  private readonly map = new Map<string, string>();
  private loaded = false;
  /** 書き込みを直列化して、並行イベントによるファイル競合を防ぐ。 */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath = ".data/thread-sessions.json") {
    this.filePath = filePath;
  }

  /** ファイルから既存マッピングを読み込む。初回アクセス時に一度だけ実行される。 */
  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const obj = JSON.parse(raw) as Record<string, string>;
      for (const [threadId, sessionId] of Object.entries(obj)) {
        this.map.set(threadId, sessionId);
      }
    } catch (err) {
      // ファイル未作成（初回起動）は正常系として扱う。
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    this.loaded = true;
  }

  /** スレッドに対応するセッション ID を返す（無ければ undefined）。 */
  async get(threadId: string): Promise<string | undefined> {
    await this.load();
    return this.map.get(threadId);
  }

  /** 対応づけを保存する。 */
  async set(threadId: string, sessionId: string): Promise<void> {
    await this.load();
    this.map.set(threadId, sessionId);
    await this.persist();
  }

  /** 対応づけを削除する（スレッド削除/アーカイブ時など）。 */
  async delete(threadId: string): Promise<void> {
    await this.load();
    if (this.map.delete(threadId)) {
      await this.persist();
    }
  }

  /**
   * スレッドに対応するセッション ID を返す。未登録なら createSession を呼んで作成・保存する。
   * Discord 側からは基本これだけ呼べばよい。
   */
  async getOrCreate(
    threadId: string,
    createSession: () => Promise<string>,
  ): Promise<string> {
    const existing = await this.get(threadId);
    if (existing) return existing;
    const sessionId = await createSession();
    await this.set(threadId, sessionId);
    return sessionId;
  }

  /** 現在のマッピング一覧（読み取り専用コピー）。 */
  async entries(): Promise<Array<[string, string]>> {
    await this.load();
    return [...this.map.entries()];
  }

  /** Map の内容をアトミックにファイルへ書き出す（tmp に書いて rename）。 */
  private persist(): Promise<void> {
    const snapshot = Object.fromEntries(this.map);
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(snapshot, null, 2), "utf8");
      await rename(tmp, this.filePath);
    });
    return this.writeChain;
  }
}
