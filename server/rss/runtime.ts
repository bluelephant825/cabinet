import { RssService } from "./service";
import { RssBriefs, briefJobId } from "./briefs";
import { RssError } from "./store";
import { listPersonas } from "../../src/lib/agents/persona-manager";
import { getJob, saveAgentJob, executeJob } from "../../src/lib/jobs/job-manager";
import { listConversationMetas, readConversationTurns, readConversationTranscript, extractAgentTurnContent } from "../../src/lib/agents/conversation-store";
import { storageOverCap } from "../../src/lib/cloud/tier";
import { recordMutation } from "../../src/lib/history/engine";
import { invalidateTreeCache } from "../../src/lib/storage/tree-builder";
import { isProcessStale } from "../../src/lib/runtime/runtime-config";

export function createRssService() {
  const service = new RssService(undefined, undefined, undefined, isProcessStale);
  service.briefs = new RssBriefs(service, {
    async job(room, brief, sync = false) {
      const agent = (await listPersonas(room)).find((a) => a.slug === brief.agentSlug && a.scope !== "global");
      if (!agent) throw new RssError("Select an agent belonging to this room");
      if (brief.enabled && !agent.active) throw new RssError("Enable this agent in the room before scheduling briefs");
      const id = briefJobId(brief.id);
      const existing = await getJob(id, room);
      if (existing && existing.rssBriefId !== brief.id) throw new RssError("RSS job identifier conflicts with another job", 409);
      if (!sync) {
        if (!existing || existing.schedule !== brief.schedule || existing.enabled !== brief.enabled || existing.agentSlug !== brief.agentSlug) throw new RssError("The linked job changed. Save the brief to reconcile its settings", 409);
        return { ...existing, provider: agent.provider, adapterType: agent.adapterType, adapterConfig: agent.adapterConfig };
      }
      const now = new Date().toISOString();
      await service.store.file(room, `.jobs/${id}.yaml`, true);
      return saveAgentJob(brief.agentSlug, { id, rssBriefId: brief.id, name: `RSS: ${brief.name}`, enabled: brief.enabled, schedule: brief.schedule, provider: agent.provider, adapterType: agent.adapterType, adapterConfig: agent.adapterConfig, cabinetPath: room, prompt: "Generate the configured RSS brief using Cabinet's prepared source input.", timeout: 600, createdAt: existing?.createdAt || now, updatedAt: now }, room);
    },
    async disableJob(room, brief) {
      await service.store.file(room, `.jobs/${briefJobId(brief.id)}.yaml`, true);
      const job = await getJob(briefJobId(brief.id), room);
      if (job?.rssBriefId === brief.id) await saveAgentJob(job.agentSlug || brief.agentSlug, { ...job, enabled: false, updatedAt: new Date().toISOString() }, room);
    },
    execute: executeJob,
    conversations: (room) => listConversationMetas({ cabinetPath: room }),
    async output(meta) {
      const turns = await readConversationTurns(meta.id, meta.cabinetPath, meta);
      return turns.filter((turn) => turn.role === "agent" && !turn.pending).at(-1)?.content || extractAgentTurnContent(await readConversationTranscript(meta.id, meta.cabinetPath));
    },
    async checkStorage() { if (await storageOverCap()) throw new RssError("Storage full. Free space before publishing this brief", 402); },
    async published(room, run, virtualPath) {
      invalidateTreeCache();
      await recordMutation({ op: "create", virtualPath, message: `Publish RSS brief: ${run.brief.name}`, actor: { kind: "agent", slug: run.brief.agentSlug, cabinetPath: room, conversationId: run.conversationId, trigger: "job" } });
    },
  });
  return service;
}
