import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, NodeSelection, TextSelection, type Transaction } from "@tiptap/pm/state";
import { Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";

/**
 * Move the top-level block containing the current selection up or down
 * by one sibling. Returns true if the doc was mutated. Used for keyboard
 * reorder (Alt+Shift+Up/Down) so non-mouse users get parity with the
 * drag handle (audit #102).
 */
function moveCurrentBlock(
  state: EditorView["state"],
  dispatch: ((tr: Transaction) => void) | undefined,
  direction: "up" | "down"
): boolean {
  const { selection, doc } = state;
  // Resolve the top-level block that holds the current selection. We walk
  // up to depth 1 because doc → top-level-block → … is the layout we care
  // about; nested list items still move as siblings of their parent block.
  let $pos = doc.resolve(selection.from);
  while ($pos.depth > 1) {
    $pos = doc.resolve($pos.before($pos.depth));
  }
  if ($pos.depth === 0) return false;

  const blockPos = $pos.before(1);
  const block = doc.nodeAt(blockPos);
  if (!block) return false;

  const parent = doc;
  const indexInParent = $pos.index(0);
  const siblingIndex = direction === "up" ? indexInParent - 1 : indexInParent + 1;
  if (siblingIndex < 0 || siblingIndex >= parent.childCount) return false;

  const sibling = parent.child(siblingIndex);
  let tr = state.tr;

  // Remove the block, then re-insert it on the other side of the sibling.
  // Computing the insertion target *before* the cut keeps positions stable.
  const blockEnd = blockPos + block.nodeSize;
  const siblingStart = direction === "up" ? blockPos - sibling.nodeSize : blockEnd;
  const siblingEnd = direction === "up" ? blockPos : blockEnd + sibling.nodeSize;

  if (direction === "up") {
    tr = tr.delete(blockPos, blockEnd);
    tr = tr.insert(siblingStart, block);
    // After re-insert the block lives at siblingStart; restore selection on it.
    tr = tr.setSelection(NodeSelection.create(tr.doc, siblingStart));
  } else {
    tr = tr.delete(blockPos, blockEnd);
    // After deletion the sibling shifts left by block.nodeSize, so the
    // insertion target is siblingEnd - block.nodeSize.
    const insertAt = siblingEnd - block.nodeSize;
    tr = tr.insert(insertAt, block);
    tr = tr.setSelection(NodeSelection.create(tr.doc, insertAt));
  }

  if (dispatch) dispatch(tr.scrollIntoView());
  return true;
}

const HANDLE_ID = "cabinet-drag-handle";
const ADD_BTN_ID = "cabinet-gutter-add";

function getOrCreateAddButton(): HTMLButtonElement {
  let el = document.getElementById(ADD_BTN_ID) as HTMLButtonElement | null;
  if (!el) {
    el = document.createElement("button");
    el.id = ADD_BTN_ID;
    el.type = "button";
    el.setAttribute("aria-label", "Add block");
    el.title = "Add block";
    el.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 1V9M1 5H9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
    Object.assign(el.style, {
      position: "absolute",
      display: "none",
      alignItems: "center",
      justifyContent: "center",
      width: "18px",
      height: "18px",
      cursor: "pointer",
      borderRadius: "4px",
      color: "var(--muted-foreground)",
      opacity: "0.55",
      zIndex: "40",
      transition: "opacity 120ms ease, background 120ms ease",
      background: "transparent",
      border: "none",
      padding: "0",
    } as Partial<CSSStyleDeclaration>);
    el.addEventListener("mouseenter", () => {
      el!.style.opacity = "1";
      el!.style.background = "var(--muted)";
    });
    el.addEventListener("mouseleave", () => {
      el!.style.opacity = "0.55";
      el!.style.background = "transparent";
    });
    document.body.appendChild(el);
  }
  return el;
}

type DraggableBlock = {
  pos: number;
  depth: number;
  node: ProseMirrorNode;
  dom: HTMLElement;
};

type HorizontalBounds = { left: number; right: number };

const GUTTER_PROBE_INSET = 20;
const GUTTER_PROBE_STEP = 32;

/**
 * A gutter pointer has no useful document position for an indented list item.
 * Probe across the line so mixed-direction and deeply nested items can still
 * contribute a candidate. The pointer's own x-coordinate stays first to keep
 * the common in-content path cheap and deterministic.
 */
export function gutterProbeXs(bounds: HorizontalBounds, pointerX: number): number[] {
  const midpoint = (bounds.left + bounds.right) / 2;
  const min = Math.min(bounds.left + GUTTER_PROBE_INSET, midpoint);
  const max = Math.max(bounds.right - GUTTER_PROBE_INSET, midpoint);
  const xs = [Math.max(min, Math.min(max, pointerX))];

  for (let x = min; x <= max; x += GUTTER_PROBE_STEP) xs.push(x);
  xs.push(max);
  return [...new Set(xs)];
}

export function markerOffsetForNodeType(nodeType: string): number {
  // Bullets and numbers render outside a regular list item's box. A task
  // checkbox is inside the task item's flex box, so it needs no extra slot.
  return nodeType === "listItem" ? 18 : 0;
}

function blockAtDepth(
  view: EditorView,
  $pos: ReturnType<EditorView["state"]["doc"]["resolve"]>,
  depth: number
): DraggableBlock | null {
  if (depth < 1) return null;
  const nodePos = $pos.before(depth);
  const node = view.state.doc.nodeAt(nodePos);
  const dom = view.nodeDOM(nodePos);
  if (!node || !(dom instanceof HTMLElement)) return null;
  return { pos: nodePos, depth, node, dom };
}

function blockAtCoords(view: EditorView, coords: { left: number; top: number }) {
  const found = view.posAtCoords(coords);
  if (!found) return null;

  const doc = view.state.doc;
  const $pos = doc.resolve(Math.max(0, Math.min(found.pos, doc.content.size)));

  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (node.type.name === "listItem" || node.type.name === "taskItem") {
      const block = blockAtDepth(view, $pos, depth);
      if (block) return block;
    }
  }

  return blockAtDepth(view, $pos, 1);
}

function findBlockAt(
  view: EditorView,
  coords: { left: number; top: number },
  editorBounds: HorizontalBounds
) {
  let deepest: DraggableBlock | null = null;

  for (const left of gutterProbeXs(editorBounds, coords.left)) {
    const candidate = blockAtCoords(view, { left, top: coords.top });
    if (candidate && (!deepest || candidate.depth > deepest.depth)) {
      deepest = candidate;
    }
  }

  return deepest;
}

function validateCurrentBlock(
  view: EditorView,
  block: DraggableBlock | null
): DraggableBlock | null {
  if (!block || view.isDestroyed || !view.editable) return null;

  const node = view.state.doc.nodeAt(block.pos);
  const dom = view.nodeDOM(block.pos);
  if (
    node !== block.node ||
    dom !== block.dom ||
    !(dom instanceof HTMLElement) ||
    !view.dom.contains(dom)
  ) {
    return null;
  }

  return block;
}

export function canInsertNodeAt(
  doc: ProseMirrorNode,
  pos: number,
  previousNode: ProseMirrorNode,
  candidate: ProseMirrorNode
): boolean {
  if (pos < 0 || pos > doc.content.size) return false;
  const $pos = doc.resolve(pos);
  return (
    $pos.nodeBefore === previousNode &&
    candidate.type.validContent(candidate.content) &&
    $pos.parent.canReplace($pos.index(), $pos.index(), Fragment.from(candidate))
  );
}

function getOrCreateHandle(): HTMLDivElement {
  let el = document.getElementById(HANDLE_ID) as HTMLDivElement | null;
  if (!el) {
    el = document.createElement("div");
    el.id = HANDLE_ID;
    el.setAttribute("data-drag-handle", "true");
    el.draggable = true;
    el.innerHTML = `<svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><circle cx="2.5" cy="3" r="1.2"/><circle cx="2.5" cy="8" r="1.2"/><circle cx="2.5" cy="13" r="1.2"/><circle cx="7.5" cy="3" r="1.2"/><circle cx="7.5" cy="8" r="1.2"/><circle cx="7.5" cy="13" r="1.2"/></svg>`;
    Object.assign(el.style, {
      position: "absolute",
      display: "none",
      cursor: "grab",
      padding: "2px 4px",
      borderRadius: "4px",
      color: "var(--muted-foreground)",
      opacity: "0.55",
      zIndex: "40",
      userSelect: "none",
      transition: "opacity 120ms ease",
    } as CSSStyleDeclaration);
    el.addEventListener("mouseenter", () => (el!.style.opacity = "1"));
    el.addEventListener("mouseleave", () => (el!.style.opacity = "0.55"));
    document.body.appendChild(el);
  }
  return el;
}

export const DragHandle = Extension.create({
  name: "dragHandle",

  addKeyboardShortcuts() {
    // Audit #102: drag handle is mouse-only. Add Alt+Shift+ArrowUp /
    // Alt+Shift+ArrowDown so keyboard users can reorder blocks too.
    return {
      "Mod-Alt-ArrowUp": ({ editor }) =>
        moveCurrentBlock(editor.state, editor.view.dispatch, "up"),
      "Mod-Alt-ArrowDown": ({ editor }) =>
        moveCurrentBlock(editor.state, editor.view.dispatch, "down"),
      "Alt-Shift-ArrowUp": ({ editor }) =>
        moveCurrentBlock(editor.state, editor.view.dispatch, "up"),
      "Alt-Shift-ArrowDown": ({ editor }) =>
        moveCurrentBlock(editor.state, editor.view.dispatch, "down"),
    };
  },

  addProseMirrorPlugins() {
    let currentBlock: DraggableBlock | null = null;

    const handle = typeof document !== "undefined" ? getOrCreateHandle() : null;
    const addBtn = typeof document !== "undefined" ? getOrCreateAddButton() : null;

    const hide = () => {
      if (handle) handle.style.display = "none";
      if (addBtn) addBtn.style.display = "none";
      currentBlock = null;
    };

    return [
      new Plugin({
        key: new PluginKey("cabinetDragHandle"),
        view: (view) => {
          if (!handle) return { destroy: () => {} };

          const onMouseMove = (event: MouseEvent) => {
            // A global mouse listener can receive one final event while an
            // editor is being replaced. Never ask a destroyed view for DOM or
            // document positions.
            if (view.isDestroyed) {
              hide();
              return;
            }
            if (!view.editable) {
              hide();
              return;
            }
            const rect = view.dom.getBoundingClientRect();
            if (
              event.clientX < rect.left - 60 ||
              event.clientX > rect.right + 60 ||
              event.clientY < rect.top ||
              event.clientY > rect.bottom
            ) {
              hide();
              return;
            }
            const block = findBlockAt(
              view,
              { left: event.clientX, top: event.clientY },
              rect
            );
            if (!block || !block.dom || !(block.dom instanceof HTMLElement)) {
              hide();
              return;
            }
            currentBlock = block;
            const domRect = block.dom.getBoundingClientRect();
            const markerOffset = markerOffsetForNodeType(block.node.type.name);
            const handleOffset = 22 + markerOffset;
            const addButtonOffset = 44 + markerOffset;
            // AutoDirection permits LTR and RTL blocks in the same document.
            // Position against this block's resolved direction, not the page.
            const isRtl = window.getComputedStyle(block.dom).direction === "rtl";
            handle.style.display = "flex";
            handle.style.top = `${window.scrollY + domRect.top + 4}px`;
            if (isRtl) {
              // Anchor the gutter from the block's right edge so the drag /
              // add handles sit outside the content's logical start in RTL.
              handle.style.left = "auto";
              handle.style.right = `${
                document.documentElement.clientWidth -
                (window.scrollX + domRect.right) -
                handleOffset
              }px`;
            } else {
              handle.style.right = "auto";
              handle.style.left = `${window.scrollX + domRect.left - handleOffset}px`;
            }
            if (addBtn) {
              addBtn.style.display = "flex";
              addBtn.style.top = `${window.scrollY + domRect.top + 4}px`;
              if (isRtl) {
                addBtn.style.left = "auto";
                addBtn.style.right = `${
                  document.documentElement.clientWidth -
                  (window.scrollX + domRect.right) -
                  addButtonOffset
                }px`;
              } else {
                addBtn.style.right = "auto";
                addBtn.style.left = `${window.scrollX + domRect.left - addButtonOffset}px`;
              }
            }
          };

          const onMouseLeave = () => hide();

          const onAddClick = () => {
            const block = validateCurrentBlock(view, currentBlock);
            if (!block) {
              hide();
              return;
            }

            const { state } = view;
            const afterPos = block.pos + block.node.nodeSize;
            const candidates = [
              state.schema.nodes.paragraph?.createAndFill(),
              block.node.type.createAndFill(),
            ];
            const insertNode = candidates.find(
              (candidate): candidate is ProseMirrorNode =>
                Boolean(
                  candidate &&
                    canInsertNodeAt(state.doc, afterPos, block.node, candidate)
                )
            );

            // Validate the complete candidate fragment, not just its type.
            // This matters for list items with required child content and also
            // proves that afterPos is still the boundary after this block.
            if (!insertNode) {
              hide();
              return;
            }

            const tr = state.tr.insert(afterPos, insertNode);
            tr.setSelection(TextSelection.near(tr.doc.resolve(afterPos + 1)));
            view.dispatch(tr.scrollIntoView());
            view.focus();
            // Dispatch on view.dom so event.target is the ProseMirror element;
            // this lets the global "/" hotkey guard (isEditableTarget) skip it
            // while the slash-commands capture listener on window still fires.
            view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true }));
          };

          const onDragStart = (event: DragEvent) => {
            const block = validateCurrentBlock(view, currentBlock);
            if (!block || !event.dataTransfer) {
              event.preventDefault();
              hide();
              return;
            }
            const { pos, dom } = block;

            // Select the block so PM treats it as the drag source
            const tr = view.state.tr.setSelection(
              NodeSelection.create(view.state.doc, pos)
            );
            view.dispatch(tr);

            const slice = view.state.selection.content();
            // Serialize slice content to HTML for external drop targets
            const tmp = document.createElement("div");
            tmp.appendChild(
              view.someProp("clipboardSerializer")?.serializeFragment(slice.content) ??
                document.createElement("div")
            );
            event.dataTransfer.clearData();
            event.dataTransfer.setData("text/html", tmp.innerHTML);
            event.dataTransfer.setData("text/plain", dom.textContent ?? "");
            event.dataTransfer.effectAllowed = "copyMove";
            event.dataTransfer.setDragImage(dom, 0, 0);

            // Hand PM the slice so its built-in drop handler performs the move
            view.dragging = { slice, move: true };
          };

          window.addEventListener("mousemove", onMouseMove);
          view.dom.addEventListener("mouseleave", onMouseLeave);
          handle.addEventListener("dragstart", onDragStart);
          if (addBtn) addBtn.addEventListener("click", onAddClick);

          return {
            update(updatedView) {
              if (!updatedView.editable) hide();
            },
            destroy() {
              window.removeEventListener("mousemove", onMouseMove);
              view.dom.removeEventListener("mouseleave", onMouseLeave);
              handle.removeEventListener("dragstart", onDragStart);
              if (addBtn) addBtn.removeEventListener("click", onAddClick);
              hide();
            },
          };
        },
      }),
    ];
  },
});
