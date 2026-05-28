from fastapi import APIRouter

router = APIRouter(prefix="/api/plugins/hermes-print-jobs", tags=["hermes-print-jobs"])

@router.get("/health")
def health():
    return {
        "ok": True,
        "service": "hermes-print-jobs",
        "features": [
            "stl_search",
            "stl_download",
            "slice",
            "moonraker_upload",
            "printer_start_pause_resume_cancel",
            "queue",
            "status",
        ],
    }
