#!/usr/bin/env node
/**
 * pnpm power-tuning --state-machine <arn> --function <lambda arn or alias arn> [--payload file.json]
 *                   [--memory 256,512,1024,2048] [--invocations 50] [--strategy cost|speed|balanced]
 *
 * Starts an execution of the AWS Lambda Power Tuning state machine
 * (https://github.com/alexcasalboni/aws-lambda-power-tuning, deployed via the Serverless
 * Application Repository) and prints the result JSON + visualization URL. Record the output in
 * the service's ADR / performance evidence (guideline §2 "Evidence over defaults", §10).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DescribeExecutionCommand,
  GetExecutionHistoryCommand,
  SFNClient,
  StartExecutionCommand,
} from '@aws-sdk/client-sfn';

function option(name: string, fallback?: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  const v = idx >= 0 ? process.argv[idx + 1] : undefined;
  if (v) return v;
  if (fallback !== undefined) return fallback;
  console.error(`missing --${name}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const stateMachineArn = option('state-machine');
  const lambdaArn = option('function');
  const payloadFile = option('payload', '');
  const input = {
    lambdaARN: lambdaArn,
    powerValues: option('memory', '256,512,1024,1536,2048').split(',').map(Number),
    num: Number(option('invocations', '50')),
    payload: payloadFile ? (JSON.parse(readFileSync(payloadFile, 'utf8')) as unknown) : {},
    parallelInvocation: true,
    strategy: option('strategy', 'balanced'),
    includeOutputResults: false,
  };
  const sfn = new SFNClient({});
  const started = await sfn.send(
    new StartExecutionCommand({ stateMachineArn, input: JSON.stringify(input) }),
  );
  console.log(`started ${started.executionArn}`);
  for (;;) {
    await new Promise((r) => setTimeout(r, 10_000));
    const exec = await sfn.send(
      new DescribeExecutionCommand({ executionArn: started.executionArn }),
    );
    if (exec.status === 'RUNNING') {
      process.stdout.write('.');
      continue;
    }
    console.log(`\nstatus: ${exec.status}`);
    if (exec.status !== 'SUCCEEDED') {
      console.error(exec.cause ?? exec.error ?? 'failed');
      process.exit(1);
    }
    // Output shape of aws-lambda-power-tuning (v4+): { power, cost, duration, stateMachine: { visualization } }.
    const output = JSON.parse(exec.output ?? '{}') as {
      power?: number;
      cost?: number;
      duration?: number;
      results?: { power?: number; cost?: number; duration?: number };
      stateMachine?: { visualization?: string; lambdaCost?: number; executionCost?: number };
    };
    const best = output.results ?? output;
    // Per-memory statistics live in the Executor state outputs of the execution history.
    const history = await sfn.send(
      new GetExecutionHistoryCommand({ executionArn: started.executionArn, maxResults: 1000 }),
    );
    const perMemory = (history.events ?? [])
      .filter((e) => e.type === 'TaskStateExited' && e.stateExitedEventDetails?.name === 'Executor')
      .map((e) => JSON.parse(e.stateExitedEventDetails?.output ?? '{}') as Record<string, unknown>)
      .sort((a, b) => Number(a['value']) - Number(b['value']));
    const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '../results');
    mkdirSync(outDir, { recursive: true });
    const file = resolve(
      outDir,
      `${lambdaArn
        .split(':')
        .slice(-2)
        .join('-')
        .replace(/[^A-Za-z0-9-]/g, '_')}-${Date.now()}.json`,
    );
    writeFileSync(
      file,
      JSON.stringify({ input, output, perMemory, recordedAt: new Date().toISOString() }, null, 2),
    );
    console.log(
      `best: ${best.power} MB, cost ${best.cost} USD/invocation, duration ${best.duration} ms (strategy ${input.strategy})`,
    );
    for (const m of perMemory) {
      console.log(
        `  ${String(m['value']).padStart(5)} MB  avg ${Number(m['averageDuration']).toFixed(2)} ms  ${Number(m['averagePrice']).toExponential(3)} USD/invocation`,
      );
    }
    console.log(`visualization: ${output.stateMachine?.visualization ?? 'n/a'}`);
    console.log(`evidence saved: ${file}`);
    return;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
