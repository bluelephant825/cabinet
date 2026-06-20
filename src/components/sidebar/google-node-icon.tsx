import { FileText, Presentation, Sheet } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Icon for a Google Workspace pointer file (Docs/Sheets/Slides) in the tree:
 * a colored lucide glyph with a small "g" badge. Shared by the regular tree
 * (tree-node) and the Drive browser (google-drive-tree) so native docs render
 * identically wherever they appear.
 */
export function GoogleNodeIcon({ kind }: { kind?: string }) {
  const Icon =
    kind === "sheets" ? Sheet : kind === "slides" ? Presentation : FileText;
  const color =
    kind === "sheets"
      ? "text-green-600"
      : kind === "slides"
        ? "text-yellow-500"
        : "text-blue-500";
  return (
    <span className="relative inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">
      <Icon className={cn("h-3.5 w-3.5", color)} />
      <span className="absolute -bottom-1.5 -end-1.5 rounded-[3px] bg-background px-[1.5px] text-[8px] font-bold leading-[1.2] text-foreground/70">
        g
      </span>
    </span>
  );
}
