"use client";

import { Node, mergeAttributes } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import yaml from "js-yaml";
import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { FrontMatter } from "@/types";

const NODE_NAME = "documentProperties";

type PropertyRecord = Record<string, unknown>;

function asPropertyRecord(value: unknown): PropertyRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...(value as PropertyRecord) };
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  return yaml.dump(value, {
    schema: yaml.JSON_SCHEMA,
    flowLevel: 0,
    lineWidth: -1,
    noRefs: true,
  }).trim();
}

function parseValue(value: string): unknown {
  if (value === "") return "";
  try {
    return yaml.load(value, { schema: yaml.JSON_SCHEMA });
  } catch {
    return value;
  }
}

function DocumentPropertiesView({ node, updateAttributes, editor }: NodeViewProps) {
  const properties = asPropertyRecord(node.attrs.properties);
  const entries = Object.entries(properties);
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(entries.map(([key, value]) => [key, formatValue(value)]))
  );

  useEffect(() => {
    setDrafts(
      Object.fromEntries(
        Object.entries(properties).map(([key, value]) => [key, formatValue(value)])
      )
    );
    // node.attrs is replaced whenever an external frontmatter edit is synced.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.attrs.properties]);

  const replaceProperties = (next: PropertyRecord) => {
    updateAttributes({ properties: next });
  };

  const renameProperty = (oldKey: string, requestedKey: string) => {
    const nextKey = requestedKey.trim();
    if (!nextKey || nextKey === oldKey || Object.hasOwn(properties, nextKey)) return;
    replaceProperties(
      Object.fromEntries(
        entries.map(([key, value]) => (key === oldKey ? [nextKey, value] : [key, value]))
      )
    );
  };

  const removeProperty = (key: string) => {
    replaceProperties(Object.fromEntries(entries.filter(([entryKey]) => entryKey !== key)));
  };

  const addProperty = () => {
    let index = 1;
    let key = "property";
    while (Object.hasOwn(properties, key)) key = `property${++index}`;
    replaceProperties({ ...properties, [key]: "" });
  };

  return (
    <NodeViewWrapper
      as="section"
      data-document-properties="true"
      className="document-properties mb-5 rounded-lg border border-border/70 bg-muted/20 px-3 py-2.5"
      contentEditable={false}
    >
      <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
        Properties
      </div>
      <div className="space-y-1">
        {entries.map(([key, value]) => (
          <div key={key} className="group flex min-w-0 items-center gap-2">
            <input
              aria-label="Property name"
              defaultValue={key}
              disabled={!editor.isEditable}
              onBlur={(event) => renameProperty(key, event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
              className="w-32 shrink-0 rounded px-1.5 py-1 text-xs text-muted-foreground outline-none hover:bg-background/70 focus:bg-background focus:ring-1 focus:ring-ring disabled:cursor-default"
            />
            <input
              aria-label={`${key} value`}
              value={drafts[key] ?? formatValue(value)}
              disabled={!editor.isEditable}
              onChange={(event) =>
                setDrafts((current) => ({ ...current, [key]: event.target.value }))
              }
              onBlur={(event) =>
                replaceProperties({ ...properties, [key]: parseValue(event.currentTarget.value) })
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
              className="min-w-0 flex-1 rounded px-1.5 py-1 font-mono text-xs outline-none hover:bg-background/70 focus:bg-background focus:ring-1 focus:ring-ring disabled:cursor-default"
            />
            {editor.isEditable && (
              <button
                type="button"
                onClick={() => removeProperty(key)}
                aria-label={`Remove ${key}`}
                className="rounded p-1 text-muted-foreground/60 opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100 focus:opacity-100"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>
      {editor.isEditable && (
        <button
          type="button"
          onClick={addProperty}
          className="mt-2 inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
          Add property
        </button>
      )}
    </NodeViewWrapper>
  );
}

export function serializeDocumentProperties(frontmatter: FrontMatter | null): string {
  return JSON.stringify(frontmatter ?? {});
}

export function parseDocumentProperties(value: string | null): PropertyRecord {
  try {
    return asPropertyRecord(JSON.parse(value ?? "{}"));
  } catch {
    return {};
  }
}

export function documentPropertiesHtml(frontmatter: FrontMatter | null): string {
  const json = serializeDocumentProperties(frontmatter)
    .replace(/&/g, "&amp;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<div data-document-properties="true" data-properties='${json}'></div>`;
}

export function frontmatterFromEditor(editor: {
  state: { doc: { firstChild: { type: { name: string }; attrs: Record<string, unknown> } | null } };
}): FrontMatter {
  const first = editor.state.doc.firstChild;
  return asPropertyRecord(
    first?.type.name === NODE_NAME ? first.attrs.properties : {}
  ) as FrontMatter;
}

export const DocumentProperties = Node.create({
  name: NODE_NAME,
  group: "block",
  atom: true,
  isolating: true,
  selectable: false,

  addAttributes() {
    return {
      properties: {
        default: {},
        parseHTML: (element) =>
          parseDocumentProperties(element.getAttribute("data-properties")),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-document-properties="true"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const properties = asPropertyRecord(HTMLAttributes.properties);
    return [
      "div",
      mergeAttributes({
        "data-document-properties": "true",
        "data-properties": JSON.stringify(properties),
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(DocumentPropertiesView);
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (_transactions, oldState, newState) => {
          const found: Array<{ pos: number; node: (typeof newState.doc)["firstChild"] }> = [];
          newState.doc.descendants((node, pos) => {
            if (node.type.name === NODE_NAME) found.push({ pos, node });
          });
          if (found.length === 1 && found[0].pos === 0) return null;

          const previous = oldState.doc.firstChild;
          const properties = asPropertyRecord(
            found[0]?.node?.attrs.properties ??
              (previous?.type.name === NODE_NAME ? previous.attrs.properties : {})
          );
          const transaction = newState.tr;
          for (const item of found.slice().reverse()) {
            if (item.node) transaction.delete(item.pos, item.pos + item.node.nodeSize);
          }
          transaction.insert(0, this.type.create({ properties }));
          return transaction;
        },
      }),
    ];
  },
});
