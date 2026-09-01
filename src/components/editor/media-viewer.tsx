"use client";

import { useRef, useState } from "react";
import {
  Download,
  ExternalLink,
  FastForward,
  Pause,
  Play,
  Rewind,
} from "lucide-react";
import { ViewerToolbar } from "@/components/layout/viewer-toolbar";
import { ViewerLayout } from "@/components/layout/viewer-layout";
import { ToolbarButton } from "@/components/layout/toolbar-button";
import { assetUrlFor } from "@/lib/cabinets/asset-url";
import {
  clampMediaTime,
  formatMediaTime,
  mediaErrorMessage,
  nextPlaybackRate,
} from "./media-player-utils";

interface MediaViewerProps {
  path: string;
  title: string;
  type: "video" | "audio";
}

export function MediaViewer({ path, title, type }: MediaViewerProps) {
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const src = assetUrlFor(path);
  const filename = path.split("/").pop() || path;
  const ext = filename.includes(".")
    ? filename.split(".").pop()!.toUpperCase()
    : type.toUpperCase();

  const togglePlayback = async () => {
    const media = mediaRef.current;
    if (!media) return;
    setError(null);
    if (!media.paused) {
      media.pause();
      return;
    }
    try {
      await media.play();
    } catch {
      setError("Playback could not start. Try again or open the file in a new tab.");
    }
  };

  const seekTo = (time: number) => {
    const media = mediaRef.current;
    if (!media) return;
    const nextTime = clampMediaTime(time, media.duration);
    media.currentTime = nextTime;
    setCurrentTime(nextTime);
  };

  const changeRate = () => {
    const media = mediaRef.current;
    if (!media) return;
    const rate = nextPlaybackRate(media.playbackRate);
    media.playbackRate = rate;
    setPlaybackRate(rate);
  };

  const mediaEvents = {
    onLoadedMetadata: () => {
      const media = mediaRef.current;
      if (!media) return;
      setDuration(Number.isFinite(media.duration) ? media.duration : 0);
      setError(null);
    },
    onDurationChange: () => {
      const media = mediaRef.current;
      if (media) setDuration(Number.isFinite(media.duration) ? media.duration : 0);
    },
    onTimeUpdate: () => setCurrentTime(mediaRef.current?.currentTime || 0),
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onRateChange: () => setPlaybackRate(mediaRef.current?.playbackRate || 1),
    onEnded: () => setPlaying(false),
    onError: () => {
      setPlaying(false);
      setError(mediaErrorMessage(mediaRef.current?.error?.code));
    },
  };

  return (
    <ViewerLayout
      toolbar={
        <ViewerToolbar path={path} badge={ext}>
          <ToolbarButton
            icon={Download}
            label="Download"
            href={src}
            download={filename}
          />
          <ToolbarButton
            icon={ExternalLink}
            label="Open in new tab"
            iconOnly
            href={src}
            target="_blank"
          />
        </ViewerToolbar>
      }
    >
      <div className="flex flex-1 items-center justify-center overflow-auto bg-[#1a1a1a] p-8">
        <div className="flex w-full max-w-4xl flex-col gap-4">
          {type === "video" ? (
            <video
              ref={(node) => {
                mediaRef.current = node;
              }}
              src={src}
              preload="metadata"
              className="max-h-[calc(100vh-13rem)] w-full rounded-md bg-black object-contain shadow-lg"
              onClick={() => void togglePlayback()}
              {...mediaEvents}
            >
              Your browser does not support the video element.
            </video>
          ) : (
            <audio
              ref={(node) => {
                mediaRef.current = node;
              }}
              src={src}
              preload="metadata"
              {...mediaEvents}
            >
              Your browser does not support the audio element.
            </audio>
          )}

          <div className="rounded-lg border border-white/10 bg-black/35 p-3 text-neutral-100 shadow-lg">
            <div className="mb-3 truncate text-sm font-medium" title={title}>
              {title}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void togglePlayback()}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-black transition-colors hover:bg-neutral-200"
                aria-label={playing ? "Pause" : "Play"}
              >
                {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              </button>
              <button
                type="button"
                onClick={() => seekTo(currentTime - 10)}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-300 hover:bg-white/10 hover:text-white"
                aria-label="Back 10 seconds"
                title="Back 10 seconds"
              >
                <Rewind className="h-4 w-4" />
              </button>
              <span className="w-11 text-right font-mono text-xs tabular-nums text-neutral-300">
                {formatMediaTime(currentTime)}
              </span>
              <input
                type="range"
                min={0}
                max={duration || 0}
                step="0.1"
                value={clampMediaTime(currentTime, duration)}
                onChange={(event) => seekTo(Number(event.target.value))}
                disabled={duration <= 0}
                className="h-1 min-w-0 flex-1 cursor-pointer accent-white disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Seek"
                aria-valuetext={`${formatMediaTime(currentTime)} of ${formatMediaTime(duration)}`}
              />
              <span className="w-11 font-mono text-xs tabular-nums text-neutral-300">
                {formatMediaTime(duration)}
              </span>
              <button
                type="button"
                onClick={() => seekTo(currentTime + 10)}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-300 hover:bg-white/10 hover:text-white"
                aria-label="Forward 10 seconds"
                title="Forward 10 seconds"
              >
                <FastForward className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={changeRate}
                className="h-8 min-w-12 shrink-0 rounded-md px-2 text-xs font-medium text-neutral-300 hover:bg-white/10 hover:text-white"
                aria-label={`Playback speed ${playbackRate} times`}
                title="Change playback speed"
              >
                {playbackRate}x
              </button>
            </div>
            {error ? (
              <p className="mt-3 text-sm text-red-300" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </ViewerLayout>
  );
}
