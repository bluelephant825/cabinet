/**
 * HTTP adapter for the document service, mounted in cabinet-daemon under
 * /documents/. Same auth shape as the daemon's other handlers: bearer token via
 * daemon-auth. Errors map DocumentError.httpStatus and never leak abs paths.
 */
import type http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import {
  getTokenFromAuthorizationHeader,
  isDaemonTokenValid,
} from "../../src/lib/agents/daemon-auth";
import { DocumentError } from "../../src/lib/documents/errors";
import type { ConvertTarget } from "../../src/lib/documents/types";
import { maxDocumentBytes } from "./persistence";
import type { DocumentService } from "./service";

type Json = Record<string, unknown>;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

function sendError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof DocumentError) {
    sendJson(res, err.httpStatus, {
      error: err.message,
      code: err.code,
      details: err.details,
    });
    return;
  }
  sendJson(res, 500, { error: "Internal document error", code: "worker-failed" });
}

async function readJson(req: http.IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Json;
  } catch {
    throw new DocumentError("invalid", "Request body is not valid JSON");
  }
}

export async function handleDocumentsRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  service: DocumentService,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/documents/")) return false;

  const token = getTokenFromAuthorizationHeader(req.headers.authorization);
  if (!isDaemonTokenValid(token)) {
    sendJson(res, 401, { error: "Unauthorized", code: "unauthorized" });
    return true;
  }

  try {
    const parts = url.pathname.split("/").filter(Boolean); // ["documents", ...]

    if (req.method === "GET" && parts[1] === "health") {
      sendJson(res, 200, await service.health());
      return true;
    }

    if (req.method === "GET" && parts[1] === "ocr" && parts[2] === "capabilities") {
      sendJson(res, 200, await service.ocrCapabilities());
      return true;
    }

    if (req.method === "GET" && parts[1] === "recovery" && !parts[2]) {
      sendJson(res, 200, await service.listRecovery(url.searchParams.get("path") ?? ""));
      return true;
    }

    if (req.method === "DELETE" && parts[1] === "draft") {
      sendJson(res, 200, await service.clearDraft(url.searchParams.get("path") ?? ""));
      return true;
    }

    if (req.method === "PUT" && parts[1] === "draft") {
      const virtualPath = url.searchParams.get("path") ?? "";
      const sessionId = url.searchParams.get("sessionId") ?? undefined;
      const { tempPath } = await service.prepareDraftTarget(virtualPath);
      const cap = maxDocumentBytes();
      const stream = fs.createWriteStream(tempPath);
      let total = 0;
      let oversized = false;
      try {
        for await (const chunk of req) {
          total += (chunk as Buffer).byteLength;
          if (total > cap) {
            oversized = true;
            continue;
          }
          if (oversized) continue;
          if (!stream.write(chunk)) {
            await new Promise<void>((r) => stream.once("drain", r));
          }
        }
      } finally {
        stream.end();
        await new Promise<void>((r) => stream.once("close", r));
      }
      if (oversized) {
        await fsp.rm(tempPath, { force: true });
        sendJson(res, 413, { error: `Draft exceeds the ${cap}-byte limit`, code: "too-large" });
        return true;
      }
      sendJson(res, 200, await service.saveDraft({
        virtualPath,
        tempPath,
        sessionId,
        baseRevision: url.searchParams.get("baseRevision") ?? undefined,
      }));
      return true;
    }

    if (req.method === "GET" && parts[1] === "pdf-composition" && parts[2] === "catalog") {
      sendJson(res, 200, service.pdfCompositionCatalog());
      return true;
    }

    if (req.method === "GET" && parts[1] === "pdf-composition" && parts[2] === "status") {
      const output = url.searchParams.get("output");
      if (output) {
        sendJson(res, 200, (await service.pdfCompositionStatusByOutput(output)) ?? {});
        return true;
      }
      sendJson(res, 200, await service.pdfCompositionStatus(url.searchParams.get("path") ?? ""));
      return true;
    }

    if (req.method === "GET" && parts[1] === "preview" && parts[2]) {
      const file = await service.pdfPreviewFile(parts[2]);
      res.writeHead(200, { "Content-Type": "application/pdf" });
      fs.createReadStream(file).pipe(res);
      return true;
    }

    if (parts[1] === "jobs" && parts[2]) {
      const jobId = parts[2];
      if (req.method === "GET" && !parts[3]) {
        sendJson(res, 200, service.jobStatus(jobId));
        return true;
      }
      if (req.method === "POST" && parts[3] === "cancel") {
        sendJson(res, 200, service.cancel(jobId));
        return true;
      }
      if (req.method === "POST" && parts[3] === "mark-recorded") {
        sendJson(res, 200, service.markJobRecorded(jobId));
        return true;
      }
      sendJson(res, 404, { error: "Unknown job route", code: "not-found" });
      return true;
    }

    if (req.method === "PUT" && parts[1] === "save") {
      const virtualPath = url.searchParams.get("path") ?? "";
      const baseRevision = url.searchParams.get("baseRevision");
      const { tempPath } = await service.prepareSaveTarget(virtualPath);
      const cap = maxDocumentBytes();
      const stream = fs.createWriteStream(tempPath);
      let total = 0;
      let oversized = false;
      try {
        for await (const chunk of req) {
          total += (chunk as Buffer).byteLength;
          if (total > cap) {
            // Drain the rest of the body (socket stays usable for the 413).
            oversized = true;
            continue;
          }
          if (oversized) continue;
          if (!stream.write(chunk)) {
            await new Promise<void>((r) => stream.once("drain", r));
          }
        }
      } finally {
        stream.end();
        await new Promise<void>((r) => stream.once("close", r));
      }
      if (oversized) {
        await fsp.rm(tempPath, { force: true });
        sendJson(res, 413, {
          error: `Document exceeds the ${cap}-byte limit`,
          code: "too-large",
        });
        return true;
      }
      const result = await service.save({
        virtualPath,
        baseRevision: baseRevision || null,
        tempPath,
      });
      sendJson(res, 200, result);
      return true;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed", code: "invalid" });
      return true;
    }

    const body = await readJson(req);
    switch (parts[1]) {
      case "open":
        sendJson(res, 200, await service.open(body as never));
        return true;
      case "inspect":
        sendJson(res, 200, await service.inspect(body));
        return true;
      case "read":
        sendJson(res, 200, await service.read(body as never));
        return true;
      case "search":
        sendJson(res, 200, await service.search(body as never));
        return true;
      case "patch":
        sendJson(res, 200, await service.applyPatch(body as never));
        return true;
      case "save-copy":
        sendJson(res, 200, await service.saveCopy(body as never));
        return true;
      case "convert":
        if (parts[2] === "plan") {
          sendJson(
            res,
            200,
            await service.convertPlan(
              String(body.virtualPath ?? ""),
              (body as { target?: ConvertTarget }).target ?? "docx",
            ),
          );
          return true;
        }
        sendJson(res, 200, await service.convert(body as never));
        return true;
      case "fonts":
        if (parts[2] === "list") {
          sendJson(res, 200, await service.listFonts());
          return true;
        }
        sendJson(res, 404, { error: "Unknown fonts route", code: "not-found" });
        return true;
      case "revision":
        sendJson(res, 200, await service.revision(String(body.virtualPath ?? "")));
        return true;
      case "docx":
        if (parts[2] === "load") {
          sendJson(res, 200, await service.docxLoad(body as never));
          return true;
        }
        if (parts[2] === "save") {
          sendJson(res, 200, await service.docxSave(body as never));
          return true;
        }
        sendJson(res, 404, { error: "Unknown docx route", code: "not-found" });
        return true;
      case "pdf":
        if (parts[2] === "geometry") {
          sendJson(res, 200, await service.pdfPageGeometry(body as never));
          return true;
        }
        sendJson(res, 404, { error: "Unknown pdf route", code: "not-found" });
        return true;
      case "recovery":
        if (parts[2] === "restore") {
          sendJson(res, 200, await service.restoreRecovery(body as never));
          return true;
        }
        sendJson(res, 404, { error: "Unknown recovery route", code: "not-found" });
        return true;
      case "pdf-composition":
        if (parts[2] === "validate") {
          sendJson(res, 200, await service.pdfCompositionValidate(body));
          return true;
        }
        if (parts[2] === "render") {
          sendJson(res, 200, await service.pdfCompositionRender(body as never));
          return true;
        }
        if (parts[2] === "source") {
          sendJson(res, 200, await service.pdfCompositionSaveSource(body as never));
          return true;
        }
        sendJson(res, 404, { error: "Unknown pdf-composition route", code: "not-found" });
        return true;
      case "close":
        sendJson(res, 200, service.close(String(body.sessionId ?? "")));
        return true;
      default:
        sendJson(res, 404, { error: "Unknown document route", code: "not-found" });
        return true;
    }
  } catch (err) {
    sendError(res, err);
    return true;
  }
}
