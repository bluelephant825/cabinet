import assert from "node:assert/strict";
import test from "node:test";
import { applyJupyterMessage, createExecuteRequest } from "./kernel";
import type { CodeCell } from "./model";

const emptyCell: CodeCell = { cell_type: "code", source: ["print('ok')\n"], outputs: [], execution_count: null };

test("execute request uses the Jupyter wire contract deterministically", () => {
  const request = createExecuteRequest("print('ok')", "message-1", "session-1");
  assert.equal(request.header.msg_type, "execute_request");
  assert.equal(request.header.msg_id, "message-1");
  assert.equal(request.header.session, "session-1");
  assert.equal(request.content.code, "print('ok')");
  assert.equal(request.content.allow_stdin, false);
  assert.equal(request.channel, "shell");
});

test("mocked kernel messages merge streams and preserve rich execution output", () => {
  let cell = applyJupyterMessage(emptyCell, {
    header: { msg_type: "stream" },
    content: { name: "stdout", text: "one" },
  });
  cell = applyJupyterMessage(cell, {
    header: { msg_type: "stream" },
    content: { name: "stdout", text: [" two\n"] },
  });
  cell = applyJupyterMessage(cell, {
    header: { msg_type: "display_data" },
    content: { data: { "text/plain": "chart", "image/png": "abc" }, metadata: { width: 10 } },
  });
  cell = applyJupyterMessage(cell, {
    header: { msg_type: "execute_reply" },
    content: { execution_count: 7 },
  });

  assert.deepEqual(cell.outputs?.[0], { output_type: "stream", name: "stdout", text: "one two\n" });
  assert.deepEqual(cell.outputs?.[1], {
    output_type: "display_data",
    data: { "text/plain": "chart", "image/png": "abc" },
    metadata: { width: 10 },
  });
  assert.equal(cell.execution_count, 7);
});

test("mocked kernel errors become notebook error outputs", () => {
  const cell = applyJupyterMessage(emptyCell, {
    header: { msg_type: "error" },
    content: { ename: "ValueError", evalue: "bad value", traceback: ["trace"] },
  });
  assert.deepEqual(cell.outputs?.[0], {
    output_type: "error",
    ename: "ValueError",
    evalue: "bad value",
    traceback: ["trace"],
  });
});
