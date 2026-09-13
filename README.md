<h1 align="center">Interleaf</h1>

<h4 align="center">A fork of Overleaf Community Edition where an AI agent is a first-class collaborator.</h4>

<p align="center">
  <a href="#what-this-adds">What this adds</a> •
  <a href="#quick-start">Quick start</a> •
  <a href="#documentation">Documentation</a> •
  <a href="#relationship-to-overleaf">Relationship to Overleaf</a> •
  <a href="#license">License</a>
</p>

Overleaf Community Edition is a collaborative LaTeX editor built for people
sitting in front of a browser. Interleaf keeps all of that and adds the two
things an agent needs in order to work on the same document as those people: a
machine-usable interface, and a shared history where a human can see what the
agent did and undo it.

The name is the point. Interleaving is what happens when an agent and an author
take turns on the same pages: the agent proposes, the human reads the margin
notes, accepts some of it, and the timeline records both hands.

## What this adds

- **A built-in MCP endpoint** at `POST /mcp`, spoken by any Model Context
  Protocol client. An agent reads and writes files, follows the history, opens
  and merges branches, reads review comments and replies to them, and offers
  edits as tracked changes for a person to accept or reject. It is stateless
  and authenticated with a personal access token.
- **Comment-driven collaboration.** Upstream's review panel exists in the
  Community Edition source but is switched off. Interleaf turns it on, adds the
  web routes it needs, and gives an agent a service account of its own, so a
  comment thread reads as a conversation between named participants. Comments
  survive rewrites of the text they are anchored to.
- **A readable change history.** Every agent write carries the name of the
  client and the message it sent, shown under the author line in the history
  panel. Labels stay what they are upstream, milestones a human chose, rather
  than one label per machine edit.
- **Git access on Community Edition.** The web half of the official Java
  git-bridge, so `git clone` and `git push` work against a project. Upstream
  ships the bridge itself under the MIT licence but keeps the web adapter in
  Server Pro; this one is written from scratch.
- **One-way GitHub backup.** Link a project to a repository and its history is
  mirrored there on a schedule or on demand, fast-forward only, with the tokens
  encrypted at rest.

## Quick start

Interleaf is a drop-in replacement for the `sharelatex/sharelatex` image, so the
[Overleaf Toolkit](https://github.com/overleaf/toolkit) is the shortest path.
See [`doc/deploy-toolkit.md`](doc/deploy-toolkit.md) for the full runbook,
including the one patch the toolkit needs before it will run git-bridge outside
Server Pro.

For a development stack that reloads on code changes, see
[`doc/design/dev-environment.md`](doc/design/dev-environment.md).

Connect an agent once the server is up:

```bash
claude mcp add --transport http interleaf https://your-host/mcp \
  --header "Authorization: Bearer olp_your_token"
```

## Documentation

| Document | What it covers |
|---|---|
| [`doc/agent-sync-usage.md`](doc/agent-sync-usage.md) | Enabling the features, tokens, the MCP tools, the comment workflow, Git |
| [`doc/github-backup.md`](doc/github-backup.md) | Linking a project to GitHub and what the statuses mean |
| [`doc/deploy-toolkit.md`](doc/deploy-toolkit.md) | Building the image and rolling it out with the Overleaf Toolkit |
| [`doc/design/agent-sync-architecture.md`](doc/design/agent-sync-architecture.md) | Why the design looks like this, and the decisions behind it |
| [`doc/design/github-backup.md`](doc/design/github-backup.md) | The mirror job, its data model and its failure modes |
| [`AGENTS.md`](AGENTS.md) | Conventions for anyone, human or agent, changing this repository |

## Relationship to Overleaf

Interleaf is an independent fork of
[overleaf/overleaf](https://github.com/overleaf/overleaf). It is **not**
affiliated with, endorsed by, or supported by Overleaf. Overleaf and ShareLaTeX
are trademarks of their respective owners; this project uses those names only to
say where it came from.

Everything here is either upstream's own open-source code or written from
scratch against public interfaces. No Server Pro source was used. The
interfaces the new modules implement come from the MIT-licensed
[`services/git-bridge`](services/git-bridge) in this same repository and from
the Community Edition code around them.

If you want a supported product with a warranty behind it, buy
[Overleaf Server Pro](https://www.overleaf.com/for/enterprises). Their revenue
is what pays for the Community Edition this fork is built on.

The upstream README is kept at
[`doc/README.overleaf.md`](doc/README.overleaf.md).

> [!CAUTION]
> This inherits the Community Edition security model: it is meant for
> environments where **all** users are trusted. Without sandboxed compiles a
> user can read and write the container's filesystem, network and environment
> during a LaTeX compile. Giving an agent write access does not change that
> boundary, it just means a program is now standing inside it.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for upstream's process, which applies
to anything that belongs upstream. For this fork, open an issue first; changes
that make agent collaboration clearer are welcome, changes that diverge from
upstream for no reason are not.

## License

GNU Affero General Public License, version 3, the same as upstream. A copy is in
[`LICENSE`](LICENSE).

Copyright (c) Overleaf, 2014-2025, for the upstream work.
Copyright (c) the Interleaf contributors, 2026, for the changes in this fork.

[`services/git-bridge`](services/git-bridge) remains under its own MIT licence.

Because this is AGPL software, anyone you let use a server running it is
entitled to its source. If you deploy a modified copy, publish your changes and
link to them from the running instance.
