import { NextResponse } from "next/server";
import { DATA_DIR } from "@/lib/storage/path-utils";
import { isProcessStale } from "@/lib/runtime/runtime-config";
import { StaleProcessError } from "@/lib/api/stale-process";
import { staleProcessResponse } from "@/lib/api/stale-process-response";
import { detectInstallKind, readInstallMetadata } from "@/lib/system/install-metadata";
import { readBundledReleaseManifest } from "@/lib/system/release-manifest";

export async function GET() {
  if (isProcessStale()) {
    return staleProcessResponse(new StaleProcessError());
  }

  const [metadata, manifest] = await Promise.all([
    readInstallMetadata(),
    readBundledReleaseManifest(),
  ]);

  return NextResponse.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: manifest.version,
    installKind: detectInstallKind(metadata),
    dataDir: DATA_DIR,
    stale: isProcessStale(),
  });
}
