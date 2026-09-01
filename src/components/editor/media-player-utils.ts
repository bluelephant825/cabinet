export const PLAYBACK_RATES = [0.5, 1, 1.25, 1.5, 2] as const;

export function formatMediaTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const wholeSeconds = Math.floor(seconds);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const remainder = wholeSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  }
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export function clampMediaTime(time: number, duration: number): number {
  const safeTime = Number.isFinite(time) ? time : 0;
  if (!Number.isFinite(duration) || duration < 0) return Math.max(0, safeTime);
  return Math.min(duration, Math.max(0, safeTime));
}

export function nextPlaybackRate(current: number): number {
  const index = PLAYBACK_RATES.findIndex((rate) => rate > current + 0.001);
  return index === -1 ? PLAYBACK_RATES[0] : PLAYBACK_RATES[index];
}

export function mediaErrorMessage(code?: number): string {
  switch (code) {
    case 1:
      return "Playback was stopped before the media finished loading.";
    case 2:
      return "The media could not be loaded because of a network error.";
    case 3:
      return "This media file could not be decoded.";
    case 4:
      return "This media format is not supported by your browser.";
    default:
      return "The media could not be played.";
  }
}
