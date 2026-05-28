# hermes-print-jobs

Hermes Agent dashboard plugin for managing 3D print jobs via Moonraker/Klipper.

## Features

- **STL Search** — search Printables, Thingiverse, and MakerWorld from the dashboard
- **Job Queue** — persistent queue with per-job pipeline state
- **Download → Slice → Upload → Print** — step-by-step pipeline with OrcaSlicer CLI
- **Moonraker Integration** — live printer status, start/pause/resume/cancel
- **Bed-Clear Gate** — after each print, you must confirm the bed is clear before the next job starts
- **History** — last 50 completed/cancelled jobs retained

## Requirements

- Hermes Agent with the dashboard plugin system
- Klipper + Moonraker + Fluidd running on your printer host
- [OrcaSlicer](https://github.com/SoftFever/OrcaSlicer) (Flatpak or system install)
- `requests` Python library

## Installation

```bash
# Clone into the user plugins directory
git clone https://github.com/pamplona007/hermes-print-jobs.git \
  ~/.hermes/plugins/hermes-print-jobs

# Restart Hermes dashboard (or hit /api/dashboard/plugins/rescan)
```

## Configuration

Environment variables (set in `~/.hermes/.env` or shell):

| Variable | Default | Description |
|---|---|---|
| `MOONRAKER_IP` | `192.168.1.133` | Printer's Moonraker IP |
| `MOONRAKER_PORT` | `7125` | Moonraker port |
| `PRINT_JOBS_CACHE` | `~/3dprint/stl_cache` | Where STLs are downloaded |
| `PRINT_JOBS_OUTPUT` | `~/3dprint/gcode_output` | Where G-code files are written |
| `PRINT_JOBS_STATE` | `~/.hermes/print-jobs-state.json` | Persistent job queue state |

### OrcaSlicer CLI

The plugin calls OrcaSlicer via Flatpak:

```bash
flatpak run com.orcaslicer.OrcaSlicer -g input.stl -o output.gcode --load /path/to/profile.ini
```

Ensure your print profiles are configured in OrcaSlicer first. The plugin will auto-detect
the first matching `.ini` profile in `~/.var/app/com.orcaslicer.OrcaSlicer/config/OrcaSlicer/printers/profiles/`.

## Usage

1. Open the **Print Jobs** tab in the Hermes dashboard
2. **Search** tab — search for models on Printables, Thingiverse, or MakerWorld
3. Click **Add to Queue** on any result
4. In the **Queue** tab:
   - **Download STL** — fetches the file to the local cache
   - **Slice** — runs OrcaSlicer to produce `.gcode`
   - **Upload to Moonraker** — pushes the G-code to the printer
   - **Start Print** — begins printing (blocked if a previous job just finished and bed isn't confirmed clear)
5. While printing: **Pause / Resume / Cancel**
6. When the print finishes: click **Confirm Bed Clear** before the next job can start
7. **History** tab shows completed/cancelled jobs

## Safety Workflow

The bed-clear gate exists to prevent the printer from starting a new job while
the previous print is still stuck to the bed. This protects both the model and
the printer from damage.

```
Print finishes → "⚠ Bed Clear Required" banner appears
User removes finished print and cleans bed
User clicks "✓ Confirm Bed Clear"
→ Next job in queue is unblocked and can be started
```

## API Routes

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/plugins/print-jobs/health` | Plugin health + version |
| `GET` | `/api/plugins/print-jobs/status` | Live printer status + queue |
| `GET` | `/api/plugins/print-jobs/search?q=` | Search all STL sources |
| `GET` | `/api/plugins/print-jobs/sources` | List available sources |
| `POST` | `/api/plugins/print-jobs/queue/add` | Add model URL to queue |
| `GET` | `/api/plugins/print-jobs/queue` | Get full queue |
| `DELETE` | `/api/plugins/print-jobs/queue/{job_id}` | Remove from queue |
| `POST` | `/api/plugins/print-jobs/queue/{job_id}/download` | Download STL |
| `POST` | `/api/plugins/print-jobs/queue/{job_id}/slice` | Slice STL to G-code |
| `POST` | `/api/plugins/print-jobs/queue/{job_id}/upload` | Upload to Moonraker |
| `POST` | `/api/plugins/print-jobs/start` | Start a print |
| `POST` | `/api/plugins/print-jobs/pause` | Pause current print |
| `POST` | `/api/plugins/print-jobs/resume` | Resume paused print |
| `POST` | `/api/plugins/print-jobs/cancel` | Cancel current print |
| `POST` | `/api/plugins/print-jobs/confirm-bed-clear` | Acknowledge bed cleared |
| `GET` | `/api/plugins/print-jobs/history` | Completed/cancelled jobs |

## Architecture

```
Browser (React IIFE)
  └─ SDK.fetchJSON("/api/plugins/print-jobs/...")
       └─ Hermes web server (FastAPI)
            └─ dashboard/plugin_api.py
                 ├─ Moonraker HTTP API (start/pause/status/etc.)
                 ├─ requests.get/post (download STLs)
                 └─ subprocess.run (OrcaSlicer CLI)
```

## Development

```bash
# Syntax check
python -m py_compile dashboard/plugin_api.py

# Verify routes load
python -c "
import importlib.util, sys
spec = importlib.util.spec_from_file_location('t', 'dashboard/plugin_api.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
print([r.path for r in mod.router.routes])
"

# Reload plugin (no restart needed)
curl -X POST http://localhost:3000/api/dashboard/plugins/rescan
```

## License

MIT
