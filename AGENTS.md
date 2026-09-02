# AGENTS.md

## 目的

Deno + SQLite で、小さく高速で保守しやすいWebアプリケーションを作る。

以下を優先する。

1. 正しさ
2. シンプルさ
3. 読みやすさ
4. コード量の少なさ
5. 開発速度
6. 実行性能

Web標準APIとDeno標準機能を優先し、フレームワークや依存ライブラリ、抽象化レイヤーを必要になるまで増やさない。
将来必要になるかもしれないという理由だけで複雑な設計を導入しない。

## 基本構成

- ランタイム: 最新安定版 Deno 2.x
- サーバー: TypeScript
- クライアント: JavaScript (ES Modules) + HTML + CSS
- DB: SQLite
- HTTP: `Deno.serve()`
- フロントエンド: buildless
- ORM: 使用しない
- フロントエンドフレームワーク: 原則使用しない

## サーバー

サーバー側はTypeScriptを使用する。

- `Deno.serve()` を使用する
- Web標準APIを優先する
- 小さく明示的なルーティングを優先する
- 外部ライブラリは必要性が明確な場合のみ追加する
- Node.js固有APIは明確な利点がある場合のみ使用する
- 不要なController / Service / Repository / DAO層を作らない

基本的な処理の流れは以下とする。

```text
request
  ↓
route
  ↓
小さな処理関数
  ↓
SQLite
```

単純な処理では、ルートや小さな関数からprepared statementを直接実行してよい。

## クライアント

クライアント側は素のJavaScriptを使用する。

- TypeScriptを使用しない
- ES Modulesを使用する
- HTML / CSS / JavaScriptをブラウザへ直接配信する
- transpileやbundleを必要としない構成にする
- `fetch`、DOM API、WebSocketなどWeb標準APIを優先する
- React / Vue / Svelte / Angular等は明示的な指定がない限り導入しない
- JSXを使用しない
- CSSフレームワークは原則導入しない
- 入力フォームの文字サイズは16px以上にする（スマホの自動ズームを防ぐため）

フロントエンドのbuild stepを作らない。

Vite、Webpack、Rollup、Babel等は明示的に必要とされない限り導入しない。

## SQLite

SQLiteは `node:sqlite` を使用する。

```ts
import { DatabaseSync } from "node:sqlite";
```

ORMは使用せず、生SQLを優先する。

初期化時に原則として以下を設定する。

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
```

- 外部入力値にはprepared statementを使用する
- 外部入力をSQL文字列へ直接連結しない
- 原則として `STRICT` tableを使用する
- 複数の更新を一体として扱う必要がある場合はtransactionを使う
- transactionは短く保つ
- indexは実際のquery patternに基づいて追加する
- N+1 queryを避ける
- 必要性が確認できるまでcache層を追加しない

## Migration

DB schemaの変更はmigrationとして管理する。

```text
migrations/
  001_init.sql
  002_add_messages.sql
  003_add_rooms.sql
```

適用済みmigrationは原則変更しない。 schema変更時は新しいmigrationを追加する。

## ユーザー管理

特に指定がなければ、ID + password方式を使用する。

ユーザーは以下を基本とする。

```text
id
password_hash
is_admin
must_change_password
created_at
updated_at
```

メールアドレスはアプリケーション上必要な場合のみ要求する。

passwordを平文で保存しない。
password保存用として確立された標準的なhash方式を使用し、独自暗号方式を作らない。

## 初期管理者

DB初期作成時に以下の管理者を登録する。

```text
ID: admin
初期password: adminadmin
管理者: yes
```

これはbootstrap用の初期passwordであり、初回login後にpassword変更を必須とする。

初期作成時は `must_change_password = 1` とする。

既存DB起動時に `admin` のpasswordを初期値へ戻してはいけない。 既に `admin`
が存在する場合は上書きしない。

## Login / Session

loginはIDとpasswordで行う。

認証失敗時は、IDの存在有無を不必要に漏らさず、例えば以下のような共通エラーを返す。

```json
{
  "error": "Invalid ID or password"
}
```

認証成功後はserver-side sessionを作成し、SQLiteへ保存する。 JWTは特に理由がない限り使用しない。

session IDは暗号学的に安全な乱数で生成する。

cookieは原則として以下を使用する。

- `HttpOnly`
- `SameSite=Lax`
- productionでは `Secure`
- 適切な有効期限

passwordやpassword hashをcookieへ保存しない。

## 権限管理

認証と権限確認を分離して考える。

管理者権限はサーバー側DBの `is_admin` のみを信用する。 clientから送られたuser ID、role、`is_admin`
等を信用しない。

保護された処理では、

1. sessionを検証
2. userを取得
3. 権限を確認
4. 処理を実行

の順で行う。

最後の管理者を誤って削除したり、管理者権限を外したりできないようにする。

管理者は原則として以下を行えるようにする。

- user作成
- user一覧
- password reset
- user削除
- 管理者権限の付与・解除

user自身も認証後にpasswordを変更できるようにする。

## API

APIは原則JSONを使用する。

- HTTP methodとstatus codeを適切に使用する
- すべての外部入力を検証する
- clientへstack traceや内部情報を返さない
- API responseを必要以上に大きくしない
- 単純で予測可能なendpointを優先する

## リアルタイム通信

chat、通知、presence等には原則WebSocketを使用する。

clientはbrowser標準の `WebSocket` を使用する。 protocolは可能な限り単純なJSONとする。

WebSocketから受信した値も信用せず、server側で検証する。 user
identityや権限はclientのmessageではなくserver-side sessionから決定する。

## セキュリティ

HTTP request、WebSocket、query
parameter、form、JSON、cookieなど外部から受け取る値はすべて信用しない。

- 入力値を境界で検証する
- SQLにはprepared statementを使用する
- passwordをlogへ出さない
- secretをrepositoryへcommitしない
- 独自暗号を実装しない
- production errorで内部実装を漏らさない
- 必要なDeno permissionだけを許可する
- `-A` / `--allow-all` を標準にしない

## Project構成

最初はコンパクトに保つ。

```text
.
├── AGENTS.md
├── README.md
├── deno.json
├── data/
├── migrations/
├── public/
│   ├── index.html
│   ├── app.js
│   └── style.css
├── src/
│   ├── server.ts
│   ├── db.ts
│   └── auth.ts
└── test/
```

必要になるまでdirectoryやlayerを増やさない。 将来用の空directoryや抽象化を作らない。

## Git / .gitignore

実行時に生成されるデータ、DB、secret、temporary fileなどはGitへcommitしない。

新規プロジェクトでは `.gitignore` を作成し、少なくとも以下を除外する。

```gitignore
# Runtime data
data/
*.db
*.db-shm
*.db-wal
*.sqlite
*.sqlite3

# Environment / secrets
.env
.env.*
!.env.example

# Logs / temporary files
*.log
tmp/
temp/

# OS / editor
.DS_Store
```

SQLiteのDB本体やWAL/SHMファイルなど、実行時データをrepositoryへ含めない。

必要なdirectory構成だけをGitで維持したい場合は、実データではなく `.gitkeep` 等を使用してよい。

secretやcredentialをGitへcommitしない。 設定例が必要な場合は、実値を含まない `.env.example`
等を用意する。

新しい永続データや生成ファイルを追加した場合は、それらをcommitすべきか確認し、不要なら `.gitignore`
も同時に更新する。

## Dependency

依存ライブラリを追加する前に、以下で十分実装できないか確認する。

- Deno標準API
- Web標準API
- `node:sqlite`
- 少量のlocal code

小さな機能のためだけにdependencyを追加しない。
dependencyを追加する場合は、その方が明確に単純・安全になる理由が必要。

## Test

Deno標準のtest機能を使用する。

特に以下を優先してtestする。

- authentication
- authorization
- database
- API
- 重要なbusiness rule
- bugのregression test

過剰なmockより、実際の動作に近いintegration testを優先する。 可能ならtemporaryまたはin-memory
SQLiteを使用する。

## Performance / Scale

最初は単一Deno process + local SQLiteで構築する。

早すぎる分散化をしない。

基本的なscale方針は以下。

```text
Deno + SQLite
      ↓
query / index / WAL最適化
      ↓
高速なlocal storage / machine強化
      ↓
必要ならread replicationやpartition
      ↓
write concurrency等が実際に問題になったらDB移行を検討
```

アプリが大きくなったという理由だけでPostgreSQL等へ移行しない。
実際のbottleneckを計測してからarchitectureを複雑化する。

## Coding Style

以下を優先する。

- plain function
- plain object
- 短いmodule
- 明示的で読みやすいcontrol flow
- readableなSQL
- early return
- server側の境界では明確なTypeScript型
- 標準APIの直接利用

以下は必要性が明確でない限り避ける。

- 不要なclass
- dependency injection framework
- decorator
- 深い継承
- 過剰なgeneric
- ORM
- 意味の薄いwrapper
- 将来のためだけの抽象化

現在の要求を満たす最小で分かりやすい実装を選ぶ。

## 変更時のルール

大きめの変更を行う前に、

1. 関連コードを読む
2. schemaを確認する
3. testを確認する
4. 関連documentを確認する
5. 最小の変更方法を考える
6. 実装する
7. 動作確認する

既存動作は、明示的に変更を要求されない限り維持する。 機能追加と無関係なrefactoringを同時に行わない。
diffは小さく保つ。

## 曖昧な依頼への対応

「オシャレなチャットサービスを作って」のように要求が大まかな場合でも、細かな未指定事項ごとに作業を停止しない。

既存コード、仕様、一般的なWebアプリの慣習から合理的な判断を行い、まず動作するMVPを完成させる。

重大な設計判断、不可逆な変更、security上重要な判断など、本当に確認が必要な場合のみ質問する。

大規模な新機能では必要に応じて短い `PLAN.md` を作成してから実装してよい。
小さな変更では不要な計画documentを作らない。

## 完了条件

作業完了前に原則として以下を実行する。

```sh
deno fmt
deno lint
deno check src/server.ts
deno test
```

可能なら実際にserverを起動し、主要な操作が動くことも確認する。

UI変更ではコードを見るだけでなく、実際の画面・操作を確認する。

変更によって発生した問題は修正する。 debug用codeやtemporary fileを残さない。

実際に実行していないtestやcheckを「成功した」と報告しない。

## Codexへの基本方針

実装依頼を受けたら、まずrepositoryを確認してこのファイルに従う。

- serverはTypeScript
- clientはplain JavaScript
- frontendはbuildless
- SQLiteを直接使用
- raw SQLを優先
- frameworkを原則使わない
- dependencyを最小化
- 既存機能を壊さない
- 必要なtestを追加
- 完了前にcheck/testを実行

大きい・危険な変更では、編集前に短く実装方針を整理する。 小さく明白な変更は、そのまま実装してよい。

過剰設計より、すぐ動き、理解しやすく、後から変更しやすい実装を優先する。
