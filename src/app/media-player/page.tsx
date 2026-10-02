"use client";

import { useSearchParams } from "next/navigation";
import { Loader2, Pause, Play } from "lucide-react";
import { Suspense, useEffect, useRef, useState } from "react";

function formatMediaTime(value: number) {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  const totalSeconds = Math.floor(value);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function AudioPlayer({ src }: { src: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const objectUrlRef = useRef<string | null>(null);
  const sourceVersionRef = useRef(0);
  const retriedBlobRef = useRef(false);
  const retryingRef = useRef(false);
  const [resolvedSrc, setResolvedSrc] = useState(src);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadingFallback, setLoadingFallback] = useState(false);

  useEffect(() => {
    sourceVersionRef.current += 1;
    setResolvedSrc(src);
    setCurrentTime(0);
    setDuration(0);
    setLoadFailed(false);
    setLoadingFallback(false);
    setIsPlaying(false);
    retriedBlobRef.current = false;
    retryingRef.current = false;
    const objectUrl = objectUrlRef.current;
    objectUrlRef.current = null;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    return () => {
      const latest = objectUrlRef.current;
      objectUrlRef.current = null;
      if (latest) URL.revokeObjectURL(latest);
    };
  }, [src]);

  const retryWithBlob = async () => {
    if (retriedBlobRef.current || retryingRef.current) return;
    retriedBlobRef.current = true;
    retryingRef.current = true;
    const sourceVersion = sourceVersionRef.current;
    setLoadingFallback(true);
    try {
      const response = await fetch(src, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Asset request failed (${response.status})`);
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      if (sourceVersion !== sourceVersionRef.current) {
        URL.revokeObjectURL(objectUrl);
        return;
      }
      const previous = objectUrlRef.current;
      objectUrlRef.current = objectUrl;
      if (previous) URL.revokeObjectURL(previous);
      setResolvedSrc(objectUrl);
      setLoadFailed(false);
    } catch {
      if (sourceVersion === sourceVersionRef.current) setLoadFailed(true);
    } finally {
      if (sourceVersion === sourceVersionRef.current) setLoadingFallback(false);
    }
  };

  const togglePlayback = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play().catch(() => setIsPlaying(audio.paused));
      return;
    }
    audio.pause();
  };

  const seek = (value: number) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.duration)) return;
    audio.currentTime = value;
    setCurrentTime(value);
  };

  return (
    <div className="flex w-full max-w-md flex-col items-center gap-6 p-8">
      <div className="flex h-20 w-20 items-center justify-center rounded-full bg-neutral-800 text-3xl shadow-inner">
        🎵
      </div>
      <audio
        ref={audioRef}
        src={resolvedSrc}
        autoPlay
        preload="metadata"
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => setIsPlaying(false)}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onError={() => {
          if (retriedBlobRef.current) {
            setLoadFailed(true);
            return;
          }
          void retryWithBlob();
        }}
      />
      <div className="flex w-full items-center gap-3 rounded-full border border-neutral-800 bg-neutral-900 px-3 py-2">
        <button
          type="button"
          onClick={togglePlayback}
          disabled={loadFailed || loadingFallback}
          aria-label={isPlaying ? "Pause" : "Play"}
          title={isPlaying ? "Pause" : "Play"}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-neutral-950 transition-colors hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loadingFallback ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : isPlaying ? (
            <Pause className="h-4 w-4" fill="currentColor" />
          ) : (
            <Play className="h-4 w-4 translate-x-px" fill="currentColor" />
          )}
        </button>
        <span className="w-10 shrink-0 text-right text-xs tabular-nums text-neutral-400">
          {formatMediaTime(currentTime)}
        </span>
        <input
          type="range"
          min={0}
          max={Number.isFinite(duration) && duration > 0 ? duration : 0}
          step={0.1}
          value={Number.isFinite(duration) && duration > 0 ? Math.min(currentTime, duration) : 0}
          disabled={!Number.isFinite(duration) || duration <= 0}
          onChange={(event) => seek(Number(event.target.value))}
          aria-label="Seek"
          className="min-w-0 flex-1 accent-white disabled:opacity-40"
        />
        <span className="w-10 shrink-0 text-xs tabular-nums text-neutral-400">
          {formatMediaTime(duration)}
        </span>
      </div>
      {loadFailed ? (
        <div className="text-center text-sm text-neutral-400">
          Audio could not be loaded.
        </div>
      ) : null}
    </div>
  );
}

function MediaPlayer() {
  const searchParams = useSearchParams();
  const path = searchParams.get("path") || "";
  const type = searchParams.get("type") || "video";
  const title = searchParams.get("title") || "Media";

  const assetUrl = `/api/assets/${path.split("/").map(encodeURIComponent).join("/")}`;

  return (
    <div className="flex flex-col items-center justify-center w-full h-screen bg-neutral-950 p-6 text-white font-sans">
      <div className="w-full max-w-4xl flex flex-col gap-4">
        <h1 className="text-lg font-medium text-neutral-200">{decodeURIComponent(title)}</h1>
        <div className="relative w-full aspect-video rounded-xl overflow-hidden border border-neutral-800 bg-neutral-900 shadow-2xl flex items-center justify-center">
          {type === "audio" ? (
            <AudioPlayer src={assetUrl} />
          ) : (
            <video controls src={assetUrl} className="w-full h-full object-contain" autoPlay />
          )}
        </div>
      </div>
    </div>
  );
}

export default function MediaPlayerPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center w-full h-screen bg-neutral-950 text-neutral-400">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      }
    >
      <MediaPlayer />
    </Suspense>
  );
}
