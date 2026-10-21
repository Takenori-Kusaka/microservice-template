# ADR-0024: Diagram-as-code toolchain (cloud assembly → D2 as source of truth)

- Status: accepted
- Date: 2026-10-21
- Owner: platform-team
- Review date: 2027-04-21
- Related: ADR-0019（CDK construct boundaries）, ADR-0020（CI）, [AWS システム構成図の diagram-as-code 調査](../decision/diagram-as-code-tools.md), [architecture/overview.md 図の形式](../architecture/overview.md#図の形式)

## Context

本テンプレートは構成図を 3 経路で描画している（[overview.md](../architecture/overview.md#図の形式)、`package.json` の `diagrams` / `diagrams:deployed` / `diagrams:awsdac`）。

| 経路 | 入力                                                                                | 実装                                                                     | 状態（2026-10-18）                                                                                                                      |
| ---- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| (a)  | `cdk.out` の cloud assembly メタデータ（`Show` / `Connection` / `paas:connection`） | 自前の `tools/diagrams/src/cdk2d2.ts` → D2 → TALA → SVG                  | 稼働中。CI の `diagrams` ステップで毎 PR 実行                                                                                           |
| (b)  | デプロイ済み CloudFormation スタック + `cdk.out`                                    | 公式 cdk2d2 v0.2.0 + `tools/diagrams/src/cdk2d2-official.ts` の互換 shim | 稼働するが cdk2d2 本体は 2023-04 以降更新なし。Stage の nested assembly と `<artifact>.metadata.json` を読めず、icon CDN は名前解決不能 |
| (c)  | `cdk.out/**/*.template.json`                                                        | awslabs/diagram-as-code（`awsdac --cfn-template`、beta）→ PNG            | `pnpm diagrams:awsdac` として実装済み。CI には未組み込み                                                                                |

owner の問い「cdk2d2 が非対応だとすると最新の AWS system diagram as code は何か」に対し、[調査文書](../decision/diagram-as-code-tools.md)が 2026-10-18 に候補を一次資料（GitHub REST API / PyPI JSON API の返却値）で検証した。要点は次のとおり。

| 候補                                     | 検証済みの事実（確認日 2026-10-18）                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| awslabs/diagram-as-code（`awsdac`）      | Apache-2.0、v0.24（2026-08-26）、最終 push 2026-09-16。`--cfn-template` は README で `[beta]`、`doc/cloudformation.md` に「Complex nested stacks may not render correctly」「Some resource dependencies are not detected automatically」「Custom resources are not supported」。出力は PNG のみ。アイコン定義は既定で raw.githubusercontent から実行時取得[^200][^201] |
| 同、CDK 生成 template での既知問題       | issue #196（2025-06-12、`AWS::IAM::Policy` 等で nil pointer panic）、#202（2025-07-07、`AWS::ApiGateway::Resource` で同 panic）が open[^202]。本リポジトリでの観測: `--dac-file` は CDK template の `Rules` 節で失敗、`--cfn-template` は 91 リソースを 1 行に並べ 26,000 px 超の横長 PNG になる（`tools/diagrams/src/awsdac.ts`、overview.md）                        |
| AWS PDK CdkGraph + CdkGraphDiagramPlugin | README に「The AWS PDK is no longer supported」。最終リリース v0.26.15（2025-10-31）。移行先の Nx Plugin for AWS に同等機能はなく、移行ガイドは cdk-dia を代替として名指し[^203][^204]                                                                                                                                                                                 |
| cdk-dia                                  | MIT、0.12.4（2026-09-27）。Graphviz 必須、出力 PNG（HTML は experimental）、リリースノート本文が空[^205]                                                                                                                                                                                                                                                               |
| D2 + TALA                                | MPL-2.0、v0.9.0（2026-09-07）で TALA を open source 化し本体に同梱（`d2 --layout=tala`、`--tala-seeds`）。AWS アイコン集は同梱せず `icons.terrastruct.com` の URL 参照[^206][^207]                                                                                                                                                                                     |
| cdk2d2（megaproaktiv）                   | Apache-2.0、唯一のリリース v0.2.0（2023-04-02）、最終 push 2023-04-06。`cdn.megaproaktiv.de` は DNS 名前解決不能（curl exit 6）。独自価値は CloudFormation のリソース状態を色で描くことのみ[^213]                                                                                                                                                                      |
| Infrastructure Composer（standalone）    | console は 2026-12-07 に終了、新規受付は 2026-10-29 停止。API / CLI なし[^208]                                                                                                                                                                                                                                                                                         |
| Workload Discovery on AWS                | 「This AWS Solution is no longer available.」代替は CloudWatch Application Map（export 記載なし）[^209]                                                                                                                                                                                                                                                                |
| mingrammer/diagrams、cfn-diagram         | Python 手書き（CDK 読み込みなし）[^210]、cfn-diagram は最終リリース 2024-04-19 で 30 か月更新なし[^211]                                                                                                                                                                                                                                                                |
| AWS Diagram MCP Server / agent skill     | MCP server は全バージョン yanked、後継は `aws-architecture-diagram` agent skill（draw.io XML、LLM 生成で非決定的）[^212]                                                                                                                                                                                                                                               |

本テンプレートの図が伝えたいのは「サービス境界と非同期の論理経路（outbox → EventBridge → SQS）」であり、これは CloudFormation template 層に `Ref` として現れない。cloud assembly 層を読む経路でなければ正本にできない。

## Decision

準拠: AWS CDK Developer Guide「Apps」（construct tree、cloud assembly）[^214]、awslabs/diagram-as-code README / `doc/cloudformation.md`[^200][^201]、AWS PDK README と Nx Plugin for AWS 移行ガイド[^203][^204]、terrastruct/d2 v0.9.0 リリース（TALA 同梱）[^206]、[再検討 §0.3 の再検討トリガー](../decision/latest-tech-reassessment.md)

- **経路 (a)（cloud assembly → D2 → TALA → SVG）を構成図の唯一の正本とする。** 根拠: 入力が `cdk.out` で AWS 認証不要、D2 ソースが差分レビュー可能、TALA が D2 v0.9.0 に同梱されプラグイン不要[^206]、CI で毎 PR 実行済み。外部依存は `icons.terrastruct.com` の URL 参照のみ。[^207]
- **経路 (b)（公式 cdk2d2 v0.2.0 + 互換 shim）は「デプロイ状態の閲覧図」としてのみ残し、正本・CI 対象にしない。** cdk2d2 は最終リリース 2023-04-02、icon CDN 消失、Stage / `metadata.json` 非対応で shim が必要なことを `overview.md` と shim の冒頭コメントに明記する。[^213] **sunset トリガー**: 次のいずれかで (b) を削除する（`diagrams:deployed` script、`cdk2d2-official.ts`、`diagrams/deployed/`）。(1) CDK の cloud assembly schema 変更で shim が壊れた、(2) `icons.terrastruct.com` の置換表で描けないアイコンが出た、(3) 経路 (a) にデプロイ状態の色分け（`describe-stack-resources` オプション）を移植した、(4) 2027-04-21 の Review までに (b) の利用実績がない。削除後の代替は CloudFormation console の Resources タブと CloudWatch Application Map。[^209]
- **経路 (c)（`awsdac --cfn-template`）は非ブロッキングの棚卸し図として併用する。** 全リソース（IAM Role / Policy / Alarm を含む）を公式アイコンで漏れなく描く用途に限り、読図用の正本にはしない。CI には `continue-on-error: true` のオプションジョブとして追加し、`awsdac` のバージョンを `v0.24` にピン留め、アイコン定義 YAML（約 243 KB）を `tools/diagrams/awsdac/` に vendoring して `--override-def-file` で参照する（既定の raw.githubusercontent 取得は CI の再現性を壊す）。[^200][^201] `--dac-file` の YAML はコミットしない（(a) との二重管理を避ける）。
- **PDK CdkGraph は不採用。** 非サポート宣言済みの依存を正本経路に置かない。[^203]
- **cdk-dia は (a) が使えなくなった場合の fallback。** 同じ construct tree ベースで現役（2026-09-27）だが、Graphviz 依存と PNG 出力のため常用しない。[^205]
- **agent skill（draw.io 出力）は設計レビュー前の説明用の下書きに限り MAY。** 生成物はコミットしない。LLM 出力は決定的でなく、本リポジトリの出典規約（出典のない構成要素を図に描かない）を自動では満たせない。[^212]
- 再検討トリガー: awsdac の `--cfn-template` から `[beta]` が外れる、issue #196 / #202 が closed、awsdac が SVG 出力を追加、D2 が AWS アイコン集を同梱、`icons.terrastruct.com` が 4xx / 5xx を返す、AWS が CDK / CloudFormation からの図生成を What's New で発表（2026-10-18 時点で該当なし）。

## Alternatives

### A. 経路 (a) 自前生成器 + D2 / TALA（採用）

- 長所: cloud assembly の `Show` / `Connection` / `paas:connection` 注釈から論理経路を描ける。D2 はテキストで差分レビュー可能。TALA 同梱で追加インストール不要。[^206] AWS 認証不要で CI 再現性が高い。
- 短所: 自前コードの保守。TALA は「a small change to a label can cascade into an entirely different layout」「slower on large diagrams」と公式が述べており[^206]、`--tala-seeds` でレイアウトを固定する運用が要る。AWS アイコンは外部 URL 参照。[^207]

### B. `awsdac --cfn-template` を正本にする

- 長所: AWS 公式、Apache-2.0、活発（2026-08-26 リリース）。公式アイコン。headless browser 不要の単一バイナリ。MCP server あり。[^200]
- 短所: CloudFormation 入力は beta で、CDK 生成 template の sub-resource で panic する issue が open。[^201][^202] 出力 PNG のみで差分レビュー不能。`paas:connection` の論理経路は template に `Ref` がなく描かれない。本テンプレート規模（91 リソース）では 26,000 px 超の横長になり読図に向かない（計測で確定: 本テンプレートの全 template で panic せずに描けるか、`docs/decision/template-defaults.md` に M-30 として追加し CI のオプションジョブで記録する。現在は `--cfn-template` が sandbox で成功、`--dac-file` が失敗）。

### C. PDK CdkGraph / cdk-dia（construct tree ベース）

- 長所: L2 / L3 の境界（`@paas/constructs`）がそのまま図の階層になる。DOT / SVG（PDK）で差分可能。
- 短所: PDK は非サポート宣言済み。[^203] cdk-dia は Graphviz 必須、PNG 出力、リリースノート空。[^205] (a) が同じ入力から D2 を生成しており重複する。

### D. cdk2d2 互換 shim を廃止（調査文書 §6.3 の推奨）

- 長所: バイナリ DL、icon 置換表、assembly 変換の保守負担がゼロになる。CI の外部依存が `icons.terrastruct.com` だけになる。
- 短所: デプロイ状態の色分けを失う。2026-10-17 の sandbox 実デプロイで生成した `diagrams/deployed/` の図が再生成できなくなる。本 ADR は sunset トリガー付きで残す折衷を採り、トリガー到達時に本案へ移行する。

## Consequences

- **費用**: 変化なし。awsdac のオプションジョブは CI 時間を数十秒増やす（計測で確定: M-30 で job duration を記録）。
- **性能**: TALA は大きな図で遅い。[^206] 本テンプレートの 4 stacks では CI の `diagrams` ステップが完了している（`.github/workflows/ci.yml`）。
- **運用**: platform-team が (a) の生成器と `--tala-seeds` を保守する。(b) は保守対象外（sunset トリガーの監視のみ）。(c) は失敗しても PR をブロックしない。`icons.terrastruct.com` の応答は CI の `diagrams` ステップが検知する。[^207]
- **Lock-in**: D2 は MPL-2.0 の OSS で、`.d2` ソースをコミットするため他ツールへの移行時も入力が残る。[^206] awsdac の YAML はコミットしないため lock-in なし。
- **移行**: (c) の CI ジョブ追加と定義 YAML の vendoring は 1 PR。(b) の削除は sunset トリガー到達時に 1 PR（`package.json`、`tools/diagrams/src/cdk2d2-official.ts`、`docs/architecture/diagrams/deployed/`、overview.md）。

## Evidence

- 候補ごとの保守状況（リリース日、push 日、issue 状態）は GitHub REST API / PyPI JSON API の返却値（2026-10-18）。[^200][^202][^203][^204][^205][^206][^211][^212][^213]
- サービス終了: Infrastructure Composer standalone（2026-12-07）[^208]、Workload Discovery[^209]。
- 本リポジトリでの実測（2026-10-17/18）: (a) は CI で毎 PR 生成。(b) は sandbox 実デプロイで `diagrams/deployed/<stack>.svg` を生成（緑 = CREATE_COMPLETE）し、cdk2d2 v0.2.0 が Stage の nested assembly を読めないことを確認（shim で回避）。(c) は `--cfn-template` が成功、`--dac-file` が `Rules` 節で失敗、91 リソースで 26,000 px 超（`tools/diagrams/src/awsdac.ts`、overview.md）。
- 受入基準: PR ごとに (a) の SVG が再生成され、`.d2` の差分がレビューできる。(c) のオプションジョブが panic した場合は issue #196 / #202 への追記で記録する。

## Compliance / How it is enforced

- CI の `diagrams` ステップ（`.github/workflows/ci.yml`）が `pnpm diagrams --env production --layout tala` を毎 PR 実行し、SVG を artifact として保存する。失敗は PR をブロックする。
- `@paas/constructs` の paved constructs（`PavedApiService`、`PavedQueueConsumer`、`PavedWorkflow`、`EventSubscription`、`PlatformDetection` 等）が `show()` / `connection` 注釈を自動付与する（`packages/constructs/src/diagram.ts`）。サービス側で注釈を手書きしない（ADR-0019）。
- `tools/diagrams/src/cdk2d2-official.ts` の冒頭コメントに「2023 年で更新停止したツールの互換レイヤ、sunset トリガーは ADR-0024」を明記し、四半期 conformance review の対象から外す。
- (c) のオプションジョブは `continue-on-error: true`、`awsdac@v0.24` 固定、`--override-def-file tools/diagrams/awsdac/definition-for-aws-icons-light.yaml`。定義 YAML の更新は PR で差分レビューする。
- `docs/architecture/diagrams/` 配下にコミットするのは (a) の `.d2` / `.svg` と (c) の `.png` のみ。agent skill の draw.io 出力と awsdac の `--dac-file` YAML はコミット禁止（`.gitignore`）。

## Expiry / Review date

| 日付       | 評価者        | 結果                                                                      |
| ---------- | ------------- | ------------------------------------------------------------------------- |
| 2026-10-21 | platform-team | 初版。(a) 正本、(b) sunset トリガー付きで維持、(c) 非ブロッキング棚卸し図 |

## 参考

[^200]: [awslabs/diagram-as-code](https://github.com/awslabs/diagram-as-code)（参照日 2026-10-18。README、Releases v0.24 2026-08-26、`doc/mcp-server.md`、`examples/alb-ec2.yaml`、`definitions/definition-for-aws-icons-light.yaml`）

[^201]: [awslabs/diagram-as-code `doc/cloudformation.md`](https://github.com/awslabs/diagram-as-code/blob/main/doc/cloudformation.md)（参照日 2026-10-18。「currently in beta」、既知の問題 3 件、2 段階ワークフロー）

[^202]: [awslabs/diagram-as-code issue #196](https://github.com/awslabs/diagram-as-code/issues/196)、[issue #202](https://github.com/awslabs/diagram-as-code/issues/202)（参照日 2026-10-18。open。CDK 生成 template の sub-resource で panic）

[^203]: [aws/aws-pdk](https://github.com/aws/aws-pdk)（参照日 2026-10-18。README「The AWS PDK is no longer supported」、v0.26.15 2025-10-31）、[CDK Graph Diagram Plugin](https://aws.github.io/aws-pdk/developer_guides/cdk-graph-plugin-diagram/index.html)

[^204]: [Migrating from AWS PDK - Nx Plugin for AWS](https://awslabs.github.io/nx-plugin-for-aws/en/blog/migrating-from-aws-pdk/)（参照日 2026-10-18。2026-09-07。CDK Graph の同等機能なし、cdk-dia を代替として名指し）

[^205]: [pistazie/cdk-dia](https://github.com/pistazie/cdk-dia)（参照日 2026-10-18。MIT、0.12.4 2026-09-27、Graphviz 必須）

[^206]: [terrastruct/d2](https://github.com/terrastruct/d2)（参照日 2026-10-18。MPL-2.0、v0.9.0 2026-09-07）、[TALA is open source - D2 Blog](https://d2lang.com/blog/tala-is-open-source/)（2026-09-07。MPL-2.0、`--tala-seeds`、レイアウトの randomness と大規模図での遅さ）、[TALA - D2 Tour](https://d2lang.com/tour/tala/)

[^207]: [Icons - D2 Tour](https://d2lang.com/tour/icons/)、[icons.d2lang.com](https://icons.d2lang.com/)（参照日 2026-10-18。AWS 専用セットの同梱なし、「icons at existing URLs won't be changed or expired」、ライセンス表記は公式に記載なし）

[^208]: [AWS Infrastructure Composer end of support](https://docs.aws.amazon.com/infrastructure-composer/latest/dg/infrastructure-composer-end-of-support.html)、[What is Infrastructure Composer](https://docs.aws.amazon.com/infrastructure-composer/latest/dg/what-is-composer.html)（参照日 2026-10-18。standalone console 2026-12-07 終了、新規受付 2026-10-29 停止、API / CLI なし）

[^209]: [Workload Discovery on AWS](https://docs.aws.amazon.com/solutions/workload-discovery-on-aws/)（参照日 2026-10-18。「no longer available」）、[CloudWatch Application Map](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/ServiceMap.html)（export 記載なし）

[^210]: [mingrammer/diagrams](https://github.com/mingrammer/diagrams)（参照日 2026-10-18。MIT、v0.25.1 2025-11-22、CDK / CloudFormation 読み込みなし）

[^211]: [ljacobsson/cfn-diagram](https://github.com/ljacobsson/cfn-diagram)、[mhlabs/cfn-diagram](https://github.com/mhlabs/cfn-diagram)（参照日 2026-10-18。upstream v1.1.40 2024-04-19、fork は「no longer being updated」）

[^212]: [awslabs.aws-diagram-mcp-server (PyPI JSON)](https://pypi.org/pypi/awslabs.aws-diagram-mcp-server/json)（参照日 2026-10-18。全バージョン yanked、理由は agent skill への移行）、[aws-architecture-diagram skill - awslabs/agent-plugins](https://github.com/awslabs/agent-plugins/tree/main/plugins/deploy-on-aws/skills/aws-architecture-diagram)（draw.io XML、LLM 生成）

[^213]: [megaproaktiv/cdk2d2](https://github.com/megaproaktiv/cdk2d2)（参照日 2026-10-18。v0.2.0 2023-04-02、最終 push 2023-04-06、`main/main.go` の icon URL）、[A new simple approach to diagram as code on AWS with CDK and D2 - tecRacer](https://www.tecracer.com/blog/2023/04/a-new-simple-approach-to-diagram-as-code-on-aws-with-cdk-and-d2.html)（2023-04-02）

[^214]: [Apps - AWS CDK Developer Guide](https://docs.aws.amazon.com/cdk/v2/guide/apps.html)（参照日 2026-10-18。construct tree、`node.path`、cloud assembly）
