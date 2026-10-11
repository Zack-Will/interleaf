# Live-preview protocol

Shared wire-format helpers for the web module and preview service. `Frames.mjs`
and `DisplayList.mjs` use browser primitives and accept typed arrays or
ArrayBuffers. `Tickets.mjs` uses Node crypto for HMAC opening tickets and HTTP
access tokens. Import these entries individually so browser bundles never load
Node crypto. There are no service dependencies; protocol errors use the existing
`@overleaf/o-error` workspace library.

Run `yarn test:unit` in this directory. CE copies all of `libraries/`; the web
Dockerfile includes this workspace for its dev and webpack images. Develop web
and webpack mount it explicitly, while live-preview mounts the whole repository.
Rebuild older web/webpack images after adding this workspace so their installed
dependencies contain its workspace link.

Editor source annotations use optional `path`, `doc_id` and half-open
`range: {start, end}` fields in background and error-paragraph headers. Offsets
are UTF-16 code units of the named document, not UTF-8 bytes. Background headers
include `versions.source_revision` for layout ordering. These additions retain
the existing frame encoding and type ids. A removed or unidentified unit may have
no range. See `services/live-preview/README.md` for notification resync and
diagnostics semantics.

The release implementation limits client WebSocket messages to 4 KiB and accepts
only ping/resync. Opening tickets authorize a single project; HTTP access tokens
cannot open sockets. PDF/glyph requests recheck tokens and use private `no-store`
responses, including after service restarts. See
[the consolidated verification](../../doc/design/live-preview-verification.md)
for the protocol, service and real-TeX acceptance results.
