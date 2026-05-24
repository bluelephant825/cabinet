import { NextRequest, NextResponse } from "next/server";
import {
  listRooms,
  resolveDefaultRoom,
  updateRoomMeta,
} from "@/lib/cabinets/rooms";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [rooms, defaultRoom] = await Promise.all([
      listRooms(),
      resolveDefaultRoom(),
    ]);
    return NextResponse.json({ rooms, defaultRoom });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      path?: unknown;
      name?: unknown;
      icon?: unknown;
      theme?: unknown;
      color?: unknown;
    };

    if (typeof body.path !== "string") {
      return NextResponse.json({ error: "path is required" }, { status: 400 });
    }

    const room = await updateRoomMeta(body.path, {
      name: typeof body.name === "string" ? body.name : undefined,
      icon:
        body.icon === null
          ? null
          : typeof body.icon === "string"
            ? body.icon
            : undefined,
      theme:
        body.theme === null
          ? null
          : typeof body.theme === "string"
            ? body.theme
            : undefined,
      color:
        body.color === null
          ? null
          : typeof body.color === "string"
            ? body.color
            : undefined,
    });

    return NextResponse.json({ room });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message.includes("invalid") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
