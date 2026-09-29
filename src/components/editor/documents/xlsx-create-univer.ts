import { FUniver } from "@univerjs/core/lib/facade";
import { LogLevel, Univer, type DependencyOverride, type IUniverConfig, type Plugin, type PluginCtor } from "@univerjs/core";

type PluginEntry =
  | PluginCtor<Plugin>
  | [PluginCtor<Plugin>, ConstructorParameters<PluginCtor<Plugin>>[0]];

export interface XlsxPreset {
  plugins: PluginEntry[];
}

interface CreateUniverOptions extends Partial<IUniverConfig> {
  presets: Array<XlsxPreset | [XlsxPreset, { lazy?: boolean }]>;
  plugins?: PluginEntry[];
  override?: DependencyOverride;
}

/**
 * Apache-only equivalent of @univerjs/presets' composition helper. Importing
 * that meta-package would also pull Univer's non-free collaboration presets.
 */
export function createXlsxUniver(options: CreateUniverOptions) {
  const { presets, plugins, override = [], ...config } = options;
  const univer = new Univer({ logLevel: LogLevel.WARN, ...config, override });
  const registry = new Map<string, { plugin: PluginCtor<Plugin>; options: unknown }>();

  for (const entry of presets) {
    const preset = Array.isArray(entry) ? entry[0] : entry;
    for (const pluginEntry of preset.plugins) {
      const [plugin, pluginOptions] = Array.isArray(pluginEntry)
        ? pluginEntry
        : [pluginEntry, undefined];
      registry.delete(plugin.pluginName);
      registry.set(plugin.pluginName, { plugin, options: pluginOptions });
    }
  }
  for (const pluginEntry of plugins ?? []) {
    const [plugin, pluginOptions] = Array.isArray(pluginEntry)
      ? pluginEntry
      : [pluginEntry, undefined];
    if (registry.has(plugin.pluginName)) {
      throw new Error(`Univer plugin registered twice: ${plugin.pluginName}`);
    }
    registry.set(plugin.pluginName, { plugin, options: pluginOptions });
  }
  for (const { plugin, options: pluginOptions } of registry.values()) {
    univer.registerPlugin(plugin, pluginOptions);
  }

  return { univer, univerAPI: FUniver.newAPI(univer) };
}
