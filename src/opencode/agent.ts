import { createClient, type OpencodeClient } from "./client.js";

/** prompt 時に指定するモデル（providerID / modelID）。未指定ならサーバ既定。 */
export interface ModelRef {
  providerID: string;
  modelID: string;
}

/** ask に渡す添付ファイル（Discord 非依存の素のデータ）。 */
export interface AttachmentInput {
  /** ダウンロード元 URL（例: Discord CDN URL）。 */
  url: string;
  /** content-type。不明時はフォールバック値（例: application/octet-stream）。 */
  mime: string;
  filename?: string;
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
  async ask(
    sessionId: string,
    text: string,
    attachments: AttachmentInput[] = [],
  ): Promise<string> {
    // 添付はダウンロードして base64 data URL 化する（opencode はリモート URL を受け付けない）。
    const fileParts = await Promise.all(
      attachments.map(async (a) => ({
        type: "file" as const,
        mime: a.mime,
        ...(a.filename ? { filename: a.filename } : {}),
        url: await toDataUrl(a.url, a.mime),
      })),
    );
    const parts = [
      ...(text.trim() ? [{ type: "text" as const, text }] : []),
      ...fileParts,
    ];

    const res = await this.client.session.prompt({
      path: { id: sessionId },
      body: {
        ...(this.model ? { model: this.model } : {}),
        parts,
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

/** URL からファイルを取得し、base64 の data URL に変換する。 */
async function toDataUrl(url: string, mime: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`添付ファイルの取得に失敗しました: ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/** message parts から text タイプを連結して取り出す。 */
function extractText(parts: Array<{ type: string; text?: string }>): string {
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("")
    .trim();
}
