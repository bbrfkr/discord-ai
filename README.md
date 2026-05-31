# discord-ai-bot

Discord の特定チャンネルへの投稿を起点にスレッドを立て、[opencode](https://opencode.ai) の AI agent が応答する bot です。
opencode サーバー本体は同梱せず、別デプロイの **[opencode-server](https://github.com/bbrfkr/opencode-server)** に `OPENCODE_BASE_URL` で HTTP 接続します。

> サーバー（opencode serve + n8n 短命トークンによるセキュアな git/gh 認証 + defuddle）は opencode-server 側に集約されています。
> この bot は「opencode サーバーを使うクライアント」の 1 つで、サーバーの起動・管理は行いません。

---

## アーキテクチャ

```
Discord ──(メッセージ)──▶ bot ──HTTP(OPENCODE_BASE_URL)──▶ opencode-server ──▶ litellm
                          │
                  .data/ に
            thread↔session を保存
```

- **bot**: `discord.js` で対象チャンネルを監視 → スレッド作成 → opencode に問い合わせ → スレッドへ応答。
- **opencode-server**: 別デプロイ。`OPENCODE_BASE_URL` で到達する（このリポジトリの管理対象外）。
- **会話の継続**: 1 Discord スレッド = 1 opencode セッション。対応表（`thread_id ↔ session_id`）を `.data/thread-sessions.json` に永続化するため、再起動後も会話が続く。
- **画像の添付**: メッセージに添付された画像（本文なしの画像のみの投稿も可）をダウンロードし、base64 data URL に変換して opencode へ渡す。モデル側で画像入力が有効である必要がある。
- **許可ゲート（permission）の橋渡し**: opencode は `bash` 実行やファイル編集など許可が要る操作で、応答を返さず許可待ちでブロックする。bot はイベントストリーム（SSE）で許可要求を受け取り、対応スレッドへ「承認/拒否」を促す。詳細は[許可リクエストへの応答](#許可リクエストへの応答)を参照。

### コンポーネント対応表

| レイヤ | 役割 | 主なファイル |
|---|---|---|
| `AgentService` | opencode SDK のラッパ（セッション作成・プロンプト送信） | `src/opencode/agent.ts`, `src/opencode/client.ts` |
| `ThreadSessionStore` | `thread_id ↔ session_id` を JSON で永続化 | `src/store/threadSessionStore.ts` |
| `ThreadAgent` | 上記2つを束ね「スレッド単位の会話」を提供 | `src/threadAgent.ts` |
| `PermissionGate` | 許可要求（SSE）を購読しスレッドへ通知・返信で応答 | `src/discord/permissionGate.ts` |
| Discord bot | チャンネル監視・スレッド応答 | `src/discord/bot.ts`, `src/discord/format.ts` |
| 動作確認 CLI | opencode 単体の疎通テスト | `src/cli.ts` |

---

## 許可リクエストへの応答

opencode は `bash` コマンドの実行やファイル編集など、サーバ側の `permission` 設定で許可が必要とされた操作に当たると、その許可が解決されるまで**プロンプトの HTTP 応答を返さずブロックする**。クライアントが応答しない限りセッションは止まったままになる。

bot はこれを次のように橋渡しする（実装: `src/discord/permissionGate.ts`）。

1. 起動時にイベントストリーム（`GET /event`、SSE）を購読する。
2. `permission.asked` イベントを受け取ると、`sessionID` から対応スレッドを逆引きし、そのスレッドへ許可要求（操作種別と対象、例: `bash` と実行コマンド）を投稿する。
3. ユーザがそのスレッドに**返信コマンド**を送ると、許可応答に変換してサーバへ返し、ブロックを解除する。解除後は元の応答がそのままスレッドへ投稿される。

### 返信コマンド

許可待ちのスレッドでは、次の語（前後の空白は無視、英語も可）が応答として解釈される。

| 返信 | 動作 | opencode への応答 |
|---|---|---|
| `承認` / `許可` / `approve` / `allow` / `ok` / `yes` | 今回だけ許可 | `once` |
| `常に許可` / `常に承認` / `always` | 以後この種別は自動許可 | `always` |
| `拒否` / `却下` / `deny` / `reject` / `no` | 実行しない | `reject` |

- 許可待ちの間は、上記以外の返信は通常メッセージとして AI に転送されず、待機中である旨を案内する（進行中の処理に二重で問い合わせないため）。
- 要求が失効（タイムアウト等）した場合は、セッションがアイドルに戻った時点で保留を自動的に破棄する。

> 💡 そもそも許可を求める頻度を減らしたい場合は、**opencode-server 側**の `opencode.json` の `permission` 設定で、安全な操作を `allow`、危険な操作だけ `ask`/`deny` に振り分けるとよい（設定キー: `edit` / `bash` / `webfetch` など。`bash` はコマンドのパターン別指定も可能）。

---

## 必要なもの

- Docker / docker compose（OrbStack や Docker Desktop でも可）
- 到達可能な **opencode-server** のデプロイ（`OPENCODE_BASE_URL`）
- Discord Bot のトークンと、監視対象チャンネルの ID
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
| `OPENCODE_BASE_URL` | ✅ | 接続先 opencode-server の URL（例 `http://host:4096`） |
| `DISCORD_TOKEN` | ✅ | Bot トークン（Developer Portal > Bot > Reset Token） |
| `DISCORD_TARGET_CHANNEL_ID` | ✅ | 監視対象チャンネル ID（開発者モードON → 右クリック → IDをコピー） |
| `OPENCODE_PROVIDER_ID` / `OPENCODE_MODEL_ID` | – | 使用モデルの上書き。未指定ならサーバの既定 |

> litellm の接続情報やモデル定義、git/gh 認証（n8n 短命トークン）は **opencode-server 側**の設定。bot には不要。

### 2. Discord Bot の準備

1. [Discord Developer Portal](https://discord.com/developers/applications) で New Application → **Bot** で作成しトークン取得。
2. **Bot 設定の Privileged Gateway Intents で `MESSAGE CONTENT INTENT` を ON**（本文読み取りに必須）。
3. **OAuth2 > URL Generator** で scope=`bot`、権限に `View Channels` / `Send Messages` / `Create Public Threads` / `Send Messages in Threads` を付与し、生成 URL からサーバーに招待。

---

## 起動（docker compose・推奨）

事前に opencode-server を起動し、`OPENCODE_BASE_URL` がそこへ到達できることを確認しておく。

```bash
docker compose up -d --build      # ビルドして起動
docker compose logs -f bot        # bot のログ追従。"logged in as ..." が出れば成功
docker compose ps                 # 稼働状況
docker compose down               # 停止
```

起動後、対象チャンネルに投稿するとスレッドが立ち AI が応答する。スレッド内で続けて話しかければ会話が継続する。

---

## ローカル実行（開発・デバッグ用）

`OPENCODE_BASE_URL` が到達可能な opencode-server を指している前提。

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
docker compose logs --since 1h bot   # 直近1時間
```

### 再起動 / 更新

```bash
docker compose restart bot                  # 再起動
docker compose up -d --build                # コード変更を反映して再ビルド・再起動
```

### データの永続化とリセット

| データ | 保存先 | リセット方法 |
|---|---|---|
| `thread_id ↔ session_id` | ホスト `./.data/thread-sessions.json` | ファイルを `{}` にするか削除 |

> ⚠️ opencode-server 側のセッション DB を消すと既存スレッドの session ID が無効になる。
> 整合性を保つには `.data/thread-sessions.json` も合わせてリセットする。

### バックアップ

```bash
# マッピング（軽量・テキスト）
cp .data/thread-sessions.json backup-$(date +%F).json
```

---

## トラブルシュート

| 症状 | 確認ポイント |
|---|---|
| bot がメッセージに反応しない | `MESSAGE CONTENT INTENT` が ON か / `DISCORD_TARGET_CHANNEL_ID` が正しいか / bot がそのチャンネルを見える権限を持つか |
| スレッドが作れない | bot に `Create Public Threads` 権限があるか |
| 応答が `⚠️ AI への問い合わせに失敗` | `OPENCODE_BASE_URL` が正しいか / opencode-server が稼働・到達可能か |
| ローカルで `cli` が繋がらない | opencode-server が起動しているか / `OPENCODE_BASE_URL` |

---

## セキュリティ上の注意

- `.env` と `.data/` は `.gitignore` 済み。**Bot トークンは絶対にコミットしない。**
- litellm の API キーや GitHub の秘密情報はこの bot には持たせない（すべて opencode-server 側に閉じている）。
- Bot トークンが漏れた場合は Developer Portal で即 **Reset Token**。

---

## ディレクトリ構成

```
discord-bot/
├── docker-compose.yml        # bot サービス（外部 opencode-server へ接続）
├── Dockerfile                # bot イメージ
├── src/
│   ├── cli.ts                # 動作確認 CLI
│   ├── threadAgent.ts        # スレッド単位の会話層
│   ├── opencode/             # opencode SDK ラッパ（コア層）
│   ├── store/                # thread↔session 永続化
│   └── discord/              # Discord bot 本体
├── .env.example              # 環境変数テンプレート
└── .data/                    # thread↔session マッピング（実行時生成・gitignore）
```
