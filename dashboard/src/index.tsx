/**
 * Print Jobs — Dashboard Plugin (TypeScript)
 *
 * TypeScript source for the Print Jobs dashboard plugin.
 * Compiles to dist/index.js via `npm run build`.
 *
 * SDK types are declared below based on window.__HERMES_PLUGIN_SDK__.
 */

import React from "react";

// ── SDK type declarations ────────────────────────────────────────────────────

type FetchJSON = (url: string, opts?: RequestInit) => Promise<unknown>;

interface HermesSDK {
  React: typeof React;
  hooks: {
    useState: typeof React.useState;
    useEffect: typeof React.useEffect;
    useCallback: typeof React.useCallback;
    useMemo: typeof React.useMemo;
    useRef: typeof React.useRef;
    useContext: typeof React.useContext;
    createContext: typeof React.createContext;
  };
  api: Record<string, unknown>;
  fetchJSON: FetchJSON;
  components: {
    Card: React.ComponentType<Record<string, unknown>>;
    CardHeader: React.ComponentType<Record<string, unknown>>;
    CardTitle: React.ComponentType<Record<string, unknown>>;
    CardContent: React.ComponentType<Record<string, unknown>>;
    Badge: React.ComponentType<Record<string, unknown>>;
    Button: React.ComponentType<Record<string, unknown>>;
    Input: React.ComponentType<Record<string, unknown>>;
    Label: React.ComponentType<Record<string, unknown>>;
    Separator: React.ComponentType<Record<string, unknown>>;
    Tabs: React.ComponentType<Record<string, unknown>>;
    TabsList: React.ComponentType<Record<string, unknown>>;
    TabsTrigger: React.ComponentType<Record<string, unknown>>;
    Checkbox: React.ComponentType<Record<string, unknown>>;
    Select: React.ComponentType<Record<string, unknown>>;
    SelectOption: React.ComponentType<Record<string, unknown>>;
    PluginSlot: React.ComponentType<Record<string, unknown>>;
  };
  utils: {
    cn: (...classes: (string | undefined | null | false)[]) => string;
    timeAgo: (date: string | Date) => string;
    isoTimeAgo: (date: string | Date) => string;
  };
  useI18n: () => { t: Record<string, unknown>; locale: string };
}

declare global {
  interface Window {
    __HERMES_PLUGIN_SDK__: HermesSDK;
    __HERMES_PLUGINS__: {
      register: (name: string, component: React.ComponentType) => void;
      registerSlot: (pluginName: string, slotName: string, component: React.ComponentType) => void;
    };
  }
}

// ── Constants ────────────────────────────────────────────────────────────────

const SDK = window.__HERMES_PLUGIN_SDK__;
if (!SDK || !window.__HERMES_PLUGINS__) {
  throw new Error("Hermes plugin SDK not available");
}

const API = "/api/plugins/print-jobs";

const { useState, useEffect } = SDK.hooks;
const {
  Card, CardHeader, CardTitle, CardContent,
  Badge, Button, Input, Label,
} = SDK.components;
const { cn } = SDK.utils;

// ── API helpers ───────────────────────────────────────────────────────────────

async function apiFetch<T = unknown>(url: string, opts?: RequestInit): Promise<T> {
  return SDK.fetchJSON(url, opts) as Promise<T>;
}

function parseError(err: unknown): string {
  const raw = (err && (err as Error).message) ? String((err as Error).message) : String(err || "");
  const m = raw.match(/^(\d{3}):\s*(.*)$/s);
  const body = m ? m[2] : raw;
  try {
    const p = JSON.parse(body);
    return (p && p.detail) ? String(p.detail) : body;
  } catch (_) { return body || raw; }
}

// ── Types ────────────────────────────────────────────────────────────────────

interface PrinterStatus {
  state: string;
  filename?: string | null;
  progress: number;
  message: string;
  bed_temp?: number | null;
}

interface QueueJob {
  id: string;
  model_title: string;
  source: string;
  stl_url: string;
  stl_path?: string;
  gcode_path?: string;
  moonraker_path?: string;
  status: JobStatus;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  error?: string;
}

type JobStatus =
  | "pending" | "downloading" | "sliced" | "uploading"
  | "uploaded" | "printing" | "paused"
  | "done" | "failed" | "cancelled";

interface PluginStatus {
  printer: PrinterStatus;
  queue: QueueJob[];
  current_job: QueueJob | null;
  awaiting_bed_clear: boolean;
}

interface SearchResult {
  title: string;
  source: string;
  url: string;
  stl_url?: string;
  description?: string;
}

interface SearchResponse {
  query: string;
  results: SearchResult[];
}

interface HistoryResponse {
  history: QueueJob[];
}

// ── Status metadata ──────────────────────────────────────────────────────────

const STATUS_META: Record<JobStatus, { label: string; cls: string }> = {
  pending:     { label: "Pending",     cls: "bg-gray-500" },
  downloading: { label: "Downloading",  cls: "bg-blue-500" },
  sliced:      { label: "Sliced",       cls: "bg-yellow-500" },
  uploading:   { label: "Uploading",     cls: "bg-purple-500" },
  uploaded:    { label: "Uploaded",     cls: "bg-indigo-500" },
  printing:    { label: "Printing",     cls: "bg-green-500" },
  paused:      { label: "Paused",       cls: "bg-orange-500" },
  done:        { label: "Done",         cls: "bg-green-700" },
  failed:      { label: "Failed",       cls: "bg-red-500" },
  cancelled:   { label: "Cancelled",   cls: "bg-gray-600" },
};

function StatusBadge({ status }: { status: JobStatus }) {
  const meta = STATUS_META[status] ?? { label: status ?? "—", cls: "bg-gray-400" };
  return React.createElement("span",
    { className: `text-xs px-2 py-0.5 rounded text-white ${meta.cls}` },
    meta.label
  );
}

// ── Polling hook ─────────────────────────────────────────────────────────────

function usePrinterStatus(pollMs = 5000): {
  status: PluginStatus;
  error: string | null;
} {
  const [status, setStatus] = useState<PluginStatus>({
    printer: { state: "unknown", filename: null, progress: 0, message: "" },
    queue: [],
    current_job: null,
    awaiting_bed_clear: false,
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    function poll() {
      apiFetch<PluginStatus>(`${API}/status`)
        .then(data => { if (!cancelled) { setStatus(data); setError(null); } })
        .catch(e => { if (!cancelled) setError(parseError(e)); });
    }
    poll();
    const id = setInterval(poll, pollMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [pollMs]);

  return { status, error };
}

// ── Search Tab ───────────────────────────────────────────────────────────────

interface SearchTabProps {
  onSwitchTab: (tab: "search" | "queue" | "history") => void;
}

function SearchTab({ onSwitchTab }: SearchTabProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  function doSearch(q: string) {
    if (!q.trim()) return;
    setSearching(true);
    setSearchError(null);
    apiFetch<SearchResponse>(`${API}/search?q=${encodeURIComponent(q)}`)
      .then(data => setResults(data.results ?? []))
      .catch(e => setSearchError(parseError(e)))
      .finally(() => setSearching(false));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    doSearch(query);
  }

  function addToQueue(result: SearchResult) {
    const url = result.stl_url ?? result.url;
    apiFetch(`${API}/queue/add`, {
      method: "POST",
      body: JSON.stringify({ url, title: result.title }),
    })
      .then(() => onSwitchTab("queue"))
      .catch(e => alert(`Failed to add to queue: ${parseError(e)}`));
  }

  return React.createElement("div", { className: "flex flex-col gap-4" },
    React.createElement("form", { onSubmit: handleSubmit, className: "flex gap-2" },
      React.createElement(Input, {
        value: query,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value),
        placeholder: "Search Printables, Thingiverse, MakerWorld…",
        className: "flex-1",
      }),
      React.createElement(Button, { type: "submit", disabled: searching },
        searching ? "Searching…" : "Search"
      )
    ),

    searchError && React.createElement("p", { className: "text-red-500 text-sm" }, `Error: ${searchError}`),

    results.length > 0 && React.createElement("div", { className: "grid gap-3" },
      results.map((r, i) =>
        React.createElement(Card, { key: i, className: "p-3" },
          React.createElement("div", { className: "flex justify-between items-start gap-2" },
            React.createElement("div", { className: "flex-1 min-w-0" },
              React.createElement(CardTitle, { className: "text-sm truncate" }, r.title),
              React.createElement("p", { className: "text-xs text-muted-foreground mt-0.5" },
                (r.description ?? "").substring(0, 120)
              )
            ),
            React.createElement(Badge, { variant: "outline" }, r.source)
          ),
          React.createElement("div", { className: "flex gap-2 mt-2" },
            React.createElement(Button, {
              size: "sm", variant: "outline",
              onClick: () => window.open(r.url, "_blank"),
            }, "View"),
            React.createElement(Button, { size: "sm", onClick: () => addToQueue(r) }, "Add to Queue")
          )
        )
      )
    ),

    !searching && results.length === 0 && !searchError &&
      React.createElement("p", { className: "text-sm text-muted-foreground text-center py-8" },
        "Search for a model above — results from all sources will appear here."
      )
  );
}

// ── Queue Tab ───────────────────────────────────────────────────────────────

function QueueTab() {
  const { status, error } = usePrinterStatus(3000);
  const [acting, setActing] = useState<string | null>(null);

  const { queue = [], current_job: currentJob, awaiting_bed_clear: awaitingBed, printer } = status;

  function runAction(
    jobId: string,
    action: string,
    url: string,
    method = "POST",
    body?: Record<string, unknown>,
  ) {
    setActing(`${action}:${jobId}`);
    apiFetch(url, { method, body: body ? JSON.stringify(body) : undefined })
      .catch(e => alert(`${action} failed: ${parseError(e)}`))
      .finally(() => setActing(null));
  }

  function handleConfirmBedClear() {
    apiFetch(`${API}/confirm-bed-clear`, { method: "POST" })
      .catch(e => alert(`Error: ${parseError(e)}`));
  }

  function isActing(jobId: string, action: string) {
    return acting === `${action}:${jobId}`;
  }

  return React.createElement("div", { className: "flex flex-col gap-4" },

    // Printer status
    React.createElement(Card, { className: "p-4" },
      React.createElement(CardHeader, { className: "pb-2" },
        React.createElement(CardTitle, { className: "text-sm" }, "Printer")
      ),
      React.createElement(CardContent, { className: "flex flex-col gap-1.5" },
        React.createElement("div", { className: "flex justify-between text-sm" },
          React.createElement("span", null,
            React.createElement("b", null, printer?.state ?? "unknown")
          ),
          printer?.bed_temp != null &&
            React.createElement("span", { className: "text-muted-foreground" },
              `Bed: ${printer!.bed_temp!.toFixed(1)}°C`
            )
        ),
        printer?.filename &&
          React.createElement("p", { className: "text-xs text-muted-foreground" },
            `Printing: ${printer!.filename}`
          ),
        (printer?.progress ?? 0) > 0 &&
          React.createElement("p", { className: "text-xs text-muted-foreground" },
            `Progress: ${Math.round((printer?.progress ?? 0) * 100)}%`
          ),
        printer?.message &&
          React.createElement("p", { className: "text-xs text-muted-foreground" }, printer!.message),
        error && React.createElement("p", { className: "text-xs text-red-500" }, `Error: ${error}`),

        awaitingBed && React.createElement("div", {
          className: "mt-2 p-2 rounded bg-yellow-100 border border-yellow-300 text-sm text-yellow-800",
        },
          "⚠ Remove finished print and click Confirm Bed Clear before the next job can start."
        ),

        React.createElement(Button, {
          size: "sm", className: "mt-2",
          disabled: !awaitingBed,
          variant: awaitingBed ? "default" : "outline",
          onClick: handleConfirmBedClear,
        }, awaitingBed ? "✓ Confirm Bed Clear" : "Bed is Clear")
      )
    ),

    // Queue
    React.createElement("div", { className: "flex flex-col gap-2" },
      React.createElement(CardTitle, { className: "text-sm px-1" }, `Job Queue (${queue.length})`),

      queue.length === 0 &&
        React.createElement(Card, { className: "p-4 text-center text-sm text-muted-foreground" },
          "Queue is empty. Search for a model and add it above."
        ),

      queue.map(job => {
        const isCurrent = currentJob?.id === job.id;

        return React.createElement(Card, { key: job.id, className: "p-3" },
          React.createElement("div", { className: "flex justify-between items-start gap-2" },
            React.createElement("div", { className: "flex-1 min-w-0" },
              React.createElement("div", { className: "flex items-center gap-2" },
                React.createElement(CardTitle, { className: "text-sm truncate" }, job.model_title),
                React.createElement(StatusBadge, { status: job.status as JobStatus }),
                isCurrent && React.createElement(Badge, { variant: "destructive" }, "Active")
              ),
              React.createElement("p", { className: "text-xs text-muted-foreground mt-0.5" },
                job.source, " — Added ",
                job.created_at ? new Date(job.created_at).toLocaleString() : ""
              ),
              job.error && React.createElement("p", { className: "text-xs text-red-500 mt-1" }, `Error: ${job.error}`)
            )
          ),

          // Pending: download STL
          job.status === "pending" && !job.stl_path &&
            actionBtn(job.id, "download", "↓ Download STL", () =>
              runAction(job.id, "download", `${API}/queue/${job.id}/download`, "POST")
            ),

          // Pending: slice (STL already downloaded)
          job.status === "pending" && !!job.stl_path &&
            actionBtn(job.id, "slice", "⚙ Slice", () =>
              runAction(job.id, "slice", `${API}/queue/${job.id}/slice`, "POST")
            ),

          // Sliced: upload
          job.status === "sliced" &&
            actionBtn(job.id, "upload", "↑ Upload to Moonraker", () =>
              runAction(job.id, "upload", `${API}/queue/${job.id}/upload`, "POST")
            ),

          // Uploaded: start
          job.status === "uploaded" &&
            actionBtn(job.id, "start", "▶ Start Print", () =>
              runAction(job.id, "start", `${API}/start`, "POST", {
                job_id: job.id,
                gcode_path: job.gcode_path,
              })
            ),

          // Printing: pause + cancel
          job.status === "printing" && isCurrent &&
            React.createElement("div", { className: "flex gap-2 mt-2" },
              actionBtn(job.id, "pause", "Pause", () =>
                runAction(job.id, "pause", `${API}/pause?job_id=${job.id}`, "POST")
              ),
              actionBtn(job.id, "cancel", "Cancel", () =>
                runAction(job.id, "cancel", `${API}/cancel?job_id=${job.id}`, "POST")
              )
            ),

          // Paused: resume + cancel
          job.status === "paused" && isCurrent &&
            React.createElement("div", { className: "flex gap-2 mt-2" },
              actionBtn(job.id, "resume", "↩ Resume", () =>
                runAction(job.id, "resume", `${API}/resume?job_id=${job.id}`, "POST")
              ),
              actionBtn(job.id, "cancel", "Cancel", () =>
                runAction(job.id, "cancel", `${API}/cancel?job_id=${job.id}`, "POST")
              )
            ),

          // Terminal states: remove
          (job.status === "done" || job.status === "failed" || job.status === "cancelled") &&
            actionBtn(job.id, "remove", "Remove from Queue", () =>
              runAction(job.id, "remove", `${API}/queue/${job.id}`, "DELETE")
            )
        );
      })
    )
  );

  function actionBtn(
    jobId: string,
    action: string,
    label: string,
    onClick: () => void,
  ) {
    return React.createElement(Button, {
      size: "sm", disabled: !!acting,
      onClick,
    }, isActing(jobId, action) ? "…" : label);
  }
}

// ── History Tab ─────────────────────────────────────────────────────────────

function HistoryTab({ version }: { version: number }) {
  const [history, setHistory] = useState<QueueJob[]>([]);

  useEffect(() => {
    apiFetch<HistoryResponse>(`${API}/history`)
      .then(d => setHistory(d.history ?? []))
      .catch(() => {});
  }, [version]);

  return React.createElement("div", { className: "flex flex-col gap-2" },
    history.length === 0 &&
      React.createElement("p", { className: "text-sm text-muted-foreground text-center py-8" },
        "No completed jobs yet."
      ),
    history.map((job, i) =>
      React.createElement(Card, { key: i, className: "p-3" },
        React.createElement("div", { className: "flex justify-between items-center" },
          React.createElement(CardTitle, { className: "text-sm" }, job.model_title),
          React.createElement(StatusBadge, { status: job.status as JobStatus })
        ),
        job.started_at && React.createElement("p", { className: "text-xs text-muted-foreground mt-1" },
          `Printed: ${new Date(job.started_at).toLocaleString()}` +
          (job.finished_at ? ` → ${new Date(job.finished_at).toLocaleString()}` : "")
        ),
        job.error && React.createElement("p", { className: "text-xs text-red-500 mt-1" }, job.error)
      )
    )
  );
}

// ── Main Page ────────────────────────────────────────────────────────────────

function PrintJobsPage() {
  const { status, error } = usePrinterStatus(5000);
  const [activeTab, setActiveTab] = useState<"search" | "queue" | "history">("search");
  const [historyVersion, setHistoryVersion] = useState(0);

  const { printer, queue = [], awaiting_bed_clear: awaitingBed } = status;

  function switchTab(tab: "search" | "queue" | "history") {
    setActiveTab(tab);
    if (tab === "history") setHistoryVersion(v => v + 1);
  }

  return React.createElement("div", { className: "flex flex-col gap-5 p-6 max-w-3xl mx-auto" },

    // Header
    React.createElement(Card, { className: "p-4" },
      React.createElement("div", { className: "flex justify-between items-center" },
        React.createElement("div", null,
          React.createElement(CardTitle, null, "Print Jobs"),
          React.createElement("p", { className: "text-xs text-muted-foreground mt-0.5" },
            printer?.state ?? "unknown",
            printer?.bed_temp != null ? ` | Bed ${printer!.bed_temp!.toFixed(1)}°C` : ""
          )
        ),
        awaitingBed && React.createElement(Badge, { variant: "destructive" }, "⚠ Bed Clear Required")
      ),
      error && React.createElement("p", { className: "text-xs text-red-500 mt-2" },
        `Cannot reach printer: ${error}`
      ),
      !error && printer?.filename && (printer?.progress ?? 0) > 0 &&
        React.createElement("p", { className: "text-xs text-muted-foreground mt-1" },
          `Printing: ${printer!.filename} (${Math.round((printer?.progress ?? 0) * 100)}%)`
        )
    ),

    // Tab bar
    React.createElement("div", { className: "flex gap-1 border-b" },
      tabButton("search", "🔍 Search"),
      tabButton("queue", `📋 Queue (${queue.length})`),
      tabButton("history", "History"),
    ),

    // Tab content
    activeTab === "search" && React.createElement(SearchTab, { onSwitchTab: switchTab }),
    activeTab === "queue" && React.createElement(QueueTab),
    activeTab === "history" && React.createElement(HistoryTab, { version: historyVersion }),
  );

  function tabButton(tab: "search" | "queue" | "history", label: string) {
    const active = activeTab === tab;
    return React.createElement("button", {
      className: cn(
        "px-4 py-2 text-sm border-b-2 transition-colors",
        active ? "border-blue-500 text-blue-600 font-medium" : "border-transparent text-muted-foreground hover:text-foreground"
      ),
      onClick: () => switchTab(tab),
    }, label);
  }
}

// ── Register ─────────────────────────────────────────────────────────────────

window.__HERMES_PLUGINS__.register("print-jobs", PrintJobsPage);
