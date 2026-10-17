# ADR-0002: Repository strategy

- Status: accepted
- Date: 2026-10-17
- Owner: platform-team
- Review date: 2027-04-17
- Related: ADR-0001, ADR-0019, ADR-0020

## Context

ADR-0001 でマイクロサービスの単位を「Service Stack = 所有チーム + データ + SLO + デプロイ単位」と定めた。次に、そのサービスとプラットフォーム共通コード（`@paas/constructs`, `@paas/runtime-context`, `@paas/observability`, `@paas/event-contracts`, `@paas/api-contracts`, `@paas/testing`）をどのリポジトリ構成で管理するかを決める必要がある。

初期フェーズの条件は次のとおりである（本テンプレットの前提であり、外部文献に基づく数値ではない）。

- サービス数は 3〜10、チーム数は 1〜3。
- 共通 Construct と SDK が頻繁に変わり、全サービスへ同時に反映したい。
- 契約（OpenAPI、event schema）の breaking change を CI で横断検出したい。
- 一方で、サービスごとの独立デプロイと所有権は ADR-0001 で必須。

Spotify は Backstage により、標準テンプレートにベストプラクティスを組み込み、新サービス作成時にリポジトリ、デプロイ、所有者情報をソフトウェアカタログへ自動登録して開発者負担を下げている。[^9] Amazon の継続的デリバリーでは、各チームが自分のサービスのパイプラインを所有し、テストに高い基準を置く。[^52] 本テンプレートでも「golden path をコード生成と CI で強制する」ことを優先する。

Lambda の Node.js 22 ランタイムは 2027-04-30 に deprecation 予定であり、Node.js 24 は 2028-04-30 まで、Node.js 26 は 2026 年 11 月に提供予定である。[^70] ランタイム更新を全サービスへ一括適用できることは、リポジトリ戦略の評価軸に含める。

## Decision

準拠: Spotify Backstage（テンプレート起点のサービス生成と所有情報の自動登録）[^9]、Amazon Builders' Library「Going faster with continuous delivery」（サービス単位のパイプライン所有）[^52]、AWS Operational Excellence Pillar（所有者の特定）[^11]

初期は **pnpm workspace による単一 monorepo** を採用し、サービス単位の独立 pipeline と ownership を維持する。[^115]

```text
.
├── apps/
│   ├── platform-cdk/             # Environment/Cell Stage の合成
│   ├── example-order-service/    # 各サービスは独立 Service Stack
│   ├── example-worker-service/
│   └── example-workflow-service/
├── packages/
│   ├── constructs/               # @paas/constructs
│   ├── runtime-context/          # @paas/runtime-context
│   ├── observability/            # @paas/observability
│   ├── api-contracts/            # @paas/api-contracts
│   ├── event-contracts/          # @paas/event-contracts
│   └── testing/                  # @paas/testing
├── schemas/                      # openapi/, events/ の正本
├── tests/                        # contract, integration, tenant-isolation, resiliency, performance
└── .github/workflows/            # service ごとの path filter pipeline
```

運用ルール:

- 各 `apps/<service>/` は独自の `cdk.json`、テスト、`ServiceManifest` を持ち、`pnpm --filter <service> cdk deploy` で単独デプロイできる。
- `.github/workflows/` の pipeline は path filter で変更サービスだけを build / test / deploy する。`packages/` の変更時は全サービスの contract test と synth を実行する。
- `CODEOWNERS` で `apps/<service>/` を所有チームに、`packages/` を platform-team に割り当てる。[^114]
- 共通パッケージは workspace 内の `workspace:*` 参照で消費し、サービスは常に最新の共通コードで build される。[^115] 互換性を壊す共通変更は、同一 PR で全サービスを修正する責任を platform-team が負う。
- 契約の正本は `schemas/` に置き、`@paas/api-contracts` と `@paas/event-contracts` が生成物を公開する。OpenAPI は 3.1.0（JSON Schema 2020-12 準拠）を採用する。[^109]
- Node.js 22、TypeScript、vitest、esbuild の設定は root で共有し、サービス側は上書き不可とする。Lambda ランタイムの deprecation（Node.js 22: 2027-04-30）[^70] への対応は root 設定の 1 回の変更で全サービスへ反映する。

monorepo から polyrepo への移行条件は、サービス数が 20 を超える、または共通パッケージの変更が 1 チームでは追えない規模になった時点とし、次回レビューで再評価する（既定値（例示値）: 20。two-pizza team 2〜3 個分を 1 PR で typecheck / test する運用の上限目安として置いた設計判断で、外部出典に基づかない。調整: docs/decision/template-defaults.md#既定値レジスタ（TD-04、半期ごとにサービス数と共通パッケージ変更の影響範囲をレビュー）。）

## Alternatives

### A. Polyrepo（サービスごとにリポジトリ、共通パッケージは npm registry 経由）

- 長所: 所有権とアクセス制御がリポジトリ単位で明確。サービスごとに CI を完全に分離できる。
- 短所: 共通 Construct の変更が各サービスの依存更新を待つため、セキュリティ修正やガードレール変更の反映が遅れる。契約の breaking change を横断検出する仕組みを別途用意する必要がある。初期の 3〜10 サービス規模では registry 運用のコストが見合わない。

### B. Monorepo だが単一 CDK app として全サービスを一括デプロイ

- 長所: 環境全体の整合性を 1 回の deploy で保証できる。
- 短所: 1 サービスの変更で全スタックが synth / diff され、デプロイ時間と障害範囲が拡大する。ADR-0001 の「独立デプロイ単位」と、Amazon のサービス単位パイプライン所有[^52]に反する。

### C. Platform monorepo + サービスは polyrepo（ハイブリッド）

- 長所: 共通コードはまとまり、サービスは独立。
- 短所: 結局 A の依存更新遅延の問題が残る。サービス数が増えた段階での移行先候補としては妥当なので、将来の再評価対象とする。

## Consequences

- **費用**: CI 実行は path filter で抑えるが、`packages/` 変更時は全サービスの synth が走るため、CI 分数は polyrepo より多い。
- **性能**: 開発者のクローン・インストール時間は増えるが、pnpm の content-addressable store で緩和する。[^115]
- **運用**: 1 リポジトリで全サービスの ADR、runbook、threat model を参照でき、新サービス生成（`pnpm create-service`）が単純になる。Backstage 互換の `catalog-info.yaml` を `ServiceManifest` から生成する。[^9]
- **Lock-in**: pnpm workspace に依存するが、ディレクトリ構成は Nx / Turborepo への移行を妨げない。
- **移行**: polyrepo へ移す場合は `packages/` を npm registry へ publish し、`apps/<service>/` を `git subtree split` で切り出す手順を runbook に用意する。

## Evidence

- Spotify Backstage: テンプレートからのサービス生成と所有情報の自動登録が開発者体験を改善した事例。[^9]
- Amazon: 各チームがサービスのパイプラインを所有し、テストに高い基準を置く継続的デリバリー。[^52]
- 受入基準「新規サービスが 15 分以内に生成され、sandbox へ自動デプロイできる」を monorepo 構成で達成することを Phase 1 で検証する（既定値（例示値）: 15 分。調整: docs/decision/template-defaults.md#既定値レジスタ（TD-03）。計測で確定: 所要時間は GitHub Actions の `deploy ephemeral` job duration で取得する（M-01、2026-10-17 時点は未計測）。）
- DORA の change lead time と deployment frequency を monorepo の path filter pipeline で計測し、polyrepo 移行条件の判断材料とする。[^108]
- 四半期レビューで、`packages/` 変更に起因するサービス側修正の PR 数と、CI 所要時間の中央値を記録し、polyrepo 移行条件を評価する。

## Compliance / How it is enforced

- `pnpm-workspace.yaml` が `apps/*` と `packages/*` を定義し、サービスが workspace 外の `@paas/*` を参照すると install が失敗する。[^115]
- `.github/CODEOWNERS` が `apps/<service>/` と `packages/` の所有者を強制する。[^114]
- CI の `policy` ステップで、各 `apps/<service>/` に `ServiceManifest`、`README.md`、`runbook` リンク、ADR 参照が存在することを検査する。
- `pnpm create-service --type api|worker|workflow` が標準ディレクトリ構成と CI path filter を生成し、手作業の逸脱を減らす。
- root の `tsconfig.base.json`、`vitest.workspace.ts`、eslint 設定をサービスが上書きしていないことを lint で確認する。
- Lambda ランタイムの deprecation 日[^70]を CI の `policy` ステップで検査し、deprecation 180 日前に警告を出す。

## 参考

[^9]: [What the Heck is Backstage Anyway? | Spotify Engineering](https://engineering.atspotify.com/2020/3/what-the-heck-is-backstage-anyway)（指針書 References より）

[^11]: [Operational Excellence Pillar - AWS Well-Architected Framework](https://docs.aws.amazon.com/pdfs/wellarchitected/latest/operational-excellence-pillar/wellarchitected-operational-excellence-pillar.pdf)（指針書 References より）

[^52]: [Going faster with continuous delivery](https://aws.amazon.com/builders-library/going-faster-with-continuous-delivery/)（指針書 References より）

[^70]: [Lambda Event Function runtimes](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html)（参照日 2026-10-17。Node.js 22 deprecation 2027-04-30、Node.js 24 deprecation 2028-04-30）

[^108]: [DORA's software delivery metrics: the four keys](https://dora.dev/guides/dora-metrics-four-keys/)（参照日 2026-10-17）

[^109]: [OpenAPI Specification v3.1.0](https://spec.openapis.org/oas/v3.1.0)（参照日 2026-10-17）

[^114]: [About code owners - GitHub Docs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)（参照日 2026-10-17。本文確認済み: CODEOWNERS は `.github/`、リポジトリルート、`docs/` のいずれかに置き、PR 作成時に code owner へ自動でレビュー依頼され、branch protection の「Require review from Code Owners」で承認を必須化できる）

[^115]: [Workspace | pnpm](https://pnpm.io/workspaces)（参照日 2026-10-17。本文確認済み: ルートの `pnpm-workspace.yaml` で対象パッケージを宣言し、`workspace:` protocol はローカル workspace パッケージ以外への解決を拒否する）
