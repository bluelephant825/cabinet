"use client";

import { Node, mergeAttributes } from "@tiptap/core";
import {
  ReactNodeViewRenderer,
  NodeViewWrapper,
  type NodeViewProps,
} from "@tiptap/react";
import { useState } from "react";
import { Check, Pencil, Puzzle, Video } from "lucide-react";
import { detectEmbed } from "@/lib/embeds/detect";
import {
  getMdxComponentSpec,
  isAllowedMdxComponent,
  sanitizeMdxProps,
  type MdxPropSpec,
} from "@/lib/mdx/registry";
import type { MdxProps } from "@/lib/mdx/jsx";

interface MdxComponentAttrs {
  name: string;
  props: MdxProps;
  childrenString: string;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    mdxComponent: {
      insertMdxComponent: (options: {
        name: string;
        props?: MdxProps;
        children?: string;
      }) => ReturnType;
    };
  }
}

const CALLOUT_TONES: Record<string, string> = {
  info: "border-sky-400/60 bg-sky-50 dark:bg-sky-950/30",
  warning: "border-amber-400/60 bg-amber-50 dark:bg-amber-950/30",
  error: "border-red-400/60 bg-red-50 dark:bg-red-950/30",
  success: "border-emerald-400/60 bg-emerald-50 dark:bg-emerald-950/30",
};

function ComponentPreview({ name, props, childrenString }: MdxComponentAttrs) {
  if (name === "Callout") {
    const tone = CALLOUT_TONES[String(props.type ?? "info")] ?? CALLOUT_TONES.info;
    return (
      <div className={`rounded-md border-l-4 px-3 py-2 text-sm ${tone}`}>
        {props.title && <div className="mb-0.5 font-semibold">{String(props.title)}</div>}
        <div className="whitespace-pre-wrap text-foreground/80">
          {childrenString || "Empty callout"}
        </div>
      </div>
    );
  }

  const url = String(props.url ?? "").trim();
  if (!url) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
        <Video className="h-4 w-4" />
        No video URL set. Click the pencil to add one.
      </div>
    );
  }

  const detected = detectEmbed(url);
  if (!detected) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
        <Video className="h-4 w-4" />
        Unsupported video URL.
      </div>
    );
  }
  if (detected.provider !== "video") {
    return (
      <div className="aspect-video w-full overflow-hidden rounded-md border border-border">
        <iframe
          src={detected.embedUrl}
          className="h-full w-full"
          sandbox="allow-scripts allow-same-origin allow-presentation"
          allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; fullscreen"
          allowFullScreen
          loading="lazy"
          title="Embedded video"
        />
      </div>
    );
  }
  return (
    <video
      src={detected.embedUrl}
      controls
      className="w-full rounded-md border border-border bg-black"
    />
  );
}

function MdxComponentView(nodeView: NodeViewProps) {
  const attrs = nodeView.node.attrs as MdxComponentAttrs;
  const [editing, setEditing] = useState(false);
  const spec = getMdxComponentSpec(attrs.name);

  const setProp = (key: string, value: string) => {
    nodeView.updateAttributes({
      props: sanitizeMdxProps(attrs.name, { ...attrs.props, [key]: value }),
    });
  };

  return (
    <NodeViewWrapper
      className="mdx-component-block my-2 rounded-md border border-border bg-muted/40 p-3"
      data-mdx-name={attrs.name}
    >
      <div className="mb-2 flex items-center justify-between gap-2" contentEditable={false}>
        <span className="inline-flex items-center gap-1.5 font-mono text-xs text-primary">
          <Puzzle className="h-3.5 w-3.5" />
          {`<${attrs.name} ${spec?.selfClosing ? "/" : ""}>`}
        </span>
        <button
          type="button"
          onClick={() => setEditing((value) => !value)}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent"
          aria-label={editing ? "Done editing" : "Edit component props"}
        >
          {editing ? <Check className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
        </button>
      </div>

      {editing ? (
        <div className="space-y-2" contentEditable={false}>
          {spec?.props.map((prop: MdxPropSpec) => (
            <label key={prop.name} className="flex items-center gap-2 text-xs">
              <span className="w-24 shrink-0 font-mono text-muted-foreground">{prop.name}</span>
              {prop.enum ? (
                <select
                  value={String(attrs.props[prop.name] ?? "")}
                  onChange={(event) => setProp(prop.name, event.target.value)}
                  className="flex-1 rounded border border-border bg-background px-2 py-1"
                >
                  <option value="">None</option>
                  {prop.enum.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={String(attrs.props[prop.name] ?? "")}
                  onChange={(event) => setProp(prop.name, event.target.value)}
                  className="flex-1 rounded border border-border bg-background px-2 py-1"
                />
              )}
            </label>
          ))}
          {!spec?.selfClosing && (
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-mono text-muted-foreground">children</span>
              <textarea
                value={attrs.childrenString}
                onChange={(event) => nodeView.updateAttributes({ childrenString: event.target.value })}
                rows={3}
                className="rounded border border-border bg-background px-2 py-1"
              />
            </label>
          )}
        </div>
      ) : (
        <div className="component-preview" contentEditable={false}>
          <ComponentPreview {...attrs} />
        </div>
      )}
    </NodeViewWrapper>
  );
}

export const MdxComponent = Node.create({
  name: "mdxComponent",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      name: { default: null },
      props: { default: {} },
      childrenString: { default: "" },
    };
  },

  parseHTML() {
    return [{
      tag: "div[data-mdx-component]",
      getAttrs: (node) => {
        const element = node as HTMLElement;
        const name = element.getAttribute("data-name");
        if (!isAllowedMdxComponent(name)) return false;
        let props: unknown = {};
        try {
          props = JSON.parse(element.getAttribute("data-props") || "{}");
        } catch {
          props = {};
        }
        return {
          name,
          props: sanitizeMdxProps(name, props),
          childrenString: element.getAttribute("data-children") || "",
        };
      },
    }];
  },

  renderHTML({ HTMLAttributes }) {
    const name = typeof HTMLAttributes.name === "string" ? HTMLAttributes.name : "";
    if (!isAllowedMdxComponent(name)) return ["div", { "data-mdx-invalid": "true" }, ""];
    const props = sanitizeMdxProps(name, HTMLAttributes.props);
    const childrenString = typeof HTMLAttributes.childrenString === "string"
      ? HTMLAttributes.childrenString
      : "";
    return [
      "div",
      mergeAttributes({
        "data-mdx-component": "true",
        "data-name": name,
        "data-props": JSON.stringify(props),
        "data-children": childrenString,
      }),
      name,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MdxComponentView);
  },

  addCommands() {
    return {
      insertMdxComponent:
        ({ name, props = {}, children = "" }) =>
        ({ commands }) => {
          if (!isAllowedMdxComponent(name)) return false;
          return commands.insertContent({
            type: this.name,
            attrs: {
              name,
              props: sanitizeMdxProps(name, props),
              childrenString: children,
            },
          });
        },
    };
  },
});
