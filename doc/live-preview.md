# Live preview

Live preview re-typesets supported paragraphs as you edit and draws them over the
PDF. A background LuaLaTeX pass updates complete pages, references and floating
figures. Everyone viewing the same project receives the same results, including
changes made by collaborators, agents and Git.

## Requirements and enabling

Your server administrator must enable live preview and install the Interleaf
image with rtex and TeX Live. The project compiler must be **LuaLaTeX**. Change
the compiler in the project settings, confirm that a normal Recompile succeeds,
then choose **Live preview** in the Recompile dropdown. Existing pdfLaTeX and
XeLaTeX projects need a deliberate LuaLaTeX migration; changing the compiler can
change fonts and line breaks. For example, acmart's LuaLaTeX math setup conflicts
with some templates that also load `newtxmath`.

The choice is remembered per project and shared with detached PDF windows. Each
window has its own connection. Closing one window leaves the others working.
Choose Live preview again to turn it off and restore normal autocompile. Changing
the compiler away from LuaLaTeX turns live preview off.

## What updates live

Ordinary paragraphs, supported headings and supported math can update before
the next complete pass. The result uses LuaLaTeX's fonts and positioning. Chinese
paragraphs work with Fandol fonts in a `ctexbook` LuaLaTeX project; the browser
fetches outlines for the glyphs it needs.

Page breaks, floats, bibliography and cross-references settle after background
passes. Preamble changes restart the engine. Pictures, transformed graphics,
unsupported TeX commands and paragraphs without a safe captured context also
wait for complete pages. Some included plots can take several seconds. Keep
editing while the toolbar reports Updating or Stale; Converged means the pass
has settled. Pass limit reached means another full compilation may be needed.

A live TeX error keeps the last good drawing visible. The PDF currently on screen
can therefore represent an earlier version while you correct the source.
**Recompile**, keyboard compilation shortcuts and PDF download use the normal
Overleaf compiler. Use a successful normal compilation for a final submission.

## Source markers and logs

Gutter dots mark source that is waiting for a complete pass or contains a live
TeX error. Hover over a dot to see the reason. Markers follow edits and disappear
when a live result or a sufficiently recent page incorporates the change.
Switching files shows that file's markers.

Open Logs to see the separately labelled live diagnostics beside normal compile
logs. Go to code location opens the relevant file and line. A clean pass clears
old errors. Normal compile tab counters count the normal compiler's entries.

## Collaboration and recovery

An active project sends editor changes more frequently (about every 150 ms).
This applies to collaborators with live preview turned off as well. The normal
delay returns when the project session stops or its activity lease expires.
Remote changes briefly receive an outline in the collaborator's cursor colour;
anonymous viewers use grey.

A temporary connection loss displays Reconnecting, obtains a fresh ticket and
rebuilds the preview after a service restart. If the engine repeatedly crashes or
the source service is unavailable, the toolbar shows Failed and offers **Retry**.
Correct the source or wait for the service to recover, then retry. A busy server
explains that its preview capacity is occupied. Normal compilation remains
available, and autocompile resumes while live preview is unavailable.

## Limits

The server normally allows two active projects, shared across their viewers.
An unused session can be evicted to make room; sessions with no viewers stop after
five minutes. The default connection limits are 16 windows per project and eight
per user. Snapshots allow 2,000 documents/files, 32 MiB per file and 256 MiB total;
the internal JSON read limit is 64 MiB. Projects beyond these limits can use normal
compilation. TeX shell escape and arbitrary absolute file reads are disabled in
live sessions, so projects depending on external commands need another workflow.

Operators should use [the deployment runbook](deploy-toolkit.md) for memory
budgets and proxy settings. Detailed release evidence is in
[live-preview verification](design/live-preview-verification.md).
