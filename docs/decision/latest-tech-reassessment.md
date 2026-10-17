# 最新技術での再検討: ランタイム / フロントドア / ログ一本化 / ローカル仮想環境

- Status: proposed
- Date: 2026-10-17
- Owner: platform-team
- Related: [api-compute-selection.md](api-compute-selection.md)、[technology-selection-rationale.md](technology-selection-rationale.md)、[ADR-0005](../adr/ADR-0005-api-gateway-http-vs-rest-api.md)、[ADR-0006](../adr/ADR-0006-lambda-event-functions-vs-web-functions.md)、[ADR-0015](../adr/ADR-0015-trace-and-correlation.md)、ADR-0021 / 0022 / 0023（本書で起票候補）
- 調査日: 2026-10-17（すべての出典は同日にアクセス。数値は出典ページの表示値をそのまま転記）

## 0. 目的と方法

### 0.1 目的

既存の技術選定（指針 §14 / §16、ADR-0005 / 0006、api-compute-selection.md）は「出典のある事実」を優先して書かれているが、出典が古いと「古い事実に最適化した選定」になる。本書は、各選定の**本質（何を得たくてその技術を選んだのか）**を取り出し、同じ本質を 2026-10 時点の技術で満たせるかを一次資料で検証する。owner の 4 つの仮説を対象にする。

| #   | 仮説（owner）                                                                                   | 本質                                                         | 判定（詳細は各章）                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | Bun はスクリプト言語の実行性能が最速に近く、API 中継の多いマイクロサービスで最速の可能性がある  | リクエストあたりの CPU 時間と起動時間を最小化したい          | **部分的に不支持**。warm な常駐 HTTP サーバでは Bun が速いが、Lambda では cold start が Node の 2〜3 倍で、managed runtime もない                                         |
| B   | API Gateway は AWS が最近取り組んでいないサービスで、AWS は Lambda 直接アクセスへ舵を切っている | 認証・流量制御・契約境界を薄く安く置きたい                   | **部分的に支持**。HTTP API への新機能は 2024〜2026 年にゼロ。一方 REST API には継続的に機能追加があり、AWS 自身は Web Functions を API Gateway の代替とは位置づけていない |
| C   | ログの集約・一本化が必要                                                                        | 全リクエストを `correlationId` / `tenantId` で横断検索したい | **支持**。ただし一本化の単位は「ログの転送先」ではなく「ログのデータモデル」。X-Ray SDK は 2027-02-25 にサポート終了で OTel 移行が必須                                    |
| D   | オンプレ高スペック機での仮想システム構築（k8s / docker-compose）が必要                          | クラウド往復なしで全経路を再現し高速にフィードバックを得たい | **条件付き支持**。LocalStack 2026.10.0 が Web Functions まで emulate するが、AWS 公式は「エミュレータは控えめに」と明言。k8s は不採用                                     |

### 0.2 方法

1. 既存文書から「採用理由」を本質（性能・費用・運用・契約境界）に分解する。
2. 本質ごとに、AWS What's New / 公式ドキュメント / ベンダー一次資料 / 方法論が明記されたベンチマークで 2026-10-17 時点の事実を確認する。
3. 仮説が事実と食い違う場合は、支持・不支持を根拠付きで明記する。出典のない数値は「既定値（例示値）: … 調整: TD-NN」「計測で確定: … M-NN」（`docs/decision/template-defaults.md`）または「公式ドキュメントに記載なし（確認日、URL）」の形で書く。
4. 結論を「採用 / 実験 / 不採用」と ADR 候補に落とし、§E に担当と期限を置く。

### 0.3 再検討トリガー（定常運用ルール）

次のいずれかに該当した技術選定は、四半期レビューで本書と同じ手順の再検討を必須とする。

- 採用根拠の出典が **24 か月より古い**（例: 2024-10-17 以前）。
- 採用サービスの公式リリースノート / What's New が **12 か月以上更新されていない**（HTTP API はこれに該当。§B）。
- 採用ライブラリ / ランタイムの EOL が **18 か月以内**（Node.js 22 の Lambda deprecation は 2027-04-30。§A）。
- 同じ本質を満たす新サービスが AWS から発表された（Lambda Web Functions 2026-10-12、CloudWatch OTLP logs 2026-03-16 など）。
- ADR の Review date 到来。

## A. ランタイム: Node.js 22 / 24 vs Bun（Deno 参考）

### A.1 Lambda での実行方法

| 項目                            | Node.js                                                                                                                   | Bun                                                                                                                                                                                                                                              | Deno（参考）                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Event Functions managed runtime | `nodejs22.x`（deprecation 2027-04-30）、`nodejs24.x`（2028-04-30）、`nodejs26.x` は public preview（GA 目標 2026-11）[^1] | **なし**。Lambda は「LTS に到達した言語バージョンのみ managed runtime を提供」し、「LTS 予定のないバージョンには提供しない」と明記[^1]                                                                                                           | なし[^1]                                                                           |
| Event Functions での実行手段    | zip（esbuild）または container image                                                                                      | (a) `bun-lambda` custom runtime layer（README は Amazon Linux 2 を前提。`provided.al2` は 2026-07-31 に deprecated）[^6][^1]、(b) container image + Lambda Web Adapter（公式ガイドは `oven/bun:debian` + adapter 1.0.1、`linux/amd64` のみ）[^5] | `deno-lambda` は 2024-09-11 に archive。container + Lambda Web Adapter を推奨[^26] |
| Web Functions runtime           | `nodejs24.x` のみ。custom runtime / container 不可。runtime management control なし[^2]                                   | 不可[^2]                                                                                                                                                                                                                                         | 不可[^2]                                                                           |
| Lambda Web Adapter の位置づけ   | 新規 Node.js Web アプリには Web Functions を推奨                                                                          | 「他のランタイムと container image は adapter を使い続ける」[^25]                                                                                                                                                                                | 同左[^25]                                                                          |

### A.2 公開ベンチマーク（方法論付き）

**cold start（Lambda 実機、日次計測）**: maxday/lambda-perf は毎日各ランタイムを S3 から再デプロイし 10 回 cold start を計測する（us-east-1、zip / image、128〜1,024 MB、x86_64 / arm64）[^15]。2026-10-16 のデータ（`acd` = 平均 cold start、`ad` = 平均 duration、ms）:

| ランタイム / パッケージ       | arch   | 512 MB cold start | 512 MB duration | 備考                             |
| ----------------------------- | ------ | ----------------- | --------------- | -------------------------------- |
| `nodejs22.x` zip              | arm64  | 124.6             | 5.50            |                                  |
| `nodejs24.x` zip              | arm64  | 117.6             | 4.92            |                                  |
| bun zip（provided.al2）       | arm64  | 290.2             | 29.67           | Node の約 2.3 倍                 |
| bun layer zip（provided.al2） | x86_64 | 447.7             | 12.58           | arm64 計測なし                   |
| bun container image           | arm64  | 259.2             | 27.81           | 256 MB では 158.3                |
| llrt zip（provided.al2023）   | arm64  | 75.4              | 1.60            | AWS Labs の実験的ランタイム[^24] |

[^15]

**cold start（第三者、2025-05-22）**: Jason Butz の計測（SQS トリガ、SHA3-512 × 50 / invocation、各 70 cold start）で平均 init は Node.js 22 152.0 ms、Deno 267.5 ms、Bun（layer）547.7 ms、平均 duration は Node 21.3 / Deno 13.7 / Bun 50.5 ms[^16]。Deno 公式ブログ（2024-07-25、container + Web Adapter、512 MB）は「Docker では Deno の cold start が Node と Bun より一貫して速い」とするがベンダー計測である[^17]。

**warm スループット（常駐サーバ、ベンダー計測）**: bun.sh トップページの「Serving Express over HTTPS」（hello-world、express 5.2.1、`bombardier -c 50 -d 5s`、TLS 1.3、Linux x64 EPYC 9R14、3 回の中央値）は Bun v1.4 48,243 req/s（105 MB）、Node.js v26.7.0 25,181 req/s（142 MB）、Deno v2.9.5 19,243 req/s（176 MB）[^18]。中立的な TechEmpower は 2026-03-24 にプロジェクトを sunset し、リポジトリは archive された[^19]。2026 年の独立系ブログの数値はハードウェア・バージョン・負荷ツールが未記載のものしか見つからず、**方法論付きの独立 warm ベンチマークは 2026-10-18 時点でも見つからない**（TechEmpower archive 後の代替なし）。本テンプレートに効く数値は計測で確定: ADR-0006 の event-vs-web benchmark（M-06、未計測）。

**読み方**: 「Bun が最速」は warm な常駐プロセスの hello-world では成り立つ（約 1.9 倍）。Lambda Event Functions では 1 invocation = 1 リクエストで cold start と init が支配的になり、Bun は Node の 2〜3 倍遅い。Web Functions（1 環境で最大 128 並列、環境が長寿命）なら warm 性能が効くが、Web Functions は `nodejs24.x` 固定で Bun を載せられない[^2]。本テンプレートの API は DynamoDB 往復が duration の大半を占める I/O bound なので、JS エンジンの差がレイテンシに出る余地は小さい（**計測で確定: ADR-0006 benchmark で `EnvironmentCPUTime / EnvironmentActiveTime` を計測する。docs/decision/template-defaults.md#計測で確定する項目 M-06、現在は未計測**）。

### A.3 互換性と運用リスク

| 観点               | Node.js 24                                                                                                                                                        | Bun 1.4.3（2026-10-10）[^7]                                                                                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| LTS / EOL          | 24.x は 2025-10-28 に Active LTS、2026-10-20 に Maintenance、EOL 2028-04-30。22.x は Maintenance、EOL 2027-04-30。26.x は 2026-10-28 に Active LTS 予定[^20][^21] | **LTS ポリシーなし**。endoflife.date は「明確なサポートポリシーがない」と記載[^8]。SemVer / LTS 要望 issue #6438 は 2023-10 から open で、メンテナは「古いバージョンへの backport は当面ありそうにない」と回答[^9] |
| セキュリティパッチ | Lambda が managed runtime に自動適用[^1]                                                                                                                          | サポート対象は「1.x.x」のみ。GitHub Security Advisories の公開実績ゼロ[^10]                                                                                                                                        |
| AsyncLocalStorage  | 24.0.0 から `AsyncContextFrame` が既定[^21]。本テンプレートの request-scoped context（Web Functions）の前提                                                       | `node:async_hooks` は `createHook` / `executionAsyncId` 等が stub、「AsyncLocalStorage context を MessagePort / BroadcastChannel / Worker に伝播しない」[^11]                                                      |
| AWS SDK v3         | Lambda runtime が特定 minor を同梱、bundle 推奨[^1]                                                                                                               | issue #26066「HTTPS requests hanging（1.2.23→1.3.x regression）」が 2026-01-14 から open、AWS SDK v3 で再現報告あり[^12]。AWS SDK チームは Bun を公式ドキュメントに含める「計画なし」[^13]                         |
| Powertools         | 公式サポート                                                                                                                                                      | Tenets に「AWS Lambda only。supported runtimes のみ最適化、Web framework / 非 Lambda 環境は非公式」[^14]                                                                                                           |
| `node:crypto`      | OpenSSL                                                                                                                                                           | BoringSSL ベースで ed448 / x448 / rsa-pss / secp256k1 / chacha20-poly1305 等が欠落[^11]。JWT 検証ライブラリの algorithm 依存に注意                                                                                 |
| `perf_hooks`       | 利用可                                                                                                                                                            | `eventLoopUtilization()` が常に 0 を返す[^11]（Web Functions の event loop block 検出に使えない）                                                                                                                  |
| bundler            | esbuild（CDK `NodejsFunction`）                                                                                                                                   | `bun build --target=node` は Bun 固有 API を使わなければ Node で動く。`bytecode` は `target: "bun"` 限定[^23]                                                                                                      |
| TypeScript 実行    | 22.18.0 から type stripping が既定（`enum` / parameter properties 等は非対応、型検査なし）[^22]                                                                   | ネイティブ実行、`bun check` 型チェッカ（1.4.3）[^7]                                                                                                                                                                |

### A.4 判定

- **Node.js 24 を Event / Web 両プロファイルの標準ランタイムにする（採用）。** 理由: Web Functions が `nodejs24.x` 固定[^2]、Node 22 の Lambda deprecation が 2027-04-30[^1]、Node 24 の `AsyncContextFrame` が request-scoped context の前提[^21]。指針 §16 の「Node.js 22」と esbuild `target: node22` を `node24` へ更新する。Node 24 は callback 形式の handler をサポートしない[^4]ため移行時に lint で検出する。
- **Bun を Lambda ランタイムとして採用しない（不採用）。** managed runtime がなく[^1]、Web Functions に載らず[^2]、cold start が 2〜3 倍[^15][^16]、LTS / セキュリティポリシーがなく[^8][^9][^10]、AWS SDK v3 の HTTPS hang が open[^12]、Powertools が非対象[^14]。owner の仮説の本質（リクエストあたり CPU 最小化）は、Lambda では「arm64 + esbuild bundle 最小化 + Node 24」で満たす。
- **Bun を開発ツール（package manager / test runner / bundler）として使うことも当面見送る（実験枠）。** pnpm + vitest + esbuild で CI が成立しており、2 系統化の保守費が利益を上回る根拠がない。Node 互換テストが `bun test` で通るかの実験は `tools/` 配下で許可する。
- **LLRT は不採用。** AWS Labs 自身が「experimental。評価目的のみ」と明記[^24]。
- **ECS/Fargate プロファイル（ADR-0009）では Bun を候補にしてよい。** 常駐サーバでは warm 性能の差が出るため、ADR-0009 の benchmark に Bun container を 1 候補として含める。
- **再検討トリガー**: AWS が Bun を managed runtime または Web Functions runtime に追加、Bun が LTS ポリシーを公開、issue #26066 の修正。

ADR 候補: **ADR-0021 Runtime: Node.js 24 標準化と Bun 不採用**。

## B. フロントドア: API Gateway vs Web Functions 直接 vs Function URL + CloudFront vs ALB

### B.1 仮説の検証: API Gateway の 2024〜2026 年のリリース

AWS What's New の API Gateway タグ付き発表を 2024-01 から 2026-10-17 まで数えた（JSON フィード[^27]）。

| 年                | 件数 | 主な発表（日付）                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2024              | 6    | TLS 1.3（02-15）、integration timeout 29 秒超（06-04、Regional / Private REST API）[^36]、private REST API の custom domain（11-21）、WebSocket リージョン拡張 ×2、Verified Permissions 連携（Cognito 主導）                                                                                                                                                                                           |
| 2025              | 9    | HTTP API / mTLS / WAF のリージョン拡張（03-03）、dual-stack IPv6（03-31、REST / HTTP / WebSocket）[^35]、**routing rules for REST APIs**（06-03）[^30]、**response streaming for REST APIs**（11-19）[^28]、TLS security policies（11-19）、**Developer Portal**（11-19）[^34]、**ALB private integration for REST**（11-21）[^33]、**MCP proxy**（12-02）[^29]、SAM の private custom domain（04-08） |
| 2026（10 月まで） | 3    | SAM の WebSocket 対応（05-05）、**backend mTLS for REST**（09-08）[^31]、**1 MB execution logs**（09-10）[^32]                                                                                                                                                                                                                                                                                         |

**所見**:

- 「API Gateway に最近取り組んでいない」は**サービス全体については不支持**。2025-06 以降だけで REST API に routing rules、response streaming、Developer Portal、ALB 統合、MCP proxy、backend mTLS、1 MB 実行ログが追加されている。
- **HTTP API（本テンプレートの標準）については支持**。期間中 HTTP API 固有の新機能はゼロで、リージョン拡張と dual-stack のみ。REST API と HTTP API の機能差（usage plan、WAF 直接、caching、request validation、X-Ray、response streaming、canary）は 2026-10-17 の比較表でも変わっていない[^37]。
- 「Lambda 直接アクセスへ舵を切っている」は**部分的に支持**。Function URL の CloudFront OAC（2024-04-11）、Web Functions と CloudFront OAC（2026-10-12）[^42]と直接経路は強化されている。しかし AWS 公式の判断ページは「Function URL は単純なアプリや prototyping 向け、API Gateway は production at scale 向け」と明記し[^38]、Web Functions のドキュメントは API Gateway の置き換えを主張せず「custom domain と WAF が必要なら CloudFront を前置」とだけ書いている[^41]。AWS Builder Center の記事も「API Gateway やコンテナの自動的な代替ではない」としている[^52]。

### B.2 マルチテナント PaaS の必須機能 × 経路

◎ 標準機能 / ○ 他サービスで補完 / △ アプリ実装 / × 不可

| 機能                           | HTTP API + Event                             | REST API + Event                   | Web Functions 直接（CloudFront + OAC）                                                                                                                               | Function URL + CloudFront                       | ALB + Lambda                                                        |
| ------------------------------ | -------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------- |
| JWT authorizer                 | ◎ native（RSA のみ）[^37]                    | ○ Lambda authorizer[^37]           | △ `ApplicationManaged` か、`IamAuth` + CloudFront が Authorization ヘッダを透過しアプリで検証[^39]                                                                   | △ アプリ実装                                    | ○ OIDC / Cognito（ブラウザリダイレクト型、`x-amzn-oidc-data`）[^46] |
| usage plan / tenant throttling | × （authorizer + サービス側）[^37]           | ◎ API key + usage plan[^37]        | △ endpoint `rateLimit`（100〜10,000 RPS、全テナント共通）[^40]、tenant 別はアプリ                                                                                    | △ reserved concurrency × 10 = RPS 上限のみ[^38] | △ アプリ                                                            |
| WAF                            | ○ CloudFront 経由（WAF 関連付け対象外）[^45] | ◎ 直接[^45]                        | ○ CloudFront 経由[^42]                                                                                                                                               | ○ CloudFront 経由                               | ◎ 直接[^45]                                                         |
| custom domain                  | ◎                                            | ◎                                  | ○ CloudFront 必須（直接付与不可）[^40]                                                                                                                               | ○ CloudFront 必須                               | ◎ ACM                                                               |
| mTLS（クライアント）           | ◎[^37]                                       | ◎ + backend mTLS（2026-09）[^31]   | ×（PrivateLink も不可）[^40]                                                                                                                                         | ×                                               | ◎ passthrough / verify[^47]                                         |
| private API                    | ×[^37]                                       | ◎                                  | × IPv4 public egress のみ[^40]                                                                                                                                       | ×（PrivateLink 非対応）[^38]                    | ◎ internal ALB                                                      |
| response streaming             | ×[^37]                                       | ◎（2025-11、最大 15 分）[^28]      | ◎ native                                                                                                                                                             | ◎                                               | × 1 MB 応答上限[^46]                                                |
| X-Ray segment                  | × Lambda が root                             | ◎                                  | × Lambda segment なし（OTel 自前送信）[^75]                                                                                                                          | × Lambda が root                                | ×                                                                   |
| 料金（US East、リクエスト）    | $1.00 / 100 万（3 億超 $0.90）[^49]          | $3.50 / 100 万（3.33 億まで）[^49] | Lambda 側 $0.30 / 100 万 + CloudFront[^49][^50]                                                                                                                      | CloudFront のみ                                 | $0.0225 / 時 + LCU（Lambda-only 例で約 $0.34 / 100 万）[^48]        |
| CloudFront 費用形状            | —                                            | —                                  | flat-rate: Free $0（100 万 req）/ Pro $15 / Business $200 / Premium $1,000、WAF ルール枠込み、超過課金なし（2025-11-18）[^50]。PAYG は HTTPS $0.0100 / 1 万 req[^50] | 同左                                            | —                                                                   |
| IaC                            | CDK L2                                       | CDK L2                             | CDK L1 のみ（L2 は PR #39210 open）                                                                                                                                  | CDK L2                                          | CDK L2                                                              |

補足: Web Functions の OAC は `always-amz-auth` 固定で、PUT / POST / PATCH は `UNSIGNED-PAYLOAD` で署名されるため、Function URL + OAC で必要だった `x-amz-content-sha256` ヘッダの計算がクライアントに不要になった[^43][^44]。`aws lambda-web deploy` の既定は `ApplicationManaged`（公開 endpoint）なので、SCP で `lambda:Request/WebFunctionAuthType = ApplicationManaged` を Deny する[^39]。

### B.3 判定

- **標準経路は `CloudFront/WAF → API Gateway HTTP API → Lambda Event Functions` を維持（採用、変更なし）。** B2B PaaS の契約境界（JWT authorizer、stage、access log、custom domain、mTLS）を最小の自前コードで満たす経路は依然これだけであり、AWS 自身も production では API Gateway を推奨している[^38]。
- **HTTP API 停滞への対処**: tier 別 quota、response streaming、private API のいずれかが契約要件になったサービスは、Web Functions ではなく **REST API** を第一候補とする（ADR-0005 の `apiType: 'rest'`）。2025〜2026 年の新機能はすべて REST API 側に入っているため[^28][^30][^31][^33]。
- **Web Functions 直接経路（CloudFront + OAC + IamAuth）を standard に昇格させる条件**（すべて満たすまで `experimental-web`）:
  1. ADR-0006 の benchmark に合格している。
  2. `@paas/runtime-context` にアプリ側 JWT 検証（JWKS キャッシュ、`iss` / `aud` / `exp` / `scope`）と tenant 別 token bucket が入り、`@paas/testing` の contract test で HTTP API JWT authorizer と同じ拒否挙動が検証されている。
  3. CDK L2 `WebFunction` と CloudFront `WebFunctionOrigin` がリリースされている（現在 PR #39210 open。api-compute-selection.md §5.4）。
  4. §C の OTel パイプラインが稼働し、X-Ray segment なしでも `correlationId` 全件検索と trace が成立している[^75]。
  5. mTLS / private API を要求するテナントがその API にいない[^40]。
- **Function URL + CloudFront は従来どおり内部 webhook 等の例外のみ**（ADR-0005 C 案）。Web Functions が同じ経路をより良い条件（UNSIGNED-PAYLOAD、`rateLimit`、`maxEnvironments`）で提供するため、新規の streaming 用途は Web Functions 側で実験する。
- **ALB + Lambda は不採用のまま**。1 MB 応答上限[^46]、JWT Bearer 検証の不在[^46]、固定費が理由。
- **再検討トリガー**: HTTP API に usage plan / streaming が追加された、Web Functions に custom domain / WAF 直接付与 / mTLS が追加された、CDK L2 リリース。

ADR 候補: ADR-0005 / ADR-0006 の Review（新規 ADR は不要）。本書 §E で改訂項目を列挙する。

## C. ログ集約・一本化

### C.1 「一本化」の単位を決める

本テンプレートの本質は「全リクエスト・イベントを `correlationId` / `tenantId` で横断検索できること」（指針 §14）であり、転送先を 1 つにすることではない。2026-10-17 時点で転送先の選択肢は増えたが、**データモデル（構造化 JSON + 必須フィールド）を不変にし、転送先を差し替え可能にする**のが一本化の正しい単位である。根拠となる事実:

- Lambda Event Functions は JSON log format と log level filtering を runtime 側で持ち、`level` キーのある JSON をそのまま取り込む。Powertools / EMF ライブラリは最新版が必要[^61][^62]。
- Web Functions は `console.*` 出力を JSON log event で包み `requestId` / `endpointName` / `region` を自動付与する。log group は `/aws/lambda/web/{fn}` と `.local`（リージョン側）の 2 系統で、`.local` と集約先の両方で Logs 課金が発生（最初の集約は無料）。EMF は `console` ではなく `process.stdout.write` で出す必要がある[^74][^75][^76]。
- Web Functions は Lambda segment を生成せず、Extensions API / Telemetry API の記載がない。X-Ray へは「アプリコードから ADOT 等で直接送る」[^75]。
- **X-Ray SDK / Daemon は 2026-02-25 に maintenance mode、2027-02-25 にサポート終了。AWS は OpenTelemetry への移行を推奨**[^70]。Powertools Tracer は X-Ray SDK に依存しており、本テンプレートは 2027-02 までに trace 経路を OTel へ切り替える必要がある。

### C.2 2024〜2026 年に増えた CloudWatch の能力

| 能力                           | 内容と日付                                                                                                                                                                                                                                                                                                                                                                                                                                           | 本テンプレートでの使い方                                                                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Field indexes（2024-11-20）    | log group あたり 20 フィールド、30 日間インデックス、Standard class の取り込み料金に含まれ追加費用なし。Logs Insights は最大 10,000 log group を横断[^55]                                                                                                                                                                                                                                                                                            | `correlationId` / `tenantId` / `requestId` / `eventId` を全 log group で index する                                                            |
| Transformers（2024-11-20）     | 取り込み時にログを変換・enrich。Standard class のみ、512 KB 未満、追加料金なし[^56]                                                                                                                                                                                                                                                                                                                                                                  | `tenantId` 欠落ログの補完や key 名の統一（Web Functions の `requestId` を `lambdaRequestId` に rename 等）                                     |
| Infrequent Access class        | 取り込み単価が Standard の 50% 低い。EMF、metric filter、Live Tail、subscription filter、field index が使えない。作成後に class 変更不可[^57]                                                                                                                                                                                                                                                                                                        | audit log / archive 用。アプリログは EMF を併用するため Standard                                                                               |
| Data protection                | 取り込み時に PII を検出・マスク、`logs:Unmask` 権限者のみ閲覧可、アカウント全体ポリシー可。スキャン $0.12 / GB[^58][^73]                                                                                                                                                                                                                                                                                                                             | `@paas/observability` の redaction の後段の保険として account policy を置く                                                                    |
| Cross-account observability    | monitoring account は最大 100,000 source account、source は最大 5 monitoring account。logs / metrics / Application Signals は追加費用なし、trace は最初のコピー無料[^59]                                                                                                                                                                                                                                                                             | 中央 observability アカウントへ集約。ADR-0003 のアカウント構成に monitoring account を追加                                                     |
| Logs Insights 追加機能         | cross-account / cross-region 集約（2025-09-17）、Facets（2025-12-02）、`estimate`（2026-07-22）[^86]                                                                                                                                                                                                                                                                                                                                                 | tenant 別のログ量見積りと費用配賦                                                                                                              |
| OTLP endpoints                 | logs `https://logs.{region}.amazonaws.com/v1/logs`（`x-aws-log-group` / `x-aws-log-stream` ヘッダ必須、SigV4 または Bearer）、metrics `monitoring.../v1/metrics`、traces `xray.../v1/traces`（SigV4 のみ）。HTTP のみで gRPC 非対応[^67]。X-Ray OTLP は 2024-11-22[^66]、HTTP log collector（OTLP logs 含む）は 2026-03-16 に 4 リージョン[^68]、OTel metrics は 2026-04-02 に public preview（preview 中は無料、料金ページは $0.50 / GB）[^69][^73] | Web Functions と Fargate の trace / log 送信先                                                                                                 |
| Transaction Search             | 100% の span を `aws/spans` log group に取り込み、既定で 1% を無料 index。取り込み $0.35 / GB、index $0.75 / 100 万 span[^71][^73]                                                                                                                                                                                                                                                                                                                   | sampling 依存を減らす。`correlationId` を span attribute に入れる                                                                              |
| Application Signals for Lambda | Node.js 18 / 20 / 22（**24 は未記載**）、layer + `AWS_LAMBDA_EXEC_WRAPPER=/opt/otel-instrument`、SLO 定義可、$1.50 / 100 万 signals（最初の 1 億）[^72][^73]。Web Functions 対応の記載なし[^75]                                                                                                                                                                                                                                                      | Event Functions の SLO。Node 24 対応は公式ドキュメントに明示なし（ADOT の Lambda layer は「Node.JS v18+」とのみ記載。確認日 2026-10-18[^128]） |

### C.3 第三者 backend への一本化パターン

| パターン                                                                     | 仕組み                                                                                                                                                   | Event Functions   | Web Functions                                                                   | 評価                                                                                                    |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Lambda Extension 型（Datadog）                                               | Extension が Telemetry API でログを収集し CloudWatch を経由せず送信。Node 18〜26 対応、Extension v99[^78]                                                | ◎                 | × Extensions API の記載なし[^75]、Datadog docs に Web Functions の記載なし[^78] | Event 専用。Web Functions と混在する本テンプレートでは標準にしない                                      |
| ADOT legacy layer + in-layer collector（Honeycomb 等）                       | `AWS_LAMBDA_EXEC_WRAPPER=/opt/otel-handler`、collector 設定で OTLP を外部へ。ADOT 自身が「legacy。CloudWatch 以外へ送る場合以外は非推奨」[^63][^64][^79] | ○                 | ×（layer なし）                                                                 | 同上                                                                                                    |
| in-process OTel SDK → OTLP（Grafana Cloud 等）                               | `@opentelemetry/sdk-node` が直接 OTLP HTTP で送信。Grafana は ADOT → Alloy gateway → Grafana Cloud を案内[^80]                                           | ○（flush 設計要） | ◎ 唯一の経路[^75]                                                               | **Web Functions 互換の唯一のパターン**。OTel JS は traces / metrics が Stable、logs は Development[^81] |
| CloudWatch を一次集約、backend へは monitoring account の Collector から転送 | Lambda は stdout → CloudWatch（egress 設計不要）。中央アカウントの OTel Collector が Logs subscription / OTLP で外部 backend へ                          | ◎                 | ◎                                                                               | 関数側の実装が runtime profile に依存しない。backend 変更が関数の再デプロイを伴わない                   |

### C.4 tenant 別のログ分離・保持・費用

- **分離の単位は log group ではなくフィールド + field index**。Lambda の tenant isolation 機能は JSON logging 有効時に `tenantId` を自動付与し、Logs Insights で `filter tenantId=='...'` を推奨している[^84]。SaaS Lens も「tenant context をログとメトリクスに注入する」パターンを示す[^85]。log group は 1 アカウントあたり 100 万まで作れる[^60]が、テナント単位の log group は retention / data protection / subscription の設定数がテナント数に比例して増えるため、**premium tier の「ログ分離契約」がある場合のみ** subscription filter → tenant 専用 S3 で分離する。
- **保持**: 指針 §14 の 3 種（trace 30 日、access / app log 90 日、audit 1 年以上）を維持。audit log は Infrequent Access class の別 log group に出す（EMF を使わないため）[^57]。
- **費用配賦**: Logs Insights `stats sum(messageSize(@message)) by tenantId` で tenant 別の取り込み量を月次集計し ADR-0018 の cost attribution に渡す（2026-10-18 確認: `strlen` は Unicode code point 数、`messageSize` は byte 長を返すため取り込み量には後者を使う。`estimate` コマンドはクエリを実行せずに scan 予定 byte 数を返すもので、取り込み量の集計ではなくクエリ費用の事前見積りに使う[^129][^130]）。`tenantId` を CloudWatch Metrics dimension にしない原則は維持（EMF 仕様も高 cardinality を警告[^54]）。
- **Web Functions の二重課金**: `.local` と home region の両方で Logs 課金が発生するため[^75]、`.local` の retention を短く（例: 3 日）設定する。

### C.5 判定: `@paas/observability` の進化計画

| フェーズ | 期限    | 内容                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | 2026-12 | **データモデル固定**: 指針 §14 の必須フィールドを `@paas/observability` の zod schema として公開し、Event / Web / Fargate の全 preset が同じ schema を出すことを contract test で保証。Web preset は `process.stdout.write` で EMF を出す[^76]。全 log group に field index（`correlationId` / `tenantId` / `requestId` / `eventId`）と data protection policy を `ObservableFunction` が自動設定                               |
| 2        | 2027-01 | **trace を OTel 化（X-Ray SDK 終了 2027-02-25 より前）**[^70]: Event Functions は Application Signals layer（Node 24 は公式に明示なし、layer は「Node.JS v18+」[^72][^128]）、Web / Fargate は `@opentelemetry/sdk-node` → CloudWatch OTLP traces endpoint[^67]。Powertools Tracer への依存を `@paas/observability/trace` の adapter に閉じ込め、Powertools の OTel 対応（RFC #4184、Tracer のみ、open[^83]）が出たら差し替える |
| 3        | 2027-03 | **中央集約**: monitoring account を作り cross-account observability で logs / metrics / traces を集約[^59]。第三者 backend は monitoring account の OTel Collector から OTLP で転送（C.3 第 4 パターン）。関数側は CloudWatch 固定のまま                                                                                                                                                                                        |
| 4        | 任意    | **logs の OTLP 化は見送り**: OTel JS logs は Development[^81]、Lambda からの直接 OTLP logs は egress / flush 設計が必要で、stdout → CloudWatch より利点がない。Transaction Search で 100% span を持つ方が `correlationId` 検索の補完として有効[^71]                                                                                                                                                                             |

ADR 候補: **ADR-0022 Observability pipeline（OTel 移行と中央集約）**。ADR-0015 を supersede する。

## D. ローカル仮想環境

### D.1 エミュレータの対応状況（2026-10-17）

| 対象                      | LocalStack（2026.10.0、2026-10-13）[^87]                                                                                                                                                                                                                                                                                                            | その他                                                                                                                                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lambda Event Functions    | Docker socket マウント必須。Function URL の response streaming 非対応。Layers は Pro。hot reload は `hot-reload` bucket + 絶対パス、検出まで最大 700 ms[^90]                                                                                                                                                                                        | SAM local は Event Functions のみ、authorizer は「AWS との 100% の忠実度を保証しない」、「できる限り cloud でテストせよ」と明記[^107]。RIE は Linux x86_64 / arm64 のみ[^109]。base image は 22 / 24 / 26[^110] |
| Lambda Web Functions      | **対応**（Hobby 以上）。`nodejs24.x` のみ、`node:24-slim` コンテナ、2 CPU / 2 GiB、hot reload（約 1 秒、Kubernetes 実行時は不可）、IamAuth、revision 重み付け、20 / 20 operations。制限: endpoint ドメインは `localhost.localstack.cloud`、request body は非ストリーミング、quota は報告のみで未強制、CORS 設定は endpoint に適用されない[^88][^89] | SAM CLI 1.169.0 に Web Functions の記載なし[^108]。AWS 公式のローカルテストは `AWS_LAMBDA_HTTP_ENDPOINT=127.0.0.1:3000 node index.js` + 同時リクエスト負荷[^113]                                                |
| API Gateway HTTP API      | 72 / 103 operations、**Base plan 以上**。authorizer 結果のキャッシュなし、resource policy 未評価、usage plan の throttling 未強制、response streaming 非対応、throttling / caching / access log / X-Ray 設定は無視[^91]                                                                                                                             | —                                                                                                                                                                                                               |
| API Gateway REST API      | 111 / 124 operations、Hobby 以上（WebSocket / custom domain は Pro）[^91]                                                                                                                                                                                                                                                                           | —                                                                                                                                                                                                               |
| DynamoDB + Streams        | DynamoDB Local を内蔵。Streams は Hobby 以上だが **persistence 非対応**[^92][^93]                                                                                                                                                                                                                                                                   | DynamoDB Local 3.3.2（2026-10-15）: PITR なし、provisioned 設定無視、parallel scan 非対応、`TransactionConflictException` を投げない、tagging 非対応、Streams の shard 生成レートが異なる[^111][^112]           |
| EventBridge               | Hobby 以上。archive / replay 実装済み。Pipes は **Ultimate**。Scheduler は配信 1 回のみ（retry なし）[^94][^95]                                                                                                                                                                                                                                     | Schema Registry は公式ドキュメントに記載なし（services 一覧に項目がなく、`/aws/services/schemas/` と coverage ページは 404。確認日 2026-10-18[^131]）                                                           |
| SQS                       | 23 / 23 operations、DLQ / redrive 対応、`/_aws/sqs/messages` で visibility を変えずに覗ける[^96]                                                                                                                                                                                                                                                    | —                                                                                                                                                                                                               |
| Step Functions            | 35 / 37 operations（RedriveExecution 未実装）、**persistence 非対応**、`SFN_MOCK_CONFIG` で Task をモック[^97]                                                                                                                                                                                                                                      | AWS 公式 Step Functions Local は「unsupported、feature parity なし」。代替は TestState API（2025-11 からサービス統合のモック、Map / Parallel / `.sync` / `.waitForTaskToken` のテスト対応）[^114][^115]         |
| CloudWatch Logs / Metrics | Logs 58 / 118、Metrics 20 / 55。composite alarm 未評価、anomaly detection 非対応。**EMF は公式ドキュメントに記載なし（CloudWatch ページに Embedded Metric Format / metric filter の記述なし。確認日 2026-10-18）**[^98][^99]                                                                                                                        | —                                                                                                                                                                                                               |
| X-Ray                     | **Ultimate** のみ、10 / 38 operations、「同じ trace_id の segment を相関しない」[^100]                                                                                                                                                                                                                                                              | —                                                                                                                                                                                                               |
| IAM                       | `ENFORCE_IAM=1` で有効化（既定 off）、Base 以上。`IAM_SOFT_MODE` で拒否せず評価のみ[^101]                                                                                                                                                                                                                                                           | —                                                                                                                                                                                                               |
| 料金 / 配布               | Hobby 無料（非商用、persistence なし）、Base $39 / license / 月（年契約）、Ultimate $89。2026-03-23 以降はイメージ起動に auth token 必須[^102][^127]。2026-03 から calendar versioning（`YYYY.MM.patch`）、月次リリース[^103]                                                                                                                       | cdklocal は **deprecated**、`lstk cdk` へ[^106]                                                                                                                                                                 |
| Kubernetes                | Helm chart あり。Lambda / ECS を Pod として動的生成する公式サポートは **Enterprise（または Kubernetes pack add-on）のみ**[^104]                                                                                                                                                                                                                     | —                                                                                                                                                                                                               |

### D.2 AWS 公式の線引き

- Lambda Testing Guide: 「cloud-based tests が品質の最も正確な尺度」「ローカルで cloud 環境を完全に再現することはできない（queue、table、event bus、security policy）」「**エミュレータは控えめに使う**。使う場合も設定検証のため cloud でテストが必要」「エミュレータの機能と API はサービス更新に遅れる」[^124]。
- Prescriptive Guidance: 「できる限り cloud でのテストに集中する」「理想は開発者ごとに専用 AWS アカウント」「ネットワークが遅い・不安定なチームや規制産業ではエミュレーションが gap を埋める。それ以外では選択的に使う」[^125]。
- serverless-test-samples: 「エミュレーションは実 cloud リソースに対するテストの代替ではない」「DynamoDB のような一部サービスのエミュレーションは高速フィードバックに有効」[^126]。
- Web Functions testing: 「ほとんどのアプリ挙動はフレームワークの通常ツールでローカルテストできる。IAM、S3 / KMS アクセス、lifecycle、scaling、telemetry、multi-Region は cloud テストが必要」[^113]。

### D.3 構成案

**L1: アプリ層 compose（全開発者、無料、エミュレータなし）** — `docker compose -f tools/local/compose.app.yaml up`

| サービス    | イメージ / 版                                                                                          | 役割                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `order-web` | `node:24-slim`、`AWS_LAMBDA_HTTP_ENDPOINT=0.0.0.0:3000`                                                | Web Functions と同じ起動経路で `server.ts` を実行[^113]。Event handler は vitest から直接呼ぶ |
| `dynamodb`  | `amazon/dynamodb-local`（3.3.2）、`-sharedDb`[^111]                                                    | adapter の高速確認。Streams は shard レートが異なる前提で使う[^112]                           |
| `otel-lgtm` | `grafana/otel-lgtm`（Collector + Prometheus + Tempo + Loki + Grafana、「開発・デモ・テスト用」）[^119] | OTLP 4317 / 4318 受け。§C の OTel 経路をローカルで通す                                        |
| `k6`        | `grafana/k6` 2.3.0、`--out opentelemetry`[^123]                                                        | Web Functions の同時 64 リクエスト smoke（api-compute-selection.md §9.2）                     |

**L2: システム層 compose（高スペック機、LocalStack Base 以上）** — `compose.system.yaml` を L1 に重ねる

| サービス                  | 設定                                                                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `localstack`              | `localstack/localstack:2026.10`、`/var/run/docker.sock` マウント、`LOCALSTACK_AUTH_TOKEN`、`PERSISTENCE=1`、`ENFORCE_IAM=1`、`LAMBDA_WEB_IGNORE_ARCHITECTURE=0`（arm64 を AWS と同様に要求）[^89][^101][^105] |
| デプロイ                  | `lstk cdk deploy`（cdklocal は deprecated）[^106]。HTTP API + Event Functions + Web Functions + DynamoDB + Streams + EventBridge + SQS + Step Functions を 1 コマンドで構築                                   |
| OTel Collector（contrib） | `awsemf`（beta）/ `awsxray`（beta）/ `awscloudwatchlogs`（alpha）exporter の `endpoint` を LocalStack に向ける[^122]。X-Ray は Ultimate のみなので Base では Tempo へ                                         |
| 対象外                    | EventBridge Pipes（Ultimate）、X-Ray（Ultimate）、Schema Registry（公式ドキュメントに記載なし、2026-10-18[^131]）、Step Functions の persistence                                                              |

**k8s 案（kind / k3d + Knative）**: kind v0.33.0（Kubernetes 1.37）[^117]、k3d 5.9.0[^118]、Knative Serving 1.23（Kubernetes 1.34 以上、scale-to-zero 既定 on、grace period 30 秒）[^116]で同じ Node HTTP サーバを動かすことは技術的に可能。しかし (1) 本テンプレートの実行モデルは Lambda であり k8s は第 3 の実行モデルを増やす、(2) LocalStack の Lambda-on-Kubernetes は Enterprise 限定[^104]、(3) Web Functions のローカル検証は compose で足りる[^89][^113]。**不採用**とし、ADR-0009 で Fargate プロファイルを採用した場合のみ再検討する。

### D.4 何をローカルで検証し、何を本物の AWS で検証するか

| 検証項目                                                      | L1（compose） | L2（LocalStack）             | 実 AWS（ephemeral） | 根拠                                                                    |
| ------------------------------------------------------------- | ------------- | ---------------------------- | ------------------- | ----------------------------------------------------------------------- |
| domain / application の unit、contract（provider / consumer） | ◎ 唯一        | —                            | —                   | 指針 §16                                                                |
| DynamoDB adapter の key 設計、条件式                          | ◎             | ○                            | ○ 最終              | DynamoDB Local は `TransactionConflictException` を投げない[^112]       |
| Web Functions の同時リクエスト / global state / event loop    | ◎             | ○                            | ○ scaling は cloud  | AWS 公式[^113]                                                          |
| HTTP API ルーティング、authorizer の有無                      | —             | ○ TTL / policy は未評価[^91] | ◎ 最終              | LocalStack の制限                                                       |
| EventBridge rule → SQS → Lambda → Step Functions の経路       | —             | ◎ 高速フィードバック         | ◎ 最終              | Pipes / X-Ray は Ultimate[^95][^100]                                    |
| `correlationId` 全経路検索（指針 §14 受入基準）               | ○ Loki で近似 | ○ LocalStack Logs            | ◎ 唯一の正          | Logs Insights の field index / cross-account はローカルにない[^55][^59] |
| IAM 境界、`dynamodb:LeadingKeys`、tenant-isolation            | —             | △ `ENFORCE_IAM`[^101]        | ◎ 唯一の正          | AWS 公式「IAM / quota は一般に emulate されない」[^125]                 |
| throttle、同時実行 quota、Streams 順序、cold start、費用      | —             | ×（quota 未強制[^89]）       | ◎ 唯一              | 指針 §16「LocalStack は最終保証ではない」                               |
| Web Functions の lifecycle / multi-Region / telemetry         | —             | △ home region 固定[^89]      | ◎ 唯一              | AWS 公式[^113]                                                          |

### D.5 判定

- **L1 を全サービスの標準ローカル環境にする（採用）。** `create-service` が `compose.app.yaml` と k6 smoke を生成する。
- **L2 を「高スペック機 + LocalStack Base」のオプションとして採用（採用、個人ライセンス）。** 対象は EventBridge / SQS / Step Functions をまたぐ経路の高速フィードバックと、`lstk cdk deploy` による CDK テンプレートの早期検証。Ultimate は X-Ray / Pipes が必要なチームのみ。
- **ephemeral AWS 環境を最終保証にする原則は変更なし。** 指針 §16 の「LocalStack 等は高速フィードバック用」は AWS 公式ガイダンスと整合する[^124][^125]。
- **k8s（kind / Knative）は不採用。** 上記 D.3。
- **再検討トリガー**: LocalStack が EMF / X-Ray 相関 / quota 強制に対応、SAM local が Web Functions に対応、AWS が Web Functions のローカルエミュレータを公開。

ADR 候補: **ADR-0023 Local virtual environment（L1 / L2 の 2 層と検証の線引き）**。

## E. 本テンプレートへの反映計画

| #   | 項目                                                                                                               | 判定         | 担当                          | 期限            | エビデンス / 完了条件                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------ | ------------ | ----------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | ADR-0021 起票: Node.js 24 を標準、Bun 不採用、LLRT 不採用。指針 §16 と esbuild `target` を `node24` へ             | 採用         | platform-team                 | 2026-11-30      | `nodejs24.x` で全 unit / contract / synth が通る。callback handler の lint 検出[^4]                                                                              |
| 2   | ADR-0009 の benchmark 候補に Bun container を追加                                                                  | 実験         | platform-team                 | ADR-0009 起票時 | 常駐サーバでの warm p99 と CPU 時間（§A.2 の bun.sh 条件を独立再現）[^18]                                                                                        |
| 3   | ADR-0005 Review: HTTP API 停滞の事実を Context に追記し、tier quota / streaming / private は REST を第一候補にする | 採用         | platform-team                 | 2026-11-30      | §B.1 の年別件数[^27]                                                                                                                                             |
| 4   | ADR-0006 Review: Web Functions 直接経路の standard 昇格条件（§B.3 の 5 条件）を Decision に追記                    | 採用         | platform-team                 | 2026-11-30      | CDK L2 PR #39210 の状態、`@paas/runtime-context` の JWT 検証 contract test                                                                                       |
| 5   | SCP: `lambda:Request/WebFunctionAuthType = ApplicationManaged` を Deny                                             | 採用         | security-team                 | 2026-10-31      | sandbox で `aws lambda-web deploy` 既定が拒否される[^39]                                                                                                         |
| 6   | ADR-0022 起票: observability pipeline（§C.5 フェーズ 1〜3）。ADR-0015 を supersede                                 | 採用         | platform-team                 | 2026-12-15      | log schema の contract test、field index / data protection の自動付与                                                                                            |
| 7   | X-Ray SDK 依存の棚卸しと OTel 移行（Event: Application Signals layer、Web: OTel SDK → OTLP）                       | 採用         | platform-team                 | 2027-01-31      | X-Ray SDK サポート終了 2027-02-25 より前[^70]。Application Signals の Node 24 は公式に明示なし（layer は v18+）[^72][^128]。着手時に ADOT release notes で再確認 |
| 8   | monitoring account の新設と cross-account observability                                                            | 採用         | platform-team + security-team | 2027-03-31      | ADR-0003 の改訂、monitoring account から `correlationId` 横断検索が通る[^59]                                                                                     |
| 9   | tenant 別ログ量の月次集計を ADR-0018 の cost attribution に接続                                                    | 採用         | platform-team                 | 2027-01-31      | Logs Insights `messageSize(@message)` で集計、`estimate` はクエリ費用の事前見積りに使う[^129][^130]                                                              |
| 10  | ADR-0023 起票: L1 compose を `create-service` が生成                                                               | 採用         | platform-team                 | 2026-11-30      | `docker compose up` で Web server + DynamoDB Local + otel-lgtm + k6 smoke が通る                                                                                 |
| 11  | L2 LocalStack Base の導入手順（`lstk cdk deploy`、`ENFORCE_IAM`、arm64 強制）                                      | 採用（任意） | platform-team                 | 2026-12-31      | HTTP API → Event / Web → DynamoDB Streams → EventBridge → SQS → Step Functions がローカルで一周する                                                              |
| 12  | LocalStack の未対応・記載なし項目（EMF、X-Ray 相関、quota 強制、Schema Registry）の一覧を四半期で再確認            | 継続         | platform-team                 | 四半期          | §D.1 の表。sandbox との挙動差は M-24 に記録                                                                                                                      |
| 13  | k8s（kind / Knative）案の不採用を ADR-0023 に記録                                                                  | 不採用       | platform-team                 | 2026-11-30      | §D.3                                                                                                                                                             |
| 14  | 本書 §0.3 の再検討トリガーを ADR README の記述ルールに追加                                                         | 採用         | docs owner                    | 2026-10-31      | README 改訂                                                                                                                                                      |

## 参考

[^1]: AWS Lambda Developer Guide, "Lambda Event Function runtimes"（supported / deprecated runtimes、LTS 方針）. https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html （2026-10-17 アクセス）

[^2]: AWS Lambda Developer Guide, "Lambda Web Function runtimes". https://docs.aws.amazon.com/lambda/latest/dg/web-functions-runtimes.html （2026-10-17）

[^4]: AWS Compute Blog, "Node.js 24 runtime now available in AWS Lambda"（2025-11-25）. https://aws.amazon.com/blogs/compute/node-js-24-runtime-now-available-in-aws-lambda/ （2026-10-17）

[^5]: Bun Guides, "Deploy a Bun application on AWS Lambda". https://bun.com/guides/deployment/aws-lambda （2026-10-17。旧 URL bun.sh/guides/ecosystem/aws-lambda は 404）

[^6]: oven-sh/bun, `packages/bun-lambda` README. https://github.com/oven-sh/bun/tree/main/packages/bun-lambda （2026-10-17）

[^7]: Bun Blog, "Bun v1.4.3"（2026-10-10）および GitHub Releases. https://bun.com/blog/bun-v1.4.3 、https://github.com/oven-sh/bun/releases （2026-10-17）

[^8]: endoflife.date, "Bun". https://endoflife.date/bun （2026-10-17）

[^9]: oven-sh/bun issue #6438 "SemVer / LTS"（open）. https://github.com/oven-sh/bun/issues/6438 （2026-10-17）

[^10]: oven-sh/bun, Security policy / advisories. https://github.com/oven-sh/bun/security （2026-10-17）

[^11]: Bun Docs, "Node.js compatibility". https://bun.sh/docs/runtime/nodejs-apis （2026-10-17）

[^12]: oven-sh/bun issue #26066 "HTTPS requests hanging (regression 1.2.23 -> 1.3.x)"（open、2026-01-14）. https://github.com/oven-sh/bun/issues/26066 （2026-10-17）

[^13]: aws/aws-sdk-js-v3 issue #6734 "Missing Installation code for bun". https://github.com/aws/aws-sdk-js-v3/issues/6734 （2026-10-17）

[^14]: Powertools for AWS Lambda (TypeScript), Tenets. https://docs.aws.amazon.com/powertools/typescript/latest/ （2026-10-17）

[^15]: maxday/lambda-perf（方法論）および 2026-10-16 データ. https://github.com/maxday/lambda-perf 、https://raw.githubusercontent.com/maxday/lambda-perf/main/data/2026-10-16.json （2026-10-17）

[^16]: Jason Butz, "JavaScript Lambda Runtime Benchmarking"（2025-05-22）. https://jasonbutz.info/2025/05/javascript-lambda-runtime-benchmarking/ （2026-10-17）

[^17]: Deno Blog, "AWS Lambda cold start benchmarks"（2024-07-25、ベンダー計測）. https://deno.com/blog/aws-lambda-coldstart-benchmarks （2026-10-17）

[^18]: bun.sh トップページ benchmark（ベンダー計測）. https://bun.sh/ （2026-10-17）

[^19]: TechEmpower/FrameworkBenchmarks issue #10932（2026-03-24 sunset）. https://github.com/TechEmpower/FrameworkBenchmarks/issues/10932 （2026-10-17）

[^20]: nodejs/Release schedule. https://github.com/nodejs/Release （2026-10-17）

[^21]: Node.js Blog, "Node.js 24.0.0"（2025-05-06）、"v24.11.0"（2025-10-28、LTS 昇格）. https://nodejs.org/en/blog/release/v24.0.0 、https://nodejs.org/en/blog/release/v24.11.0 （2026-10-17）

[^22]: Node.js Blog, "v22.18.0"（2025-07-31、type stripping 既定化）. https://nodejs.org/en/blog/release/v22.18.0 （2026-10-17）

[^23]: Bun Docs, "Bundler"（`target` / `format` / `bytecode`）. https://bun.sh/docs/bundler （2026-10-17）

[^24]: awslabs/llrt README（experimental）. https://github.com/awslabs/llrt （2026-10-17）

[^25]: awslabs/aws-lambda-web-adapter README. https://github.com/awslabs/aws-lambda-web-adapter （2026-10-17）

[^26]: denoland/deno-lambda（2024-09-11 archive）. https://github.com/denoland/deno-lambda （2026-10-17）

[^27]: AWS What's New ディレクトリ API（API Gateway タグ、日付降順）. https://aws.amazon.com/api/dirs/items/search?item.directoryId=whats-new-v2&sort_by=item.additionalFields.postDateTime&sort_order=desc&size=100&item.locale=en_US&tags.id=whats-new-v2%23general-products%23amazon-api-gateway （2026-10-17）

[^28]: AWS What's New, "Amazon API Gateway now supports response streaming for REST APIs"（2025-11-19）. https://aws.amazon.com/about-aws/whats-new/2025/11/api-gateway-response-streaming-rest-apis （2026-10-17）

[^29]: AWS What's New, "Amazon API Gateway adds MCP proxy support"（2025-12-02）. https://aws.amazon.com/about-aws/whats-new/2025/12/api-gateway-mcp-proxy-support/ （2026-10-17）

[^30]: AWS What's New, "Amazon API Gateway introduces routing rules for REST APIs"（2025-06-03）. https://aws.amazon.com/about-aws/whats-new/2025/06/amazon-api-gateway-routing-rules-rest-apis （2026-10-17）

[^31]: AWS What's New, "Amazon API Gateway now supports mutual TLS for backend integrations"（2026-09-08）. https://aws.amazon.com/about-aws/whats-new/2026/09/amazon-api-gateway-mutual-tls-backend/ （2026-10-17）

[^32]: AWS What's New, "Amazon API Gateway now supports 1 MB execution logs"（2026-09-10）. https://aws.amazon.com/about-aws/whats-new/2026/09/amazon-api-gateway-1-mb-execution-logs/ （2026-10-17）

[^33]: AWS What's New, "API Gateway REST APIs now supports private integration with ALB"（2025-11-21）. https://aws.amazon.com/about-aws/whats-new/2025/11/api-gateway-rest-apis-integration-load-balancer/ （2026-10-17）

[^34]: AWS What's New, "Amazon API Gateway adds Developer Portal capabilities"（2025-11-19）. https://aws.amazon.com/about-aws/whats-new/2025/11/api-gateway-developer-portal-capabilities （2026-10-17）

[^35]: AWS What's New, "API Gateway launches support for dual-stack endpoints"（2025-03-31）. https://aws.amazon.com/about-aws/whats-new/2025/03/api-gateway-dual-stack-ipv4-ipv6-endpoints/ （2026-10-17）

[^36]: AWS What's New, "Amazon API Gateway integration timeout limit increase beyond 29 seconds"（2024-06-04）. https://aws.amazon.com/about-aws/whats-new/2024/06/amazon-api-gateway-integration-timeout-limit-29-seconds/ （2026-10-17）

[^37]: API Gateway Developer Guide, "Choose between REST APIs and HTTP APIs". https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-vs-rest.html （2026-10-17）

[^38]: AWS Lambda Developer Guide, "Select a method to invoke your Lambda function using an HTTP request"（Function URL vs API Gateway）. https://docs.aws.amazon.com/lambda/latest/dg/furls-http-invoke-decision.html （2026-10-17）

[^39]: AWS Lambda Developer Guide, "Lambda Web Function endpoint access control". https://docs.aws.amazon.com/lambda/latest/dg/web-functions-endpoint-access-control.html （2026-10-17）

[^40]: AWS Lambda Developer Guide, "Lambda Web Function endpoints" および "Lambda quotas"（Web Functions 節）. https://docs.aws.amazon.com/lambda/latest/dg/web-functions-endpoints.html 、https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html （2026-10-17）

[^41]: AWS Lambda Developer Guide, "AWS Lambda Web Functions". https://docs.aws.amazon.com/lambda/latest/dg/web-functions.html （2026-10-17）

[^42]: AWS What's New, "Amazon CloudFront now supports AWS Lambda Web Functions as an origin"（2026-10-12）. https://aws.amazon.com/about-aws/whats-new/2026/10/cloudfront-lambda-web-functions-origin/ （2026-10-17）

[^43]: CloudFront Developer Guide, "Restricting access to a Lambda Web Function origin". https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda-web.html （2026-10-17）

[^44]: CloudFront Developer Guide, "Restricting access to an AWS Lambda function URL origin"（`x-amz-content-sha256` 要件）. https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html （2026-10-17）

[^45]: AWS WAF Developer Guide, "Associating or disassociating a web ACL with an AWS resource". https://docs.aws.amazon.com/waf/latest/developerguide/web-acl-associating-aws-resource.html （2026-10-17）

[^46]: ELB Application Load Balancer Guide, "Lambda functions as targets" および "Authenticate users". https://docs.aws.amazon.com/elasticloadbalancing/latest/application/lambda-functions.html 、https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-authenticate-users.html （2026-10-17）

[^47]: ELB Application Load Balancer Guide, "Mutual authentication with TLS". https://docs.aws.amazon.com/elasticloadbalancing/latest/application/mutual-authentication.html （2026-10-17）

[^48]: Elastic Load Balancing Pricing. https://aws.amazon.com/elasticloadbalancing/pricing/ （2026-10-17）

[^49]: Amazon API Gateway Pricing、AWS Lambda Pricing. https://aws.amazon.com/api-gateway/pricing/ 、https://aws.amazon.com/lambda/pricing/ （2026-10-17）

[^50]: CloudFront Pricing（flat-rate / pay-as-you-go）、AWS What's New "AWS flat-rate pricing plans"（2025-11-18）. https://aws.amazon.com/cloudfront/pricing/ 、https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/ 、https://aws.amazon.com/about-aws/whats-new/2025/11/aws-flat-rate-pricing-plans （2026-10-17）

[^52]: AWS Builder Center, "AWS Lambda Web Functions: A New Way to Go Serverless"（2026-10-14）. https://builder.aws.com/content/3Kf9iZ0cQmlFHcpYZltzK659D1i/aws-lambda-web-functions-a-new-way-to-go-serverless （2026-10-17）

[^54]: CloudWatch, "Embedded metric format specification". https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html （2026-10-17）

[^55]: AWS What's New, "Amazon CloudWatch Logs launches field indexes and enhanced log group selection"（2024-11-21）. https://aws.amazon.com/about-aws/whats-new/2024/11/amazon-cloudwatch-logs-field-indexes-log-group-selection-log-insights/ （2026-10-17）

[^56]: CloudWatch Logs, "Transform logs during ingestion". https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CloudWatch-Logs-Transformation.html （2026-10-17）

[^57]: CloudWatch Logs, "Log classes". https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CloudWatch_Logs_Log_Classes.html （2026-10-17）

[^58]: CloudWatch Logs, "Help protect sensitive log data with masking". https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/mask-sensitive-log-data.html （2026-10-17）

[^59]: CloudWatch, "CloudWatch cross-account observability". https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Unified-Cross-Account.html （2026-10-17）

[^60]: CloudWatch Logs quotas. https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/cloudwatch_limits_cwl.html （2026-10-17）

[^61]: AWS Lambda Developer Guide, "Configuring log level filtering". https://docs.aws.amazon.com/lambda/latest/dg/monitoring-cloudwatchlogs-log-level.html （2026-10-17）

[^62]: AWS Lambda Developer Guide, "Configuring JSON and plain text log formats". https://docs.aws.amazon.com/lambda/latest/dg/monitoring-cloudwatchlogs-logformat.html （2026-10-17）

[^63]: AWS Distro for OpenTelemetry, "AWS Distro for OpenTelemetry Lambda Support For JavaScript"（legacy 表記）. https://aws-otel.github.io/docs/getting-started/lambda/lambda-js （2026-10-17）

[^64]: AWS Distro for OpenTelemetry, "AWS Distro for OpenTelemetry Lambda". https://aws-otel.github.io/docs/getting-started/lambda （2026-10-17）

[^66]: AWS What's New, "Application Signals now supports OpenTelemetry traces via X-Ray OTLP endpoint"（2024-11-22）. https://aws.amazon.com/about-aws/whats-new/2024/11/application-signals-otel-x-ray-otlp-endpoint-traces （2026-10-17）

[^67]: CloudWatch, "OTLP Endpoints". https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-OTLPEndpoint.html （2026-10-17）

[^68]: AWS What's New, "Amazon CloudWatch Logs launches HTTP log collector"（2026-03-16、OTLP logs 含む）. https://aws.amazon.com/about-aws/whats-new/2026/03/cloudwatch-http-log-collector/ （2026-10-17）

[^69]: AWS What's New, "Amazon CloudWatch now supports native OpenTelemetry metrics (preview)"（2026-04-02）. https://aws.amazon.com/about-aws/whats-new/2026/04/amazon-cloudwatch-opentelemetry-metrics/ （2026-10-17）

[^70]: AWS X-Ray Developer Guide, "Document history"（X-Ray SDK / Daemon の maintenance mode 2026-02-25、サポート終了 2027-02-25）. https://docs.aws.amazon.com/xray/latest/devguide/document-history.html （2026-10-17）

[^71]: CloudWatch, "Transaction Search" / "Enable Transaction Search". https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Transaction-Search.html 、https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Enable-TransactionSearch.html （2026-10-17）

[^72]: AWS Lambda Developer Guide, "Monitor application performance with Amazon CloudWatch Application Signals". https://docs.aws.amazon.com/lambda/latest/dg/monitoring-application-signals.html （2026-10-17）

[^73]: Amazon CloudWatch Pricing（pricing examples から転記）. https://aws.amazon.com/cloudwatch/pricing/ （2026-10-17）

[^74]: AWS Lambda Developer Guide, "Web Function logs in Amazon CloudWatch Logs". https://docs.aws.amazon.com/lambda/latest/dg/web-functions-logging.html （2026-10-17）

[^75]: AWS Lambda Developer Guide, "Monitoring Lambda Web Functions". https://docs.aws.amazon.com/lambda/latest/dg/web-functions-monitoring.html （2026-10-17）

[^76]: AWS Lambda Developer Guide, "Embedded metric format for Lambda Web Functions". https://docs.aws.amazon.com/lambda/latest/dg/web-functions-emf.html （2026-10-17）

[^78]: Datadog Docs, "AWS Lambda" / "Node.js installation" / "Datadog Lambda Extension". https://docs.datadoghq.com/serverless/aws_lambda/ 、https://docs.datadoghq.com/serverless/aws_lambda/installation/nodejs/ 、https://docs.datadoghq.com/serverless/libraries_integrations/extension/ （2026-10-17）

[^79]: Honeycomb Docs, "Send OpenTelemetry data from AWS Lambda". https://docs.honeycomb.io/send-data/aws/lambda/opentelemetry （2026-10-17）

[^80]: Grafana Labs Blog, "AWS Lambda, OpenTelemetry, and Grafana Cloud"（2025-04-16）. https://grafana.com/blog/aws-lambda-opentelemetry-and-grafana-cloud-a-guide-to-serverless-observability-considerations/ （2026-10-17）

[^81]: OpenTelemetry, "JavaScript" status（Traces Stable、Metrics Stable、Logs Development）. https://opentelemetry.io/docs/languages/js/ （2026-10-17）

[^83]: aws-powertools/powertools-lambda-typescript issue #4184 "Feature request: OpenTelemetry Support"（open）. https://github.com/aws-powertools/powertools-lambda-typescript/issues/4184 （2026-10-17）

[^84]: AWS Lambda Developer Guide, "Monitoring tenant isolation"（JSON logging で `tenantId` 自動付与）. https://docs.aws.amazon.com/lambda/latest/dg/tenant-isolation-monitor.html （2026-10-17）

[^85]: AWS Well-Architected SaaS Lens, "Multi-tenant microservices". https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/multi-tenant-microservices.html （2026-10-17）

[^86]: CloudWatch Logs, "Document history". https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/DocumentHistory_cwl.html （2026-10-17）

[^87]: LocalStack Blog, "LocalStack for AWS release 2026.10.0"（2026-10-13）. https://blog.localstack.cloud/localstack-for-aws-release-2026-10-0/ （2026-10-17）

[^88]: LocalStack Blog, "AWS Lambda Web Functions Are Here. Test Them Locally with LocalStack."（2026-10-13）. https://blog.localstack.cloud/aws-lambda-web-functions-are-here/ （2026-10-17）

[^89]: LocalStack Docs, "Lambda Web Functions". https://docs.localstack.cloud/aws/services/lambda-web/ （2026-10-17）

[^90]: LocalStack Docs, "Lambda" / "Hot reloading". https://docs.localstack.cloud/aws/services/lambda/ 、https://docs.localstack.cloud/aws/tooling/lambda-tools/hot-reloading/ （2026-10-17）

[^91]: LocalStack Docs, "API Gateway". https://docs.localstack.cloud/aws/services/apigateway/ （2026-10-17）

[^92]: LocalStack Docs, "DynamoDB". https://docs.localstack.cloud/aws/services/dynamodb/ （2026-10-17）

[^93]: LocalStack Docs, "DynamoDB Streams". https://docs.localstack.cloud/aws/services/dynamodbstreams/ （2026-10-17）

[^94]: LocalStack Docs, "EventBridge" / "EventBridge Scheduler". https://docs.localstack.cloud/aws/services/events/ 、https://docs.localstack.cloud/aws/services/scheduler/ （2026-10-17）

[^95]: LocalStack Docs, "EventBridge Pipes"（Ultimate）. https://docs.localstack.cloud/aws/services/pipes/ （2026-10-17）

[^96]: LocalStack Docs, "SQS". https://docs.localstack.cloud/aws/services/sqs/ （2026-10-17）

[^97]: LocalStack Docs, "Step Functions". https://docs.localstack.cloud/aws/services/stepfunctions/ （2026-10-17）

[^98]: LocalStack Docs, "CloudWatch". https://docs.localstack.cloud/aws/services/cloudwatch/ （2026-10-17）

[^99]: LocalStack Docs, "CloudWatch Logs". https://docs.localstack.cloud/aws/services/logs/ （2026-10-17）

[^100]: LocalStack Docs, "X-Ray"（Ultimate）. https://docs.localstack.cloud/aws/services/xray/ （2026-10-17）

[^101]: LocalStack Docs, "IAM Policy Enforcement" / Configuration reference. https://docs.localstack.cloud/aws/capabilities/security-testing/iam-policy-enforcement/ 、https://docs.localstack.cloud/aws/capabilities/config/configuration/ （2026-10-17）

[^102]: LocalStack Pricing. https://localstack.cloud/pricing （2026-10-17）

[^103]: LocalStack Blog, "Switching to calendar versioning"（2026-03-18）、FAQ. https://blog.localstack.cloud/switching-to-calendar-versioning/ 、https://docs.localstack.cloud/aws/getting-started/faq/ （2026-10-17）

[^104]: LocalStack Docs, "Kubernetes". https://docs.localstack.cloud/aws/integrations/containers/kubernetes/ （2026-10-17）

[^105]: LocalStack Docs, "Persistence" / "Cloud Pods" / "Installation"（docker-compose 例）. https://docs.localstack.cloud/aws/capabilities/state-management/persistence/ 、https://docs.localstack.cloud/aws/capabilities/state-management/cloud-pods/ 、https://docs.localstack.cloud/aws/getting-started/installation/ （2026-10-17）

[^106]: localstack/aws-cdk-local README（deprecated、`lstk cdk` へ）. https://github.com/localstack/aws-cdk-local （2026-10-17）

[^107]: AWS SAM Developer Guide, "Introduction to testing with sam local start-api". https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/using-sam-cli-local-start-api.html （2026-10-17）

[^108]: aws/aws-sam-cli Releases（v1.169.0、2026-10-13）. https://github.com/aws/aws-sam-cli/releases （2026-10-17）

[^109]: aws/aws-lambda-runtime-interface-emulator README. https://github.com/aws/aws-lambda-runtime-interface-emulator （2026-10-17）

[^110]: AWS Lambda Developer Guide, "Deploy Node.js Lambda functions with container images". https://docs.aws.amazon.com/lambda/latest/dg/nodejs-image.html （2026-10-17）

[^111]: DynamoDB Developer Guide, "DynamoDB local release history" / "Downloading and running DynamoDB local". https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocalHistory.html 、https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.DownloadingAndRunning.html （2026-10-17）

[^112]: DynamoDB Developer Guide, "DynamoDB local usage notes". https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.UsageNotes.html （2026-10-17）

[^113]: AWS Lambda Developer Guide, "Testing Lambda Web Functions". https://docs.aws.amazon.com/lambda/latest/dg/web-functions-testing.html （2026-10-17）

[^114]: Step Functions Developer Guide, "Testing state machines with Step Functions Local (unsupported)". https://docs.aws.amazon.com/step-functions/latest/dg/sfn-local.html （2026-10-17）

[^115]: Step Functions Developer Guide, "Using TestState API"（2025-11 拡張）. https://docs.aws.amazon.com/step-functions/latest/dg/test-state-isolation.html （2026-10-17）

[^116]: Knative, "Configuring scale to zero" / Serving releases（v1.23.0）. https://knative.dev/docs/serving/autoscaling/scale-to-zero/ 、https://github.com/knative/serving/releases （2026-10-17）

[^117]: kubernetes-sigs/kind Releases（v0.33.0）. https://github.com/kubernetes-sigs/kind/releases （2026-10-17）

[^118]: k3d-io/k3d Releases（v5.9.0）. https://github.com/k3d-io/k3d/releases （2026-10-17）

[^119]: grafana/docker-otel-lgtm README. https://github.com/grafana/docker-otel-lgtm （2026-10-17）

[^122]: open-telemetry/opentelemetry-collector-contrib: awsemfexporter / awsxrayexporter / awscloudwatchlogsexporter README、Releases（v0.163.0）. https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/exporter/awsemfexporter/README.md 、https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/exporter/awsxrayexporter/README.md 、https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/exporter/awscloudwatchlogsexporter/README.md 、https://github.com/open-telemetry/opentelemetry-collector-contrib/releases （2026-10-17）

[^123]: Grafana k6 Docs, "OpenTelemetry output"、Releases（v2.3.0）. https://grafana.com/docs/k6/latest/results-output/real-time/opentelemetry/ 、https://github.com/grafana/k6/releases （2026-10-17）

[^124]: AWS Lambda Developer Guide, "Testing serverless functions and applications". https://docs.aws.amazon.com/lambda/latest/dg/testing-guide.html （2026-10-17）

[^125]: AWS Prescriptive Guidance, "Serverless application testing: Best practices" / "Techniques". https://docs.aws.amazon.com/prescriptive-guidance/latest/serverless-application-testing/best-practices.html 、https://docs.aws.amazon.com/prescriptive-guidance/latest/serverless-application-testing/techniques.html （2026-10-17）

[^126]: aws-samples/serverless-test-samples README. https://github.com/aws-samples/serverless-test-samples （2026-10-17）

[^127]: Testcontainers for Java, "LocalStack Module"（2026-03-23 以降 token 必須）. https://java.testcontainers.org/modules/localstack/ （2026-10-17）

[^128]: AWS Distro for OpenTelemetry, "AWS Distro for OpenTelemetry Lambda Support For JavaScript"（"The Lambda layer supports Node.JS v18+ Lambda runtimes"。Node.js 24 の明示なし）. https://aws-otel.github.io/docs/getting-started/lambda/lambda-js （2026-10-18）

[^129]: Amazon CloudWatch Logs User Guide, "CloudWatch Logs Insights language query syntax"（`estimate`: "Returns the estimated bytes that the query would scan ... without running the query"）. https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CWL_QuerySyntax.html （2026-10-18）

[^130]: Amazon CloudWatch Logs User Guide, "Boolean, comparison, numeric, datetime, and other functions"（`strlen`: "Returns the length of the string in Unicode code points"、`messageSize`: "Returns the byte length of a string field"）. https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CWL_QuerySyntax-operations-functions.html （2026-10-18）

[^131]: LocalStack Docs, "AWS Services"（EventBridge / EventBridge Pipes / EventBridge Scheduler のみ。Schema Registry の項目なし。`https://docs.localstack.cloud/aws/services/schemas/` と `/references/coverage/coverage_schemas/` は 404）. https://docs.localstack.cloud/aws/services/ （2026-10-18）
