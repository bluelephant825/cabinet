/**
 * YAML frontmatter for generated pages — matches the FrontMatter shape
 * page-io preserves (type/title/created/modified/tags + arbitrary keys).
 */

function yamlQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function frontmatterBlock(input: {
  title: string;
  sourceVirtualPath: string;
  now?: string;
}): string {
  const now = input.now ?? new Date().toISOString();
  return [
    "---",
    `type: ${yamlQuote("Document")}`,
    `title: ${yamlQuote(input.title)}`,
    `created: ${yamlQuote(now)}`,
    `modified: ${yamlQuote(now)}`,
    "tags: []",
    `source: ${yamlQuote(input.sourceVirtualPath)}`,
    "---",
    "",
  ].join("\n");
}
