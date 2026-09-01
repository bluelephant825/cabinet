import { NextRequest, NextResponse } from "next/server";
import { getDaemonUrl, getOrCreateDaemonToken } from "@/lib/agents/daemon-auth";
import {
  isAllowedJupyterProxyRequest,
  JUPYTER_PROXY_TIMEOUT_MS,
  JUPYTER_REQUEST_LIMIT,
  JUPYTER_RESPONSE_LIMIT,
} from "@/lib/notebook/jupyter";

type RouteContext = { params: Promise<{ path?: string[] }> };

async function handleProxy(request: NextRequest, context: RouteContext): Promise<Response> {
  const segments = (await context.params).path ?? [];
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\"))) {
    return NextResponse.json({ error: "Invalid Jupyter API path" }, { status: 400 });
  }
  const subpath = segments.join("/");
  if (!isAllowedJupyterProxyRequest(request.method, subpath)) {
    return NextResponse.json({ error: "Jupyter API operation is not allowed" }, { status: 404 });
  }

  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > JUPYTER_REQUEST_LIMIT) {
    return NextResponse.json({ error: "Jupyter request body is too large" }, { status: 413 });
  }

  try {
    const body = request.method === "GET" ? undefined : await request.arrayBuffer();
    if (body && body.byteLength > JUPYTER_REQUEST_LIMIT) {
      return NextResponse.json({ error: "Jupyter request body is too large" }, { status: 413 });
    }
    const token = await getOrCreateDaemonToken();
    const headers = new Headers({ Authorization: `Bearer ${token}` });
    const contentType = request.headers.get("content-type");
    if (contentType) headers.set("Content-Type", contentType);

    const response = await fetch(`${getDaemonUrl()}/jupyter/proxy/${subpath}`, {
      method: request.method,
      headers,
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(JUPYTER_PROXY_TIMEOUT_MS + 1_000),
    });
    const responseLength = Number(response.headers.get("content-length") || 0);
    if (responseLength > JUPYTER_RESPONSE_LIMIT) {
      return NextResponse.json({ error: "Jupyter response body is too large" }, { status: 502 });
    }
    const responseBody = response.status === 204 ? null : await response.arrayBuffer();
    if (responseBody && responseBody.byteLength > JUPYTER_RESPONSE_LIMIT) {
      return NextResponse.json({ error: "Jupyter response body is too large" }, { status: 502 });
    }
    const responseHeaders = new Headers();
    const responseType = response.headers.get("content-type");
    if (responseType) responseHeaders.set("Content-Type", responseType);
    responseHeaders.set("Cache-Control", "no-store");
    return new Response(responseBody, { status: response.status, headers: responseHeaders });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return NextResponse.json(
      { error: timedOut ? "Jupyter request timed out" : "Jupyter daemon is unavailable" },
      { status: timedOut ? 504 : 503 }
    );
  }
}

export { handleProxy as GET, handleProxy as POST, handleProxy as DELETE };
