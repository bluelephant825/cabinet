"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { loader, type OnMount } from "@monaco-editor/react";
import { Check, Code2, Copy, Download, ExternalLink, Eye, Save, WrapText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ViewerToolbar } from "@/components/layout/viewer-toolbar";
import { ViewerLayout } from "@/components/layout/viewer-layout";
import { ToolbarButton } from "@/components/layout/toolbar-button";
import { useTheme } from "@/components/theme-provider";
import { useEditorSettings } from "@/hooks/use-editor-settings";
import { useLocale } from "@/i18n/use-locale";
import {
  HTML_VIEW_EVENT,
  getHtmlViewMode,
  isHtmlPath,
  setHtmlViewMode,
  type HtmlViewModeDetail,
} from "@/lib/ui/html-view-mode";

if (typeof window !== "undefined") {
  loader.config({ paths: { vs: "/monaco/vs" } });
}

interface SourceViewerProps {
  path: string;
  title: string;
}

const EXT_TO_LANG: Record<string, string> = {
  ".js": "javascript", ".cjs": "javascript", ".mjs": "javascript",
  ".ts": "typescript", ".tsx": "typescript", ".jsx": "javascript",
  ".py": "python", ".rb": "ruby", ".php": "php",
  ".sh": "shell", ".bash": "shell", ".zsh": "shell", ".ps1": "powershell",
  ".css": "css", ".scss": "scss", ".html": "html", ".htm": "html",
  ".json": "json", ".jsonc": "json",
  ".yaml": "yaml", ".yml": "yaml", ".toml": "ini", ".ini": "ini",
  ".xml": "xml", ".sql": "sql", ".graphql": "graphql", ".gql": "graphql",
  ".go": "go", ".rs": "rust", ".swift": "swift",
  ".java": "java", ".kt": "kotlin", ".kts": "kotlin",
  ".c": "c", ".cpp": "cpp", ".h": "c",
  ".env": "shell",
  ".txt": "plaintext", ".text": "plaintext", ".log": "plaintext", ".rst": "plaintext",
  ".mdx": "markdown",
};

export function detectSourceLanguage(filename: string): string {
  const ext = filename.includes(".") ? `.${filename.split(".").pop()!.toLowerCase()}` : "";
  return EXT_TO_LANG[ext] ?? "plaintext";
}

function formatBadge(filename: string): string {
  return filename.includes(".") ? filename.split(".").pop()!.toUpperCase() : "TEXT";
}

export function SourceViewer({ path }: SourceViewerProps) {
  const { t } = useLocale();
  const { resolvedTheme } = useTheme();
  const settings = useEditorSettings();
  const [content, setContent] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const assetUrl = `/api/assets/${path.split("/").map(encodeURIComponent).join("/")}`;
  const filename = path.split("/").pop() || path;
  const language = detectSourceLanguage(filename);
  const isHtml = isHtmlPath(path);
  const [mode, setMode] = useState<"preview" | "source">(() =>
    isHtml ? getHtmlViewMode(path) : "source"
  );

  useEffect(() => {
    setMode(isHtml ? getHtmlViewMode(path) : "source");
  }, [path, isHtml]);

  useEffect(() => {
    if (!isHtml) return;
    const onExternalChange = (event: Event) => {
      const detail = (event as CustomEvent<HtmlViewModeDetail>).detail;
      if (detail?.path === path) setMode(detail.mode);
    };
    window.addEventListener(HTML_VIEW_EVENT, onExternalChange);
    return () => window.removeEventListener(HTML_VIEW_EVENT, onExternalChange);
  }, [path, isHtml]);

  const showPreview = isHtml && mode === "preview";
  const editorTheme = settings.theme === "app"
    ? (resolvedTheme === "dark" ? "vs-dark" : "light")
    : settings.theme;

  const fetchContent = useCallback(async () => {
    setLoading(true);
    setSaveError(null);
    try {
      const response = await fetch(assetUrl);
      if (!response.ok) throw new Error(`Load failed: ${response.status}`);
      const text = await response.text();
      setContent(text);
      setDraft(text);
      setDirty(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Unable to load file");
    } finally {
      setLoading(false);
    }
  }, [assetUrl]);

  useEffect(() => {
    void fetchContent();
  }, [fetchContent]);

  const save = useCallback(async (value = draft) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      const response = await fetch(assetUrl, {
        method: "PUT",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: value,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error || `Save failed: ${response.status}`);
      }
      setContent(value);
      setDraft(value);
      setDirty(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Unable to save file");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [assetUrl, draft]);
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  const handleMount: OnMount = useCallback((editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void saveRef.current(editor.getValue());
    });
  }, []);

  const copyToClipboard = () => {
    void navigator.clipboard.writeText(draft);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <ViewerLayout
      toolbar={
        <ViewerToolbar
          path={path}
          badge={showPreview ? "HTML" : formatBadge(filename)}
          sublabel={showPreview ? "webpage" : language}
        >
          {dirty && !showPreview && (
            <ToolbarButton
              icon={Save}
              label={saving ? "Saving..." : "Save"}
              disabled={saving}
              onClick={() => void save()}
              title={saveError || "Save changes"}
            />
          )}
          {isHtml && (
            <div className="mr-1 inline-flex items-center rounded-md border border-border p-0.5">
              <Button
                variant="ghost"
                size="sm"
                className={`h-6 gap-1 px-2 text-xs ${showPreview ? "bg-muted text-foreground" : "text-muted-foreground"}`}
                onClick={() => setHtmlViewMode(path, "preview")}
                title="Render as a webpage"
                aria-pressed={showPreview}
              >
                <Eye className="h-3.5 w-3.5" />
                Preview
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={`h-6 gap-1 px-2 text-xs ${!showPreview ? "bg-muted text-foreground" : "text-muted-foreground"}`}
                onClick={() => setHtmlViewMode(path, "source")}
                title="Edit the HTML source"
                aria-pressed={!showPreview}
              >
                <Code2 className="h-3.5 w-3.5" />
                Source
              </Button>
            </div>
          )}
          {!showPreview && (
            <ToolbarButton
              icon={WrapText}
              label="Wrap"
              iconOnly
              active={wrap}
              onClick={() => setWrap((value) => !value)}
              title={wrap ? "Disable line wrap" : "Enable line wrap"}
            />
          )}
          {!showPreview && (
            <ToolbarButton
              icon={copied ? Check : Copy}
              label={copied ? "Copied" : "Copy"}
              iconOnly
              onClick={copyToClipboard}
              title={t("sourceViewer:copyContents")}
            />
          )}
          <ToolbarButton
            icon={Download}
            label="Download"
            iconOnly
            title={t("sourceViewer:downloadFile")}
            href={assetUrl}
            download={filename}
          />
          <ToolbarButton
            icon={ExternalLink}
            label="Raw"
            iconOnly
            href={assetUrl}
            target="_blank"
          />
        </ViewerToolbar>
      }
    >
      {showPreview ? (
        <iframe
          src={assetUrl}
          key={content ?? "loading"}
          title={filename}
          className="flex-1 w-full border-0 bg-white"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-top-navigation-by-user-activation"
        />
      ) : loading ? (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          Loading...
        </div>
      ) : (
        <div className="relative flex-1 min-h-0 overflow-hidden bg-background">
          <Editor
            height="100%"
            path={path}
            language={language}
            theme={editorTheme}
            value={draft}
            onChange={(value) => {
              const next = value ?? "";
              setDraft(next);
              setDirty(next !== content);
              setSaveError(null);
            }}
            onMount={handleMount}
            loading={<div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading editor...</div>}
            options={{
              automaticLayout: true,
              fontFamily: settings.fontFamily,
              fontLigatures: settings.fontLigatures,
              fontSize: settings.fontSize,
              fontWeight: settings.fontWeight,
              lineHeight: settings.lineHeight,
              minimap: { enabled: settings.minimap },
              wordWrap: wrap ? "on" : "off",
              scrollBeyondLastLine: false,
              tabSize: settings.tabSize,
            }}
          />
          {saveError && (
            <div role="alert" className="absolute bottom-3 right-3 max-w-sm rounded-md border border-destructive/40 bg-background px-3 py-2 text-xs text-destructive shadow-md">
              {saveError}
            </div>
          )}
        </div>
      )}
    </ViewerLayout>
  );
}
