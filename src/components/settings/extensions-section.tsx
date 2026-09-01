"use client";

import { useCallback, useEffect, useState } from "react";
import { Blocks, Loader2, Settings, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { showError } from "@/lib/ui/toast";
import { useAppStore } from "@/stores/app-store";

interface BrowserExtension {
  id: string;
  name: string;
  version: string;
  description?: string;
  enabled?: boolean;
  iconDataUrl?: string | null;
  runtimeId?: string;
  optionsPage?: string | null;
}

interface ExtensionResult {
  ok: boolean;
  extension?: BrowserExtension;
  error?: string;
}

interface ExtensionsBridge {
  getExtensions?: () => Promise<BrowserExtension[]>;
  installExtension?: (urlOrId: string) => Promise<ExtensionResult>;
  uninstallExtension?: (id: string) => Promise<ExtensionResult>;
  toggleExtension?: (id: string, enabled: boolean) => Promise<ExtensionResult>;
  onExtensionInstalled?: (listener: (extension: BrowserExtension) => void) => () => void;
}

function desktopBridge(): ExtensionsBridge | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { CabinetDesktop?: ExtensionsBridge }).CabinetDesktop ?? null;
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function ExtensionsSection() {
  const [extensions, setExtensions] = useState<BrowserExtension[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);

  const loadExtensions = useCallback(async () => {
    try {
      setExtensions((await desktopBridge()?.getExtensions?.()) ?? []);
    } catch (error) {
      showError(errorText(error, "Failed to load extensions"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadExtensions();
    const unsubscribe = desktopBridge()?.onExtensionInstalled?.((extension) => {
      setExtensions((previous) => [
        ...previous.filter((item) => item.id !== extension.id),
        extension,
      ]);
    });
    return unsubscribe;
  }, [loadExtensions]);

  const install = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = input.trim();
    const bridge = desktopBridge();
    if (!value || !bridge?.installExtension) {
      showError("Extension management is available in the Cabinet desktop app.");
      return;
    }
    setInstalling(true);
    try {
      const result = await bridge.installExtension(value);
      if (!result.ok || !result.extension) {
        showError(result.error || "Failed to install extension");
        return;
      }
      setInput("");
      await loadExtensions();
      window.dispatchEvent(
        new CustomEvent("cabinet:toast", {
          detail: { kind: "success", message: `Extension installed: ${result.extension.name}` },
        })
      );
    } catch (error) {
      showError(errorText(error, "Failed to install extension"));
    } finally {
      setInstalling(false);
    }
  };

  const toggle = async (extension: BrowserExtension, enabled: boolean) => {
    const result = await desktopBridge()?.toggleExtension?.(extension.id, enabled);
    if (!result?.ok) {
      showError(result?.error || "Failed to update extension");
      return;
    }
    setExtensions((previous) =>
      previous.map((item) => (item.id === extension.id ? { ...item, enabled } : item))
    );
  };

  const uninstall = async (extension: BrowserExtension) => {
    const result = await desktopBridge()?.uninstallExtension?.(extension.id);
    if (!result?.ok) {
      showError(result?.error || "Failed to remove extension");
      return;
    }
    setExtensions((previous) => previous.filter((item) => item.id !== extension.id));
  };

  const openOptions = (extension: BrowserExtension) => {
    if (!extension.optionsPage) return;
    const runtimeId = extension.runtimeId || extension.id;
    useAppStore.getState().setAppMode(
      "browse",
      `chrome-extension://${runtimeId}/${extension.optionsPage}`
    );
  };

  return (
    <div className="space-y-6">
      <section className="rounded-xl border bg-card p-5 shadow-sm">
        <h3 className="mb-1 flex items-center gap-2 text-[13px] font-semibold">
          <Blocks className="h-4 w-4" />
          Add Chrome extension
        </h3>
        <p className="mb-4 text-[12px] text-muted-foreground">
          Paste a Chrome Web Store URL or a 32-character extension ID.
        </p>
        <form onSubmit={install} className="flex gap-2">
          <Input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Chrome Web Store URL or extension ID"
            disabled={installing}
          />
          <Button type="submit" disabled={installing || !input.trim()}>
            {installing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Install
          </Button>
        </form>
      </section>

      <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <div className="border-b bg-muted/20 p-4 text-[13px] font-semibold">
          Installed extensions
        </div>
        {loading ? (
          <div className="flex justify-center p-8"><Loader2 className="h-5 w-5 animate-spin" /></div>
        ) : extensions.length === 0 ? (
          <div className="p-8 text-center text-[13px] text-muted-foreground">
            No extensions installed.
          </div>
        ) : (
          <div className="divide-y">
            {extensions.map((extension) => (
              <div key={extension.id} className="flex items-start gap-4 p-4">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
                  {extension.iconDataUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- extension icons are data URLs
                    <img src={extension.iconDataUrl} alt="" className="h-8 w-8 object-contain" />
                  ) : (
                    <Blocks className="h-5 w-5 text-muted-foreground" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium">{extension.name}</div>
                  <div className="text-[11px] text-muted-foreground">Version {extension.version}</div>
                  {extension.description ? (
                    <p className="mt-1 line-clamp-2 text-[12px] text-muted-foreground">
                      {extension.description}
                    </p>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  {extension.optionsPage ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={extension.enabled === false}
                      onClick={() => openOptions(extension)}
                      title="Extension options"
                    >
                      <Settings className="h-4 w-4" />
                    </Button>
                  ) : null}
                  <Switch
                    checked={extension.enabled !== false}
                    onCheckedChange={(enabled) => void toggle(extension, enabled)}
                    title={extension.enabled === false ? "Enable extension" : "Disable extension"}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:text-destructive"
                    onClick={() => void uninstall(extension)}
                    title="Remove extension"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
