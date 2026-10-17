import { D2 } from '@d2lang/d2';

export type LayoutEngine = 'tala' | 'elk' | 'dagre';

export interface RenderOptions {
  /**
   * When true, fall back to ELK if the requested engine fails. Off by default: the template's
   * diagrams are specified as "D2 + TALA", so a silent engine swap would hide a broken setup.
   */
  allowFallback?: boolean;
}

/**
 * Renders D2 source to SVG with the TALA layout engine, which is bundled with D2 >= 0.9.0
 * (MPL-2.0, no plugin or license key; see https://github.com/d2lang/d2/releases/tag/v0.9.0).
 * The returned `layout` is the engine that actually produced the SVG.
 */
export async function renderSvg(
  source: string,
  layout: LayoutEngine = 'tala',
  options: RenderOptions = {},
): Promise<{ svg: string; layout: LayoutEngine }> {
  const d2 = new D2();
  try {
    try {
      const result = await d2.compile(source, { layout, themeID: 0, pad: 32 });
      const svg = await d2.render(result.diagram, result.renderOptions);
      return { svg, layout };
    } catch (error) {
      if (layout === 'tala' && options.allowFallback) {
        const result = await d2.compile(source, { layout: 'elk', themeID: 0, pad: 32 });
        const svg = await d2.render(result.diagram, result.renderOptions);
        return { svg, layout: 'elk' };
      }
      throw new Error(
        `D2 render with layout "${layout}" failed${layout === 'tala' ? ' (pass --allow-fallback to use ELK instead)' : ''}: ${String(error)}`,
      );
    }
  } finally {
    await d2.dispose();
  }
}
