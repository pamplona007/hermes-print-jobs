# Hermes Print Jobs

A Hermes dashboard plugin for 3D printing workflows:

- search public STL files from the web
- let the user choose one from the list
- download the STL
- slice it with OrcaSlicer for an Ender 3 V3 KE
- upload to Moonraker
- start the print
- track printer status and queue
- ask the user to remove finished prints before starting the next queued job

## Status

This is the first scaffold version. The repo now contains:
- dashboard plugin manifest
- dashboard UI stub
- backend route scaffold
- project plan

## Install target

Copy to:

`~/.hermes/plugins/hermes-print-jobs/`

The current Hermes dashboard plugin model expects the dashboard assets under a `dashboard/` directory.
