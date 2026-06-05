"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import {
  PREVIEW_INTEGRATIONS,
  INTEGRATION_BY_ID,
  filterIntegrations,
} from "@/lib/integrations/preview-catalog";
import { IntegrationDetailPage } from "@/components/integrations/hub/integration-detail-page";
import { LayoutGallery } from "@/components/integrations/hub/layouts/layout-gallery";

/**
 * The full-page Integrations Hub: a premium "logo wall" gallery of connectors
 * grouped by category, searchable, with implemented connectors crisp and
 * not-yet-built ones dimmed. Clicking a connector opens its full-page
 * configuration view (no modal).
 */
export function IntegrationsHubPage() {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const filtered = useMemo(
    () => filterIntegrations(PREVIEW_INTEGRATIONS, query),
    [query],
  );

  const selected = selectedId ? INTEGRATION_BY_ID[selectedId] : null;
  if (selected) {
    return (
      <IntegrationDetailPage item={selected} onBack={() => setSelectedId(null)} />
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header — inner content sits in the same max-width column as the
          gallery below, so the title + search line up with the cards and the
          floating sidebar toggle gets its own room in the corner. */}
      <header className="shrink-0 border-b border-border">
        <div className="mx-auto flex max-w-6xl items-start justify-between gap-4 px-6 pt-5 pb-4">
          {/* Title block */}
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              Integrations
            </h1>
            <p className="mt-1 text-[13px] text-muted-foreground">
              Connect Cabinet to everything that runs your work — your agents can act on all of it.
            </p>
          </div>

          {/* Search — top right */}
          <div className="relative w-44 shrink-0 sm:w-64">
            <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/50" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search integrations…"
              className="h-9 w-full rounded-lg border border-border bg-card ps-9 pe-3 text-[13px] text-foreground placeholder:text-muted-foreground/60 outline-none transition-colors focus:border-foreground/20"
            />
          </div>
        </div>
      </header>

      {/* Gallery (owns its own scroll) */}
      <div className="min-h-0 flex-1">
        <LayoutGallery items={filtered} onOpen={(id) => setSelectedId(id)} />
      </div>
    </div>
  );
}
