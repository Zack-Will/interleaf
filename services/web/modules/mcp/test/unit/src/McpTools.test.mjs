import { describe, expect, it, vi } from "vitest";
import { createMcpServer } from "../../../app/src/McpTools.mjs";

function setup(overrides = {}) {
  const services = {
    ProjectRef: {
      parse: vi.fn((x) => ({
        projectId: x.includes("/") ? "a".repeat(24) : x,
      })),
      urlFor: (x) => `/project/${x}`,
      requireAccess: vi.fn(async () => {}),
    },
    SnapshotService: {
      getFileTree: vi.fn(async () => [{ path: "main.tex", kind: "doc" }]),
      readDoc: vi.fn(async () => ({
        path: "main.tex",
        lines: ["one", "two"],
        totalLines: 2,
        sha256: "hash",
        docVersion: 4,
      })),
    },
    VersionService: { getLatestVersion: vi.fn(async () => ({ version: 4 })) },
    LabelService: { listLabels: vi.fn(async () => []) },
    WriteService: {
      writeFiles: vi.fn(async () => ({ version: 5, applied: [], failed: [] })),
    },
    ProjectGetter: {
      promises: {
        findAllUsersProjects: vi.fn(async () => ({})),
        getProject: vi.fn(async () => ({ name: "P" })),
      },
    },
    ...overrides,
  };
  const server = createMcpServer({
    services,
    req: { syncUser: { userId: "u" } },
  });
  return { server, services };
}

describe("MCP tools", () => {
  it("parses project refs and reads line range", async () => {
    const { server, services } = setup();
    const result = await server._registeredTools.read_file.handler({
      project: "https://x/project/" + "a".repeat(24),
      path: "main.tex",
      start_line: 2,
      end_line: 2,
    });
    expect(services.ProjectRef.parse).toHaveBeenCalled();
    expect(result.structuredContent.content).toContain("two");
  });

  it("returns permission denial payload", async () => {
    const err = Object.assign(new Error("forbidden"), { code: "forbidden" });
    const { server } = setup({
      ProjectRef: {
        parse: (x) => ({ projectId: x }),
        requireAccess: vi.fn(async () => {
          throw err;
        }),
        urlFor: (x) => x,
      },
    });
    const result = await server._registeredTools.read_file.handler({
      project: "a".repeat(24),
      path: "main.tex",
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("forbidden");
  });

  it("returns the project history version separately from the document version", async () => {
    const { server } = setup({
      VersionService: { getLatestVersion: vi.fn(async () => ({ version: 9 })) },
    });
    const result = await server._registeredTools.read_file.handler({
      project: "a".repeat(24),
      path: "main.tex",
    });
    expect(result.structuredContent.project_version).toBe(9);
    expect(result.structuredContent.doc_version).toBe(4);
  });

  it("lists review and token read-only projects as read-only", async () => {
    const { server } = setup({
      ProjectGetter: {
        promises: {
          findAllUsersProjects: vi.fn(async () => ({
            owned: [{ _id: "owned", name: "Owned" }],
            review: [{ _id: "review", name: "Review" }],
            tokenReadOnly: [{ _id: "token-read", name: "Token read" }],
            tokenReadAndWrite: [{ _id: "token-write", name: "Token write" }],
          })),
        },
      },
    });
    const result = await server._registeredTools.list_projects.handler({});
    expect(result.structuredContent).toEqual([
      expect.objectContaining({ project_id: "owned", permissions: "write" }),
      expect.objectContaining({ project_id: "review", permissions: "read" }),
      expect.objectContaining({
        project_id: "token-read",
        permissions: "read",
      }),
      expect.objectContaining({
        project_id: "token-write",
        permissions: "write",
      }),
    ]);
  });

  it("returns the outline from the root document and one input", async () => {
    const readDoc = vi.fn(async (_id, path) => {
      if (path === "main.tex")
        return { path, lines: ["\\section{Root}", "\\input{parts/intro}"] };
      return { path, lines: ["\\subsection{Introduction}"] };
    });
    const { server } = setup({
      SnapshotService: {
        getFileTree: vi.fn(async () => [
          { path: "main.tex", kind: "doc" },
          { path: "parts/intro.tex", kind: "doc" },
        ]),
        readDoc,
      },
    });
    const result = await server._registeredTools.get_outline.handler({
      project: "a".repeat(24),
    });
    expect(result.structuredContent).toEqual([
      { path: "main.tex", line: 1, level: "section", title: "Root" },
      {
        path: "parts/intro.tex",
        line: 1,
        level: "subsection",
        title: "Introduction",
      },
    ]);
  });

  it("searches plain text and regular expressions", async () => {
    const { server } = setup({
      SnapshotService: {
        getFileTree: vi.fn(async () => [{ path: "main.tex", kind: "doc" }]),
        readDoc: vi.fn(async () => ({
          path: "main.tex",
          lines: ["alpha 123", "beta"],
          totalLines: 2,
        })),
      },
    });
    const plain = await server._registeredTools.search.handler({
      project: "a".repeat(24),
      query: "alpha",
    });
    const regex = await server._registeredTools.search.handler({
      project: "a".repeat(24),
      query: "^beta$",
      regex: true,
    });
    expect(plain.structuredContent).toEqual([
      { path: "main.tex", line: 1, text: "alpha 123" },
    ]);
    expect(regex.structuredContent).toEqual([
      { path: "main.tex", line: 2, text: "beta" },
    ]);
  });

  it("returns a structured error for an invalid regular expression", async () => {
    const { server } = setup();
    const result = await server._registeredTools.search.handler({
      project: "a".repeat(24),
      query: "[",
      regex: true,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("error");
  });

  it("returns labels and updates as distinct history entry types", async () => {
    const { server } = setup({
      LabelService: {
        listLabels: vi.fn(async () => [
          {
            version: 4,
            comment: "Agent change",
            user_id: "user-1",
            created_at: "2026-01-02T00:00:00Z",
          },
        ]),
      },
      fetchJson: vi.fn(async () => ({
        updates: [
          {
            from_version: 3,
            to_version: 4,
            origin: { kind: "mcp" },
            users: ["user-1"],
            timestamp: "2026-01-01T00:00:00Z",
            pathnames: ["main.tex"],
          },
        ],
      })),
      settings: { apis: { project_history: { url: "http://history" } } },
    });
    const result = await server._registeredTools.list_history.handler({
      project: "a".repeat(24),
    });
    expect(result.structuredContent).toEqual([
      {
        type: "label",
        version: 4,
        comment: "Agent change",
        user: "user-1",
        created_at: "2026-01-02T00:00:00Z",
      },
      {
        type: "update",
        from_version: 3,
        to_version: 4,
        origin: { kind: "mcp" },
        users: ["user-1"],
        timestamp: "2026-01-01T00:00:00Z",
        pathnames: ["main.tex"],
      },
    ]);
  });

  it("returns version conflict payload for writes", async () => {
    const err = Object.assign(new Error("conflict"), {
      code: "version_conflict",
      expectedVersion: 1,
      actualVersion: 2,
    });
    const { server } = setup({
      WriteService: {
        writeFiles: vi.fn(async () => {
          throw err;
        }),
      },
    });
    const result = await server._registeredTools.write_files.handler({
      project: "a".repeat(24),
      message: "m",
      files: [],
      base_version: 1,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.actual_version).toBe(2);
  });
});

describe("edit_file", () => {
  const call = async (edit, overrides = {}, lines = ["one", "two"]) => {
    const writeFiles = vi.fn(async () => ({
      version: 5,
      label: { comment: "m" },
    }));
    const { server } = setup({
      settings: { max_doc_length: 1000 },
      SnapshotService: {
        readDoc: vi.fn(async () => ({
          path: "main.tex",
          lines,
          totalLines: lines.length,
        })),
      },
      WriteService: { writeFiles },
      ...overrides,
    });
    const result = await server._registeredTools.edit_file.handler({
      project: "a".repeat(24),
      path: "main.tex",
      base_version: 4,
      edits: [edit],
      message: "edit",
    });
    return { result, writeFiles };
  };

  it("replaces a line range", async () => {
    const { result, writeFiles } = await call({
      type: "replace_range",
      start_line: 1,
      end_line: 1,
      new_text: "new",
    });
    expect(result.structuredContent.project_version).toBe(5);
    expect(writeFiles).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        files: [{ path: "main.tex", content: "new\ntwo" }],
      }),
    );
  });

  it("inserts with an empty line range", async () => {
    const { writeFiles } = await call({
      type: "replace_range",
      start_line: 2,
      end_line: 1,
      new_text: "inserted",
    });
    expect(writeFiles).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        files: [{ path: "main.tex", content: "one\ninserted\ntwo" }],
      }),
    );
  });

  it("replaces the requested anchor occurrence", async () => {
    const { writeFiles } = await call(
      { type: "replace_anchor", anchor: "one", occurrence: 2, new_text: "ONE" },
      {},
      ["one one", "two one"],
    );
    expect(writeFiles).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        files: [{ path: "main.tex", content: "one ONE\ntwo one" }],
      }),
    );
  });

  it("replaces a middle section and keeps the next section", async () => {
    const { writeFiles } = await call(
      {
        type: "replace_section",
        title: "one",
        new_text: "\\section{one}\nchanged",
      },
      {},
      [
        "\\section{one}",
        "old body",
        "\\section{two}",
        "two body",
        "\\end{document}",
      ],
    );
    expect(writeFiles).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        files: [
          {
            path: "main.tex",
            content:
              "\\section{one}\nchanged\n\\section{two}\ntwo body\n\\end{document}",
          },
        ],
      }),
    );
  });

  it("stops the last section at end document", async () => {
    const { writeFiles } = await call(
      {
        type: "replace_section",
        title: "last",
        new_text: "\\section{last}\nnew body",
      },
      {},
      ["\\section{last}", "old body", "\\end{document}"],
    );
    expect(writeFiles).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        files: [
          {
            path: "main.tex",
            content: "\\section{last}\nnew body\n\\end{document}",
          },
        ],
      }),
    );
  });

  it("stops a subsection at the next section or subsection", async () => {
    const { writeFiles } = await call(
      {
        type: "replace_section",
        title: "child",
        level: "subsection",
        new_text: "\\subsection{child}\nnew child",
      },
      {},
      [
        "\\section{parent}",
        "\\subsection{child}",
        "old child",
        "\\section{next}",
        "next body",
        "\\subsection{later}",
        "later body",
      ],
    );
    expect(writeFiles).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        files: [
          {
            path: "main.tex",
            content:
              "\\section{parent}\n\\subsection{child}\nnew child\n\\section{next}\nnext body\n\\subsection{later}\nlater body",
          },
        ],
      }),
    );
  });

  it("matches starred headings", async () => {
    const { writeFiles } = await call(
      {
        type: "replace_section",
        title: "x",
        new_text: "\\section*{x}\nnew body",
      },
      {},
      ["\\section*{x}", "old body", "\\section{next}", "next body"],
    );
    expect(writeFiles).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        files: [
          {
            path: "main.tex",
            content: "\\section*{x}\nnew body\n\\section{next}\nnext body",
          },
        ],
      }),
    );
  });

  it("rejects section replacement text without its heading", async () => {
    const { result } = await call(
      {
        type: "replace_section",
        title: "one",
        new_text: "changed",
      },
      {},
      ["\\section{one}", "old body", "\\end{document}"],
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("invalid_edit");
  });

  it("reports ambiguous anchors and oversized files", async () => {
    const ambiguous = await call(
      { type: "replace_anchor", anchor: "o", new_text: "x" },
      {
        SnapshotService: {
          readDoc: vi.fn(async () => ({ lines: ["one", "two"] })),
        },
      },
    );
    expect(ambiguous.result.structuredContent.code).toBe("anchor_ambiguous");
    const large = await call(
      {
        type: "replace_range",
        start_line: 1,
        end_line: 1,
        new_text: "x".repeat(20),
      },
      { settings: { max_doc_length: 2 } },
    );
    expect(large.result.structuredContent.code).toBe("file_too_large");
  });
});
