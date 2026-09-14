import fs from "node:fs/promises";
import path from "node:path";
import { readWikiCabinet, initializeWikiCabinet, setWikiEnabled, WIKI_STATE_PATH } from "../../src/lib/llm-wiki/config";
import { ownedPath, contains, statOrNull, withRootLock } from "../../src/lib/llm-wiki/filesystem";
import { ObsidianManagedSourceService } from "../../src/lib/llm-wiki/obsidian";
import { SourceStore } from "../../src/lib/llm-wiki/source-store";
import { SourceLifecycleStore } from "../../src/lib/llm-wiki/source-lifecycle";
import { RawPublicationStore } from "../../src/lib/llm-wiki/raw-publication";
import { SourceSummaryPlanner, type SourceSummaryModel } from "../../src/lib/llm-wiki/source-summary";
import type { SemanticExtractionModel } from "../../src/lib/llm-wiki/semantic-extraction";
import { PlanningWikiCompiler } from "../../src/lib/llm-wiki/compiler";
import { createDeletionReconciliationCompiler } from "../../src/lib/llm-wiki/deletion-reconciliation";
import { WikiPublicationStore, durableText, readWikiInventory, textHash } from "../../src/lib/llm-wiki/wiki-publication";
import { captureNote } from "../../src/lib/llm-wiki/capture-note";
import { SourceNormalizationService } from "../../src/lib/llm-wiki/normalizers";
import { ingestionRoutes, type IngestionQueue, type JobLease } from "../../src/lib/llm-wiki/queue";
import type { IngestionJobId, IngestionStatus, SourceId, SourceVersionId } from "../../src/lib/llm-wiki/types";
import { WikiInferenceModel } from "./wiki-model";
import { WikiAgentRunner, type AgentPassResult, type AgentTask } from "./wiki-agent";
import { XbergAdapter } from "./xberg";
import { commitWikiPublication } from "../../src/lib/history/engine";
import { listPersonas } from "../../src/lib/agents/persona-manager";
import { providerRegistry } from "../../src/lib/agents/provider-registry";
import { WIKI_COMPILATION_TIMEOUT_MS, WIKI_WORKER_LEASE_MS, WIKI_WORKER_HEARTBEAT_MS } from "../../src/lib/llm-wiki/execution-limits";

const settingsPath = `${WIKI_STATE_PATH}/workflow.json`;
interface Settings { folders: string[]; running: boolean; agentSlug?: string; provider?: string; model?: string }
interface CaptureRecord { predecessor: SourceVersionId | null; fingerprint: string; warnings: readonly unknown[]; versionId?: SourceVersionId }
export class WikiWorkflow {
  private active: AbortController | null = null;
  private ticking = false;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private error: string | null = null;
  private dependencyChecked = 0;
  constructor(private readonly root: string, private readonly openQueue: () => Promise<IngestionQueue | null>,
    private readonly model: SourceSummaryModel & SemanticExtractionModel = new WikiInferenceModel(),
    private readonly stale: () => boolean = () => false,
    private readonly agent?: WikiAgentRunner) {}
  private agentRunner(): WikiAgentRunner { return this.agent ?? new WikiAgentRunner(this.root); }
  private async settings(): Promise<Settings> {
    const file = await ownedPath(this.root, settingsPath);
    if (!await statOrNull(file)) return { folders: [], running: false };
    return JSON.parse(await fs.readFile(file, "utf8"));
  }
  private async save(settings: Settings) { await withRootLock(this.root, () => durableText(this.root, settingsPath, JSON.stringify(settings))); }
  async status() {
    const cabinet = await readWikiCabinet(this.root), settings = await this.settings();
    const queue = cabinet?.config.enabled ? await this.openQueue() : null;
    const sources = cabinet ? await new SourceStore(this.root).list() : [];
    const provider = this.model instanceof WikiInferenceModel ? await this.inference(settings).status() : { available: true, provider: "test", message: "Test provider" };
    const agents = this.model instanceof WikiInferenceModel ? (await listPersonas()).map((persona) => ({ slug: persona.slug, name: persona.displayName || persona.name, provider: persona.provider, model: persona.model ?? null, active: persona.active })) : [];
    const jobs = await Promise.all((queue?.list() ?? []).map(async (job) => {
      const file = await ownedPath(this.root, `${WIKI_STATE_PATH}/operations/${job.id}.json`);
      const record = await statOrNull(file) ? JSON.parse(await fs.readFile(file, "utf8")) : {};
      return { ...job, agentWarnings: Array.isArray(record.agentWarnings) ? record.agentWarnings : [] };
    }));
    return { enabled: cabinet?.config.enabled ?? false, cabinetName: path.basename(this.root), folders: settings.folders, running: settings.running,
      busy: !!this.active, error: this.error, provider, jobs,
      agents, selectedAgent: settings.agentSlug ?? null, sources: await Promise.all(sources.map(async ({ source, versions }) => ({ id: source.id, title: source.title, path: source.mode === "managed" ? source.managedLocation.path : null,
        rawPath: source.rawPath, version: versions.find((item) => item.id === source.currentVersionId)?.version ?? null,
        warnings: await this.sourceWarnings(source.id),
        compiled: !!source.currentVersionId && source.currentVersionId === source.lastCompiledVersionId && source.lifecycle?.reconciliation !== "pending", status: source.status }))),
      wikiPath: cabinet?.config.paths.wiki ?? "wiki" };
  }
  private inference(settings: Settings) { return new WikiInferenceModel(settings.agentSlug ? { agentSlug: settings.agentSlug } : settings.provider ? { provider: settings.provider, model: settings.model } : undefined); }
  private async sourceWarnings(id: string) {
    const file = await ownedPath(this.root, `${WIKI_STATE_PATH}/dependencies/${id}.json`);
    if (!await statOrNull(file)) return [];
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    return Array.isArray(value.warnings) ? value.warnings : [];
  }
  async action(input: Record<string, unknown>) {
    if (this.stale()) throw new Error("Cabinet changed. Restart the background service.");
    if (input.action === "enable") {
      const cabinet = await readWikiCabinet(this.root);
      if (cabinet) await setWikiEnabled(this.root, true);
      else await initializeWikiCabinet(this.root, { enabled: true });
      return this.status();
    }
    const cabinet = await readWikiCabinet(this.root);
    if (!cabinet?.config.enabled) throw new Error("Enable the Wiki first");
    const settings = await this.settings();
    if (input.action === "agent") {
      if (this.active) throw new Error("Pause the current run before changing agent");
      if (typeof input.agentSlug !== "string" || !input.agentSlug.trim()) throw new Error("Choose a Cabinet agent");
      const agents = await listPersonas();
      const selected = agents.find((persona) => persona.slug === input.agentSlug);
      if (!selected) throw new Error("Choose a Cabinet agent");
      await this.save({ ...settings, agentSlug: selected.slug, provider: undefined, model: undefined });
      return this.status();
    }
    if (input.action === "provider") {
      if (this.active) throw new Error("Pause the current run before changing provider");
      if (typeof input.provider !== "string" || !providerRegistry.get(input.provider)) throw new Error("Choose a Cabinet AI provider");
      if (input.model !== undefined && (typeof input.model !== "string" || input.model.length > 120)) throw new Error("Invalid model");
      await this.save({ ...settings, provider: input.provider, model: typeof input.model === "string" && input.model.trim() ? input.model.trim() : undefined });
      return this.status();
    }
    if (input.action === "inspect") {
      if (!Array.isArray(input.folders) || input.folders.some((item) => typeof item !== "string")) throw new Error("Select source folders");
      return new ObsidianManagedSourceService(this.root, input.folders as string[]).inspect();
    }
    if (input.action === "import") {
      if (!Array.isArray(input.folders) || !Array.isArray(input.paths) || !input.paths.length || input.paths.length > 500) throw new Error("Select notes to add");
      const folders = input.folders as string[];
      const inventory = await new ObsidianManagedSourceService(this.root, folders).inspect();
      if (inventory.fingerprint !== input.fingerprint) throw new Error("Notes changed. Preview the folders again.");
      for (const relative of input.paths) if (!inventory.notes.some((item) => item.path === relative)) throw new Error("Note is outside the preview");
      const queue = await this.openQueue(); if (!queue) throw new Error("Queue unavailable");
      await this.save({ ...settings, folders: [...new Set([...settings.folders, ...folders])], running: settings.running });
      const store = new SourceStore(this.root);
      for (const relative of input.paths as string[]) {
        const note = inventory.notes.find((item) => item.path === relative)!;
        const location = { kind: "cabinet" as const, path: relative };
        let source = await store.findManaged(location);
        source ??= (await store.register({ mode: "managed", roomPath: null, title: path.posix.basename(relative, path.posix.extname(relative)), classification: "notes", managedLocation: location })).source;
        if (source.status !== "active") throw new Error("Restore the removed source before importing it again");
        const pending = queue.list().some((job) => job.sourceId === source.id && job.status !== "complete");
        if (pending) continue;
        const manifest = await store.get(source.id);
        const current = manifest!.versions.find((item) => item.id === source.currentVersionId);
        if (current?.contentHash === note.contentHash && source.lastCompiledVersionId === source.currentVersionId) continue;
        await queue.enqueue({ operation: current ? "update" : "create", sourceId: source.id, roomPath: null, input: location, contentHash: note.contentHash, generation: `onboard:${source.currentVersionId ?? "initial"}:${note.contentHash}` });
      }
      await this.save({ ...settings, folders: [...new Set([...settings.folders, ...folders])], running: true });
      this.wake(); return this.status();
    }
    if (input.action === "pause" || input.action === "resume") {
      await this.save({ ...settings, running: input.action === "resume" });
      if (input.action === "pause") this.active?.abort(new Error("Paused by user"));
      else this.wake();
      return this.status();
    }
    if (input.action === "retry") {
      const queue = await this.openQueue(); if (!queue) throw new Error("Queue unavailable");
      const id = input.id as IngestionJobId, job = queue.get(id);
      if (input.updatedAt !== job.updatedAt) throw new Error("Job changed. Refresh before retrying.");
      await queue.resumeReviewed(id, job.updatedAt);
      this.wake(); return this.status();
    }
    if (input.action === "consolidate" || input.action === "lint") {
      const queue = await this.openQueue(); if (!queue) throw new Error("Queue unavailable");
      if (!settings.agentSlug) throw new Error("Choose a Wiki agent first");
      if (queue.list().some((job) => job.operation === input.action && !["complete", "failed", "needs-review"].includes(job.status))) {
        throw new Error(`A ${input.action} operation is already queued or running`);
      }
      await queue.enqueue({ operation: input.action as "consolidate" | "lint", sourceId: null, roomPath: null, generation: `${input.action}:${Date.now()}` });
      await this.save({ ...settings, running: true });
      this.wake(); return this.status();
    }
    if (input.action === "reprocess-all") {
      const queue = await this.openQueue(); if (!queue) throw new Error("Queue unavailable");
      if (queue.list().some((job) => job.operation === "reprocess" && !["complete", "failed", "needs-review"].includes(job.status))) {
        throw new Error("A Wiki rebuild is already queued or running");
      }
      const requested = Array.isArray(input.sourceIds) ? input.sourceIds.filter((id): id is string => typeof id === "string") : null;
      if (requested && requested.length > 500) throw new Error("Too many sources for one rebuild (max 500)");
      const sources = (await new SourceStore(this.root).list()).map((entry) => entry.source);
      let selected: typeof sources;
      if (requested) {
        const byId = new Map(sources.map((source) => [source.id, source]));
        selected = requested.map((id) => {
          const source = byId.get(id as SourceId);
          if (!source || source.status !== "active" || !source.currentVersionId) throw new Error("Unknown source");
          return source;
        });
      } else {
        selected = sources.filter((source) => source.status === "active" && source.currentVersionId);
      }
      if (input.legacyOnly) {
        const wikiRoot = (await readWikiCabinet(this.root))?.config.paths.wiki ?? "wiki";
        const keep: typeof selected = [];
        for (const source of selected) {
          if (await statOrNull(await ownedPath(this.root, `${wikiRoot}/sources/source-${source.id}.md`))) keep.push(source);
        }
        selected = keep;
      }
      const day = new Date().toISOString().slice(0, 10);
      for (const source of selected) {
        await queue.enqueue({ operation: "reprocess", sourceId: source.id, sourceVersionId: source.currentVersionId!,
          roomPath: source.roomPath, generation: `rebuild:${source.id}:${source.currentVersionId}:${day}` });
      }
      await this.save({ ...settings, running: true });
      this.wake(); return this.status();
    }
    throw new Error("Unknown Wiki action");
  }
  start() { this.closed = false; this.wake(); }
  private wake() {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.tick().finally(() => this.wake()); }, 1000);
  }
  async close() { this.closed = true; if (this.timer) clearTimeout(this.timer); this.active?.abort(); }
  async tick() {
    if (this.ticking || this.closed) return;
    this.ticking = true;
    try {
      if (this.stale()) throw new Error("Cabinet changed. Restart the background service.");
      const settings = await this.settings();
      if (!settings.running || !(await readWikiCabinet(this.root))?.config.enabled) return;
      const queue = await this.openQueue(); if (!queue) return;
      // Attachment-only edits use the same source stream and immutable versioning.
      if (Date.now() - this.dependencyChecked > 30_000) {
        this.dependencyChecked = Date.now();
        for (const { source } of await new SourceStore(this.root).list()) {
          if (source.mode !== "managed" || source.managedLocation.kind !== "cabinet" || source.status !== "active" || queue.list().some((job) => job.sourceId === source.id && job.status !== "complete")) continue;
          const folder = settings.folders.find((item) => contains(item, source.managedLocation.path));
          if (!folder) continue;
          const file = await ownedPath(this.root, `${WIKI_STATE_PATH}/dependencies/${source.id}.json`);
          if (!await statOrNull(file) || !await statOrNull(await ownedPath(this.root, source.managedLocation.path))) continue;
          const previous = JSON.parse(await fs.readFile(file, "utf8"));
          const captured = await captureNote(this.root, source.managedLocation.path, folder);
          if (previous.fingerprint !== captured.fingerprint) await queue.enqueue({ operation: "update", sourceId: source.id, roomPath: source.roomPath, input: source.managedLocation, contentHash: captured.contentHash, generation: `dependencies:${source.currentVersionId}:${captured.fingerprint}` });
        }
      }
      const lease = await queue.claim("wiki-workflow", WIKI_WORKER_LEASE_MS);
      if (!lease) return;
      this.active = new AbortController();
      const active = this.active;
      const heartbeat = setInterval(() => {
        if (active.signal.aborted) return;
        try { queue.heartbeat(lease.job.id, lease.token, WIKI_WORKER_LEASE_MS); }
        catch (error) { active.abort(error); }
      }, WIKI_WORKER_HEARTBEAT_MS);
      try { await this.process(queue, lease, settings, this.active.signal); this.error = null; }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.error = message;
        try { queue.fail(lease.job.id, lease.token, message.slice(0, 4000), !this.active.signal.aborted); } catch { /* An expired lease remains recoverable. */ }
      } finally { clearInterval(heartbeat); this.active = null; }
    } catch (error) { this.error = error instanceof Error ? error.message : String(error); }
    finally { this.ticking = false; }
  }
  private batchMarker = `${WIKI_STATE_PATH}/batch-pending.json`;
  private async recordAgentResult(jobId: string, result: AgentPassResult) {
    const recordPath = `${WIKI_STATE_PATH}/operations/${jobId}.json`;
    const file = await ownedPath(this.root, recordPath);
    const existing = await statOrNull(file) ? JSON.parse(await fs.readFile(file, "utf8")) : {};
    existing.agentWarnings = result.warnings;
    existing.agentReport = result.report;
    existing.agentChanges = { created: result.created, updated: result.updated, deleted: result.deleted };
    await durableText(this.root, recordPath, JSON.stringify(existing));
  }
  /** Auto-consolidate once a batch drain finishes; the marker survives restarts. */
  private async maybeConsolidate(queue: IngestionQueue) {
    const marker = await ownedPath(this.root, this.batchMarker);
    if (!await statOrNull(marker)) return;
    if (queue.list().some((job) => ["queued", "discovered"].includes(job.status))) return;
    await fs.rm(marker, { force: true });
    if (queue.list().some((job) => job.operation === "consolidate" && !["complete", "failed", "needs-review"].includes(job.status))) return;
    await queue.enqueue({ operation: "consolidate", sourceId: null, roomPath: null, generation: `consolidate:auto:${Date.now()}` });
  }
  /** Stage 2: the tool-enabled agent pass runs while the job holds the
   * "linking" stage, after Cabinet's checked publication commit. */
  private async linkingStage(queue: IngestionQueue, lease: JobLease, settings: Settings, manifest: { source: { id: SourceId; title: string } } | null,
    sourcePage: string | null, rawMarkdownPath: string | null, signal: AbortSignal) {
    const { job, token } = lease;
    const route = ingestionRoutes[job.operation];
    for (let status = queue.get(job.id).status; status !== "linking"; status = queue.get(job.id).status) {
      queue.advance(job.id, token, route[route.indexOf(status) + 1]);
    }
    const runner = this.agentRunner();
    if (!runner.hasAgent(settings)) return;
    let task: AgentTask;
    if (job.operation === "consolidate" || job.operation === "lint") task = { kind: job.operation };
    else if (job.operation === "delete") task = { kind: "delete", sourceId: manifest!.source.id, sourcePage, title: manifest!.source.title };
    else {
      if (!sourcePage || !rawMarkdownPath || !manifest) throw new Error("Missing source page for Wiki page building");
      const batch = queue.list().some((item) => item.id !== job.id && ["queued", "discovered"].includes(item.status))
        || !!(await statOrNull(await ownedPath(this.root, this.batchMarker)));
      if (batch) await durableText(this.root, this.batchMarker, JSON.stringify({ pending: true, jobId: job.id }));
      task = { kind: "ingest", sourceId: manifest.source.id, sourcePage, rawMarkdownPath, title: manifest.source.title, batch };
    }
    const result = await runner.run(task, settings, job.id, signal);
    await this.recordAgentResult(job.id, result);
  }
  private async process(queue: IngestionQueue, lease: JobLease, settings: Settings, signal: AbortSignal) {
    const { job, token } = lease;
    const advance = (stage: IngestionStatus) => queue.advance(job.id, token, stage);
    const publisher = new WikiPublicationStore(this.root);
    const store = new SourceStore(this.root);
    if (await publisher.recover(job.id)) {
      const published = await publisher.publishedPaths(job.id);
      if (published) await commitWikiPublication(this.root, published.wikiRoot, published.paths, job.id);
      const manifest = job.sourceId ? await store.get(job.sourceId) : null;
      // A rename publishes a delete+write pair; prefer the /sources/ path that
      // still exists on disk.
      let sourcePage: string | null = null;
      for (const candidate of published?.paths.filter((item) => item.includes("/sources/")) ?? []) {
        if (await statOrNull(await ownedPath(this.root, candidate))) sourcePage = candidate;
      }
      const current = manifest?.versions.find((item) => item.id === manifest.source.currentVersionId);
      await this.linkingStage(queue, lease, settings, manifest, sourcePage, current?.markdownPath ?? null, signal);
      advance("complete");
      await this.maybeConsolidate(queue);
      return;
    }
    let manifest = job.sourceId ? await store.get(job.sourceId) : null;
    if (job.operation === "consolidate" || job.operation === "lint") {
      await this.linkingStage(queue, lease, settings, null, null, null, signal);
      advance("complete");
      return;
    }
    if (job.operation === "delete") {
      if (!manifest) throw new Error("Source is missing");
      if (manifest.source.status === "active") manifest = await new SourceLifecycleStore(this.root).remove(manifest.source.id, manifest.source.lifecycle?.revision ?? 0, "missing");
    } else if (job.operation !== "reprocess") {
      if (job.input?.kind !== "cabinet") throw new Error("This workflow requires a local Cabinet source");
      if (manifest?.source.status === "deleted") manifest = await new SourceLifecycleStore(this.root).restore(manifest.source.id, manifest.source.lifecycle?.revision ?? 0, "returned");
      const folder = settings.folders.find((item) => contains(item, job.input!.path));
      const bytes = folder ? null : await fs.readFile(await ownedPath(this.root, job.input.path));
      const captured = folder ? await captureNote(this.root, job.input.path, folder) : {
        normalized: await new SourceNormalizationService(new XbergAdapter()).normalize({ path: job.input.path, bytes: bytes!, contentHash: textHash(bytes!) }),
        contentHash: textHash(bytes!), fingerprint: textHash(bytes!),
      };
      if (captured.contentHash !== job.contentHash) throw new Error("Source changed after it was queued. Review this operation before retrying.");
      signal.throwIfAborted();
      if (job.operation === "create") {
        advance("classifying");
        if (!manifest) {
          manifest = await store.register({ mode: "snapshot", title: path.posix.basename(job.input.path), classification: "inbox", roomPath: job.roomPath });
          await queue.bindSource(job.id, token, manifest.source.id);
        }
      }
      if (!manifest) throw new Error("Source is missing");
      advance("promoting");
      const recordPath = `${WIKI_STATE_PATH}/operations/${job.id}.json`;
      const recordFile = await ownedPath(this.root, recordPath);
      let preparation: CaptureRecord;
      if (await statOrNull(recordFile)) {
        preparation = JSON.parse(await fs.readFile(recordFile, "utf8"));
        if (preparation.fingerprint !== captured.fingerprint) throw new Error("Captured dependencies changed. Review the interrupted operation.");
      } else {
        preparation = { predecessor: manifest.source.currentVersionId, fingerprint: captured.fingerprint, warnings: captured.normalized.warnings };
        await durableText(this.root, recordPath, JSON.stringify(preparation));
      }
      const raw = new RawPublicationStore(this.root);
      manifest = preparation.predecessor ? await raw.publishUpdate(manifest.source.id, preparation.predecessor, captured.normalized) : await raw.publishInitial(manifest.source.id, captured.normalized);
      preparation.versionId = manifest.source.currentVersionId!;
      await durableText(this.root, recordPath, JSON.stringify(preparation));
      await durableText(this.root, `${WIKI_STATE_PATH}/dependencies/${manifest.source.id}.json`, JSON.stringify(preparation));
      advance(job.operation === "create" ? "compiling" : "reconciling");
    } else {
      if (!manifest || manifest.source.currentVersionId !== job.sourceVersionId) throw new Error("Reprocess must target current evidence");
      advance("promoting"); advance("reconciling");
    }
    if (!manifest) throw new Error("Source is missing");
    signal.throwIfAborted();
    const inventory = await readWikiInventory(this.root);
    const references = [...new Map(inventory.filter((item) => item.provenance.roomPath === manifest.source.roomPath).flatMap((item) => item.provenance.knowledge.flatMap((node) => [...node.supports, ...(node.inactiveSupports ?? [])])).map((edge) => [`${edge.sourceId}:${edge.versionId}`, { sourceId: edge.sourceId, versionId: edge.versionId }])).values()];
    const selectedModel = this.model instanceof WikiInferenceModel ? this.inference(settings) : this.model;
    const guardedModel: SourceSummaryModel & SemanticExtractionModel = {
      summarize: (input, inner) => selectedModel.summarize(input, AbortSignal.any([signal, inner])),
      extract: (input, inner) => selectedModel.extract(input, AbortSignal.any([signal, inner])),
    };
    const planner = new SourceSummaryPlanner(guardedModel, guardedModel);
    const current = manifest.versions.find((item) => item.id === manifest!.source.currentVersionId);
    const previous = manifest.versions.find((item) => item.id === manifest!.source.lastCompiledVersionId);
    // Deletion is deterministic reconciliation over the provenance inventory —
    // no inference — so it keeps its own compiler rather than the summary
    // planner. The Stage 2 agent pass does the linking afterwards.
    const compiler = job.operation === "delete"
      ? createDeletionReconciliationCompiler(this.root, inventory.filter((item) => item.provenance.roomPath === manifest!.source.roomPath), WIKI_COMPILATION_TIMEOUT_MS)
      : new PlanningWikiCompiler(this.root, planner, WIKI_COMPILATION_TIMEOUT_MS, references, true);
    const plan = job.operation === "delete" ? await compiler.reconcileDeletion(manifest.source) : previous && current && previous.version < current.version
      ? await compiler.reconcileUpdate(manifest.source, previous, current) : await compiler.ingest(manifest.source, current!);
    signal.throwIfAborted();
    if (this.stale()) throw new Error("Cabinet changed before publication");
    queue.heartbeat(job.id, token, WIKI_WORKER_LEASE_MS);
    await publisher.publish(job.id, plan, compiler);
    await commitWikiPublication(this.root, plan.wikiRoot, plan.changes.map((change) => change.path), job.id);
    const sourcePage = plan.changes.find((change) => change.path.includes("/sources/") && change.kind === "write")?.path ?? null;
    await this.linkingStage(queue, lease, settings, manifest, sourcePage, current?.markdownPath ?? null, signal);
    advance("complete");
    await this.maybeConsolidate(queue);
  }
}
