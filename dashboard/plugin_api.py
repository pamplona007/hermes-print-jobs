"""Print Jobs dashboard plugin backend API.

Mounted under the dashboard plugin system. This first pass exposes health,
printer status, queue state, and search hooks.
"""

from __future__ import annotations

from fastapi import APIRouter, Query

router = APIRouter()

PRINTER_IP = "192.168.1.133"
MOONRAKER_PORT = 7125


@router.get("/health")
async def health():
    return {
        "ok": True,
        "plugin": "print-jobs",
        "version": "0.1.0",
        "printer": f"http://{PRINTER_IP}:{MOONRAKER_PORT}",
        "features": [
            "search_stl_sources",
            "choose_model",
            "download_stl",
            "slice_with_orca",
            "upload_to_moonraker",
            "start_pause_resume_cancel",
            "queue",
            "status",
            "bed-clear confirmation",
        ],
    }


@router.get("/status")
async def status():
    # This route is a placeholder for the live Moonraker integration.
    return {
        "printer": "Ender 3 V3 KE",
        "moonraker": f"{PRINTER_IP}:{MOONRAKER_PORT}",
        "state": "ready",
        "queue": [],
        "current_job": None,
        "awaiting_bed_clear": False,
    }


@router.get("/search")
async def search(q: str = Query(..., min_length=1)):
    # Placeholder search results for the first iteration.
    # Next step: wire search providers and return real public STL links.
    return {
        "query": q,
        "results": [
            {
                "title": "STAND FOR EDIFIER R1080BT",
                "source": "Printables",
                "url": "https://www.printables.com/model/1444395-stand-for-edifier-r1080bt",
                "description": "Exact-fit stand for Edifier R1080BT",
            }
        ],
    }


@router.post("/confirm-bed-clear")
async def confirm_bed_clear():
    # Will be used to release the queue gate after a finished print.
    return {"ok": True, "awaiting_bed_clear": False}
