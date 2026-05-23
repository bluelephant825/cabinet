"use client";

import { useEffect, useState } from "react";
import { ChevronDown, Plus, Check, ExternalLink, Pencil } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuGroup,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app-store";
import { useRoomsStore, type RoomMetaClient } from "@/stores/rooms-store";
import { ROOT_CABINET_PATH } from "@/lib/cabinets/paths";
import { RoomAvatar } from "@/lib/cabinets/room-icons";
import { openRoomWindow } from "@/lib/cabinets/room-window";
import { useLocale } from "@/i18n/use-locale";
import { NewCabinetDialog } from "./new-cabinet-dialog";
import { RoomEditDialog } from "./room-edit-dialog";

/**
 * The home-button room switcher: a Notion-style dropdown next to the logo that
 * shows the current room (icon + name) and lets you switch, customize, add, or
 * open any room in its own window (Electron + web).
 */
export function RoomSwitcher() {
  const { t } = useLocale();
  const section = useAppStore((s) => s.section);
  const setSection = useAppStore((s) => s.setSection);
  const rooms = useRoomsStore((s) => s.rooms);
  const load = useRoomsStore((s) => s.load);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<RoomMetaClient | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  const activePath = section.cabinetPath || ROOT_CABINET_PATH;
  // Rooms are top-level cabinets, so a deep path resolves to its first segment.
  const activeTop =
    activePath === ROOT_CABINET_PATH ? ROOT_CABINET_PATH : activePath.split("/")[0];
  const rootRoom = rooms.find((r) => r.isRoot) ?? null;
  const active = rooms.find((r) => r.path === activeTop) ?? rootRoom;

  function switchTo(room: RoomMetaClient) {
    if (room.isRoot) {
      setSection({ type: "home", cabinetPath: ROOT_CABINET_PATH });
    } else {
      setSection({ type: "cabinet", cabinetPath: room.path });
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          title={active?.name || t("rooms:switcherTitle")}
          aria-label={t("rooms:switcherTitle")}
          className={cn(
            "group flex shrink-0 items-center gap-0.5 rounded-md p-1 cursor-pointer",
            "transition-colors hover:bg-accent/60 data-[popup-open]:bg-accent/60"
          )}
        >
          <RoomAvatar
            name={active?.name ?? ""}
            iconKey={active?.icon}
            color={active?.color}
            colorKey={active?.path ?? ""}
            className="size-6"
          />
          <ChevronDown className="size-3 shrink-0 text-muted-foreground/70" />
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" sideOffset={6} className="w-64">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t("rooms:switchRoom")}</DropdownMenuLabel>
            {rooms.map((room) => {
              const isActive = room.path === activeTop;
              return (
                <DropdownMenuItem
                  key={room.path}
                  onClick={() => switchTo(room)}
                  className="gap-2"
                >
                  <RoomAvatar
                    name={room.name}
                    iconKey={room.icon}
                    color={room.color}
                    colorKey={room.path}
                    className="size-5"
                  />
                  <span className="min-w-0 flex-1 truncate">{room.name}</span>
                  {isActive && <Check className="text-foreground" />}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuGroup>

          <DropdownMenuSeparator />

          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-2">
              <ExternalLink className="text-muted-foreground" />
              <span className="flex-1">{t("rooms:openInNewWindow")}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-56">
              {rooms.map((room) => (
                <DropdownMenuItem
                  key={room.path}
                  onClick={() => openRoomWindow(room.path)}
                  className="gap-2"
                >
                  <RoomAvatar
                    name={room.name}
                    iconKey={room.icon}
                    color={room.color}
                    colorKey={room.path}
                    className="size-5"
                  />
                  <span className="min-w-0 flex-1 truncate">{room.name}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSeparator />

          {active && (
            <DropdownMenuItem onClick={() => setEditing(active)} className="gap-2">
              <Pencil className="text-muted-foreground" />
              {t("rooms:customizeRoom")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => setAddOpen(true)} className="gap-2">
            <Plus className="text-muted-foreground" />
            {t("rooms:addRoom")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {addOpen && (
        <NewCabinetDialog
          open={addOpen}
          onOpenChange={(open) => {
            setAddOpen(open);
            if (!open) void load(true);
          }}
          parentPath=""
        />
      )}

      {editing && (
        <RoomEditDialog
          room={editing}
          onClose={() => setEditing(null)}
          onSaved={() => void load(true)}
        />
      )}
    </>
  );
}
