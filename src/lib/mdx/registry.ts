/**
 * Allowlist for structured MDX blocks supported by Cabinet's editor.
 * Components and props not declared here stay as inert source text.
 */

import { sanitizeModelAssetUrl } from "@/lib/models/asset-url";
import type { MdxProps } from "./jsx";

export interface MdxPropSpec {
  name: string;
  description?: string;
  required?: boolean;
  enum?: readonly string[];
  /** Restrict this string to a same-origin .glb/.gltf Cabinet asset URL. */
  modelAssetUrl?: boolean;
}

export interface MdxComponentSpec {
  name: string;
  description: string;
  selfClosing?: boolean;
  props: readonly MdxPropSpec[];
}

export const MDX_COMPONENT_REGISTRY: Record<
  "Callout" | "VideoPlayer" | "ModelViewer",
  MdxComponentSpec
> = {
  Callout: {
    name: "Callout",
    description: "A highlighted info, warning, error, or success banner.",
    props: [
      {
        name: "type",
        description: "Severity and color of the banner.",
        enum: ["info", "warning", "error", "success"],
      },
      { name: "title", description: "Optional heading shown above the body." },
    ],
  },
  VideoPlayer: {
    name: "VideoPlayer",
    description: "An embedded video player.",
    selfClosing: true,
    props: [{ name: "url", description: "URL of the video to play.", required: true }],
  },
  ModelViewer: {
    name: "ModelViewer",
    description: "An interactive viewer for a Cabinet .glb or .gltf asset.",
    selfClosing: true,
    props: [
      {
        name: "src",
        description: "Same-origin /api/assets URL of the model.",
        required: true,
        modelAssetUrl: true,
      },
      { name: "title", description: "Accessible label for the model." },
    ],
  },
};

export type MdxComponentName = keyof typeof MDX_COMPONENT_REGISTRY;

export function isAllowedMdxComponent(
  name: string | null | undefined
): name is MdxComponentName {
  return !!name && Object.prototype.hasOwnProperty.call(MDX_COMPONENT_REGISTRY, name);
}

export function getMdxComponentSpec(
  name: string | null | undefined
): MdxComponentSpec | undefined {
  return isAllowedMdxComponent(name) ? MDX_COMPONENT_REGISTRY[name] : undefined;
}

/** Keep only declared props with primitive values and valid enum members. */
export function sanitizeMdxProps(name: string, value: unknown): MdxProps {
  const spec = getMdxComponentSpec(name);
  if (!spec || !value || typeof value !== "object" || Array.isArray(value)) return {};

  const input = value as Record<string, unknown>;
  const props: MdxProps = {};
  for (const prop of spec.props) {
    const candidate = input[prop.name];
    if (
      typeof candidate !== "string" &&
      typeof candidate !== "number" &&
      typeof candidate !== "boolean"
    ) {
      continue;
    }
    if (prop.enum && (typeof candidate !== "string" || !prop.enum.includes(candidate))) {
      continue;
    }
    if (prop.modelAssetUrl) {
      const safeUrl = sanitizeModelAssetUrl(candidate);
      if (!safeUrl) continue;
      props[prop.name] = safeUrl;
      continue;
    }
    props[prop.name] = candidate;
  }
  return props;
}

export function mdxRegistryPromptText(): string {
  return Object.values(MDX_COMPONENT_REGISTRY)
    .map((spec) => {
      const props = spec.props
        .map((prop) => {
          const value = prop.enum ? prop.enum.join("|") : "string";
          return `${prop.required ? prop.name : `${prop.name}?`}="${value}"`;
        })
        .join(" ");
      const tag = spec.selfClosing
        ? `<${spec.name}${props ? ` ${props}` : ""} />`
        : `<${spec.name}${props ? ` ${props}` : ""}>children</${spec.name}>`;
      return `- \`${tag}\`: ${spec.description}`;
    })
    .join("\n");
}
