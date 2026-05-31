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

/** permission への応答。once=今回だけ許可 / always=以後同種も許可 / reject=拒否。 */
export type PermissionResponse = "once" | "always" | "reject";

/**
 * opencode が tool 実行の許可待ちで送ってくるイベント（type: "permission.asked"）。
 *
 * 注意: @opencode-ai/sdk の生成型は別名（permission.updated / Permission）になっているが、
 * サーバ実体（opencode serve）がワイヤに流す実際の type は "permission.asked"、payload は
 * 下記 PermissionRequest 形状である（バイナリ検証済み）。SDK の型に頼らず実体に合わせて扱う。
 */
export interface PermissionRequest {
  /** per_… 形式。応答時の permissionID として使う。 */
  id: string;
  /** ses_… 形式。どのセッション（=スレッド）の許可要求か。 */
  sessionID: string;
  /** 要求された操作の種別（"bash" / "edit" / "webfetch" など）。 */
  permission: string;
  /** 対象パターン（bash ならコマンド文字列など）。 */
  patterns?: string[];
  metadata?: Record<string, unknown>;
  always?: string[];
  tool?: { messageID: string; callID: string };
}

/**
 * サーバが SSE で流すイベントの最小形（type と任意の properties）。
 * SDK の生成型は実体とずれている箇所があるため、型に頼らず実体に合わせて緩く扱う。
 */
export interface OpencodeEvent {
  type: string;
  properties?: Record<string, unknown>;
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

  /**
   * サーバのイベントストリーム（SSE: GET /event）を購読し、各イベントを yield する。
   *
   * ask() は permission ゲートに当たると prompt の HTTP 応答が返らずブロックするため、
   * 許可要求（permission.asked）はこの独立したストリームで受け取り、respondPermission() で
   * 応答して解除する。ストリームが切れたら呼び出し側で再購読する想定（1接続ぶんを流すだけ）。
   */
  async *events(): AsyncGenerator<OpencodeEvent> {
    const res = await this.client.event.subscribe();
    for await (const event of res.stream) {
      // SDK の型は実体とずれているため unknown 経由で実体形状に寄せる。
      const ev = event as unknown as OpencodeEvent;
      if (ev && typeof ev.type === "string") yield ev;
    }
  }

  /** 保留中の permission に応答する（許可/拒否）。 */
  async respondPermission(
    sessionId: string,
    permissionID: string,
    response: PermissionResponse,
  ): Promise<void> {
    const res = await this.client.postSessionIdPermissionsPermissionId({
      path: { id: sessionId, permissionID },
      body: { response },
    });
    unwrap(res);
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
