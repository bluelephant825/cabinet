import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";
import matter from "gray-matter";
import { DATA_DIR } from "@/lib/storage/path-utils";
import { scaffoldCabinet } from "@/lib/storage/cabinet-scaffold";
import {
  getMandatoryAgentSlugs,
  resolveAgentLibraryDir,
} from "@/lib/agents/library-manager";
import { ensureAgentScaffold } from "@/lib/agents/scaffold";
import { getRoomConfig, type RoomType } from "@/lib/onboarding/rooms";

const AGENTS_DIR = path.join(DATA_DIR, ".agents");
const CONFIG_DIR = path.join(AGENTS_DIR, ".config");
const CHAT_DIR = path.join(DATA_DIR, ".chat");

interface OnboardingRequest {
  homeName?: string;
  roomType?: RoomType;
  answers: {
    name?: string;
    // New field; falls back to legacy companyName if absent.
    workspaceName?: string;
    companyName?: string;
    description: string;
    goals?: string;
    teamSize: string;
    priority?: string;
  };
  selectedAgents: string[];
  /** The single agent the user configured from scratch in the team step. */
  firstAgent?: {
    name?: string;
    role?: string;
    instructions?: string;
    provider?: string;
  };
  locale?: string;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as OnboardingRequest;
    const { answers } = body;
    const roomType: RoomType = body.roomType || "office";
    const roomConfig = getRoomConfig(roomType);
    const workspaceName =
      answers.workspaceName?.trim() || answers.companyName?.trim() || "My Cabinet";
    const homeName =
      body.homeName?.trim() || (answers.name ? `${answers.name}'s Home` : "Home");

    // No pre-made team: create exactly the agents the user chose (which is
    // none during onboarding now — the user configures their first agent in the
    // wizard, created separately via /api/agents/personas). We no longer force
    // the room's mandatory agents.
    const selectedAgents = Array.isArray(body.selectedAgents)
      ? body.selectedAgents
      : [];
    const mandatorySlugs = getMandatoryAgentSlugs(roomType);
    const libraryDir = await resolveAgentLibraryDir();

    if (!libraryDir) {
      return NextResponse.json(
        { error: "Agent library is unavailable" },
        { status: 500 }
      );
    }

    // 1. Save workspace config (v2 shape, forward-compatible with multi-room).
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    const workspaceConfig = {
      exists: true,
      version: 2,
      home: { name: homeName },
      room: {
        id: `${roomType}-01`,
        type: roomType,
        name: roomConfig.label,
      },
      cabinet: {
        name: workspaceName,
        description: answers.description,
        size: answers.teamSize || "",
      },
      setupDate: new Date().toISOString(),
    };
    await fs.writeFile(
      path.join(CONFIG_DIR, "workspace.json"),
      JSON.stringify(workspaceConfig, null, 2)
    );

    // Legacy company.json — keeps old code paths working (config route fallback, etc.)
    await fs.writeFile(
      path.join(CONFIG_DIR, "company.json"),
      JSON.stringify(
        {
          exists: true,
          company: {
            name: workspaceName,
            description: answers.description,
            goals: answers.goals || "",
            teamSize: answers.teamSize,
            priority: answers.priority || "",
          },
          setupDate: workspaceConfig.setupDate,
        },
        null,
        2
      )
    );

    // 2. Bootstrap root cabinet structure (cabinet protocol compliance)
    await scaffoldCabinet(DATA_DIR, {
      name: workspaceName,
      kind: "root",
      description: answers.description,
      body: answers.description,
      tags: [roomType],
      skipExisting: true,
      locale: body.locale,
    });

    // 3. Mark onboarding as complete
    await fs.writeFile(
      path.join(CONFIG_DIR, "onboarding-complete.json"),
      JSON.stringify({ completed: true, date: new Date().toISOString() })
    );

    // Also write the old-format config so existing config check works
    await fs.writeFile(
      path.join(CONFIG_DIR, "../.config.json"),
      JSON.stringify({ exists: true })
    ).catch(() => {});

    // 4. Instantiate selected agents from library templates
    for (const slug of selectedAgents) {
      const templateDir = path.join(libraryDir, slug);
      const targetDir = path.join(AGENTS_DIR, slug);

      try {
        await fs.access(templateDir);
      } catch {
        if (mandatorySlugs.includes(slug)) {
          return NextResponse.json(
            { error: `Required agent template "${slug}" is unavailable` },
            { status: 500 }
          );
        }
        continue; // Template doesn't exist, skip
      }

      // Skip if agent already exists
      try {
        await fs.access(targetDir);
        continue;
      } catch {
        // Good, doesn't exist
      }

      // Copy template
      await copyDir(templateDir, targetDir);
      await ensureAgentScaffold(targetDir);

      // Inject context into persona.md. Substitutes both variable families so
      // new personas (using workspace_*) and legacy ones (using company_*) both work.
      const personaPath = path.join(targetDir, "persona.md");
      try {
        const raw = await fs.readFile(personaPath, "utf-8");
        const injected = raw
          .replace(/\{\{company_name\}\}/g, workspaceName)
          .replace(/\{\{workspace_name\}\}/g, workspaceName)
          .replace(/\{\{company_description\}\}/g, answers.description || "")
          .replace(/\{\{workspace_description\}\}/g, answers.description || "")
          .replace(/\{\{home_name\}\}/g, homeName)
          .replace(/\{\{goals\}\}/g, answers.goals || answers.priority || "");
        await fs.writeFile(personaPath, injected);
      } catch {
        // Ignore injection errors
      }
    }

    // 4b. Create the user's first agent (configured from scratch in the team
    // step). We write persona.md directly — like the library templates above —
    // so it doesn't depend on a configured provider (the user may skip provider
    // setup). The agent simply won't run until a provider is connected.
    let firstAgentSlug = "";
    const firstAgent = body.firstAgent;
    if (firstAgent && typeof firstAgent.name === "string" && firstAgent.name.trim()) {
      const agentName = firstAgent.name.trim();
      const slug =
        agentName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "") ||
        "agent";
      const agentDir = path.join(AGENTS_DIR, slug);
      let exists = false;
      try {
        await fs.access(agentDir);
        exists = true;
      } catch {
        // Doesn't exist yet — good.
      }
      if (!exists) {
        await fs.mkdir(agentDir, { recursive: true });
        const personaBody =
          (firstAgent.instructions || "").trim() || `You are ${agentName}.`;
        const personaMd = matter.stringify(`\n${personaBody}\n`, {
          name: agentName,
          slug,
          emoji: "🤖",
          type: "specialist",
          role: (firstAgent.role || "").trim(),
          provider: firstAgent.provider?.trim() || "claude-code",
          heartbeat: "",
          heartbeatEnabled: false,
          budget: 100,
          active: true,
          workdir: "/data",
          workspace: "/",
          channels: ["general"],
          focus: [],
        });
        await fs.writeFile(path.join(agentDir, "persona.md"), personaMd);
        await ensureAgentScaffold(agentDir);
        firstAgentSlug = slug;
      }
    }

    // 5. Create chat channels from all agent channel references
    await fs.mkdir(CHAT_DIR, { recursive: true });

    // Collect all channels referenced by agents + map members
    const channelMembers = new Map<string, Set<string>>();
    // Always create #general with the created agents.
    channelMembers.set(
      "general",
      new Set(firstAgentSlug ? [...selectedAgents, firstAgentSlug] : selectedAgents)
    );

    for (const slug of selectedAgents) {
      try {
        const personaPath = path.join(AGENTS_DIR, slug, "persona.md");
        const raw = await fs.readFile(personaPath, "utf-8");
        const { data } = matter(raw);
        const agentChannels = (data.channels as string[]) || [];
        for (const ch of agentChannels) {
          if (!channelMembers.has(ch)) {
            channelMembers.set(ch, new Set());
          }
          channelMembers.get(ch)!.add(slug);
        }
        // Also add leadership agents to all channels
        if (data.type === "lead") {
          for (const [, members] of channelMembers) {
            members.add(slug);
          }
        }
      } catch {
        // Skip
      }
    }

    const channelDescriptions: Record<string, string> = {
      general: "Shared space for announcements and discussion",
      leadership: "Strategic planning and goal setting",
      marketing: "Marketing campaigns, content, and SEO",
      content: "Content creation, editing, and review",
      sales: "Lead generation, outreach, and deals",
      engineering: "Technical work and code quality",
      notes: "PKM curation, links, and indexes",
      writing: "Drafting, editing, and review",
      inbox: "Email triage and drafts",
      calendar: "Scheduling and reminders",
      habits: "Habit tracking and reflection",
      tools: "Small scripts, dashboards, and plugins",
      research: "Research agenda and paper reviews",
      teaching: "Lecture prep, slides, problem sets",
      schedule: "Family calendar and logistics",
      meals: "Meal planning and grocery lists",
      kids: "Kids' schedules, activities, and projects",
      household: "Household coordination and admin",
    };

    const channels = Array.from(channelMembers.entries()).map(
      ([slug, members]) => ({
        slug,
        name: slug.charAt(0).toUpperCase() + slug.slice(1),
        members: Array.from(members),
        description:
          channelDescriptions[slug] || `${slug} channel`,
      })
    );

    await fs.writeFile(
      path.join(CHAT_DIR, "channels.json"),
      JSON.stringify(channels, null, 2)
    );

    // Create channel directories
    for (const ch of channels) {
      const chDir = path.join(CHAT_DIR, ch.slug);
      await fs.mkdir(chDir, { recursive: true });
      // Only create files if they don't exist (don't wipe existing messages)
      const msgPath = path.join(chDir, "messages.md");
      const pinPath = path.join(chDir, "pins.json");
      await fs.writeFile(msgPath, "", { flag: "wx" }).catch(() => {});
      await fs.writeFile(pinPath, JSON.stringify([]), { flag: "wx" }).catch(() => {});
    }

    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}
