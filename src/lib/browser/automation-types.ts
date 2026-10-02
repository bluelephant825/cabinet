export const ALOHAJET_VERSION = "0.4.4";

export type BrowserAutomationSettings = {
  enabled: boolean;
  maxObservationTokens: number;
  compactTools: boolean;
};

export type BrowserAutomationStatus = {
  enabled: boolean;
  supported: boolean;
  installed: boolean;
  installing: boolean;
  platform: string;
  version: string;
  source: "managed" | "override" | null;
  maxObservationTokens: number;
  compactTools: boolean;
  error?: string;
};

export const DEFAULT_BROWSER_AUTOMATION_SETTINGS: BrowserAutomationSettings = {
  enabled: false,
  maxObservationTokens: 8000,
  compactTools: false,
};
