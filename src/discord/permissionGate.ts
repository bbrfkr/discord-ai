import type { Client } from "discord.js";
import type {
  OpencodeEvent,
  PermissionRequest,
  PermissionResponse,
  ThreadAgent,
} from "../threadAgent.js";

/** スレッドで保留中の許可要求。返信コマンドを応答に変換するのに必要な分だけ保持する。 */
interface Pending {
  sessionId: string;
  permissionID: string;
  /** 要求された操作の種別（bash / edit など）。表示用。 */
  kind: string;
  /** 対象の説明（bash ならコマンド文字列など）。表示用。 */
  detail: string;
}

/** 返信コマンドの判定結果。 */
type ReplyResult =
  | { handled: false }
  | { handled: true; message: string };

/**
 * opencode の permission ゲートと Discord を橋渡しするゲート。
 *
 * 背景: AgentService.ask() は tool 実行の許可待ちに当たると prompt の HTTP 応答が返らず
 * ブロックする。クライアント（この bot）が許可要求を受け取って応答しない限り、セッションは
 * 永久に止まり、呼び出し元には何も返らない。
 *
 * そこで本クラスは独立した SSE ストリーム（events）で許可要求を受け取り、対応する
 * スレッドへ「返信コマンドで承認/拒否してください」と通知する。ユーザがスレッドに返信した
 * コマンドを handleReply() が応答（once/always/reject）に変換してサーバへ返し、ブロックを解除する。
 * 解除後は元の ask() が答えを返してスレッドへ投稿される（その経路は既存のまま）。
 */
export class PermissionGate {
  private readonly agent: ThreadAgent;
  /** threadId -> 保留中の許可要求。thread↔session は 1:1 なので 1 スレッド 1 件で足りる。 */
  private readonly pending = new Map<string, Pending>();

  constructor(agent: ThreadAgent) {
    this.agent = agent;
  }

  /**
   * 許可要求の購読を開始する（バックグラウンドで回り続ける）。
   * ストリームが切れても一定間隔で再購読する。discord client は通知先スレッドの取得に使う。
   */
  start(discord: Client): void {
    void this.loop(discord);
  }

  /** このスレッドに保留中の許可要求があるか。 */
  hasPending(threadId: string): boolean {
    return this.pending.has(threadId);
  }

  /**
   * スレッドへの返信を許可応答として解釈する。
   * 保留が無ければ { handled: false }（＝通常メッセージとして処理させる）。
   * 保留がある間は、コマンドでなくても handled:true を返して通常プロンプト化を防ぐ
   *（元の ask が進行中のため、同一セッションへ二重に prompt しないこと）。
   */
  async handleReply(threadId: string, content: string): Promise<ReplyResult> {
    const p = this.pending.get(threadId);
    if (!p) return { handled: false };

    const response = parseCommand(content);
    if (!response) {
      return {
        handled: true,
        message:
          `⏳ 「${p.kind}」の許可を待っています。\n` +
          "返信で承認/拒否してください（`承認` / `常に許可` / `拒否`）。",
      };
    }

    // 二重応答を避けるため、応答前に保留を確定的に取り除く。
    this.pending.delete(threadId);
    try {
      await this.agent.respondPermission(p.sessionId, p.permissionID, response);
    } catch (err) {
      // 失効済み（タイムアウト等）や再起動で permissionID が無効になっていることがある。
      console.error("[permission] respond failed:", err);
      return {
        handled: true,
        message:
          "⚠️ 許可応答の送信に失敗しました（要求が失効した可能性があります）。" +
          "必要ならもう一度指示し直してください。",
      };
    }

    return { handled: true, message: replyAck(response, p.kind) };
  }

  /** 1 接続ぶんの購読 + 自動再接続のループ。 */
  private async loop(discord: Client): Promise<void> {
    for (;;) {
      try {
        for await (const ev of this.agent.events()) {
          await this.onEvent(discord, ev).catch((err) =>
            console.error("[permission] handle event failed:", err),
          );
        }
      } catch (err) {
        console.error("[permission] event stream error:", err);
      }
      // ストリームが終了/切断したら少し待って再購読する。
      await delay(3000);
    }
  }

  /** イベントを種別ごとに捌く。 */
  private async onEvent(discord: Client, ev: OpencodeEvent): Promise<void> {
    if (ev.type === "permission.asked") {
      await this.onRequest(discord, ev.properties as unknown as PermissionRequest);
      return;
    }
    // セッションがアイドルに戻ったら、未応答のまま失効した保留を掃除する
    //（タイムアウト/切断後に通常メッセージが保留で詰まり続けるのを防ぐ）。
    if (ev.type === "session.idle") {
      const sessionID = ev.properties?.sessionID;
      if (typeof sessionID === "string") this.clearBySession(sessionID);
    }
  }

  /** 指定セッションに紐づく保留を取り除く（アイドル復帰時の掃除用）。 */
  private clearBySession(sessionID: string): void {
    for (const [threadId, p] of this.pending) {
      if (p.sessionId === sessionID) this.pending.delete(threadId);
    }
  }

  /** 受け取った許可要求を、対応スレッドへ通知し保留として記録する。 */
  private async onRequest(
    discord: Client,
    req: PermissionRequest,
  ): Promise<void> {
    if (!req?.id || !req.sessionID) return;
    const threadId = await this.agent.findThreadBySession(req.sessionID);
    if (!threadId) {
      // スレッドに紐づかないセッション（CLI 等）からの要求は通知先が無いので無視する。
      return;
    }

    const detail = (req.patterns ?? []).join("\n").trim();
    this.pending.set(threadId, {
      sessionId: req.sessionID,
      permissionID: req.id,
      kind: req.permission,
      detail,
    });

    const channel = await discord.channels.fetch(threadId).catch(() => null);
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      return;
    }
    await channel.send(formatRequest(req.permission, detail));
  }
}

/** 返信文字列を許可応答へ変換する（判定できなければ undefined）。 */
function parseCommand(content: string): PermissionResponse | undefined {
  const t = content.trim().toLowerCase();
  if (/^(常に許可|常に承認|always)$/.test(t)) return "always";
  if (/^(承認|許可|approve|allow|ok|yes|y|はい)$/.test(t)) return "once";
  if (/^(拒否|却下|deny|reject|no|n|いいえ)$/.test(t)) return "reject";
  return undefined;
}

/** 許可要求をスレッドへ提示する本文。 */
function formatRequest(kind: string, detail: string): string {
  const body = detail
    ? `\n\`\`\`\n${detail.slice(0, 1500)}\n\`\`\`\n`
    : "\n";
  return (
    `🔐 **許可が必要です**: \`${kind}\`${body}` +
    "返信で承認/拒否してください：\n" +
    "• `承認` … 今回だけ許可\n" +
    "• `常に許可` … 以後この種別は自動許可\n" +
    "• `拒否` … 実行しない"
  );
}

/** 応答後にスレッドへ返す確認文。 */
function replyAck(response: PermissionResponse, kind: string): string {
  switch (response) {
    case "once":
      return `✅ 「${kind}」を許可しました。処理を続けます…`;
    case "always":
      return `✅ 「${kind}」を以後も許可します。処理を続けます…`;
    case "reject":
      return `🚫 「${kind}」を拒否しました。`;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
