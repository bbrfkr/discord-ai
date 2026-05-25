import { createClient, type OpencodeClient } from "./client.js";

/** prompt 時に指定するモデル（providerID / modelID）。未指定ならサーバ既定。 */
export interface ModelRef {
  providerID: string;
  modelID: string;
}

export interface AgentServiceOptions {
  /** 接続先。未指定なら env / 既定値。 */
  baseUrl?: string;
  /** 使用モデル。未指定なら env(OPENCODE_PROVIDER_ID/OPENCODE_MODEL_ID)、それも無ければサーバ既定。 */
  model?: ModelRef;
}

/**
 * opencode の AI agent に作業を依頼する中核サービス。
 *
 * Discord 非依存。将来 Discord bot 化する際は「スレッドID → セッションID」の
 * マッピング層をこの上に被せ、スレッドごとに createSession して同じ sessionId で
 * ask を呼び続ければ会話を継続できる。
 */
export class AgentService {
  private readonly client: OpencodeClient;
  private readonly model?: ModelRef;

  constructor(options: AgentServiceOptions = {}) {
    this.client = createClient(options.baseUrl);
    this.model = options.model ?? resolveModelFromEnv();
  }

  /** 新しいセッションを作成し、その ID を返す。 */
  async createSession(title?: string): Promise<string> {
    const res = await this.client.session.create({
      body: title ? { title } : {},
    });
    const session = unwrap(res);
    return session.id;
  }

  /**
   * 指定セッションにプロンプトを送り、完了まで待って応答テキストを返す（同期）。
   * 同じ sessionId を渡し続ければ会話コンテキストが継続する。
   */
  async ask(sessionId: string, text: string): Promise<string> {
    const res = await this.client.session.prompt({
      path: { id: sessionId },
      body: {
        ...(this.model ? { model: this.model } : {}),
        parts: [{ type: "text", text }],
      },
    });

    const result = unwrap(res);
    return extractText(result.parts);
  }

  /** 設定中のモデル（未設定時は undefined = サーバ既定）。ログ表示用。 */
  get currentModel(): ModelRef | undefined {
    return this.model;
  }
}

function resolveModelFromEnv(): ModelRef | undefined {
  const providerID = process.env.OPENCODE_PROVIDER_ID;
  const modelID = process.env.OPENCODE_MODEL_ID;
  if (providerID && modelID) return { providerID, modelID };
  return undefined;
}

/**
 * SDK は responseStyle 既定が "fields" のため、応答は { data, error, ... } 形式で返る。
 * data を取り出しつつ error があれば投げる。
 */
function unwrap<T>(res: { data?: T; error?: unknown }): T {
  if (res.error) {
    throw new Error(`opencode API error: ${JSON.stringify(res.error)}`);
  }
  if (res.data === undefined) {
    throw new Error("opencode API returned no data");
  }
  return res.data;
}

/** message parts から text タイプを連結して取り出す。 */
function extractText(parts: Array<{ type: string; text?: string }>): string {
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("")
    .trim();
}
