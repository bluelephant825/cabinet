"use client";

import { useEffect, useState } from "react";
import { Loader2, ArrowLeft, Tv, ExternalLink, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface SlidevViewerProps {
  filePath: string;
  onExit: () => void;
}

export function SlidevViewer({ filePath, onExit }: SlidevViewerProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [focusToggle, setFocusToggle] = useState(false);

  useEffect(() => {
    const handleReflow = () => {
      if (document.visibilityState === "visible") {
        setFocusToggle((f) => !f);
      }
    };

    window.addEventListener("focus", handleReflow);
    document.addEventListener("visibilitychange", handleReflow);
    return () => {
      window.removeEventListener("focus", handleReflow);
      document.removeEventListener("visibilitychange", handleReflow);
    };
  }, []);

  useEffect(() => {
    let active = true;

    async function startServer() {
      try {
        setLoading(true);
        setError(null);
        const res = await fetch("/api/slidev/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filePath })
        });
        const data = await res.json();
        if (!active) return;
        
        if (data.error) {
          throw new Error(data.error);
        }
        setUrl(data.url);
        setLoading(false);
      } catch (err) {
        if (!active) return;
        const msg = err instanceof Error ? err.message : "Failed to start presentation server.";
        setError(msg);
        setLoading(false);
      }
    }
    
    startServer();

    return () => {
      active = false;
      // Tell the daemon to terminate this file's Slidev server
      fetch("/api/slidev/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath })
      }).catch((e) => console.error("[SlidevViewer] cleanup failed:", e));
    };
  }, [filePath]);

  const handleRefresh = () => {
    setReloadKey((prev) => prev + 1);
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-zinc-950 text-white select-none overflow-hidden animate-in fade-in duration-300">
      {/* Sleek Dark Header */}
      <div className="h-14 border-b border-zinc-800/80 bg-zinc-900/90 backdrop-blur-md flex items-center justify-between px-6 z-10">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={onExit}
            className="text-zinc-400 hover:text-white hover:bg-zinc-800/70 transition-all rounded-lg"
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Editor
          </Button>
          <span className="h-5 w-[1px] bg-zinc-800" />
          <div className="flex items-center gap-2.5 text-sm text-zinc-200 font-semibold tracking-wide">
            <Tv className="h-4 w-4 text-purple-400 animate-pulse" />
            <span>Slidev Presentation</span>
          </div>
        </div>

        {url && (
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={handleRefresh}
              title="Reload Frame"
              className="text-zinc-400 hover:text-white hover:bg-zinc-800/70 h-8 w-8 rounded-lg"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.open(`${url}/presenter`, "_blank")}
              className="text-xs text-zinc-300 hover:text-white border-zinc-700 hover:bg-zinc-800/60 bg-transparent rounded-lg px-3 py-1.5 font-medium transition-all"
            >
              Presenter View
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.open(url, "_blank")}
              className="text-xs text-zinc-300 hover:text-white border-zinc-700 hover:bg-zinc-800/60 bg-transparent rounded-lg px-3 py-1.5 font-medium transition-all flex items-center gap-1.5"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open in Browser
            </Button>
          </div>
        )}
      </div>

      {/* Frame Container */}
      <div className="flex-1 relative flex items-center justify-center bg-zinc-950">
        {loading && (
          <div className="flex flex-col items-center gap-4 animate-in fade-in zoom-in-95 duration-200">
            <div className="p-4 rounded-full bg-purple-500/10 border border-purple-500/20">
              <Loader2 className="h-8 w-8 animate-spin text-purple-400" />
            </div>
            <div className="text-center space-y-1">
              <p className="text-zinc-200 font-semibold text-sm">Launching Slidev Server</p>
              <p className="text-zinc-500 text-xs max-w-[280px]">Compiling your markdown slides, this may take a few seconds...</p>
            </div>
          </div>
        )}

        {error && (
          <div className="text-center p-8 max-w-md border border-zinc-800 bg-zinc-900/40 backdrop-blur-sm rounded-2xl animate-in fade-in zoom-in-95 duration-200">
            <p className="text-rose-500 font-semibold text-base mb-2">Failed to start Slidev</p>
            <p className="text-zinc-400 text-sm mb-6 leading-relaxed">{error}</p>
            <div className="flex justify-center gap-3">
              <Button variant="outline" onClick={onExit} className="border-zinc-700 text-zinc-300 hover:bg-zinc-800">
                Close
              </Button>
            </div>
          </div>
        )}

        {!loading && !error && url && (
          <iframe
            key={reloadKey}
            src={url}
            style={{
              width: focusToggle ? "100%" : "calc(100% - 0.2px)",
              height: focusToggle ? "100%" : "calc(100% - 0.2px)",
            }}
            className="absolute inset-0 border-none bg-zinc-950 animate-in fade-in duration-500"
            allow="fullscreen; clipboard-write"
          />
        )}
      </div>
    </div>
  );
}
