import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Duration } from 'aws-cdk-lib';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import type { Construct } from 'constructs';
import {
  EventSubscription,
  ObservableFunction,
  PavedWorkflow,
  ServiceObservability,
  ServiceStack,
  TRANSIENT_RETRY,
  TenantAwareTable,
  connection,
  loadServiceManifest,
  type ServiceStackProps,
} from '@paas/constructs';

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string): string => resolve(here, '../src', p);

export const workflowServiceManifest = loadServiceManifest(resolve(here, '../service.yaml'));

/**
 * Tenant provisioning saga (ADR-0010): Validate → ReserveSlot → Provision → Activate →
 * publish `tenant.provisioned.v1`. Failures after the reservation run the compensation
 * (ReleaseSlot) and publish `tenant.provisioning-failed.v1`. The state machine only calls this
 * service's own tasks and the event bus: it never touches another service's datastore.
 */
export class WorkflowServiceStack extends ServiceStack {
  readonly workflow: PavedWorkflow;

  constructor(scope: Construct, id: string, props: Omit<ServiceStackProps, 'manifest'>) {
    super(scope, id, { ...props, manifest: workflowServiceManifest });
    const { manifest, config, platform } = this;
    const defaults = this.functionDefaults();

    const table = new TenantAwareTable(this, 'Provisioning', { manifest, config });
    const env = { PROVISIONING_TABLE_NAME: table.table.tableName };

    const task = (operation: string, file: string): ObservableFunction => {
      const fn = new ObservableFunction(this, `Task${operation}`, {
        manifest,
        config,
        operation,
        entry: src(`tasks/${file}.ts`),
        timeout: Duration.seconds(15),
        environment: env,
        alarmTopic: platform.alarmTopic,
        ...defaults,
      });
      table.grantReadWriteData(fn.fn);
      return fn;
    };
    const validate = task('ValidateRequest', 'validate');
    const reserve = task('ReserveTenantSlot', 'reserve-slot');
    const provision = task('ProvisionResources', 'provision');
    const activate = task('ActivateTenant', 'activate');
    const release = task('ReleaseTenantSlot', 'release-slot');

    const invoke = (id: string, fn: ObservableFunction): sfn.TaskStateBase =>
      new tasks.LambdaInvoke(this, id, {
        lambdaFunction: fn.alias,
        payloadResponseOnly: true,
        resultPath: '$.state',
        taskTimeout: sfn.Timeout.duration(Duration.seconds(20)),
        retryOnServiceExceptions: false,
      }).addRetry(TRANSIENT_RETRY);

    const envelopeField = (name: string): string => sfn.JsonPath.stringAt(`$.request.${name}`);
    const publish = (
      id: string,
      detailType: string,
      detail: Record<string, unknown>,
    ): tasks.EventBridgePutEvents =>
      new tasks.EventBridgePutEvents(this, id, {
        entries: [
          {
            eventBus: platform.eventBus,
            source: manifest.serviceId,
            detailType,
            detail: sfn.TaskInput.fromObject({
              specversion: '1.0',
              id: sfn.JsonPath.stringAt('$$.Execution.Name'),
              type: detailType,
              source: manifest.serviceId,
              time: sfn.JsonPath.stringAt('$$.State.EnteredTime'),
              tenantId: envelopeField('tenantId'),
              tenantTier: envelopeField('tenantTier'),
              correlationId: envelopeField('correlationId'),
              causationId: envelopeField('id'),
              subject: sfn.JsonPath.format(
                'tenant/{}',
                sfn.JsonPath.stringAt('$.request.data.targetTenantId'),
              ),
              datacontenttype: 'application/json',
              data: detail,
            }),
          },
        ],
        resultPath: sfn.JsonPath.DISCARD,
      });

    const publishProvisioned = publish('PublishProvisioned', 'tenant.provisioned.v1', {
      targetTenantId: sfn.JsonPath.stringAt('$.request.data.targetTenantId'),
      tier: sfn.JsonPath.stringAt('$.request.data.tier'),
      cellId: sfn.JsonPath.stringAt('$.request.data.cellId'),
      activatedAt: sfn.JsonPath.stringAt('$$.State.EnteredTime'),
    });
    const publishFailed = publish('PublishFailed', 'tenant.provisioning-failed.v1', {
      targetTenantId: sfn.JsonPath.stringAt('$.request.data.targetTenantId'),
      failedStep: sfn.JsonPath.stringAt('$.error.Error'),
      compensated: true,
      reason: sfn.JsonPath.stringAt('$.error.Cause'),
    });

    const compensate = invoke('ReleaseTenantSlot', release)
      .next(publishFailed)
      .next(
        new sfn.Fail(this, 'ProvisioningFailed', {
          error: 'ProvisioningFailed',
          cause: 'compensated',
        }),
      );

    // Validation failures share the compensation path: ReleaseTenantSlot is idempotent (no-op
    // when nothing was reserved), which keeps the state machine to a single failure branch.
    const validateStep = invoke('ValidateRequest', validate).addCatch(compensate, {
      errors: ['States.ALL'],
      resultPath: '$.error',
    });
    const reserveStep = invoke('ReserveTenantSlot', reserve).addCatch(compensate, {
      errors: ['States.ALL'],
      resultPath: '$.error',
    });
    const provisionStep = invoke('ProvisionResources', provision).addCatch(compensate, {
      errors: ['States.ALL'],
      resultPath: '$.error',
    });
    const activateStep = invoke('ActivateTenant', activate).addCatch(compensate, {
      errors: ['States.ALL'],
      resultPath: '$.error',
    });

    const definition = new sfn.Pass(this, 'Init', {
      // Normalise the EventBridge-delivered envelope into { request, state }.
      parameters: { 'request.$': '$', state: {} },
    })
      .next(validateStep)
      .next(reserveStep)
      .next(provisionStep)
      .next(activateStep)
      .next(publishProvisioned)
      .next(new sfn.Succeed(this, 'Provisioned'));

    this.workflow = new PavedWorkflow(this, 'ProvisioningWorkflow', {
      manifest,
      config,
      definition,
      timeout: Duration.minutes(15),
      p99ExecutionTime: Duration.minutes(5),
      alarmTopic: platform.alarmTopic,
    });
    platform.eventBus.grantPutEventsTo(this.workflow.stateMachine);

    new EventSubscription(this, 'RequestedSubscription', {
      manifest,
      eventBus: platform.eventBus,
      eventTypes: ['tenant.provisioning-requested.v1'],
      target: { stateMachine: this.workflow.stateMachine },
      alarmTopic: platform.alarmTopic,
    });
    for (const fn of [validate, reserve, provision, activate, release]) {
      connection(this.workflow.stateMachine, fn.fn);
    }
    connection(
      this.workflow.stateMachine,
      platform.eventBus,
      'tenant.provisioned.v1 / provisioning-failed.v1',
    );

    new ServiceObservability(this, 'Observability', {
      manifest,
      config,
      functions: [validate, reserve, provision, activate, release],
      workflows: [this.workflow],
      alarmTopic: platform.alarmTopic,
    });
  }
}
