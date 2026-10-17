import type { IConstruct } from 'constructs';

/**
 * Diagram annotations compatible with cdk2d2 (https://github.com/megaproaktiv/cdk2d2, v0.2.0):
 * the official tool reads `Show` / `Connection` / `Container` metadata from the cloud assembly
 * and polls CloudFormation to colour resources by deployment state, so it needs a deployed stack
 * (`pnpm diagrams:deployed`). The paved constructs call these helpers automatically.
 *
 * Two edge encodings are written side by side:
 *  - `Connection` = target construct **id** (what cdk2d2 v0.2.0 resolves);
 *  - `paas:connection` = target construct **path** plus an optional label, which the offline
 *    generator in tools/diagrams resolves unambiguously at synth time (no AWS needed).
 */
export const DIAGRAM_METADATA = {
  show: 'Show',
  connection: 'Connection',
  container: 'Container',
  label: 'Label',
  pathConnection: 'paas:connection',
  pathContainer: 'paas:container',
} as const;

export function show(construct: IConstruct, label?: string): void {
  construct.node.addMetadata(DIAGRAM_METADATA.show, 'true');
  if (label) construct.node.addMetadata(DIAGRAM_METADATA.label, label);
}

/** Edge from → to (cdk2d2 id form + path form with optional label). */
export function connection(from: IConstruct, to: IConstruct, label?: string): void {
  from.node.addMetadata(DIAGRAM_METADATA.connection, to.node.id);
  from.node.addMetadata(
    DIAGRAM_METADATA.pathConnection,
    label ? `${to.node.path}|${label}` : to.node.path,
  );
}

export function container(child: IConstruct, parent: IConstruct): void {
  child.node.addMetadata(DIAGRAM_METADATA.container, parent.node.id);
  child.node.addMetadata(DIAGRAM_METADATA.pathContainer, parent.node.path);
}
