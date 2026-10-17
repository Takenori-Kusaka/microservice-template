# AWS システム構成図の diagram-as-code: 2026-10 時点の選択肢と本テンプレートの経路

- Status: proposed
- Date: 2026-10-18
- Owner: platform-team
- Related: [architecture/overview.md](../architecture/overview.md)（図の形式、描画コマンド 2 経路）、[latest-tech-reassessment.md](latest-tech-reassessment.md)（再検討トリガー §0.3）、[ADR-0019](../adr/ADR-0019-cdk-construct-boundaries.md)、ADR-0024（本書で起票候補）
- 調査日: 2026-10-18（すべての出典は同日にアクセス。リリース日・issue 状態は GitHub REST API / PyPI JSON API の返却値をそのまま転記）

## 0. 目的

owner の問い「cdk2d2 が非対応だとすると最新の AWS system diagram as code は何か」に、一次資料だけで答える。

本テンプレートは構成図を 2 経路で描画している（[overview.md 図の形式](../architecture/overview.md#図の形式)）。

| 経路 | 入力                                                                 | 実装                                                                     | 状態                                                                                                                                             |
| ---- | -------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| (a)  | `cdk.out` の cloud assembly メタデータ（`Show` / `Connection` 注釈） | 自前の `tools/diagrams/src/cdk2d2.ts` → D2 → TALA → SVG                  | 稼働中。CI（`.github/workflows/ci.yml` の diagrams ステップ）でも実行                                                                            |
| (b)  | デプロイ済み CloudFormation スタック + `cdk.out`                     | 公式 cdk2d2 v0.2.0 + `tools/diagrams/src/cdk2d2-official.ts` の互換 shim | 稼働するが、cdk2d2 本体は 2023-04 以降更新なし。Stage の nested assembly と `<artifact>.metadata.json` を読めず、icon CDN も名前解決不能（§3.8） |

本書は、(1) 2026-10-18 時点で保守されている候補を同じ評価軸で並べ、(2) 経路 (b) の shim を維持するか廃止するかの判断材料を示し、(3) 第 3 の経路（CloudFormation template から AWS 公式ツールで描く）の採否を ADR-0024 候補として整理する。

## 1. 評価軸

| 軸                 | 問い                                                                                                     | 本テンプレートでの重み                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 入力               | CDK construct tree / cloud assembly（`cdk.out`）/ CloudFormation template / live account のどれを読むか  | **高**。CDK が正本（指針 17 章）。synth 後の成果物から再現できることが必須                         |
| 出力形式           | SVG / PNG / draw.io / D2 / DOT                                                                           | 中。レビュー差分が取れるテキスト形式（D2・DOT・draw.io XML）を優先し、PNG は閲覧用                 |
| レイアウトエンジン | 自動配置の品質と決定性                                                                                   | 中。コミット対象の SVG が毎回変わると差分レビューが壊れる                                          |
| デプロイ状態の反映 | CloudFormation のリソース状態を色などで表すか                                                            | 低。本テンプレートでは「synth 時点の構成」が主用途。デプロイ状態は CloudFormation console で足りる |
| 保守状況           | 最終リリース日、直近 push、open issue、archived / deprecated 宣言                                        | **高**。24 か月以上更新のないツールは §0.3 の再検討トリガーに該当                                  |
| ライセンス         | OSS ライセンスとアイコン素材の配布条件                                                                   | 中。MPL-2.0 / Apache-2.0 / MIT はいずれも社内利用に支障なし                                        |
| CI での再現性      | ネットワーク不要か、外部 URL 依存はピン留めできるか、headless browser やネイティブ依存（Graphviz）の有無 | **高**。CI は `pnpm diagrams` を毎 PR で実行                                                       |
| AI / MCP 連携      | MCP server または agent skill として呼べるか                                                             | 低〜中。図の「下書き」生成には有用だが、正本は決定的な生成器でなければならない                     |

### 1.1 入力の 4 層

同じ CDK アプリから、抽象度の異なる 4 つの入力が得られる。ツールはこのうちどれを読むかで性格が決まる。

| 層                      | 実体                                                                                                                    | 得られる情報                                                                 | 読むツール                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------- |
| construct tree          | synth 時のメモリ上の `App` 配下。`node.path` / `node.children` で辿れる（CDK v2 Developer Guide「The construct tree」） | L2 / L3 の境界、`@paas/constructs` の粒度                                    | PDK CdkGraph、cdk-dia                                         |
| cloud assembly          | `cdk.out/`（manifest、`<artifact>.metadata.json`、Stage ごとの `assembly-*/`）                                          | construct path 単位のメタデータ（`Show` / `Connection` / `paas:connection`） | 自前 (a)、cdk2d2                                              |
| CloudFormation template | `cdk.out/**/*.template.json`                                                                                            | 論理リソースと `Ref` / `GetAtt` 依存。論理的接続（イベント経路）は含まれない | awsdac `--cfn-template`、cfn-diagram、Infrastructure Composer |
| live account            | デプロイ済みスタック、AWS Config、Application Signals の telemetry                                                      | 実在リソースと稼働状態                                                       | cdk2d2（状態色）、Application Map                             |

本テンプレートの図が伝えたいのは「サービス境界と非同期の論理経路（outbox → EventBridge → SQS）」であり、これは template 層には現れない。したがって cloud assembly 層を読む経路が正本でなければならない。

## 2. 候補ごとの検証済み事実

各候補の「確認日」はすべて 2026-10-18。リリース日は GitHub Releases の `published_at`、push 日はリポジトリの `pushed_at`。

### 2.1 awslabs/diagram-as-code（`awsdac`）

- URL: https://github.com/awslabs/diagram-as-code 、docs: `doc/cloudformation.md`、`doc/mcp-server.md`、`doc/template.md`、`doc/resource-types.md`
- ライセンス: Apache-2.0。stars 1,588、open issues 38、最終 push 2026-09-16、archived ではない。
- リリース: v0.24（2026-08-26）、v0.23（2026-04-08）、v0.22.4（2025-11-27）。v0.24 で MCP tool `listDocumentation` / `getDocumentation` を追加。v0.23 で orthogonal link の配置改善と「YAML 中の未使用リソース警告」を追加。
- 入力: 独自 YAML（`Diagram: Resources:` に `AWS::Diagram::Canvas` を根とするツリー）。`-c, --cfn-template` は README で `[beta] Create diagram from CloudFormation template`、`-d, --dac-file` は `[beta] Generate YAML file in dac (diagram-as-code) format from CloudFormation template` と明記。`-t, --template` は Go `text/template` 展開で、`doc/template.md` は YAML の繰り返し生成だけを扱い、JSON や CDK 成果物の読み込みは記載なし。CDK の直接入力は README に記載なし（確認日 2026-10-18、https://github.com/awslabs/diagram-as-code/blob/main/README.md ）。
- 出力: PNG のみ（README の `-o` 説明と `doc/cloudformation.md`）。SVG・draw.io の出力は記載なし。
- アイコン定義: 既定は `DefinitionFiles: - Type: URL` で `https://raw.githubusercontent.com/awslabs/diagram-as-code/main/definitions/definition-for-aws-icons-light.yaml` を実行時に取得する（`examples/alb-ec2.yaml`）。`Type: LocalFile` と `--override-def-file` でローカル定義に差し替え可能。定義ファイル中の `AWS::*` 型は 326 件（2026-10-18 に `grep -c '^  AWS::'` で計数）。
- `--cfn-template` の公式記載（`doc/cloudformation.md`）: 「currently in beta」。既知の問題として「Complex nested stacks may not render correctly」「Some resource dependencies are not detected automatically」「Custom resources are not supported」。直接変換モードでは配置を変更できず、`--dac-file` で YAML を出してから手で整える 2 段階ワークフローを推奨。
- CDK 生成 template に対する open issue（state: open、2026-10-18 時点）:
  - #196（2025-06-12）「Fails to produce image for large CDK generated CloudFormation Template」。`AWS::IAM::Policy` が定義ファイルにないと service icon へ fallback した後に nil pointer で panic。コメントで `AWS::ElasticLoadBalancingV2::Listener` でも再現報告。
  - #202（2025-07-07）「Which resources are supported?」。`AWS::ApiGateway::Resource` で同じ panic。
  - #221（2025-08-27）`AWS::Serverless::Function` が定義にない。
  - #300（2026-09-16）cfn 変換時に custom dac template と画像が上書きし合う。
- MCP server: `cmd/awsdac-mcp-server`（brew / `go install` で同梱）。tool は `generateDiagram`（YAML → base64 PNG）、`generateDiagramToFile`、`getDiagramAsCodeFormat`。入力は YAML であり、CloudFormation template を MCP 経由で渡す tool は `doc/mcp-server.md` に記載なし。
- 配布: `go install github.com/awslabs/diagram-as-code/cmd/awsdac@latest`、`brew install awsdac`、コンテナ。headless browser 不要（README）。

### 2.2 AWS PDK（aws/aws-pdk）CdkGraph + CdkGraphDiagramPlugin

- URL: https://github.com/aws/aws-pdk 、https://aws.github.io/aws-pdk/developer_guides/cdk-graph-plugin-diagram/index.html
- 保守状況: README 冒頭に「**The AWS PDK is no longer supported.** We recommend migrating to the Nx Plugin for AWS」。最終リリース v0.26.15（2025-10-31、Lambda runtime を Node 18 → 20 に変更）。最終 push 2026-09-11（archived ではない）。Apache-2.0。
- 機能（docs）: `new CdkGraph(app, { plugins: [new CdkGraphDiagramPlugin()] })` を組み、`app.synth()` 後に `await graph.report()` で `cdk.out/` に `diagram.dot` / `diagram.svg` / `diagram.png` を書く。provider は Graphviz のみ stable、draw.io は「early design stage」。filter plan（COMPACT / NON_EXTRANEOUS / NONE、resource type や node type の include / exclude、focus）と dark theme を持つ。
- 移行ガイド（https://awslabs.github.io/nx-plugin-for-aws/en/blog/migrating-from-aws-pdk/ 、2026-09-07）: CDK Graph / Diagram Plugin の同等機能は Nx Plugin for AWS に**ない**。「For a similar deterministic approach a viable alternative is」として cdk-dia を、生成 AI 系として foundation model による生成を挙げる。CDK Graph がアイコン対応に使っていた AWS Arch も「no direct replacement」。
- Nx Plugin for AWS（https://github.com/awslabs/nx-plugin-for-aws 、v1.0.11、2026-10-15、Apache-2.0）の docs トップに diagram 生成の記載なし（確認日 2026-10-18、https://awslabs.github.io/nx-plugin-for-aws/en/ ）。

### 2.3 cdk-dia（pistazie/cdk-dia）

- URL: https://github.com/pistazie/cdk-dia
- ライセンス: MIT。stars 970、open issues 35、最終 push 2026-09-27。
- リリース: 0.12.4（2026-09-27）、0.12.3（2026-01-27）、0.12.2（2026-01-24）、0.12.1（2025-09-29）。0.12.4 / 0.12.2 のリリースノート本文は空。変更内容は GitHub の compare リンクのみ（公式に記載なし、確認日 2026-10-18、https://github.com/pistazie/cdk-dia/releases ）。
- 入力: `cdk synth` 後に `npx cdk-dia`。L2 construct を既定で collapse し、decorator で個別制御。`--include <stack>` でスタック選択。
- 出力: PNG（既定）、`--rendering cytoscape-html` は experimental。Graphviz の `dot` が PATH に必要。
- AWS 公式の位置づけ: PDK 移行ガイドが「deterministic approach」の代替として名指し（§2.2）。

### 2.4 D2（terrastruct/d2）+ TALA + AWS アイコン

- URL: https://github.com/terrastruct/d2 、https://d2lang.com/blog/tala-is-open-source/ 、https://d2lang.com/tour/tala/
- ライセンス: MPL-2.0（リポジトリ `LICENSE.txt`）。stars 25,623、open issues 537、最終 push 2026-10-11。
- リリース: v0.9.0（2026-09-07）で TALA を open source 化し本体に同梱。`d2 --layout=tala`、`D2_LAYOUT=tala`、`vars.d2-config.layout-engine: tala` で選択。`--tala-seeds` でレイアウト試行回数を設定。installer は旧 `--tala` フラグを拒否して移行案内を出す。v0.8.2（2026-08-28）で Dagre / ELK を Go ネイティブ実装に置換（配置が変わるので snapshot 再生成が必要と明記）。
- TALA のライセンス: blog（2026-09-07、Alexander Wang）に「open-source under MPL-2.0, the same license as D2」。リポジトリに `d2layouts/d2talalayout` が存在。
- TALA の適性（同 blog）: software architecture 向けの orthogonal engine で「Dagre or ELK often work better for long, flowing DAG-style graphs」「randomness: a small change to a label can cascade into an entirely different layout」「slower on large diagrams」。
- WASM: npm `@d2lang/d2` 0.1.34（2026-09-07、MPL-2.0）。npm の `d2`（31.10.2、2021-11-18、BSD-3-Clause）は無関係のパッケージ。
- AWS アイコン: D2 本体に AWS アイコン集は同梱されない（`d2lang.com/tour/icons/` は任意 URL とローカルファイルを指定する方式で、AWS 専用セットの記載なし）。`https://icons.terrastruct.com/aws%2FCompute%2FAWS-Lambda_Lambda-Function_light-bg.svg` は 2026-10-18 に HTTP 200 / `image/svg+xml` を返す。`icons.d2lang.com` は「provided, free, for your convenience」「icons at existing URLs won't be changed or expired」と記載。ライセンス表記は公式に記載なし（確認日 2026-10-18、https://icons.d2lang.com/ ）。

### 2.5 AWS Infrastructure Composer（旧 Application Composer）

- URL: https://docs.aws.amazon.com/infrastructure-composer/latest/dg/what-is-composer.html 、https://docs.aws.amazon.com/infrastructure-composer/latest/dg/infrastructure-composer-end-of-support.html
- 入力: CloudFormation / SAM template の import。CDK は記載なし（synth 済み template を渡す形になる）。customer-facing API / SDK / CLI は「ない」と明記。
- **サポート終了**: standalone console は 2026-12-07 に終了。新規顧客は 2026-10-29 から受付停止。AWS Toolkit for Visual Studio Code 内の Infrastructure Composer は継続。CloudFormation console の埋め込みは「improved visual editor component」に置換。Lambda console と Step Functions console の「Export to Infrastructure Composer」は削除。
- 位置づけ: 対話的な設計・閲覧ツールであり、CI で成果物を生成する用途ではない。

### 2.6 Workload Discovery on AWS（live account）

- URL: https://docs.aws.amazon.com/solutions/workload-discovery-on-aws/
- **提供終了**: 「This AWS Solution is no longer available.」代替として Amazon CloudWatch Application Map と AWS DevOps Agent を案内。
- CloudWatch Application Map（https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/ServiceMap.html ）: Application Signals の telemetry（trace / metric）から service と dependency の topology を描く。未計装 service は Resource Explorer で検出（最大 3,000 resources）。cross-account 対応。構成図としての export（SVG / draw.io）は記載なし（確認日 2026-10-18）。
- AWS DevOps Agent（https://aws.amazon.com/devops-agent/ ）: service-topology mapping を含むが、構成図生成は記載なし。

### 2.7 mingrammer/diagrams（Python）

- URL: https://github.com/mingrammer/diagrams
- ライセンス: MIT。stars 42,735、open issues 399、最終 push 2026-10-17。リリース v0.25.1（2025-11-22）。
- 入力: Python コード（手書き）。CDK / CloudFormation の読み込み機能はない（README は「doesn't manage cloud resources or generate CloudFormation or Terraform」）。Python 3.9+ と Graphviz が必要。

### 2.8 cfn-diagram（ljacobsson / mhlabs）

- URL: https://github.com/ljacobsson/cfn-diagram （upstream）、https://github.com/mhlabs/cfn-diagram （fork）
- mhlabs fork の README: 「no longer being updated」で upstream を案内。fork の最終 push 2024-06-30、最終リリース 1.1.37（2023-11-08）。
- upstream: v1.1.40（2024-04-19）、最終 push 2024-04-19、open issues 38、`package.json` の license は ISC。
- 入力: CloudFormation / SAM / CDK（CDK は内部で synth を実行）。出力: draw.io、vis.js HTML、Mermaid、ASCII。
- 保守状況: 最終更新から 30 か月。§0.3 の「24 か月より古い」トリガーに該当。

### 2.9 AWS Diagram MCP Server と後継の agent skill

- `awslabs.aws-diagram-mcp-server`（PyPI）: 全バージョンが yanked。yanked reason は「Superceeded by diagram agent skill in the deploy-on-aws plugin https://github.com/awslabs/agent-plugins/tree/main/plugins/deploy-on-aws」。最終版 1.0.23（2026-03-09）。awslabs/mcp の `src/` に `diagram` を含むディレクトリは存在しない（2026-10-18、GitHub contents API）。
- 後継: https://github.com/awslabs/agent-plugins の `plugins/deploy-on-aws/skills/aws-architecture-diagram`（Apache-2.0、最終 push 2026-10-15）。SKILL.md によれば、コードベースを走査して CloudFormation（`AWS::*`）、CDK（`cdk.json` と construct 定義）、Terraform（`resource "aws_*"`）を検出し、**draw.io XML**（AWS4 アイコン）を `./docs/` に書く。PNG / SVG / PDF export は draw.io desktop CLI がある場合のみ。生成は LLM が行うため決定的ではない。
- 2026-10-18 時点で、AWS 公式ブログ / What's New に「CDK や CloudFormation から構成図を自動生成する新サービス」の発表は見つからなかった（WebSearch extended、クエリ「AWS architecture diagram generation from CDK CloudFormation 2026 announcement」。公式に記載なし）。

### 2.10 cdk2d2（megaproaktiv/cdk2d2）: 現行経路 (b)

- URL: https://github.com/megaproaktiv/cdk2d2 、解説記事 https://www.tecracer.com/blog/2023/04/a-new-simple-approach-to-diagram-as-code-on-aws-with-cdk-and-d2.html （2023-04-02、Gernot Glawe）
- ライセンス: Apache-2.0。stars 41、open issues 2、**最終 push 2026-10-18 時点で 2023-04-06**、唯一のリリース v0.2.0（2023-04-02。`changelog.md` 上の日付は 2023-03-05）。archived ではないが、`changelog.md` の Unreleased 節に「(todo) Use cloudformation template」「(todo) Read CfnResources」が残ったまま。
- 動作: cloud assembly の manifest から `Show` / `Connection` / `Container` メタデータを読み、CloudFormation をポーリングしてリソース状態を色（作成中 = 黄、完了 = 緑）で描く。watch モードは 4 秒ごとに `.d2` を再生成。
- アイコン: `main/main.go` が `https://cdn.megaproaktiv.de/img/icons/` と `https://icons.terrastruct.com/aws%2F_General%2F...` を参照。`cdn.megaproaktiv.de` は 2026-10-18 に DNS 名前解決に失敗（curl exit code 6）。本リポジトリの `tools/diagrams/src/cdk2d2-official.ts` 188〜200 行目が `icons.terrastruct.com` への置換表を持つ。
- 互換性: v0.2.0 は Stage の nested assembly と `<artifact>.metadata.json` を読めない（本リポジトリでの計測で確定。2026-10-17 の sandbox 実デプロイ時に shim で回避）。

## 3. 比較表

| 候補                                   | 入力                                      | 出力                             | レイアウト                 | デプロイ状態 | 最終リリース（push）         | ライセンス | CI 再現性                                                                                                       | AI / MCP                                   |
| -------------------------------------- | ----------------------------------------- | -------------------------------- | -------------------------- | ------------ | ---------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 自前 (a) `cdk2d2.ts` + D2 TALA         | cloud assembly メタデータ                 | D2 → SVG                         | TALA（同梱、ELK へ退避可） | なし         | D2 v0.9.0（2026-09-07）      | MPL-2.0    | 高。アイコンは URL 参照（`icons.terrastruct.com`）                                                              | なし                                       |
| awsdac `--cfn-template`                | CloudFormation template（beta）           | PNG                              | 独自（グリッド配置）       | なし         | v0.24（2026-08-26 / 09-16）  | Apache-2.0 | 中。定義 YAML を既定で raw.githubusercontent から取得。CDK 生成 template で panic する open issue（#196, #202） | `awsdac-mcp-server`（YAML 入力）           |
| awsdac YAML（手書き）                  | 独自 YAML                                 | PNG                              | 独自                       | なし         | 同上                         | Apache-2.0 | 高（定義をローカル化すれば）                                                                                    | 同上                                       |
| PDK CdkGraphDiagramPlugin              | CDK construct tree（synth 時）            | DOT / SVG / PNG                  | Graphviz                   | なし         | v0.26.15（2025-10-31）       | Apache-2.0 | 中。Graphviz 必須                                                                                               | なし                                       |
| cdk-dia                                | `cdk.out`（synth 後）                     | PNG / cytoscape HTML             | Graphviz dot               | なし         | 0.12.4（2026-09-27）         | MIT        | 中。Graphviz 必須                                                                                               | なし                                       |
| cdk2d2 v0.2.0 + shim（現行 b）         | cloud assembly + CloudFormation API       | D2 → SVG                         | D2（TALA）                 | **あり**     | v0.2.0（2023-04-02 / 04-06） | Apache-2.0 | 低。AWS 認証とデプロイ済みスタックが必要。icon CDN 消失                                                         | なし                                       |
| cfn-diagram（upstream）                | CloudFormation / SAM / CDK                | draw.io / HTML / Mermaid / ASCII | vis.js / draw.io           | なし         | v1.1.40（2024-04-19）        | ISC        | 中                                                                                                              | なし                                       |
| mingrammer/diagrams                    | Python コード（手書き）                   | PNG 等                           | Graphviz                   | なし         | v0.25.1（2025-11-22）        | MIT        | 中。Graphviz + Python                                                                                           | 旧 AWS Diagram MCP Server が利用（yanked） |
| agent skill `aws-architecture-diagram` | コードベース走査（CFn / CDK / Terraform） | draw.io XML                      | LLM が配置                 | なし         | push 2026-10-15              | Apache-2.0 | 低（非決定的）                                                                                                  | **skill そのもの**                         |
| Infrastructure Composer                | CloudFormation / SAM import               | console / VS Code 表示           | 独自                       | なし         | console は 2026-12-07 終了   | —          | 不可（対話的）                                                                                                  | なし                                       |
| Workload Discovery                     | live account（AWS Config）                | —                                | —                          | —            | **提供終了**                 | —          | —                                                                                                               | —                                          |
| CloudWatch Application Map             | live telemetry（Application Signals）     | console 表示                     | 独自                       | 稼働状態     | 現行サービス                 | —          | 不可（export 記載なし）                                                                                         | なし                                       |

## 4. 問いへの回答: 「最新の AWS system diagram as code」

1. **AWS 公式で現在も開発が続く IaC → 図の決定的ツールは awslabs/diagram-as-code（`awsdac`）だけ**である。ただし CloudFormation 入力は 2026-10-18 時点でも beta で、CDK が生成する `AWS::IAM::Policy` / `AWS::ApiGateway::Resource` などの sub-resource で panic する issue が 2025-06 から open のまま（§2.1）。
2. **AWS 公式の CDK construct tree ベース（PDK CdkGraph）は非サポート宣言済み**で、AWS 自身が後継として cdk-dia（コミュニティ、MIT、2026-09-27 リリース）を名指ししている（§2.2）。
3. **AWS 公式の MCP 経由の図生成は「MCP server」から「agent skill（draw.io 出力）」へ移った**（§2.9）。決定的な生成器ではなく、下書き用途。
4. **live account 系（Workload Discovery）と console 系（Infrastructure Composer standalone）は終了**し、運用中の topology は CloudWatch Application Map が担う（§2.5、§2.6）。
5. **レイアウト基盤としての D2 + TALA は 2026-09-07 に OSS 化され最も活発**（§2.4）。cdk2d2 が使った「CDK メタデータ → D2」という発想は、ツール本体が止まっても D2 側が生きているため、自前生成器 (a) として維持する価値がある。

つまり「cdk2d2 の後継」として 1 つの公式ツールを置き換え採用できる状況にはない。入力の軸で選ぶのが正しい。

## 5. 本テンプレートへの推奨

### 5.1 現行 2 経路の位置づけ

| 経路 | 判断               | 理由                                                                                                                                                                                |
| ---- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a)  | **維持（正本）**   | 入力が cloud assembly で AWS 不要、D2 ソースが差分レビュー可能、TALA が D2 v0.9.0 に同梱されプラグイン不要。CI で毎 PR 実行済み。外部依存は `icons.terrastruct.com` の URL 参照のみ |
| (b)  | **廃止候補（§6）** | cdk2d2 本体が 30 か月更新なし、icon CDN 消失、Stage / `metadata.json` 非対応で shim が必要。デプロイ状態の色分けは CloudFormation console と Application Map で代替可能             |

### 5.2 第 3 の経路: `awsdac --cfn-template` を synth 後に実行する案

```bash
# 例（採用する場合の形。本テンプレートにはまだ組み込んでいない）
pnpm cdk synth --quiet
awsdac cdk.out/<stack>.template.json --cfn-template --dac-file -o docs/architecture/diagrams/cfn/<stack>.png
```

| 長所                                                                                 | 短所                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS 公式・Apache-2.0・活発（2026-08-26 リリース、2026-09-16 push）                   | CloudFormation 入力が beta。CDK 生成 template で panic する open issue #196 / #202（§2.1）。本テンプレートの template は `AWS::IAM::Policy` と `AWS::Lambda::Permission` を多数含む                        |
| 公式 AWS アイコンで「AWS らしい」図になる。`--dac-file` で YAML を出して手修正できる | 出力が PNG のみ。差分レビュー不能。SVG は公式に記載なし                                                                                                                                                    |
| headless browser 不要、単一バイナリ                                                  | アイコン定義を既定で raw.githubusercontent から実行時取得する。CI では `--override-def-file` でリポジトリ内にピン留めが必要                                                                                |
| MCP server があり AI 補助と相性がよい                                                | MCP の入力は YAML であり、template を直接渡す tool はない                                                                                                                                                  |
| nested stack / custom resource の制約は本テンプレートの単一スタック構成では影響小    | 「Some resource dependencies are not detected automatically」と明記。本テンプレートの `paas:connection` 注釈（outbox relay → EventBridge → SQS など論理的な接続）は template 上に Ref が無いため描かれない |

**判断**: 実験（experiment）として採用し、正本にはしない。CI のオプションジョブ（失敗しても PR をブロックしない）で `--cfn-template` を実行し、#196 / #202 が閉じた時点で再評価する。計測で確定: 本テンプレートの `cdk.out/*.template.json` に対して panic せずに描けるか（M-NN、`docs/decision/template-defaults.md` に項目追加）。

実験ジョブの最小構成（採用時に `.github/workflows/ci.yml` へ追加する形。`continue-on-error: true` で非ブロッキングにする）:

```yaml
- name: diagrams (experimental, awsdac --cfn-template)
  continue-on-error: true
  run: |
    go install github.com/awslabs/diagram-as-code/cmd/awsdac@v0.24   # バージョンをピン留め
    for t in cdk.out/assembly-*/*.template.json cdk.out/*.template.json; do
      [ -f "$t" ] || continue
      awsdac "$t" --cfn-template --dac-file \
        --override-def-file tools/diagrams/awsdac/definition-for-aws-icons-light.yaml \
        -o "docs/architecture/diagrams/cfn/$(basename "${t%.template.json}").png" || echo "awsdac failed: $t"
    done
```

- 定義 YAML（`definition-for-aws-icons-light.yaml`、約 243 KB）はリポジトリに vendoring し、`--override-def-file` で参照する。既定の raw.githubusercontent 取得は CI の再現性を壊す（§2.1）。
- Stage を使う本テンプレートでは template が `cdk.out/assembly-<stage>/` 配下に出る。cdk2d2 と同じ nested assembly の問題が awsdac には無い（template を 1 ファイルずつ渡すため）。
- `--dac-file` で出る `output.yaml` はコミットしない。手修正した YAML を正本にすると (a) と二重管理になる。

### 5.3 代替案: CdkGraph（PDK）または cdk-dia を使う案

| 観点               | PDK CdkGraphDiagramPlugin                                                                                                              | cdk-dia                                                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 長所               | construct tree を読むため L2/L3 の境界（`@paas/constructs`）がそのまま図の階層になる。filter plan で粒度制御。DOT / SVG 出力で差分可能 | 同じく construct tree ベースで L2 を自動 collapse。2026-09-27 リリースで現役。MIT。AWS 公式移行ガイドが名指し                     |
| 短所               | **非サポート宣言済み**（README）。最終リリース 2025-10-31。`@aws/pdk` 全体を依存に入れる必要があり、CDK バージョン追従が止まるリスク   | Graphviz のネイティブ依存が CI に増える。出力は PNG（差分レビュー不能）か experimental HTML。リリースノートが空で変更追跡しにくい |
| 本テンプレート適性 | 不採用。非サポートの依存を正本経路に置かない                                                                                           | 補助用途なら可。ただし (a) が既に construct 境界（`Show` 注釈）を描いており、重複する                                             |

**判断**: どちらも正本にはしない。(a) が同じ入力（cloud assembly）から D2 を生成しており、Graphviz や非サポート依存を増やす理由がない。

### 5.4 agent skill（draw.io）の扱い

`aws-architecture-diagram` skill は、設計レビュー前の「説明用の絵」を速く作る用途に限って MAY とする。生成物はコミットしない。理由: LLM の出力は決定的でなく、本リポジトリのエビデンス規約（出典のない構成要素を図に描かない）を自動では満たせない。

## 6. cdk2d2 互換 shim を維持するか廃止するかの判断材料

### 6.1 事実

- cdk2d2 の更新は 2023-04-06 の push が最後。リリースは v0.2.0（2023-04-02）のみ。Unreleased の todo（CloudFormation template 読み込み）は 3 年半実装されていない（§2.10）。
- icon CDN `cdn.megaproaktiv.de` は名前解決不能。shim 側で `icons.terrastruct.com` へ置換して延命している（`tools/diagrams/src/cdk2d2-official.ts` 188〜200 行目）。
- cdk2d2 v0.2.0 は Stage の nested assembly と `<artifact>.metadata.json` を読まないため、shim が互換 assembly を生成している（計測で確定、2026-10-17）。
- (b) が提供する独自価値は「CloudFormation のリソース状態を色で描く」ことだけ。これは CloudFormation console の Resources タブ、および Application Signals の Application Map（稼働状態）で代替できる。
- (b) は AWS 認証とデプロイ済みスタックを必要とし、CI で再現できない。

### 6.2 選択肢

| 選択肢                              | 内容                                                                                                                                                | 費用 / リスク                                                                                                    |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| A. shim を廃止                      | `diagrams:deployed` script と `cdk2d2-official.ts`、`diagrams/deployed/` を削除。paved constructs の `Connection` 注釈（cdk2d2 形式）は残す（無害） | 失うのはデプロイ状態の色分けのみ。保守負担（バイナリ DL、icon 置換表、assembly 変換）がゼロになる                |
| B. shim を凍結して残す              | 現状維持。README に「2023 年で更新停止したツールの互換レイヤ」と明記し、四半期 conformance review の対象外にする                                    | shim の変換ロジックが CDK の cloud assembly schema 変更で壊れたとき、誰も直さない                                |
| C. (a) にデプロイ状態の色分けを移植 | `cdk2d2.ts` に `describe-stack-resources` を叩くオプションを足し、cdk2d2 本体を捨てる                                                               | 実装 1 日程度（既定値（例示値）: 理由 = CloudFormation API 呼び出しと D2 の style 付与のみ。調整: TD-NN は不要） |

### 6.3 推奨

**A（廃止）を推奨し、要望が出たら C を実装する。** 根拠は §0.3 の再検討トリガー（出典 24 か月超、リリースノート 12 か月以上更新なし）に cdk2d2 が二重に該当すること、(b) の価値が AWS の既存 console で代替できること。B は「動いているが誰も責任を持たない経路」を残すため不採用。

## 7. ADR-0024 候補

- タイトル: 「構成図生成の入力は cloud assembly、正本は D2。cdk2d2 互換経路は廃止し、awsdac は実験扱い」
- Decision drivers: CI 再現性、差分レビュー可能性、保守されている依存のみを正本に置く、AWS 認証なしで生成できること。
- Options considered: §3 の全候補。
- Decision: (a) を唯一の正本経路とする。(b) を廃止（§6.3 A）。`awsdac --cfn-template` を CI の非ブロッキング実験ジョブで走らせ、#196 / #202 の解消と SVG 出力対応を Review date の判定条件にする。agent skill は説明用途のみ MAY。
- Consequences: デプロイ状態の色分けは CloudFormation console / Application Map に委ねる。`tools/diagrams/.bin/` のバイナリ DL が消え、CI の外部依存が `icons.terrastruct.com` の URL 参照だけになる（これもローカルキャッシュ化を検討）。
- Review date: 2027-04-18（半年）。トリガー: awsdac が CloudFormation 入力を GA にする、SVG 出力を追加する、または D2 が AWS アイコン集を同梱する。

## 8. 再検討トリガー（本書固有）

- awslabs/diagram-as-code の `--cfn-template` から `[beta]` 表記が外れる、または issue #196 / #202 が closed になる。
- D2 のメジャーリリースで TALA のレイアウト決定性（`--tala-seeds`）の仕様が変わる。
- `icons.terrastruct.com` または `icons.d2lang.com` が 4xx / 5xx を返す（CI の diagrams ステップが検知する）。
- AWS が CDK / CloudFormation からの図生成を What's New で発表する（2026-10-18 時点では該当なし）。

## 9. 参考（確認日 2026-10-18）

| #   | 出典                                                                                                                                                                                                                                                                    | 用途            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| 1   | https://github.com/awslabs/diagram-as-code （README、`doc/cloudformation.md`、`doc/mcp-server.md`、`doc/template.md`、`doc/resource-types.md`、`examples/alb-ec2.yaml`、`definitions/definition-for-aws-icons-light.yaml`、issues #196 / #202 / #221 / #300、Releases） | §2.1、§5.2      |
| 2   | https://github.com/aws/aws-pdk （README、Releases）、https://aws.github.io/aws-pdk/developer_guides/cdk-graph-plugin-diagram/index.html                                                                                                                                 | §2.2、§5.3      |
| 3   | https://awslabs.github.io/nx-plugin-for-aws/en/blog/migrating-from-aws-pdk/ 、https://github.com/awslabs/nx-plugin-for-aws                                                                                                                                              | §2.2            |
| 4   | https://github.com/pistazie/cdk-dia （README、Releases）                                                                                                                                                                                                                | §2.3、§5.3      |
| 5   | https://github.com/terrastruct/d2 （Releases v0.9.0 / v0.8.2、`LICENSE.txt`、`d2layouts/`）、https://d2lang.com/blog/tala-is-open-source/ 、https://d2lang.com/tour/tala/ 、https://d2lang.com/tour/icons/ 、https://icons.d2lang.com/ 、npm `@d2lang/d2`               | §2.4            |
| 6   | https://docs.aws.amazon.com/infrastructure-composer/latest/dg/what-is-composer.html 、https://docs.aws.amazon.com/infrastructure-composer/latest/dg/infrastructure-composer-end-of-support.html                                                                         | §2.5            |
| 7   | https://docs.aws.amazon.com/solutions/workload-discovery-on-aws/ 、https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/ServiceMap.html 、https://aws.amazon.com/devops-agent/                                                                                | §2.6            |
| 8   | https://github.com/mingrammer/diagrams                                                                                                                                                                                                                                  | §2.7            |
| 9   | https://github.com/ljacobsson/cfn-diagram 、https://github.com/mhlabs/cfn-diagram                                                                                                                                                                                       | §2.8            |
| 10  | https://pypi.org/pypi/awslabs.aws-diagram-mcp-server/json （yanked reason）、https://github.com/awslabs/agent-plugins/tree/main/plugins/deploy-on-aws/skills/aws-architecture-diagram                                                                                   | §2.9            |
| 11  | https://github.com/megaproaktiv/cdk2d2 （`main/main.go`、`changelog.md`、Releases）、https://www.tecracer.com/blog/2023/04/a-new-simple-approach-to-diagram-as-code-on-aws-with-cdk-and-d2.html                                                                         | §2.10、§6       |
| 12  | https://docs.aws.amazon.com/cdk/v2/guide/apps.html （construct tree、`node.path`）                                                                                                                                                                                      | §1 入力軸の定義 |
| 13  | 本リポジトリ `tools/diagrams/src/cdk2d2.ts`、`tools/diagrams/src/cdk2d2-official.ts`、`.github/workflows/ci.yml`                                                                                                                                                        | 現行経路の事実  |
