/**
 * Cloud assembly → D2 (same annotation model as https://github.com/megaproaktiv/cdk2d2:
 * `Show`, `Connection`, `Container`, plus `Label`). Unlike the upstream Go tool this generator
 * does not poll CloudFormation, so it works offline on `cdk synth` output and in CI.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface ManifestMetadataEntry {
  type: string;
  data: unknown;
}

interface CloudAssemblyManifest {
  artifacts: Record<
    string,
    {
      type: string;
      properties?: { templateFile?: string; stackName?: string; directoryName?: string };
      /** Older assemblies inline the metadata; newer ones write `<artifact>.metadata.json`. */
      metadata?: Record<string, ManifestMetadataEntry[]>;
      displayName?: string;
    }
  >;
}

/** Construct paths in metadata files start with "/", `node.path` (used in Connection data) does not. */
function normalizePath(path: string): string {
  return path.replace(/^\/+/, '');
}

function loadStackMetadata(
  cdkOut: string,
  artifactId: string,
  inline: Record<string, ManifestMetadataEntry[]> | undefined,
): Record<string, ManifestMetadataEntry[]> {
  const merged: Record<string, ManifestMetadataEntry[]> = {};
  const add = (source: Record<string, unknown>) => {
    for (const [path, entries] of Object.entries(source)) {
      if (Array.isArray(entries)) merged[normalizePath(path)] = entries as ManifestMetadataEntry[];
    }
  };
  if (inline) add(inline);
  const file = join(cdkOut, `${artifactId}.metadata.json`);
  if (existsSync(file)) {
    const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    add((doc['metadata'] as Record<string, unknown> | undefined) ?? doc);
  }
  return merged;
}

interface DiagramNode {
  path: string;
  id: string;
  label: string;
  resourceType?: string;
  stack: string;
}

interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
}

export interface StackDiagram {
  stackName: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  containers: { child: string; parent: string }[];
}

/** Resource type → D2 shape + short kind label. Extend as new services enter the paved road. */
const RESOURCE_STYLES: Record<string, { shape: string; kind: string }> = {
  'AWS::Lambda::Function': { shape: 'hexagon', kind: 'Lambda' },
  'AWS::Lambda::WebFunction': { shape: 'hexagon', kind: 'Lambda Web Function' },
  'AWS::DynamoDB::GlobalTable': { shape: 'cylinder', kind: 'DynamoDB' },
  'AWS::DynamoDB::Table': { shape: 'cylinder', kind: 'DynamoDB' },
  'AWS::SQS::Queue': { shape: 'queue', kind: 'SQS' },
  'AWS::Events::EventBus': { shape: 'diamond', kind: 'EventBridge bus' },
  'AWS::Events::Rule': { shape: 'parallelogram', kind: 'EventBridge rule' },
  'AWS::ApiGatewayV2::Api': { shape: 'cloud', kind: 'API Gateway HTTP API' },
  'AWS::StepFunctions::StateMachine': { shape: 'step', kind: 'Step Functions' },
  'AWS::SNS::Topic': { shape: 'oval', kind: 'SNS' },
  'AWS::KMS::Key': { shape: 'circle', kind: 'KMS' },
};

function d2Id(path: string): string {
  return path.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function escapeLabel(label: string): string {
  return label.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n');
}

export function readCloudAssembly(cdkOut: string): CloudAssemblyManifest {
  const manifestPath = join(cdkOut, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`cloud assembly not found at ${manifestPath}; run \`pnpm synth\` first`);
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as CloudAssemblyManifest;
}

/** Nested stages produce nested assemblies; collect every stack artifact recursively. */
interface StackSource {
  name: string;
  templateFile: string;
  metadata: Record<string, ManifestMetadataEntry[]>;
}

function collectStacks(cdkOut: string, manifest: CloudAssemblyManifest): StackSource[] {
  const stacks: StackSource[] = [];
  for (const [artifactId, artifact] of Object.entries(manifest.artifacts)) {
    if (artifact.type === 'aws:cloudformation:stack' && artifact.properties?.templateFile) {
      stacks.push({
        name: artifact.properties.stackName ?? artifactId,
        templateFile: join(cdkOut, artifact.properties.templateFile),
        metadata: loadStackMetadata(cdkOut, artifactId, artifact.metadata),
      });
    } else if (artifact.type === 'cdk:cloud-assembly' && artifact.properties?.directoryName) {
      const nested = join(cdkOut, artifact.properties.directoryName);
      stacks.push(...collectStacks(nested, readCloudAssembly(nested)));
    }
  }
  return stacks;
}

export function buildDiagrams(cdkOut: string): StackDiagram[] {
  const manifest = readCloudAssembly(cdkOut);
  const stacks = collectStacks(cdkOut, manifest);
  const diagrams: StackDiagram[] = [];

  for (const stack of stacks) {
    const template = JSON.parse(readFileSync(stack.templateFile, 'utf8')) as {
      Resources?: Record<string, { Type: string }>;
    };
    const resources = template.Resources ?? {};
    const logicalIdByPath = new Map<string, string>();
    for (const [path, entries] of Object.entries(stack.metadata)) {
      for (const e of entries)
        if (e.type === 'aws:cdk:logicalId') logicalIdByPath.set(path, String(e.data));
    }
    const resourceTypeForPath = (path: string): string | undefined => {
      // The annotated construct is usually the L2; its CfnResource is a child (…/Resource or …/Default).
      for (const candidate of [path, `${path}/Resource`, `${path}/Default`]) {
        const id = logicalIdByPath.get(candidate);
        if (id && resources[id]) return resources[id].Type;
      }
      const prefix = `${path}/`;
      for (const [p, id] of logicalIdByPath) {
        if (p.startsWith(prefix) && resources[id]) return resources[id].Type;
      }
      return undefined;
    };

    const nodes: DiagramNode[] = [];
    const edges: DiagramEdge[] = [];
    const containers: { child: string; parent: string }[] = [];
    for (const [path, entries] of Object.entries(stack.metadata)) {
      const show = entries.some((e) => e.type === 'Show' && e.data === 'true');
      const label = entries.find((e) => e.type === 'Label')?.data;
      if (show) {
        const resourceType = resourceTypeForPath(path);
        // Node ids only need to be unique inside the stack container: drop the stack path prefix.
        const stackPrefix =
          Object.keys(stack.metadata).sort((a, b) => a.length - b.length)[0] ?? '';
        const localPath = path.startsWith(`${stackPrefix}/`)
          ? path.slice(stackPrefix.length + 1)
          : path;
        nodes.push({
          path,
          id: d2Id(localPath),
          label: typeof label === 'string' ? label : (path.split('/').slice(-1)[0] ?? path),
          ...(resourceType ? { resourceType } : {}),
          stack: stack.name,
        });
      }
      for (const e of entries) {
        if (e.type === 'paas:connection' && typeof e.data === 'string') {
          const [target, edgeLabel] = e.data.split('|');
          if (target)
            edges.push({
              from: path,
              to: normalizePath(target),
              ...(edgeLabel ? { label: edgeLabel } : {}),
            });
        }
        if (e.type === 'paas:container' && typeof e.data === 'string')
          containers.push({ child: path, parent: normalizePath(e.data) });
      }
    }
    diagrams.push({ stackName: stack.name, nodes, edges, containers });
  }
  return diagrams;
}

/**
 * Renders all stacks into one D2 document: one container per stack, nodes inside, edges
 * across stacks resolved by construct path. Unknown edge targets (e.g. imported resources in
 * another stack) become a shared "external" node so the picture stays truthful.
 */
export function toD2(
  diagrams: StackDiagram[],
  options: { title?: string; direction?: 'right' | 'down' } = {},
): string {
  const lines: string[] = [];
  lines.push(`direction: ${options.direction ?? 'right'}`);
  if (options.title) lines.push(`title: |md\n  # ${options.title}\n| { near: top-center }`);
  lines.push('');

  const nodeByPath = new Map<string, { diagram: StackDiagram; node: DiagramNode }>();
  for (const d of diagrams)
    for (const n of d.nodes) nodeByPath.set(n.path, { diagram: d, node: n });
  const qualified = (d: StackDiagram, n: DiagramNode): string => `${d2Id(d.stackName)}.${n.id}`;

  for (const d of diagrams) {
    lines.push(`${d2Id(d.stackName)}: "${escapeLabel(d.stackName)}" {`);
    for (const n of d.nodes) {
      const style = n.resourceType ? RESOURCE_STYLES[n.resourceType] : undefined;
      const label = style ? `${n.label}\n(${style.kind})` : n.label;
      lines.push(`  ${n.id}: "${escapeLabel(label)}" {`);
      lines.push(`    shape: ${style?.shape ?? 'rectangle'}`);
      lines.push('  }');
    }
    lines.push('}');
    lines.push('');
  }

  const externals = new Set<string>();
  for (const d of diagrams) {
    for (const e of d.edges) {
      const from = nodeByPath.get(e.from);
      const to = nodeByPath.get(e.to);
      const fromRef = from ? qualified(from.diagram, from.node) : undefined;
      let toRef: string;
      if (to) {
        toRef = qualified(to.diagram, to.node);
      } else {
        // Imported resource (fromEventBusName etc.): draw as an external node named by its id.
        const extId = `external.${d2Id(e.to.split('/').slice(-1)[0] ?? e.to)}`;
        externals.add(extId);
        toRef = extId;
      }
      if (!fromRef) continue;
      lines.push(
        e.label ? `${fromRef} -> ${toRef}: "${escapeLabel(e.label)}"` : `${fromRef} -> ${toRef}`,
      );
    }
  }
  if (externals.size > 0) {
    lines.push('');
    lines.push('external: "imported / shared" {');
    for (const ext of externals) lines.push(`  ${ext.replace('external.', '')}: { shape: cloud }`);
    lines.push('}');
  }
  return lines.join('\n') + '\n';
}
