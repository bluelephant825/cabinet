import {
  joinNotebookSource,
  type CodeCell,
  type NotebookOutput,
  type NotebookSource,
} from "./model";

export interface JupyterMessage {
  header?: { msg_type?: string };
  parent_header?: { msg_id?: string };
  content?: {
    text?: NotebookSource;
    name?: string;
    data?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    execution_count?: number | null;
    ename?: string;
    evalue?: string;
    traceback?: string[];
    execution_state?: string;
  };
}

export function createExecuteRequest(code: string, msgId: string, sessionId: string) {
  return {
    header: {
      msg_id: msgId,
      username: "cabinet",
      session: sessionId,
      msg_type: "execute_request",
      version: "5.3",
    },
    parent_header: {},
    metadata: {},
    content: {
      code,
      silent: false,
      store_history: true,
      user_expressions: {},
      allow_stdin: false,
      stop_on_error: true,
    },
    buffers: [],
    channel: "shell",
  };
}

export function applyJupyterMessage(cell: CodeCell, message: JupyterMessage): CodeCell {
  const type = message.header?.msg_type;
  const content = message.content ?? {};
  if (type === "execute_reply") {
    return { ...cell, execution_count: content.execution_count ?? null };
  }

  const outputs = [...(cell.outputs ?? [])];
  if (type === "stream") {
    const name = content.name === "stderr" ? "stderr" : "stdout";
    const text = joinNotebookSource(content.text);
    const previous = outputs.at(-1);
    if (previous?.output_type === "stream" && previous.name === name) {
      outputs[outputs.length - 1] = {
        ...previous,
        text: joinNotebookSource(previous.text as NotebookSource) + text,
      };
    } else {
      outputs.push({ output_type: "stream", name, text });
    }
  } else if (type === "execute_result" || type === "display_data") {
    outputs.push({
      output_type: type,
      data: content.data ?? {},
      metadata: content.metadata ?? {},
      ...(type === "execute_result" ? { execution_count: content.execution_count ?? null } : {}),
    });
  } else if (type === "error") {
    outputs.push({
      output_type: "error",
      ename: content.ename ?? "Error",
      evalue: content.evalue ?? "",
      traceback: content.traceback ?? [],
    });
  } else {
    return cell;
  }
  return { ...cell, outputs: outputs as NotebookOutput[] };
}
