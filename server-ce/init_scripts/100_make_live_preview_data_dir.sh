#!/bin/bash
set -e

if [ "$LIVE_PREVIEW_ENABLED" = "true" ] && [ -z "$LIVE_PREVIEW_TICKET_SECRET" ]; then
    echo 'LIVE_PREVIEW_ENABLED requires LIVE_PREVIEW_TICKET_SECRET' >&2
    exit 1
fi

install -d -o www-data -g www-data "${LIVE_PREVIEW_DATA_DIR:-/var/lib/overleaf/data/live-preview}"
