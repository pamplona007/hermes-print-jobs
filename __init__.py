"""Hermes Print Jobs plugin.

Scaffold for a dashboard-integrated print workflow:
- STL search/discovery
- file download
- slicing (OrcaSlicer CLI)
- Moonraker upload/start/pause/cancel
- queue + status tracking
"""

from .plugin_api import router


def register(ctx):
    # The dashboard can mount these routes under /api/plugins/hermes-print-jobs/
    # once the plugin is loaded in ~/.hermes/plugins/hermes-print-jobs/.
    ctx.register_hook("post_tool_call", lambda *args, **kwargs: None)
    return {"router": router}
