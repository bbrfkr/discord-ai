# discord-ai

Discord の特定チャンネルへの投稿を起点にスレッドを立て、[opencode](https://opencode.ai) の AI agent が応答する bot です。
bot と opencode サーバの両方を Docker / docker compose で起動できます。

---

## アーキテクチャ

```
Discord ──(メッセージ)──▶ bot ──HTTP──▶ opencode serve ──▶ litellm (OpenAI互換API)
                          │                  │
                  .data/ に              /data (named volume) に
            thread↔session を保存      session DB を保存
```

- **bot**: `discord.js` で対象チャンネルを監視 → スレッド作成 → opencode に問い合わせ → スレッドへ応答。
- **opencode**: `opencode serve`（headless HTTP サーバ）。litellm 互換エンドポイントにアクセスして推論。
- **会話の継続**: 1 Discord スレッド = 1 opencode セッション。対応表（`thread_id ↔ session_id`）を `.data/thread-sessions.json` に永続化するため、再起動後も会話が続く。

### コンポーネント対応表

| レイヤ | 役割 | 主なファイル |
|---|---|---|
| `AgentService` | opencode SDK のラッパ（セッション作成・プロンプト送信） | `src/opencode/agent.ts`, `src/opencode/client.ts` |
| `ThreadSessionStore` | `thread_id ↔ session_id` を JSON で永続化 | `src/store/threadSessionStore.ts` |
| `ThreadAgent` | 上記2つを束ね「スレッド単位の会話」を提供 | `src/threadAgent.ts` |
| Discord bot | チャンネル監視・スレッド応答 | `src/discord/bot.ts`, `src/discord/format.ts` |
| 動作確認 CLI | opencode 単体の疎通テスト | `src/cli.ts` |

---

## 必要なもの

- Docker / docker compose（OrbStack や Docker Desktop でも可）
- Discord Bot のトークンと、監視対象チャンネルの ID
- litellm など OpenAI 互換 API のエンドポイントと API キー
- （ローカル実行する場合のみ）Node.js 24 以上

---

## セットアップ

### 1. `.env` を用意

```bash
cp .env.example .env
```

`.env` を編集して以下を設定する（このファイルは `.gitignore` 済み。**コミットしないこと**）。

| 変数 | 必須 | 説明 |
|---|---|---|
| `DISCORD_TOKEN` | ✅ | Bot トークン（Developer Portal > Bot > Reset Token） |
| `DISCORD_TARGET_CHANNEL_ID` | ✅ | 監視対象チャンネル ID（開発者モードON → 右クリック → IDをコピー） |
| `LITELLM_BASE_URL` | ✅(compose) | OpenAI 互換エンドポイント（例 `https://.../v1`） |
| `LITELLM_API_KEY` | ✅(compose) | 上記の API キー |
| `OPENCODE_BASE_URL` | – | ローカル実行時の opencode 接続先。compose では自動上書き |
| `OPENCODE_PROVIDER_ID` / `OPENCODE_MODEL_ID` | – | 使用モデルの上書き。未指定なら `opencode.json` の既定 |

### 2. Discord Bot の準備

1. [Discord Developer Portal](https://discord.com/developers/applications) で New Application → **Bot** で作成しトークン取得。
2. **Bot 設定の Privileged Gateway Intents で `MESSAGE CONTENT INTENT` を ON**（本文読み取りに必須）。
3. **OAuth2 > URL Generator** で scope=`bot`、権限に `View Channels` / `Send Messages` / `Create Public Threads` / `Send Messages in Threads` を付与し、生成 URL からサーバーに招待。

### 3. モデル設定

opencode が使うプロバイダ／モデルは `opencode/opencode.json` で定義。API キーは `{env:LITELLM_API_KEY}` 置換で実行時に注入するため、**このファイルに秘密情報は書かない**。

---

## 起動（docker compose・推奨）

```bash
docker compose up -d --build      # ビルドして起動
docker compose logs -f bot        # bot のログ追従。"logged in as ..." が出れば成功
docker compose ps                 # 稼働状況
docker compose down               # 停止（session DB の volume は保持）
```

起動後、対象チャンネルに投稿するとスレッドが立ち AI が応答する。スレッド内で続けて話しかければ会話が継続する。

---

## ローカル実行（開発・デバッグ用）

ホストで `opencode serve` を起動している前提（`OPENCODE_BASE_URL` をそれに合わせる）。

```bash
npm install

# opencode 単体の疎通テスト（毎回新規セッション）
npm run cli -- "1+1は？"

# スレッド継続のテスト（同じ名前 = 同じセッション。別プロセスでも継続）
npm run cli -- --thread demo "私の名前はタロウ"
npm run cli -- --thread demo "私の名前は？"      # → タロウ

# bot をローカル起動
npm run bot

# 型チェック
npm run typecheck
```

---

## 運用・保守

### ログの確認

```bash
docker compose logs -f bot           # bot
docker compose logs -f opencode      # opencode サーバ
docker compose logs --since 1h bot   # 直近1時間
```

### 再起動 / 更新

```bash
docker compose restart bot                  # bot だけ再起動
docker compose up -d --build                # コード変更を反映して再ビルド・再起動

# opencode 本体や依存を最新化（イメージを作り直す）
docker compose build --no-cache opencode
docker compose up -d opencode
```

> bot のコード変更は `--build` で反映される。`opencode-ai` のバージョンを上げたい場合は
> `opencode/Dockerfile` の `npm install -g opencode-ai` を再ビルドする（必要ならバージョン固定推奨）。

### データの永続化とリセット

| データ | 保存先 | リセット方法 |
|---|---|---|
| `thread_id ↔ session_id` | ホスト `./.data/thread-sessions.json` | ファイルを `{}` にするか削除 |
| opencode セッション DB | named volume `opencode-data` | `docker compose down -v` または `docker volume rm discord-ai_opencode-data` |

> ⚠️ 両者は連動している。opencode の DB を消すと既存スレッドの session ID が無効になるため、
> 整合性を保つには `.data/thread-sessions.json` も合わせてリセットする。

### バックアップ

```bash
# マッピング（軽量・テキスト）
cp .data/thread-sessions.json backup-$(date +%F).json

# opencode セッション DB（volume をtar化）
docker run --rm -v discord-ai_opencode-data:/data -v "$PWD":/backup \
  busybox tar czf /backup/opencode-data-$(date +%F).tgz -C /data .
```

---

## トラブルシュート

| 症状 | 確認ポイント |
|---|---|
| bot がメッセージに反応しない | `MESSAGE CONTENT INTENT` が ON か / `DISCORD_TARGET_CHANNEL_ID` が正しいか / bot がそのチャンネルを見える権限を持つか |
| スレッドが作れない | bot に `Create Public Threads` 権限があるか |
| 応答が `⚠️ AI への問い合わせに失敗` | `docker compose logs opencode` を確認。`LITELLM_API_KEY` / `LITELLM_BASE_URL` が正しいか |
| opencode が unhealthy | `docker compose logs opencode` / litellm への到達性 / config の `{env:...}` が解決されているか |
| ローカルで `cli` が繋がらない | ホストで `opencode serve` が起動しているか / `OPENCODE_BASE_URL` |

`opencode` 単体の死活確認：

```bash
docker compose exec opencode node -e "fetch('http://127.0.0.1:4096/global/health').then(r=>r.json()).then(console.log)"
```

---

## セキュリティ上の注意

- `.env` と `.data/` は `.gitignore` 済み。**API キー・Bot トークンは絶対にコミットしない。**
- `opencode/opencode.json` はキーを直書きせず `{env:...}` 参照のみ（リポジトリにもイメージにも秘密情報を残さない）。
- opencode サーバはポートを公開せず、compose 内部ネットワークからのみ到達可能（外部公開する場合は `OPENCODE_SERVER_PASSWORD` 等の認証を検討）。
- Bot トークンが漏れた場合は Developer Portal で即 **Reset Token**。

---

## ディレクトリ構成

```
discord-ai/
├── docker-compose.yml        # opencode + bot の2サービス
├── Dockerfile                # bot イメージ
├── opencode/
│   ├── Dockerfile            # opencode サーバイメージ
│   └── opencode.json         # プロバイダ/モデル設定（秘密情報なし）
├── src/
│   ├── cli.ts                # 動作確認 CLI
│   ├── threadAgent.ts        # スレッド単位の会話層
│   ├── opencode/             # opencode SDK ラッパ（コア層）
│   ├── store/                # thread↔session 永続化
│   └── discord/              # Discord bot 本体
├── .env.example              # 環境変数テンプレート
└── .data/                    # thread↔session マッピング（実行時生成・gitignore）
```
