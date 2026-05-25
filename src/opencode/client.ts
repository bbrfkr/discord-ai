import { createOpencodeClient } from "@opencode-ai/sdk";

/**
 * opencode serve が待ち受けている HTTP サーバへ接続する SDK クライアントを生成する。
 *
 * baseUrl は引数 > 環境変数 OPENCODE_BASE_URL > 既定値(127.0.0.1:4096) の優先順。
 */
export function createClient(baseUrl?: string) {
  const url =
    baseUrl ?? process.env.OPENCODE_BASE_URL ?? "http://127.0.0.1:4096";

  return createOpencodeClient({ baseUrl: url });
}

export type OpencodeClient = ReturnType<typeof createClient>;
