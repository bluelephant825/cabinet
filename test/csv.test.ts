import test from "node:test";
import assert from "node:assert/strict";
import {
  CABINET_CSV_DRAG_TYPE,
  CSV_DROP_LIMITS,
  CsvLimitError,
  csvDropInsertionPosition,
  csvPathFromDataTransfer,
  csvRowsToTableContent,
  parseCsv,
  responseTextWithinLimit,
} from "@/lib/csv";

function dataTransfer(path: string, types: string[] = [CABINET_CSV_DRAG_TYPE]) {
  return {
    types,
    getData(type: string) {
      return type === CABINET_CSV_DRAG_TYPE ? path : "";
    },
  };
}

test("parseCsv handles fields, empty cells, and all record separators", () => {
  assert.deepEqual(parseCsv("name,value\r\na,\rbody,b\nc,d"), [
    ["name", "value"],
    ["a", ""],
    ["body", "b"],
    ["c", "d"],
  ]);
  assert.deepEqual(parseCsv(",,"), [["", "", ""]]);
  assert.deepEqual(parseCsv(""), []);
  assert.deepEqual(parseCsv("\n"), [[""]]);
});

test("parseCsv handles BOM, quoted delimiters, escaped quotes, and multiline fields", () => {
  assert.deepEqual(parseCsv('\ufeffname,notes\nAda,"one,two"\nGrace,"line 1\nline 2"\nLinus,"say ""hi"""'), [
    ["name", "notes"],
    ["Ada", "one,two"],
    ["Grace", "line 1\nline 2"],
    ["Linus", 'say "hi"'],
  ]);
});

test("parseCsv preserves malformed text rather than silently dropping it", () => {
  assert.deepEqual(parseCsv('a,"unterminated'), [["a", "unterminated"]]);
  assert.deepEqual(parseCsv('a,"quoted"tail'), [["a", "quotedtail"]]);
});

test("parseCsv enforces character limits at the exact boundary", () => {
  assert.deepEqual(parseCsv("abc", { maxChars: 3 }), [["abc"]]);
  assert.throws(() => parseCsv("abcd", { maxChars: 3 }), CsvLimitError);
});

test("parseCsv enforces row, column, and total-cell limits", () => {
  assert.deepEqual(parseCsv("a,b\nc,d", { maxRows: 2, maxColumns: 2, maxCells: 4 }), [
    ["a", "b"],
    ["c", "d"],
  ]);
  assert.throws(() => parseCsv("a\nb", { maxRows: 1 }), /1-row limit/);
  assert.throws(() => parseCsv("a,b", { maxColumns: 1 }), /1-column limit/);
  assert.throws(() => parseCsv("a,b\nc,d", { maxCells: 3 }), /3-cell limit/);
});

test("parseCsv rejects invalid runtime limit values", () => {
  for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => parseCsv("a", { maxRows: invalid }), TypeError);
  }
});

test("responseTextWithinLimit accepts exact byte bounds and split UTF-8 chunks", async () => {
  const encoded = new TextEncoder().encode("a,é");
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, 3));
        controller.enqueue(encoded.slice(3));
        controller.close();
      },
    })
  );
  assert.equal(await responseTextWithinLimit(response, encoded.byteLength), "a,é");
});

test("responseTextWithinLimit rejects oversized declared and streamed bodies", async () => {
  await assert.rejects(
    responseTextWithinLimit(new Response("small", { headers: { "content-length": "10" } }), 5),
    CsvLimitError
  );

  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6));
      },
      cancel() {
        cancelled = true;
      },
    })
  );
  await assert.rejects(responseTextWithinLimit(response, 5), /5-byte drop limit/);
  assert.equal(cancelled, true);
});

test("responseTextWithinLimit checks the body when streaming is unavailable", async () => {
  const response = {
    headers: new Headers(),
    body: null,
    text: async () => "éé",
  } as unknown as Response;
  assert.equal(await responseTextWithinLimit(response, 4), "éé");
  await assert.rejects(responseTextWithinLimit(response, 3), CsvLimitError);
  await assert.rejects(responseTextWithinLimit(response, 0), TypeError);
});

test("csvPathFromDataTransfer accepts only the custom drag type and relative CSV paths", () => {
  assert.equal(csvPathFromDataTransfer(dataTransfer("room/reports/Q1 Data.CSV")), "room/reports/Q1 Data.CSV");
  assert.equal(csvPathFromDataTransfer(dataTransfer("room/report.csv", ["text/plain"])), null);
  assert.equal(csvPathFromDataTransfer(dataTransfer("room/report.txt")), null);
});

test("csvPathFromDataTransfer rejects traversal, absolute, ambiguous, and oversized paths", () => {
  const invalidPaths = [
    "../report.csv",
    "room/../report.csv",
    "./report.csv",
    "/room/report.csv",
    "C:/room/report.csv",
    "room\\report.csv",
    "room//report.csv",
    "room/report.csv?download=1",
    "room/report.csv#sheet",
    "room/report.csv\0",
    " room/report.csv",
    "room/report.csv ",
    `room/${"a".repeat(CSV_DROP_LIMITS.maxPathChars)}.csv`,
  ];
  for (const path of invalidPaths) assert.equal(csvPathFromDataTransfer(dataTransfer(path)), null, path);
});

test("csvRowsToTableContent creates headers, pads rows, and preserves line breaks", () => {
  assert.deepEqual(csvRowsToTableContent([["Name", "Notes"], ["Ada", "line 1\nline 2"], ["Grace"]]), {
    type: "table",
    content: [
      {
        type: "tableRow",
        content: [
          { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Name" }] }] },
          { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Notes" }] }] },
        ],
      },
      {
        type: "tableRow",
        content: [
          { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "Ada" }] }] },
          {
            type: "tableCell",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "line 1" },
                  { type: "hardBreak" },
                  { type: "text", text: "line 2" },
                ],
              },
            ],
          },
        ],
      },
      {
        type: "tableRow",
        content: [
          { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "Grace" }] }] },
          { type: "tableCell", content: [{ type: "paragraph", content: undefined }] },
        ],
      },
    ],
  });
});

test("csvRowsToTableContent handles empty tables and empty rows", () => {
  assert.equal(csvRowsToTableContent([]), null);
  const table = csvRowsToTableContent([[]]);
  assert.deepEqual(table, {
    type: "table",
    content: [
      {
        type: "tableRow",
        content: [
          { type: "tableHeader", content: [{ type: "paragraph", content: undefined }] },
        ],
      },
    ],
  });
});

test("csvDropInsertionPosition clamps stale positions to current document bounds", () => {
  assert.equal(csvDropInsertionPosition(4, 10), 4);
  assert.equal(csvDropInsertionPosition(10, 10), 10);
  assert.equal(csvDropInsertionPosition(20, 10), 10);
  assert.equal(csvDropInsertionPosition(-1, 10), null);
  assert.equal(csvDropInsertionPosition(1.5, 10), null);
  assert.equal(csvDropInsertionPosition(1, -1), null);
});
