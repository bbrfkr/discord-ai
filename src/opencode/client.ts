import { createOpencodeClient } from "@opencode-ai/sdk";

/**
 * 接続先 base URL を解決する。引数 > 環境変数 OPENCODE_BASE_URL > 既定値(127.0.0.1:4096) の優先順。
 * 末尾スラッシュは取り除く（後段の `${base}/path` 連結のため）。
 */
export function resolveBaseUrl(baseUrl?: string): string {
  const url =
    baseUrl ?? process.env.OPENCODE_BASE_URL ?? "http://127.0.0.1:4096";
  return url.replace(/\/+$/, "");
}

/**
 * opencode serve が待ち受けている HTTP サーバへ接続する SDK クライアントを生成する。
 */
export function createClient(baseUrl?: string) {
  return createOpencodeClient({ baseUrl: resolveBaseUrl(baseUrl) });
}

export type OpencodeClient = ReturnType<typeof createClient>;
