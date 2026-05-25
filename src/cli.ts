import { AgentService } from "./opencode/agent.js";
import { ThreadAgent } from "./threadAgent.js";

/**
 * 動作確認用 CLI。
 *
 *   # 単発（毎回新規セッション）
 *   npm run cli -- "1+1は？"
 *
 *   # スレッド継続（thread_id を固定すると同じセッションを再利用 = 会話が継続）
 *   npm run cli -- --thread demo "私の好きな色は青です"
 *   npm run cli -- --thread demo "私の好きな色は何でしたか？"
 *
 * --thread を付けると ThreadAgent 経由となり、thread_id↔session_id が
 * .data/thread-sessions.json に永続化される（プロセスを跨いでも継続）。
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  let threadId: string | undefined;
  const idx = argv.indexOf("--thread");
  if (idx !== -1) {
    threadId = argv[idx + 1];
    argv.splice(idx, 2);
  }

  const prompt =
    argv.join(" ").trim() || "自己紹介を一文でお願いします。";

  const baseUrl = process.env.OPENCODE_BASE_URL ?? "http://127.0.0.1:4096";
  console.log(`[opencode] baseUrl: ${baseUrl}`);

  let answer: string;
  if (threadId) {
    const ta = new ThreadAgent();
    const before = await ta.getSessionId(threadId);
    console.log(`[thread]   ${threadId} -> ${before ?? "(新規作成)"}`);
    console.log(`[prompt]   ${prompt}`);
    console.log("---");
    answer = await ta.ask(threadId, prompt);
    const after = await ta.getSessionId(threadId);
    console.log(answer || "(空の応答)");
    console.log(`--- session: ${after}`);
  } else {
    const agent = new AgentService();
    const sessionId = await agent.createSession("discord-ai cli test");
    console.log(`[opencode] session: ${sessionId}`);
    console.log(`[prompt]   ${prompt}`);
    console.log("---");
    answer = await agent.ask(sessionId, prompt);
    console.log(answer || "(空の応答)");
  }
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
