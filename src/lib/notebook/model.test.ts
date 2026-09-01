import test from "node:test";
import assert from "node:assert/strict";
import {
  createNotebookCell,
  joinNotebookSource,
  moveNotebookCell,
  NotebookRevisionTracker,
  parseNotebook,
  replaceCellSource,
  serializeNotebook,
} from "./model";

const fixture = {
  cells: [
    {
      cell_type: "markdown",
      id: "intro",
      metadata: { tags: ["keep"] },
      source: ["# Intro\n", "Body"],
      attachments: { "plot.png": { "image/png": "abc" } },
    },
    {
      cell_type: "code",
      id: "code",
      execution_count: 2,
      metadata: {},
      source: ["print('ok')\n"],
      outputs: [{ output_type: "stream", name: "stdout", text: ["ok\n"] }],
    },
  ],
  metadata: { kernelspec: { name: "python3" }, custom: { preserve: true } },
  nbformat: 4,
  nbformat_minor: 5,
};

test("notebook pipeline parses, edits, reorders, and serializes without losing fields", () => {
  const notebook = parseNotebook(fixture);
  const edited = replaceCellSource(notebook.cells[0], "# Changed\n\nBody\n");
  const cells = moveNotebookCell([edited, notebook.cells[1]], 0, 1);
  const serialized = serializeNotebook({ ...notebook, cells });
  const roundTrip = JSON.parse(serialized);

  assert.equal(serialized.endsWith("\n"), true);
  assert.equal(roundTrip.cells[0].id, "code");
  assert.deepEqual(roundTrip.cells[0].outputs, fixture.cells[1].outputs);
  assert.deepEqual(roundTrip.cells[1].source, ["# Changed\n", "\n", "Body\n"]);
  assert.deepEqual(roundTrip.cells[1].attachments, fixture.cells[0].attachments);
  assert.deepEqual(roundTrip.metadata.custom, { preserve: true });
});

test("cell creation emits valid nbformat defaults", () => {
  assert.deepEqual(createNotebookCell("code"), {
    cell_type: "code",
    execution_count: null,
    metadata: {},
    outputs: [],
    source: [],
  });
  assert.equal(joinNotebookSource(createNotebookCell("markdown").source), "");
});

test("moving outside the notebook is a no-op", () => {
  const notebook = parseNotebook(fixture);
  assert.equal(moveNotebookCell(notebook.cells, 0, -1), notebook.cells);
  assert.equal(moveNotebookCell(notebook.cells, 1, 2), notebook.cells);
});

test("an edit made during a save belongs to a newer revision", () => {
  const revisions = new NotebookRevisionTracker();
  const savingRevision = revisions.current();

  revisions.changed();

  assert.equal(revisions.isCurrent(savingRevision), false);
  assert.equal(revisions.isCurrent(revisions.current()), true);
  revisions.reset();
  assert.equal(revisions.current(), 0);
});

test("parser rejects malformed cells before the editor can save them", () => {
  assert.throws(() => parseNotebook(null), /JSON object/);
  assert.throws(() => parseNotebook({ cells: "nope" }), /cells array/);
  assert.throws(
    () => parseNotebook({ cells: [{ cell_type: "markdown", source: ["ok", 3] }] }),
    /invalid source/
  );
  assert.throws(
    () => parseNotebook({ cells: [{ cell_type: "heading", source: "bad" }] }),
    /unsupported type/
  );
});
