# Lambda Power Tuning

指針 §2「Evidence over defaults」と §10/§15 に従い、Lambda のメモリ・アーキテクチャはこのツールで実測して決める。

## 1. 準備（1回）

AWS Lambda Power Tuning（Serverless Application Repository 公開アプリ）を対象アカウントにデプロイする。

```bash
aws serverlessrepo create-cloud-formation-change-set \
  --application-id arn:aws:serverlessrepo:us-east-1:451282441545:applications/aws-lambda-power-tuning \
  --stack-name lambda-power-tuning \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides Name=lambdaResource,Value='*'
# 出力された ChangeSetId を execute-change-set で適用し、StateMachineARN を控える
```

## 2. 実行

```bash
pnpm power-tuning \
  --state-machine arn:aws:states:ap-northeast-1:123456789012:stateMachine:powerTuningStateMachine-xxxx \
  --function arn:aws:lambda:ap-northeast-1:123456789012:function:paas-sandbox-...-ApiFnListOrders... \
  --payload tools/power-tuning/payloads/create-order.json \
  --memory 512,1024,1536,2048 --invocations 100 --strategy balanced
```

結果は `tools/power-tuning/results/*.json` に保存される。関数 ARN は **alias/version 修飾なし**で渡す（power tuning は自身で version と alias を作るため、`:live` 付きの ARN は `Invalid ARN` で失敗する。2026-10-18 に実測で確認）。ADR（例: ADR-0008, ADR-0009）の Evidence 節へリンクする。

## 3. 判定基準

- `balanced` の推奨値を初期値にし、p99 duration が SLO 予算内であることを負荷試験で確認する。
- arm64 と x86 の両方を測り、ネイティブ依存がない限り arm64 を採用する（AWS Serverless Lens の推奨）。

出典: AWS Lambda Power Tuning (https://github.com/alexcasalboni/aws-lambda-power-tuning), AWS Compute Blog「Understanding techniques to reduce AWS Lambda costs in serverless applications」。
