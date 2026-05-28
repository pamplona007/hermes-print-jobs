import os
import json
import requests
from fastapi import APIRouter, Query, HTTPException

router = APIRouter()

# Configuration
PRINTER_IP = "192.168.1.133"
MOONRAKER_PORT = 7125
BASE_URL = f"http://{PRINTER_IP}:{MOONRAKER_PORT}"

# Shared State (for demo purposes)
# In production, use a persistent store (e.g., SQLite or json file)
printer_state = {
    "awaiting_bed_clear": False,
    "queue": []
}

@router.get("/health")
async def health():
    return {"ok": True, "printer_url": BASE_URL}

@router.get("/status")
async def status():
    try:
        # Query printer status from Moonraker
        res = requests.get(f"{BASE_URL}/printer/objects/query?webhooks&print_stats", timeout=5)
        res.raise_for_status()
        data = res.json()["result"]["status"]
        
        return {
            "webhooks": data.get("webhooks", {}),
            "print_stats": data.get("print_stats", {}),
            "awaiting_bed_clear": printer_state["awaiting_bed_clear"],
            "queue_length": len(printer_state["queue"])
        }
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Moonraker error: {str(e)}")

@router.post("/confirm-bed-clear")
async def confirm_bed_clear():
    printer_state["awaiting_bed_clear"] = False
    return {"status": "ok", "message": "Printer ready for next job."}

# Search functionality (placeholder for real integration)
@router.get("/search")
async def search(q: str = Query(...)):
    # Strategy: 
    # Use Printables/Thingiverse search URLs
    # Printables: https://www.printables.com/search/models?q={q}
    # Thingiverse: https://www.thingiverse.com/search?q={q}&type=things
    return {
        "query": q,
        "results": [
            {"title": f"Model: {q}", "source": "Printables", "url": f"https://www.printables.com/search/models?q={q}"}
        ]
    }
