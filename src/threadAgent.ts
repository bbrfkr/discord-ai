import {
  AgentService,
  type AgentServiceOptions,
  type AttachmentInput,
  type OpencodeEvent,
  type PermissionRequest,
  type PermissionResponse,
  type QuestionInfo,
  type QuestionOption,
  type QuestionRequest,
} from "./opencode/agent.js";
import { ThreadSessionStore } from "./store/threadSessionStore.js";

export type {
  AttachmentInput,
  OpencodeEvent,
  PermissionRequest,
  PermissionResponse,
  QuestionInfo,
  QuestionOption,
  QuestionRequest,
};

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
  async ask(
    threadId: string,
    text: string,
    attachments: AttachmentInput[] = [],
    title?: string,
  ): Promise<string> {
    const sessionId = await this.store.getOrCreate(threadId, () =>
      this.agent.createSession(title ?? `discord-thread:${threadId}`),
    );
    return this.agent.ask(sessionId, text, attachments);
  }

  /** スレッドに紐づくセッション ID を返す（未紐づけなら undefined）。 */
  getSessionId(threadId: string): Promise<string | undefined> {
    return this.store.get(threadId);
  }

  /** セッション ID から逆引きでスレッド ID を返す（permission 通知の宛先解決用）。 */
  findThreadBySession(sessionId: string): Promise<string | undefined> {
    return this.store.findThreadBySession(sessionId);
  }

  /** サーバのイベントストリーム（SSE）を購読する。 */
  events(): AsyncGenerator<OpencodeEvent> {
    return this.agent.events();
  }

  /** 保留中の permission に応答する（許可/拒否）。 */
  respondPermission(
    sessionId: string,
    permissionID: string,
    response: PermissionResponse,
  ): Promise<void> {
    return this.agent.respondPermission(sessionId, permissionID, response);
  }

  /** 保留中の質問に回答する（質問順に、選択ラベルの配列の配列）。 */
  replyQuestion(requestID: string, answers: string[][]): Promise<void> {
    return this.agent.replyQuestion(requestID, answers);
  }

  /** 保留中の質問を取り消す。 */
  rejectQuestion(requestID: string): Promise<void> {
    return this.agent.rejectQuestion(requestID);
  }

  /** スレッドの紐づけを解除する（アーカイブ/削除時など）。 */
  forget(threadId: string): Promise<void> {
    return this.store.delete(threadId);
  }
}
