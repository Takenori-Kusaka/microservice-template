#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';
import { EnvironmentStage } from '../lib/environment-stage.js';
import { environmentConfig, isEnvironmentName } from '../lib/environments.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../../..');

const app = new App();
const envName: unknown = app.node.tryGetContext('env') ?? 'sandbox';
if (!isEnvironmentName(envName)) {
  throw new Error(
    `unknown environment "${String(envName)}" (use --context env=sandbox|development|staging|production)`,
  );
}
const cellId = String(app.node.tryGetContext('cell') ?? 'cell-01');
const config = environmentConfig(envName, cellId);

new EnvironmentStage(app, `paas-${envName}`, {
  config,
  projectRoot,
  experimentalWeb: String(app.node.tryGetContext('experimentalWeb') ?? 'false') === 'true',
});

app.synth();
