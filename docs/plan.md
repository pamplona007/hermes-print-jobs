# Print Jobs Plugin Plan

## User story
- User asks for a model or object.
- Plugin searches public STL sources.
- Plugin shows a ranked list.
- User picks one.
- Plugin downloads STL.
- Plugin slices with OrcaSlicer using the Ender 3 V3 KE 0.4 profile.
- Plugin uploads to Moonraker.
- Plugin starts the print.
- Plugin tracks state.
- When a print finishes, plugin asks the user to remove the print and confirm the bed is clear before queueing the next one.

## Important workflow rule
- Do not start the next queued print until the user confirms the bed is ready.

## Suggested backend endpoints
- GET /health
- GET /search?q=
- POST /choose
- POST /download
- POST /slice
- POST /upload
- POST /start
- POST /queue
- GET /status
- POST /confirm-bed-clear

## Next implementation steps
1. Search provider adapters (Printables, Thingiverse, MakerWorld)
2. Download + caching layer
3. OrcaSlicer pipeline
4. Moonraker queue + state polling
5. Bed-clear confirmation gate
6. Public GitHub repo README + install docs
