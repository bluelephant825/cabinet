import test from "node:test";
import assert from "node:assert/strict";
import { markdownToHtml } from "@/lib/markdown/to-html";
import { htmlToMarkdown } from "@/lib/markdown/to-markdown";
import { markdownToPlaintext } from "@/lib/markdown/to-plaintext";
import {
  parseJsxAttributes,
  serializeMdxComponent,
  stripMdxForPlaintext,
  transformMdxToHtml,
} from "./jsx";
import { sanitizeMdxProps } from "./registry";

test("restricted JSX attributes accept literals without evaluation", () => {
  assert.deepEqual(
    parseJsxAttributes('type="warning" title={"Heads up"} count={3} open'),
    { type: "warning", title: "Heads up", count: 3, open: true }
  );
  assert.equal(parseJsxAttributes("onClick={() => alert(1)}"), null);
  assert.equal(parseJsxAttributes("{...props}"), null);
  assert.equal(parseJsxAttributes("payload={{danger: true}}"), null);
});

test("registry strips unknown, complex, and invalid enum props", () => {
  assert.deepEqual(
    sanitizeMdxProps("Callout", {
      type: "warning",
      title: "Careful",
      onClick: "alert(1)",
      payload: { dangerous: true },
    }),
    { type: "warning", title: "Careful" }
  );
  assert.deepEqual(sanitizeMdxProps("Callout", { type: "not-a-tone" }), {});
  assert.deepEqual(sanitizeMdxProps("Unknown", { title: "x" }), {});
});

test("transform rewrites allowlisted blocks and escapes marker attributes", () => {
  const output = transformMdxToHtml(
    '<Callout type="warning" title="&quot; onmouseover=&quot;bad">A & B</Callout>'
  );
  assert.match(output, /data-mdx-component="true"/);
  assert.match(output, /data-name="Callout"/);
  assert.match(output, /&amp;quot; onmouseover=&amp;quot;bad/);
  assert.match(output, /data-children="A &amp; B"/);
});

test("transform leaves unknown, dynamic, malformed, and fenced JSX inert", () => {
  const samples = [
    "<NotRegistered dangerous />",
    "<Callout {...props}>text</Callout>",
    "<Callout title={runCode()}>text</Callout>",
    '<Callout type="info">unbalanced',
    '<VideoPlayer url="https://example.com/v.mp4">unexpected</VideoPlayer>',
    '```jsx\n<Callout type="info">example</Callout>\n```',
  ];
  for (const source of samples) assert.equal(transformMdxToHtml(source), source);
});

test("serialization emits balanced JSX with only safe registered props", () => {
  assert.equal(
    serializeMdxComponent(
      "Callout",
      { type: "info", title: 'A "quote"', onClick: "bad" },
      "Hello"
    ),
    '<Callout type="info" title="A \\"quote\\"">\nHello\n</Callout>'
  );
  assert.equal(
    serializeMdxComponent(
      "VideoPlayer",
      { url: "https://example.com/video.mp4" },
      "ignored children"
    ),
    '<VideoPlayer url="https://example.com/video.mp4" />'
  );
  assert.equal(serializeMdxComponent("script", { src: "bad" }, "payload"), "");
});

test("forged markers cannot serialize arbitrary JSX", () => {
  const forged =
    '<div data-mdx-component="true" data-name="script" ' +
    'data-props="{&quot;src&quot;:&quot;bad&quot;}">script</div>';
  assert.equal(htmlToMarkdown(forged), "");

  const extraProp =
    '<div data-mdx-component="true" data-name="Callout" ' +
    'data-props="{&quot;type&quot;:&quot;info&quot;,&quot;onClick&quot;:&quot;bad&quot;}" ' +
    'data-children="Safe">Callout</div>';
  assert.equal(htmlToMarkdown(extraProp).trim(), '<Callout type="info">\nSafe\n</Callout>');
});

test("Callout and VideoPlayer survive markdown, HTML, and plaintext paths", async () => {
  const markdown =
    '<Callout type="success" title="Done">Saved **safely**.</Callout>\n\n' +
    '<VideoPlayer url="https://example.com/demo.mp4" />';
  const html = await markdownToHtml(markdown);
  const roundTrip = htmlToMarkdown(html);
  assert.match(roundTrip, /<Callout type="success" title="Done">/);
  assert.match(roundTrip, /Saved \*\*safely\*\*\./);
  assert.match(roundTrip, /<VideoPlayer url="https:\/\/example\.com\/demo\.mp4" \/>/);

  assert.equal(
    stripMdxForPlaintext(markdown),
    "[Callout (success): Saved **safely**.]\n\n[VideoPlayer: https://example.com/demo.mp4]"
  );
  assert.match(markdownToPlaintext(markdown).text, /\[Callout \(success\): Saved safely\.\]/);
  assert.match(markdownToPlaintext(markdown).text, /\[VideoPlayer: https:\/\/example\.com\/demo\.mp4\]/);
});

test("ModelViewer keeps safe asset URLs through MDX and plaintext paths", async () => {
  const markdown = '<ModelViewer src="/api/assets/designs/chair.glb?version=2" title="Chair" />';
  const html = await markdownToHtml(markdown);
  const roundTrip = htmlToMarkdown(html);

  assert.match(roundTrip, /<ModelViewer src="\/api\/assets\/designs\/chair\.glb\?version=2" title="Chair" \/>/);
  assert.equal(
    stripMdxForPlaintext(markdown),
    "[ModelViewer: /api/assets/designs/chair.glb?version=2]"
  );
  assert.match(
    markdownToPlaintext(markdown).text,
    /\[ModelViewer: \/api\/assets\/designs\/chair\.glb\?version=2\]/
  );
});

test("ModelViewer strips unsafe and non-model sources", () => {
  for (const src of [
    "https://example.com/model.glb",
    "//example.com/model.glb",
    "javascript:alert(1)",
    "/api/assets/model.obj",
    "/api/assets/model.glb#fragment",
  ]) {
    assert.deepEqual(sanitizeMdxProps("ModelViewer", { src, title: "Unsafe" }), {
      title: "Unsafe",
    });
  }
});
