import simpleGit from "simple-git";
import { NextRequest, NextResponse } from "next/server";
import { autoCommit } from "@/lib/git/git-service";
import {
  cloneAndLinkRepository,
  CloneRepoError,
  type CloneRepoInput,
} from "@/lib/git/repo-clone";
import { ReadOnlySourceError } from "@/lib/knowledge-sources/store";
import { invalidateTreeCache } from "@/lib/storage/tree-builder";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    let input: CloneRepoInput;
    try {
      input = (await req.json()) as CloneRepoInput;
    } catch {
      throw new CloneRepoError("Request body must be valid JSON.");
    }
    const result = await cloneAndLinkRepository(input, {
      clone: async (remote, destination, branch) => {
        const options = branch ? ["--branch", branch, "--single-branch"] : [];
        await simpleGit().clone(remote, destination, options);
      },
      currentBranch: async (destination) => {
        const summary = await simpleGit(/*turbopackIgnore: true*/ destination).branchLocal();
        return summary.current || undefined;
      },
    });

    invalidateTreeCache();
    autoCommit(result.path, "Add");
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status =
      error instanceof CloneRepoError ? error.status : error instanceof ReadOnlySourceError ? 403 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
