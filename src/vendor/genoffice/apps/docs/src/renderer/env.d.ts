// Cabinet adaptation: upstream declares the full Electron DesktopApi on
// Window. The vendored editor only touches `window.desktop?.copyImageToClipboard`
// and `window.desktop.onLanguageChanged` (both absent in a plain browser), so
// the ambient declaration here is the minimal optional shape.
declare global {
  interface Window {
    // Required like upstream's declaration: the only unguarded access is in
    // LocaleProvider, which the Cabinet frame never mounts.
    desktop: {
      copyImageToClipboard?: (dataUrl: string, metaJson?: string) => Promise<boolean>;
      onLanguageChanged: (listener: (lang: import('@genoffice/i18n').Lang) => void) => void;
    };
  }
}

export {};
