/**
 * Print Jobs — Dashboard Plugin
 *
 * Full pipeline: search STL models → add to queue → download →
 * slice with OrcaSlicer → upload to Moonraker → start/pause/resume/cancel.
 *
 * Also handles the bed-clear confirmation gate between jobs.
 */
(function () {
  "use strict";

  const SDK = window.__HERMES_PLUGIN_SDK__;
  if (!SDK || !window.__HERMES_PLUGINS__) return;

  const React = SDK.React;
  const h = React.createElement;
  const { useState, useEffect, useCallback, useRef } = SDK.hooks;
  const {
    Card, CardHeader, CardTitle, CardContent,
    Badge, Button, Input, Label, Spinner, Tabs, TabsList, TabsTrigger, TabsContent,
    Progress,
  } = SDK.components;
  const { cn } = SDK.utils;

  const API = "/api/plugins/print-jobs";

  // ── fetchJSON with error extraction ────────────────────────────────────────

  async function apiFetch(url, opts) {
    const res = await SDK.fetchJSON(url, opts);
    return res;
  }

  function parseError(err) {
    const raw = (err && err.message) ? String(err.message) : String(err || "");
    const m = raw.match(/^(\d{3}):\s*(.*)$/s);
    const body = m ? m[2] : raw;
    try {
      const p = JSON.parse(body);
      return (p && p.detail) ? String(p.detail) : body;
    } catch (_) { return body || raw; }
  }

  // ── Polling state hook ─────────────────────────────────────────────────────

  function usePrinterStatus(pollMs = 3000) {
    const [status, setStatus] = useState({
      printer: { state: "unknown", filename: null, progress: 0, message: "", bed_temp: null },
      queue: [],
      current_job: null,
      awaiting_bed_clear: false,
    });
    const [error, setError] = useState(null);

    useEffect(() => {
      async function poll() {
        try {
          const data = await apiFetch(`${API}/status`);
          setStatus(data);
          setError(null);
        } catch (e) {
          setError(parseError(e));
        }
      }
      poll();
      const id = setInterval(poll, pollMs);
      return () => clearInterval(id);
    }, [pollMs]);

    return { status, error };
  }

  // ── Job status badge ───────────────────────────────────────────────────────

  const STATUS_META = {
    pending:   { label: "Pending",   color: "bg-gray-500" },
    downloading: { label: "Downloading", color: "bg-blue-500" },
    sliced:    { label: "Sliced",    color: "bg-yellow-500" },
    uploading: { label: "Uploading", color: "bg-purple-500" },
    uploaded:  { label: "Uploaded",  color: "bg-indigo-500" },
    printing:  { label: "Printing",  color: "bg-green-500" },
    paused:    { label: "Paused",    color: "bg-orange-500" },
    done:      { label: "Done",      color: "bg-green-700" },
    failed:    { label: "Failed",    color: "bg-red-500" },
    cancelled: { label: "Cancelled", color: "bg-gray-600" },
  };

  function StatusBadge({ status: s }) {
    const meta = STATUS_META[s] || { label: s || "—", color: "bg-gray-400" };
    return h("span", { className: `text-xs px-2 py-0.5 rounded text-white ${meta.color}` }, meta.label);
  }

  // ── Search Tab ─────────────────────────────────────────────────────────────

  function SearchTab() {
    const [query, setQuery] = useState("");
    const [results, setResults] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    async function doSearch(q) {
      if (!q.trim()) return;
      setLoading(true);
      setError(null);
      try {
        const data = await apiFetch(`${API}/search?q=${encodeURIComponent(q)}`);
        setResults(data.results || []);
      } catch (e) {
        setError(parseError(e));
      } finally {
        setLoading(false);
      }
    }

    function handleSubmit(e) {
      e.preventDefault();
      doSearch(query);
    }

    async function addToQueue(result) {
      try {
        await apiFetch(`${API}/queue/add`, {
          method: "POST",
          body: JSON.stringify({ url: result.stl_url || result.url, title: result.title }),
        });
        // Switch to queue tab
        const tabsEl = document.querySelector('[data-tab="queue"]');
        if (tabsEl) tabsEl.click();
      } catch (e) {
        alert("Failed to add to queue: " + parseError(e));
      }
    }

    return h("div", { className: "flex flex-col gap-4" },
      h("form", { onSubmit: handleSubmit, className: "flex gap-2" },
        h(Input, {
          value: query,
          onChange: e => setQuery(e.target.value),
          placeholder: "Search Printables, Thingiverse, MakerWorld…",
          className: "flex-1",
        }),
        h(Button, { type: "submit", disabled: loading },
          loading ? h(Spinner, { size: "sm" }) : "Search"
        )
      ),

      error && h("p", { className: "text-red-500 text-sm" }, error),

      results.length > 0 && h("div", { className: "grid gap-3" },
        results.map((r, i) =>
          h(Card, { key: i, className: "p-3" },
            h("div", { className: "flex justify-between items-start gap-2" },
              h("div", { className: "flex-1 min-w-0" },
                h(CardTitle, { className: "text-sm truncate" }, r.title),
                h("p", { className: "text-xs text-muted-foreground mt-0.5" },
                  r.source, " — ", r.description || ""
                ),
              ),
              h(Badge, { variant: "outline" }, r.source),
            ),
            h("div", { className: "flex gap-2 mt-2" },
              h(Button, { size: "sm", variant: "outline", onClick: () => window.open(r.url, "_blank") }, "View"),
              h(Button, { size: "sm", onClick: () => addToQueue(r) }, "Add to Queue"),
            )
          )
        )
      ),

      !loading && results.length === 0 && !error &&
        h("p", { className: "text-sm text-muted-foreground text-center py-8" },
          "Search for a model above — results from Printables, Thingiverse, and MakerWorld will appear here."
        )
    );
  }

  // ── Queue Tab ──────────────────────────────────────────────────────────────

  function QueueTab() {
    const { status, error } = usePrinterStatus(3000);
    const [acting, setActing] = useState(null);   // { jobId, action }

    async function runAction(jobId, action, url, method, body) {
      setActing({ jobId, action });
      try {
        await apiFetch(url, { method, body: body ? JSON.stringify(body) : undefined });
      } catch (e) {
        alert(`${action} failed: ${parseError(e)}`);
      } finally {
        setActing(null);
      }
    }

    async function handleConfirmBedClear() {
      try {
        await apiFetch(`${API}/confirm-bed-clear`, { method: "POST" });
      } catch (e) {
        alert("Error: " + parseError(e));
      }
    }

    const { queue = [], current_job: currentJob, awaiting_bed_clear: awaitingBed, printer = {} } = status;

    return h("div", { className: "flex flex-col gap-4" },

      // Printer status card
      h(Card, { className: "p-4" },
        h(CardHeader, { className: "pb-2" },
          h(CardTitle, { className: "text-sm" }, "Printer"),
        ),
        h(CardContent, { className: "flex flex-col gap-1.5" },
          h("div", { className: "flex justify-between text-sm" },
            h("span", null, h("b", null, printer.state || "—")),
            printer.bed_temp != null && h("span", { className: "text-muted-foreground" },
              `Bed: ${printer.bed_temp.toFixed(1)}°C`
            )
          ),
          printer.filename && h("p", { className: "text-xs text-muted-foreground" },
            "Printing: ", printer.filename
          ),
          printer.progress > 0 && h(Progress, { value: printer.progress * 100, className: "h-1.5" }),
          printer.message && h("p", { className: "text-xs text-muted-foreground" }, printer.message),

          // Bed-clear gate banner
          awaitingBed && h("div", {
            className: "mt-2 p-2 rounded bg-yellow-100 border border-yellow-300 text-sm text-yellow-800"
          },
            h("b", null, "⚠ Remove finished print and confirm before next job starts."),
          ),

          h(Button, {
            size: "sm",
            className: "mt-2",
            disabled: !awaitingBed,
            variant: awaitingBed ? "default" : "outline",
            onClick: handleConfirmBedClear,
          }, awaitingBed ? "✓ Confirm Bed Clear" : "Bed is Clear"),
        ),
      ),

      // Queue
      h("div", { className: "flex flex-col gap-2" },
        h(CardTitle, { className: "text-sm px-1" },
          "Job Queue", ` (${queue.length})`
        ),

        queue.length === 0 &&
          h(Card, { className: "p-4 text-center text-sm text-muted-foreground" },
            "Queue is empty. Search for a model and add it above."
          ),

        queue.map(job =>
          h(Card, { key: job.id, className: "p-3" },
            h("div", { className: "flex justify-between items-start gap-2" },
              h("div", { className: "flex-1 min-w-0" },
                h("div", { className: "flex items-center gap-2" },
                  h(CardTitle, { className: "text-sm truncate" }, job.model_title),
                  h(StatusBadge, { status: job.status }),
                ),
                h("p", { className: "text-xs text-muted-foreground mt-0.5" },
                  job.source || "", job.created_at ? ` — Added ${new Date(job.created_at).toLocaleString()}` : ""
                ),
                job.error && h("p", { className: "text-xs text-red-500 mt-1" }, job.error),
              ),
            ),
            // Action buttons per job status
            job.status === "pending" && h("div", { className: "flex gap-2 mt-2" },
              h(Button, {
                size: "sm", disabled: acting?.jobId === job.id,
                onClick: () => runAction(job.id, "download", `${API}/queue/${job.id}/download`, "POST"),
              }, acting?.jobId === job.id && acting?.action === "download" ? h(Spinner,{size:"sm"}) : "Download STL"),
            ),

            job.status === "pending" && job.stl_path && h("div", { className: "flex gap-2 mt-1" },
              h(Button, {
                size: "sm", disabled: acting?.jobId === job.id,
                onClick: () => runAction(job.id, "slice", `${API}/queue/${job.id}/slice`, "POST"),
              }, acting?.jobId === job.id && acting?.action === "slice" ? h(Spinner,{size:"sm"}) : "Slice"),
            ),

            job.status === "sliced" && h("div", { className: "flex gap-2 mt-2" },
              h(Button, {
                size: "sm", disabled: acting?.jobId === job.id,
                onClick: () => runAction(job.id, "upload", `${API}/queue/${job.id}/upload`, "POST"),
              }, acting?.jobId === job.id && acting?.action === "upload" ? h(Spinner,{size:"sm"}) : "Upload to Moonraker"),
            ),

            job.status === "uploaded" && h("div", { className: "flex gap-2 mt-2" },
              h(Button, {
                size: "sm", disabled: acting?.jobId === job.id,
                onClick: () => runAction(job.id, "start", `${API}/start`, "POST", { job_id: job.id, gcode_path: job.gcode_path }),
              }, acting?.jobId === job.id && acting?.action === "start" ? h(Spinner,{size:"sm"}) : "▶ Start Print"),
            ),

            job.status === "printing" && currentJob?.id === job.id && h("div", { className: "flex gap-2 mt-2" },
              h(Button, {
                size: "sm", variant: "outline", disabled: acting?.jobId === job.id,
                onClick: () => runAction(job.id, "pause", `${API}/pause?job_id=${job.id}`, "POST"),
              }, "Pause"),
              h(Button, {
                size: "sm", variant: "destructive", disabled: acting?.jobId === job.id,
                onClick: () => runAction(job.id, "cancel", `${API}/cancel?job_id=${job.id}`, "POST"),
              }, "Cancel"),
            ),

            job.status === "paused" && currentJob?.id === job.id && h("div", { className: "flex gap-2 mt-2" },
              h(Button, {
                size: "sm", disabled: acting?.jobId === job.id,
                onClick: () => runAction(job.id, "resume", `${API}/resume?job_id=${job.id}`, "POST"),
              }, "Resume"),
              h(Button, {
                size: "sm", variant: "destructive", disabled: acting?.jobId === job.id,
                onClick: () => runAction(job.id, "cancel", `${API}/cancel?job_id=${job.id}`, "POST"),
              }, "Cancel"),
            ),

            !["printing", "paused", "uploaded", "sliced", "pending"].includes(job.status) &&
              h("div", { className: "flex gap-2 mt-2" },
                h(Button, {
                  size: "sm", variant: "destructive",
                  onClick: () => runAction(job.id, "remove", `${API}/queue/${job.id}`, "DELETE"),
                }, "Remove from Queue"),
              )
          )
        ),
      ),
    );
  }

  // ── History Tab ─────────────────────────────────────────────────────────────

  function HistoryTab() {
    const [history, setHistory] = useState([]);

    useEffect(() => {
      apiFetch(`${API}/history`)
        .then(d => setHistory(d.history || []))
        .catch(() => {});
    }, []);

    return h("div", { className: "flex flex-col gap-2" },
      history.length === 0
        ? h("p", { className: "text-sm text-muted-foreground text-center py-8" }, "No completed jobs yet.")
        : history.map((job, i) =>
            h(Card, { key: i, className: "p-3" },
              h("div", { className: "flex justify-between items-center" },
                h(CardTitle, { className: "text-sm" }, job.model_title),
                h(StatusBadge, { status: job.status }),
              ),
              job.started_at && h("p", { className: "text-xs text-muted-foreground mt-1" },
                `Printed: ${new Date(job.started_at).toLocaleString()} → ${job.finished_at ? new Date(job.finished_at).toLocaleString() : "—"}`
              ),
            )
          )
    );
  }

  // ── Main Page ──────────────────────────────────────────────────────────────

  function PrintJobsPage() {
    const { status, error } = usePrinterStatus(5000);

    return h("div", { className: "flex flex-col gap-6 p-6 max-w-3xl mx-auto" },

      // Top header with global state
      h(Card, { className: "p-4" },
        h("div", { className: "flex justify-between items-center" },
          h("div", null,
            h(CardTitle, null, "Print Jobs"),
            h("p", { className: "text-xs text-muted-foreground mt-0.5" },
              status.printer?.state || "—", " | ",
              status.printer?.bed_temp != null ? `${status.printer.bed_temp.toFixed(1)}°C` : "—"
            ),
          ),
          status.awaiting_bed_clear && h(Badge, { variant: "destructive" }, "⚠ Bed Clear Required"),
        ),
        error && h("p", { className: "text-xs text-red-500 mt-2" }, "Cannot reach printer: " + error),
      ),

      // Tabs
      h(Tabs, { defaultValue: "search", className: "w-full" },
        h(TabsList, { className: "mb-4" },
          h(TabsTrigger, { value: "search" }, "🔍 Search"),
          h(TabsTrigger, { value: "queue" }, `📋 Queue (${(status.queue || []).length})`),
          h(TabsTrigger, { value: "history" }, "History"),
        ),

        h(TabsContent, { value: "search" }, h(SearchTab)),
        h(TabsContent, { value: "queue" }, h(QueueTab)),
        h(TabsContent, { value: "history" }, h(HistoryTab)),
      ),
    );
  }

  window.__HERMES_PLUGINS__.register("print-jobs", PrintJobsPage);
})();
