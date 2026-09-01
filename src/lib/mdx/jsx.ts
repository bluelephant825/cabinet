import {
  getMdxComponentSpec,
  isAllowedMdxComponent,
  sanitizeMdxProps,
} from "./registry";

export type MdxProps = Record<string, string | number | boolean>;

interface ParsedMdxComponent {
  name: string;
  props: MdxProps;
  children: string;
}

interface MdxMatch {
  start: number;
  end: number;
  parsed: ParsedMdxComponent;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Parse the deliberately small JSX attribute subset Cabinet supports.
 * Values may be quoted strings, primitive JSON expressions, or bare booleans.
 * Spread props, object/array expressions, handlers, and malformed tails fail
 * closed. No source text is ever evaluated.
 */
export function parseJsxAttributes(raw: string): MdxProps | null {
  const props: MdxProps = {};
  let cursor = 0;

  while (cursor < raw.length) {
    while (/\s/.test(raw[cursor] ?? "")) cursor += 1;
    if (cursor >= raw.length) break;

    const keyMatch = /^[A-Za-z_][\w-]*/.exec(raw.slice(cursor));
    if (!keyMatch) return null;
    const key = keyMatch[0];
    cursor += key.length;
    while (/\s/.test(raw[cursor] ?? "")) cursor += 1;

    if (raw[cursor] !== "=") {
      props[key] = true;
      continue;
    }

    cursor += 1;
    while (/\s/.test(raw[cursor] ?? "")) cursor += 1;
    const opener = raw[cursor];

    if (opener === '"' || opener === "'") {
      const end = raw.indexOf(opener, cursor + 1);
      if (end === -1) return null;
      props[key] = raw.slice(cursor + 1, end);
      cursor = end + 1;
      continue;
    }

    if (opener === "{") {
      const end = raw.indexOf("}", cursor + 1);
      if (end === -1) return null;
      const expression = raw.slice(cursor + 1, end).trim();
      let value: unknown;
      try {
        value = JSON.parse(expression);
      } catch {
        return null;
      }
      if (
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        return null;
      }
      props[key] = value;
      cursor = end + 1;
      continue;
    }

    return null;
  }

  return props;
}

function serializeProps(name: string, props: MdxProps): string {
  return Object.entries(sanitizeMdxProps(name, props))
    .map(([key, value]) => {
      if (value === true) return key;
      if (typeof value === "string") return `${key}=${JSON.stringify(value)}`;
      return `${key}={${JSON.stringify(value)}}`;
    })
    .join(" ");
}

/** Serialize only registered components and registered primitive props. */
export function serializeMdxComponent(
  name: string,
  props: MdxProps,
  children: string
): string {
  const spec = getMdxComponentSpec(name);
  if (!spec) return "";
  const propsString = serializeProps(name, props);
  const head = propsString ? `${name} ${propsString}` : name;
  if (spec.selfClosing || !children.trim()) return `<${head} />`;
  return `<${head}>\n${children}\n</${name}>`;
}

function findCodeFenceRanges(markdown: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const fence = /^(\`\`\`|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(markdown)) !== null) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

function inRanges(index: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

function findClosingTag(
  markdown: string,
  name: string,
  from: number
): [number, number] | null {
  const tag = new RegExp(`<(/?)${name}(?=[\\s/>])[^>]*>`, "g");
  let depth = 1;
  tag.lastIndex = from;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(markdown)) !== null) {
    const full = match[0];
    if (match[1]) {
      depth -= 1;
      if (depth === 0) return [match.index, match.index + full.length];
    } else if (!/\/>$/.test(full)) {
      depth += 1;
    }
  }
  return null;
}

function findMdxComponents(markdown: string): MdxMatch[] {
  const codeRanges = findCodeFenceRanges(markdown);
  const matches: MdxMatch[] = [];
  const openingTag = /<([A-Z][A-Za-z0-9]*)((?:[^>"'{}]|"[^"]*"|'[^']*'|\{[^{}]*\})*?)(\/?)>/g;
  let match: RegExpExecArray | null;

  while ((match = openingTag.exec(markdown)) !== null) {
    const [full, name, rawAttributes = "", slash] = match;
    if (!isAllowedMdxComponent(name) || inRanges(match.index, codeRanges)) continue;

    const parsedAttributes = parseJsxAttributes(rawAttributes);
    const spec = getMdxComponentSpec(name);
    if (!parsedAttributes || !spec || (spec.selfClosing && slash !== "/")) continue;
    const props = sanitizeMdxProps(name, parsedAttributes);
    const openEnd = match.index + full.length;

    if (slash === "/") {
      matches.push({
        start: match.index,
        end: openEnd,
        parsed: { name, props, children: "" },
      });
      continue;
    }

    const closing = findClosingTag(markdown, name, openEnd);
    if (!closing) continue;
    const [closeStart, closeEnd] = closing;
    matches.push({
      start: match.index,
      end: closeEnd,
      parsed: {
        name,
        props,
        children: markdown.slice(openEnd, closeStart).trim(),
      },
    });
    openingTag.lastIndex = closeEnd;
  }

  return matches;
}

/** Convert allowlisted JSX blocks to inert HTML markers for Tiptap parsing. */
export function transformMdxToHtml(markdown: string): string {
  const matches = findMdxComponents(markdown);
  if (!matches.length) return markdown;

  let output = "";
  let last = 0;
  for (const { start, end, parsed } of matches) {
    output += markdown.slice(last, start);
    output +=
      `\n\n<div data-mdx-component="true"` +
      ` data-name="${escapeHtmlAttribute(parsed.name)}"` +
      ` data-props="${escapeHtmlAttribute(JSON.stringify(parsed.props))}"` +
      ` data-children="${escapeHtmlAttribute(parsed.children)}">` +
      `${escapeHtmlAttribute(parsed.name)}</div>\n\n`;
    last = end;
  }
  return output + markdown.slice(last);
}

/** Replace structured JSX with semantic text before search/RAG processing. */
export function stripMdxForPlaintext(markdown: string): string {
  const matches = findMdxComponents(markdown);
  if (!matches.length) return markdown;

  let output = "";
  let last = 0;
  for (const { start, end, parsed } of matches) {
    output += markdown.slice(last, start);
    const variant = typeof parsed.props.type === "string" ? ` (${parsed.props.type})` : "";
    const body = parsed.children
      ? `: ${stripMdxForPlaintext(parsed.children)}`
      : typeof parsed.props.url === "string"
        ? `: ${parsed.props.url}`
        : "";
    output += `[${parsed.name}${variant}${body}]`;
    last = end;
  }
  return output + markdown.slice(last);
}
