# Split Deployment

This repo now supports running the system in 3 roles from the same codebase:

- `listener`
- `alert-worker`
- `video-worker`

The split is driven by env flags:

- `INGRESS_ENABLED`
- `ALERT_PROCESSING_ENABLED`
- `VIDEO_PROCESSING_ENABLED`
- `ALERT_WORKER_URL`
- `VIDEO_WORKER_URL`
- `INTERNAL_WORKER_TOKEN`

## Recommended topology

### Listener

Owns:

- JT808 TCP ingress
- RTP UDP ingress
- protocol parsing / routing

Does not own:

- alert persistence/notification
- HLS/video writing

Recommended env:

```env
API_PORT=3000
INGRESS_ENABLED=true
ALERT_PROCESSING_ENABLED=false
VIDEO_PROCESSING_ENABLED=false
LOCAL_BUFFER_CAPTURE_ENABLED=false

ALERT_WORKER_URL=http://ALERT_SERVER_IP:3000
VIDEO_WORKER_URL=http://VIDEO_SERVER_IP:3000
INTERNAL_WORKER_TOKEN=replace_me
CORS_ORIGIN=*
```

### Alert worker

Owns:

- alert creation
- alert storage
- alert websocket/api

Does not own:

- external TCP/UDP device ingress
- video/HLS processing

Recommended env:

```env
API_PORT=3100
INGRESS_ENABLED=false
ALERT_PROCESSING_ENABLED=true
VIDEO_PROCESSING_ENABLED=false
LOCAL_BUFFER_CAPTURE_ENABLED=false

LISTENER_SERVER_URL=http://LISTENER_SERVER_IP:3000
INTERNAL_WORKER_TOKEN=replace_me
CORS_ORIGIN=*
```

### Video worker

Owns:

- RTP packet processing
- frame assembly
- HLS/video writing
- live stream / replay related processing

Does not own:

- external TCP/UDP device ingress
- alert generation

Recommended env:

```env
API_PORT=3200
INGRESS_ENABLED=false
ALERT_PROCESSING_ENABLED=false
VIDEO_PROCESSING_ENABLED=true
LOCAL_BUFFER_CAPTURE_ENABLED=true

INTERNAL_WORKER_TOKEN=replace_me
CORS_ORIGIN=*
```

## Internal ingest endpoints

These routes are mounted on the worker nodes:

- `POST /api/internal/ingest/location-alert`
- `POST /api/internal/ingest/external-alert`
- `POST /api/internal/ingest/rtp`

If `INTERNAL_WORKER_TOKEN` is set, the listener must send it as:

- `X-Internal-Token: <token>`

## Important note on load

This split reduces pressure by moving heavy work off the ingest server.

Biggest win:

- moving video/HLS/file writing away from the listener

Moderate win:

- moving alert persistence / screenshot orchestration away from the listener

Current implementation note:

- RTP forwarding is currently HTTP-based to the video worker

That is acceptable for an initial split, but for very high throughput it may still be chatty.

If needed later, phase 2 should switch video forwarding to:

- direct RTP ingress on the video worker, or
- a lightweight internal transport / queue
