import { AgentService, type AgentServiceOptions } from "./opencode/agent.js";
import { ThreadSessionStore } from "./store/threadSessionStore.js";

export interface ThreadAgentOptions extends AgentServiceOptions {
  /** マッピングの永続化先。未指定なら既定パス。 */
  storeFilePath?: string;
}

/**
 * AgentService（opencode コア層）と ThreadSessionStore（永続マッピング層）を束ね、
 * 「スレッド単位の会話」を提供する。Discord bot からはこのクラスを使うだけでよい。
 *
 *   const ta = new ThreadAgent();
 *   const answer = await ta.ask(threadId, userMessage);
 *
 * 同じ threadId は自動的に同じ opencode セッションへ紐づき、会話が継続する。
 */
export class ThreadAgent {
  private readonly agent: AgentService;
  private readonly store: ThreadSessionStore;

  constructor(options: ThreadAgentOptions = {}) {
    const { storeFilePath, ...agentOptions } = options;
    this.agent = new AgentService(agentOptions);
    this.store = new ThreadSessionStore(storeFilePath);
  }

  /**
   * スレッドにメッセージを送り、応答テキストを返す。
   * 初回は opencode セッションを作成して thread_id に紐づけ、以降は同一セッションを再利用する。
   * @param title 新規セッション作成時のタイトル（任意。一覧での識別用）。
   */
  async ask(threadId: string, text: string, title?: string): Promise<string> {
    const sessionId = await this.store.getOrCreate(threadId, () =>
      this.agent.createSession(title ?? `discord-thread:${threadId}`),
    );
    return this.agent.ask(sessionId, text);
  }

  /** スレッドに紐づくセッション ID を返す（未紐づけなら undefined）。 */
  getSessionId(threadId: string): Promise<string | undefined> {
    return this.store.get(threadId);
  }

  /** スレッドの紐づけを解除する（アーカイブ/削除時など）。 */
  forget(threadId: string): Promise<void> {
    return this.store.delete(threadId);
  }
}
