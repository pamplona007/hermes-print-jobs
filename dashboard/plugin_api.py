"""Print Jobs dashboard plugin — backend API routes.

Mounted at /api/plugins/print-jobs/ by the dashboard plugin system.

Full pipeline:
  search  → STLs from Printables / Thingiverse / MakerWorld
  download → fetch STL to local cache
  slice    → run OrcaSlicer CLI to produce .gcode
  upload   → push G-code to Moonraker via /server/files/upload
  queue    → persistent job queue with bed-clear gating
  control  → start / pause / resume / cancel via Moonraker
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

import requests
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

log = logging.getLogger(__name__)
router = APIRouter()

# ---------------------------------------------------------------------------
# Config — loaded once at startup
# ---------------------------------------------------------------------------

PRINTER_IP = os.getenv("MOONRAKER_IP", "192.168.1.133")
MOONRAKER_PORT = int(os.getenv("MOONRAKER_PORT", "7125"))
MOONRAKER_BASE = f"http://{PRINTER_IP}:{MOONRAKER_PORT}"
MOONRAKER_WS_URL = f"ws://{PRINTER_IP}:{MOONRAKER_PORT}/websocket"

# OrcaSlicer (Flatpak)
ORCA_SLICER_CMD = ["flatpak", "run", "com.orcaslicer.OrcaSlicer"]
ORCA_CONFIG_DIR = Path.home() / ".var/app/com.orcaslicer.OrcaSlicer/config/OrcaSlicer"

# Local cache
CACHE_DIR = Path(os.getenv("PRINT_JOBS_CACHE", "/home/pamplona/3dprint/stl_cache"))
SLICE_OUTPUT_DIR = Path(os.getenv("PRINT_JOBS_OUTPUT", "/home/pamplona/3dprint/gcode_output"))
CACHE_DIR.mkdir(parents=True, exist_ok=True)
SLICE_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# State file
STATE_FILE = Path(os.getenv("PRINT_JOBS_STATE", str(Path.home() / ".hermes/print-jobs-state.json")))

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            pass
    return {
        "queue": [],
        "current_job": None,
        "awaiting_bed_clear": False,
        "history": [],
    }

def _save_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2, default=str))

def _moonreq(method: str, path: str, **kwargs) -> requests.Response:
    url = f"{MOONRAKER_BASE}{path}"
    resp = requests.request(method, url, timeout=30, **kwargs)
    resp.raise_for_status()
    return resp

def _get_printer_status() -> dict:
    """Query Moonraker for live printer status."""
    try:
        resp = _moonreq("POST", "/printer/objects/query",
                        json={"print_stats": ["state", "message", "filename", "total_duration",
                                              "print_duration", "progress", "eta"],
                              "toolhead": ["position"],
                              "heater_bed": ["temperature"]})
        objects = resp.json().get("result", {}).get("status", {})
        ps = objects.get("print_stats", {})
        return {
            "state": ps.get("state", "unknown"),
            "filename": ps.get("filename") or None,
            "progress": ps.get("progress", 0.0),
            "message": ps.get("message", ""),
            "total_duration": ps.get("total_duration", 0),
            "print_duration": ps.get("print_duration", 0),
            "eta": ps.get("eta"),
            "bed_temp": objects.get("heater_bed", {}).get("temperature", {}).get("current"),
        }
    except Exception as exc:
        log.warning("Moonraker status query failed: %s", exc)
        return {"state": "offline", "error": str(exc)}

# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class SearchResult(BaseModel):
    title: str
    source: str          # "printables" | "thingiverse" | "makerworld"
    url: str             # model page URL
    stl_url: Optional[str] = None   # direct STL download URL (resolved)
    description: Optional[str] = None
    thumbnail_url: Optional[str] = None   # preview image URL

class SearchResponse(BaseModel):
    query: str
    results: list[SearchResult]

class QueueJob(BaseModel):
    id: str
    model_title: str
    source: str
    stl_url: str
    gcode_path: Optional[str] = None
    status: str = "pending"   # pending | sliced | uploaded | printing | done | failed | cancelled
    created_at: str
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    error: Optional[str] = None

class QueueResponse(BaseModel):
    jobs: list[QueueJob]
    current_job: Optional[QueueJob]
    awaiting_bed_clear: bool

class DownloadRequest(BaseModel):
    url: str
    title: str

class SliceRequest(BaseModel):
    job_id: str
    stl_path: str
    profile: Optional[str] = "0.20mm Standard"   # OrcaSlicer filament/print profile name

class SliceResponse(BaseModel):
    ok: bool
    job_id: str
    gcode_path: str
    message: str

class UploadResponse(BaseModel):
    ok: bool
    job_id: str
    moonraker_path: str

class StartPrintRequest(BaseModel):
    job_id: str
    gcode_path: str

class ControlResponse(BaseModel):
    ok: bool
    job_id: str
    state: str
    message: str

class ConfirmBedClearRequest(BaseModel):
    pass

# ---------------------------------------------------------------------------
# STL Search Adapters
# ---------------------------------------------------------------------------

def _search_printables(query: str) -> list[SearchResult]:
    """Search Printables.com via GraphQL API.

    The REST API (api.printables.com/v1/model/search) is Cloudflare-protected
    and returns 403. The GraphQL endpoint at api.printables.com/graphql/
    works with a normal User-Agent.
    """
    try:
        gql_query = """
        query SearchModels($query: String!, $limit: Int, $ordering: SearchChoicesEnum) {
          result: searchPrints2(
            query: $query
            printType: print
            limit: $limit
            ordering: $ordering
          ) {
            items {
              id
              name
              slug
              ratingAvg
              likesCount
              downloadCount
              datePublished
              image { filePath }
              user { handle }
            }
          }
        }
        """
        payload = {
            "operationName": "SearchModels",
            "query": gql_query.strip(),
            "variables": {
                "query": query,
                "limit": 10,
                "ordering": "best_match",
            },
        }
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        resp = requests.post(
            "https://api.printables.com/graphql/",
            json=payload,
            headers=headers,
            timeout=20,
        )
        resp.raise_for_status()
        data = resp.json()
        items = (
            data.get("data", {})
            .get("result", {})
            .get("items", [])
        )
        results = []
        for item in items:
            img_path = (item.get("image") or {}).get("filePath", "")
            img_url = (
                f"https://media.printables.com/{img_path}"
                if img_path
                else ""
            )
            model_id = str(item.get("id", ""))
            results.append(SearchResult(
                title=item.get("name", "Untitled"),
                source="printables",
                # Page URL — user visits this to see the model
                url=f"https://www.printables.com/model/{model_id}",
                # STL direct download URL (may require login for some models)
                stl_url=f"https://www.printables.com/model/{model_id}/download-file/{model_id}/stl",
                description=(
                    f"⭐ {item.get('ratingAvg', 0):.1f} "
                    f"❤️ {item.get('likesCount', 0)} "
                    f"⬇ {item.get('downloadCount', 0)}"
                ),
                thumbnail_url=img_url,
            ))
        return results
    except Exception as exc:
        log.warning("Printables search failed: %s", exc)
        return []

def _search_thingiverse(query: str) -> list[SearchResult]:
    """Search Thingiverse for models matching query."""
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (compatible; hermes-print-jobs/1.0)",
        }
        resp = requests.get(
            "https://api.thingiverse.com/search",
            params={"q": query, "per_page": 10},
            headers=headers,
            timeout=15,
        )
        resp.raise_for_status()
        items = resp.json().get("hits", {}).get("hits", [])
        results = []
        for item in items:
            src = item.get("_source", {})
            results.append(SearchResult(
                title=src.get("name", "Untitled"),
                source="thingiverse",
                url=src.get("public_url", ""),
                description=src.get("description", "")[:200],
            ))
        return results
    except Exception as exc:
        log.warning("Thingiverse search failed: %s", exc)
        return []

def _search_makerworld(query: str) -> list[SearchResult]:
    """Search MakerWorld for models matching query."""
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (compatible; hermes-print-jobs/1.0)",
            "Accept": "application/json",
        }
        resp = requests.get(
            "https://api.makerworld.com/api/v1/models/search",
            params={"keyword": query, "limit": 10, "type": "all"},
            headers=headers,
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        results = []
        for item in data.get("data", {}).get("result", []):
            results.append(SearchResult(
                title=item.get("name", "Untitled"),
                source="makerworld",
                url=item.get("detailUrl", ""),
                stl_url=item.get("downloadUrl"),
                description=item.get("description", "")[:200],
            ))
        return results
    except Exception as exc:
        log.warning("MakerWorld search failed: %s", exc)
        return []

# ---------------------------------------------------------------------------
# Download helper
# ---------------------------------------------------------------------------

def _download_stl(url: str, dest_path: Path, headers: Optional[dict] = None) -> Path:
    """Download an STL file to dest_path. Raises HTTPException on failure."""
    default_headers = {
        "User-Agent": "Mozilla/5.0 (compatible; hermes-print-jobs/1.0)",
    }
    h = dict(headers) if headers else default_headers
    resp = requests.get(url, headers=h, timeout=120, stream=True)
    resp.raise_for_status()
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    with dest_path.open("wb") as f:
        for chunk in resp.iter_content(chunk_size=65536):
            f.write(chunk)
    return dest_path

# ---------------------------------------------------------------------------
# Slicing
# ---------------------------------------------------------------------------

def _slice_stl(stl_path: Path, output_path: Path, profile: str = "0.20mm Standard") -> Path:  # noqa: ARG001
    """Slice an STL file using OrcaSlicer CLI.

    OrcaSlicer CLI usage:
      orca-slicer [-g {stl_file}] [--load {profile.ini}] -o {output.gcode}

    We use the OrcaSlicer config dir to find the right print profile.
    """
    # Find the profile .ini file
    profiles_dir = ORCA_CONFIG_DIR / "printers" / "profiles"
    profile_ini = None
    if profiles_dir.exists():
        for f in profiles_dir.glob("*.ini"):
            if profile.lower() in f.stem.lower() or profile.lower() in f.read_text().lower():
                profile_ini = str(f)
                break
        # Fallback: use any available profile
        if not profile_ini:
            files = list(profiles_dir.glob("*.ini"))
            if files:
                profile_ini = str(files[0])

    cmd = ORCA_SLICER_CMD + [
        "-g", str(stl_path),
        "-o", str(output_path),
    ]
    if profile_ini:
        cmd += ["--load", profile_ini]

    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=600,
    )
    if result.returncode != 0:
        raise RuntimeError(f"OrcaSlicer failed: {result.stderr[:500]}")
    if not output_path.exists():
        raise RuntimeError(f"OrcaSlicer produced no output at {output_path}")
    return output_path

# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/health")
async def health():
    return {
        "ok": True,
        "plugin": "print-jobs",
        "version": "0.2.0",
        "printer": MOONRAKER_BASE,
        "orca_config": str(ORCA_CONFIG_DIR),
        "cache_dir": str(CACHE_DIR),
        "output_dir": str(SLICE_OUTPUT_DIR),
    }

@router.get("/status")
async def get_status():
    """Return live printer status + queue state."""
    ps = _get_printer_status()
    state = _load_state()
    return {
        "printer": {
            "state": ps.get("state", "unknown"),
            "filename": ps.get("filename"),
            "progress": ps.get("progress", 0.0),
            "message": ps.get("message", ""),
            "bed_temp": ps.get("bed_temp"),
        },
        "queue": state["queue"],
        "current_job": state["current_job"],
        "awaiting_bed_clear": state["awaiting_bed_clear"],
    }

@router.get("/search", response_model=SearchResponse)
async def search(q: str = Query(..., min_length=1)):
    """Search all configured STL sources. Sources that fail are silently skipped."""
    results: list[SearchResult] = []
    sources = [
        ("printables", _search_printables),
        ("thingiverse", _search_thingiverse),
        ("makerworld", _search_makerworld),
    ]
    for name, fn in sources:
        try:
            results.extend(fn(q))
        except Exception as exc:
            log.warning("Search source %s failed: %s", name, exc)
    # Dedupe by URL
    seen: set[str] = set()
    deduped = []
    for r in results:
        if r.url not in seen:
            seen.add(r.url)
            deduped.append(r)
    return SearchResponse(query=q, results=deduped)

@router.get("/sources")
async def sources():
    """List available STL sources and their status."""
    return {
        "sources": [
            {"name": "printables", "label": "Printables", "status": "ok"},
            {"name": "thingiverse", "label": "Thingiverse", "status": "ok"},
            {"name": "makerworld", "label": "MakerWorld", "status": "ok"},
        ]
    }

@router.post("/download", response_model=dict)
async def download(req: DownloadRequest):
    """Download an STL file to the local cache and return the local path."""
    state = _load_state()
    # Create a safe filename from title
    safe_name = "".join(c if c.isalnum() or c in ".-" else "_" for c in req.title)[:80]
    ext = ".stl" if ".stl" in req.url.lower() else ".stl"
    dest = CACHE_DIR / f"{safe_name}_{datetime.now().strftime('%Y%m%d%H%M%S')}{ext}"

    # Determine source-specific headers
    headers = None
    if "printables" in req.url:
        headers = {"User-Agent": "Mozilla/5.0", "Accept": "*/*"}

    try:
        _download_stl(req.url, dest, headers=headers)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Download failed: {exc}")

    return {"ok": True, "path": str(dest), "title": req.title}

@router.post("/slice", response_model=SliceResponse)
async def slice_model(req: SliceRequest):
    """Slice an STL file to G-code using OrcaSlicer."""
    stl_path = Path(req.stl_path)
    if not stl_path.exists():
        raise HTTPException(status_code=404, detail=f"STL not found: {req.stl_path}")

    safe_name = stl_path.stem
    gcode_path = SLICE_OUTPUT_DIR / f"{safe_name}_{datetime.now().strftime('%Y%m%d%H%M%S')}.gcode"

    try:
        _slice_stl(stl_path, gcode_path, profile=req.profile)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Slicing failed: {exc}")

    # Update job status in queue
    state = _load_state()
    for job in state["queue"]:
        if job["id"] == req.job_id:
            job["status"] = "sliced"
            job["gcode_path"] = str(gcode_path)
            break
    _save_state(state)

    return SliceResponse(
        ok=True,
        job_id=req.job_id,
        gcode_path=str(gcode_path),
        message=f"Sliced successfully: {gcode_path.name}",
    )

@router.post("/upload", response_model=UploadResponse)
async def upload_to_moonraker(req: dict):
    """Upload a G-code file to Moonraker's print directory."""
    gcode_path = Path(req.get("gcode_path", ""))
    if not gcode_path.exists():
        raise HTTPException(status_code=404, detail=f"G-code not found: {gcode_path}")

    job_id = req.get("job_id", "unknown")

    try:
        with gcode_path.open("rb") as f:
            files = {"file": (gcode_path.name, f, "application/octet-stream")}
            resp = requests.post(
                f"{MOONRAKER_BASE}/server/files/upload",
                files=files,
                timeout=120,
            )
            resp.raise_for_status()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Moonraker upload failed: {exc}")

    moonraker_path = f"//{gcode_path.name}"

    # Update job status
    state = _load_state()
    for job in state["queue"]:
        if job["id"] == job_id:
            job["status"] = "uploaded"
            job["moonraker_path"] = moonraker_path
            break
    _save_state(state)

    return UploadResponse(
        ok=True,
        job_id=job_id,
        moonraker_path=moonraker_path,
    )

@router.post("/start", response_model=ControlResponse)
async def start_print(req: StartPrintRequest):
    """Start a print job on Moonraker. Requires bed-clear confirmation if previous job exists."""
    state = _load_state()

    # Gate: if previous job finished, require explicit bed-clear confirmation
    if state.get("awaiting_bed_clear"):
        raise HTTPException(
            status_code=409,
            detail="Bed-clear confirmation required before starting next job. "
                   "Remove the finished print and click 'Confirm Bed Clear'.",
        )

    gcode_path = Path(req.gcode_path)
    moonraker_path = f"//{gcode_path.name}"

    try:
        resp = requests.post(
            f"{MOONRAKER_BASE}/printer/print/start",
            json={"filename": moonraker_path},
            timeout=15,
        )
        if resp.status_code == 409:
            raise HTTPException(status_code=409, detail="Printer is already printing or not ready.")
        resp.raise_for_status()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Start print failed: {exc}")

    # Update queue
    for job in state["queue"]:
        if job["id"] == req.job_id:
            job["status"] = "printing"
            job["started_at"] = datetime.now().isoformat()
            state["current_job"] = job
            break
    state["awaiting_bed_clear"] = False
    _save_state(state)

    return ControlResponse(
        ok=True,
        job_id=req.job_id,
        state="printing",
        message=f"Started: {moonraker_path}",
    )

@router.post("/pause")
async def pause_print(job_id: str = Query(...)):
    """Pause the current print."""
    try:
        resp = requests.post(f"{MOONRAKER_BASE}/printer/print/pause", timeout=15)
        resp.raise_for_status()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Pause failed: {exc}")

    state = _load_state()
    if state.get("current_job") and state["current_job"]["id"] == job_id:
        state["current_job"]["status"] = "paused"
    _save_state(state)

    return {"ok": True, "job_id": job_id, "state": "paused"}

@router.post("/resume")
async def resume_print(job_id: str = Query(...)):
    """Resume the current print."""
    try:
        resp = requests.post(f"{MOONRAKER_BASE}/printer/print/resume", timeout=15)
        resp.raise_for_status()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Resume failed: {exc}")

    state = _load_state()
    if state.get("current_job") and state["current_job"]["id"] == job_id:
        state["current_job"]["status"] = "printing"
    _save_state(state)

    return {"ok": True, "job_id": job_id, "state": "printing"}

@router.post("/cancel")
async def cancel_print(job_id: str = Query(...)):
    """Cancel the current print."""
    try:
        resp = requests.post(f"{MOONRAKER_BASE}/printer/print/cancel", timeout=15)
        resp.raise_for_status()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Cancel failed: {exc}")

    state = _load_state()
    if state.get("current_job") and state["current_job"]["id"] == job_id:
        state["current_job"]["status"] = "cancelled"
        state["current_job"]["finished_at"] = datetime.now().isoformat()
        state["current_job"] = None
    state["awaiting_bed_clear"] = False
    _save_state(state)

    return {"ok": True, "job_id": job_id, "state": "cancelled"}

@router.post("/confirm-bed-clear")
async def confirm_bed_clear():
    """Acknowledge that the finished print was removed and the bed is clear.

    This releases the gate so the next queued job can start.
    """
    state = _load_state()
    # Archive the completed job
    if state.get("current_job"):
        state["current_job"]["status"] = "done"
        state["current_job"]["finished_at"] = datetime.now().isoformat()
        state["history"].insert(0, state["current_job"])
        state["history"] = state["history"][:50]   # keep last 50
        state["current_job"] = None

    state["awaiting_bed_clear"] = False
    _save_state(state)

    return {"ok": True, "awaiting_bed_clear": False}

@router.get("/queue", response_model=QueueResponse)
async def get_queue():
    """Return the current job queue and state."""
    state = _load_state()
    return QueueResponse(
        jobs=state["queue"],
        current_job=state["current_job"],
        awaiting_bed_clear=state["awaiting_bed_clear"],
    )

@router.post("/queue/add")
async def add_to_queue(req: DownloadRequest):
    """Add a model to the queue by URL. Does NOT download/slice immediately."""
    import uuid
    job_id = str(uuid.uuid4())[:8]
    job = {
        "id": job_id,
        "model_title": req.title,
        "source": "unknown",
        "stl_url": req.url,
        "gcode_path": None,
        "status": "pending",
        "created_at": datetime.now().isoformat(),
        "started_at": None,
        "finished_at": None,
        "error": None,
    }
    state = _load_state()
    state["queue"].append(job)
    _save_state(state)

    return {"ok": True, "job": job}

@router.delete("/queue/{job_id}")
async def remove_from_queue(job_id: str):
    """Remove a job from the queue."""
    state = _load_state()
    state["queue"] = [j for j in state["queue"] if j["id"] != job_id]
    _save_state(state)
    return {"ok": True}

@router.post("/queue/{job_id}/download")
async def queue_download(job_id: str):
    """Download the STL for a queued job."""
    state = _load_state()
    job = next((j for j in state["queue"] if j["id"] == job_id), None)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found in queue")

    safe_name = "".join(c if c.isalnum() or c in ".-" else "_" for c in job["model_title"])[:80]
    dest = CACHE_DIR / f"{safe_name}_{job_id}.stl"

    try:
        _download_stl(job["stl_url"], dest)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Download failed: {exc}")

    job["stl_path"] = str(dest)
    job["status"] = "pending"   # ready to slice
    _save_state(state)

    return {"ok": True, "path": str(dest)}

@router.post("/queue/{job_id}/slice")
async def queue_slice(job_id: str, profile: Optional[str] = "0.20mm Standard"):
    """Slice a queued job whose STL has been downloaded."""
    state = _load_state()
    job = next((j for j in state["queue"] if j["id"] == job_id), None)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found in queue")

    stl_path = Path(job.get("stl_path", ""))
    if not stl_path.exists():
        raise HTTPException(status_code=400, detail="STL not downloaded yet. Run /download first.")

    safe_name = stl_path.stem
    gcode_path = SLICE_OUTPUT_DIR / f"{safe_name}_{job_id}.gcode"

    try:
        _slice_stl(stl_path, gcode_path, profile=(profile or "0.20mm Standard"))
    except Exception as exc:
        job["status"] = "failed"
        job["error"] = str(exc)
        _save_state(state)
        raise HTTPException(status_code=500, detail=f"Slicing failed: {exc}")

    job["status"] = "sliced"
    job["gcode_path"] = str(gcode_path)
    _save_state(state)

    return {"ok": True, "gcode_path": str(gcode_path)}

@router.post("/queue/{job_id}/upload")
async def queue_upload(job_id: str):
    """Upload a sliced G-code to Moonraker."""
    state = _load_state()
    job = next((j for j in state["queue"] if j["id"] == job_id), None)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found in queue")

    gcode_path = Path(job.get("gcode_path", ""))
    if not gcode_path.exists():
        raise HTTPException(status_code=400, detail="G-code not sliced yet. Run /slice first.")

    try:
        with gcode_path.open("rb") as f:
            files = {"file": (gcode_path.name, f, "application/octet-stream")}
            resp = requests.post(
                f"{MOONRAKER_BASE}/server/files/upload",
                files=files,
                timeout=120,
            )
            resp.raise_for_status()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Moonraker upload failed: {exc}")

    job["status"] = "uploaded"
    job["moonraker_path"] = f"//{gcode_path.name}"
    _save_state(state)

    return {"ok": True, "moonraker_path": job["moonraker_path"]}

@router.get("/history")
async def get_history():
    """Return completed/cancelled job history."""
    state = _load_state()
    return {"history": state.get("history", [])}

@router.get("/moonraker/info")
async def moonraker_info():
    """Return Moonraker server info and Klipper host version."""
    try:
        resp = _moonreq("GET", "/printer/info")
        return resp.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))
