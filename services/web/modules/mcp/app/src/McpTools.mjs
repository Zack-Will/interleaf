import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const textResult = (data, text = JSON.stringify(data)) => ({
  content: [{ type: "text", text }],
  structuredContent: data,
});

const errorResult = (error, next = "check request") => ({
  isError: true,
  content: [{ type: "text", text: error.message || String(error) }],
  structuredContent: {
    code: error.code || "error",
    message: error.message || String(error),
    ...(error.expectedVersion != null
      ? { expected_version: error.expectedVersion }
      : {}),
    ...(error.actualVersion != null
      ? { actual_version: error.actualVersion }
      : {}),
    next_action: next,
  },
});

function projectId(ref, services) {
  return services.ProjectRef.parse(ref).projectId;
}

async function access(services, request, id, level = "read") {
  return services.ProjectRef.requireAccess(request.syncUser.userId, id, level);
}

export function registerTools(
  server,
  { services = {}, req = {}, clientName } = {},
) {
  const userId = req.syncUser?.userId;
  const run = async (fn, next) => {
    try {
      return textResult(await fn());
    } catch (error) {
      return errorResult(error, next);
    }
  };

  server.tool("list_projects", "List projects", {}, async () =>
    run(async () => {
      const all = await services.ProjectGetter.promises.findAllUsersProjects(
        userId,
        "name lastUpdated",
      );
      const output = [];
      for (const [key, projects] of Object.entries(all || {})) {
        for (const project of projects || []) {
          const id = String(project._id || project.id || project.projectId);
          const write =
            key === "owned" ||
            key === "readAndWrite" ||
            key === "tokenReadAndWrite";
          output.push({
            project_id: id,
            url: services.ProjectRef.urlFor(id),
            name: project.name,
            permissions: write ? "write" : "read",
          });
        }
      }
      return output;
    }),
  );

  server.tool(
    "get_project",
    "Get project metadata",
    { project: z.string() },
    async ({ project }) =>
      run(async () => {
        const id = projectId(project, services);
        await access(services, req, id);
        const projectData = await services.ProjectGetter.promises.getProject(
          id,
          {
            name: 1,
            rootDoc_id: 1,
          },
        );
        const tree = await services.SnapshotService.getFileTree(id);
        const version = await services.VersionService.getLatestVersion(id);
        let permissions = "read";
        try {
          await services.ProjectRef.requireAccess(userId, id, "write");
          permissions = "write";
        } catch (error) {
          if (error?.code === "not_found") throw error;
        }
        let root;
        if (projectData?.rootDoc_id) {
          try {
            const paths =
              await services.ProjectEntityHandler.promises.getAllDocPathsFromProjectById(
                id,
              );
            root =
              paths[String(projectData.rootDoc_id)] ||
              paths[projectData.rootDoc_id];
          } catch {}
        }
        root ||= tree.find((file) => file.kind === "doc")?.path;
        return {
          project_id: id,
          url: services.ProjectRef.urlFor(id),
          name: projectData?.name,
          root_doc_path: root,
          project_version: version.version,
          permissions,
          files: tree,
        };
      }),
  );

  server.tool(
    "read_file",
    "Read a text file",
    {
      project: z.string(),
      path: z.string(),
      start_line: z.number().optional(),
      end_line: z.number().optional(),
    },
    async ({ project, path, start_line, end_line }) =>
      run(async () => {
        const id = projectId(project, services);
        await access(services, req, id);
        const document = await services.SnapshotService.readDoc(id, path, {
          startLine: start_line,
          endLine: end_line,
        });
        const lines = document.lines
          .map((line, index) => `${(start_line || 1) + index}: ${line}`)
          .join("\n");
        const latest = await services.VersionService.getLatestVersion(id);
        return {
          path: document.path,
          content: lines,
          lines: document.lines,
          project_version: latest.version,
          doc_version: document.docVersion,
          sha256: document.sha256,
          total_lines: document.totalLines,
        };
      }),
  );

  server.tool(
    "get_outline",
    "Get LaTeX outline",
    { project: z.string(), path: z.string().optional() },
    async ({ project, path }) =>
      run(async () => {
        const id = projectId(project, services);
        await access(services, req, id);
        const tree = await services.SnapshotService.getFileTree(id);
        const root = path || tree.find((file) => file.kind === "doc")?.path;
        const documents = [];
        if (root) documents.push(root);
        if (!path && root) {
          const rootDocument = await services.SnapshotService.readDoc(
            id,
            root,
            {},
          );
          for (const line of rootDocument.lines) {
            const match = line.match(/\\(?:input|include)\{([^}]+)\}/);
            if (match) {
              documents.push(
                match[1].endsWith(".tex") ? match[1] : `${match[1]}.tex`,
              );
            }
          }
        }
        const output = [];
        for (const documentPath of documents) {
          try {
            const document = await services.SnapshotService.readDoc(
              id,
              documentPath,
              {},
            );
            document.lines.forEach((line, index) => {
              const match = line.match(
                /^\s*\\(part|chapter|section|subsection|subsubsection)\*?\{([^}]*)\}/,
              );
              if (match) {
                output.push({
                  path: documentPath,
                  line: index + 1,
                  level: match[1],
                  title: match[2],
                });
              }
            });
          } catch {}
        }
        return output;
      }),
  );

  server.tool(
    "search",
    "Search project files",
    {
      project: z.string(),
      query: z.string(),
      regex: z.boolean().optional(),
      max_results: z.number().optional(),
    },
    async ({ project, query, regex, max_results = 50 }) =>
      run(async () => {
        const id = projectId(project, services);
        await access(services, req, id);
        const tree = await services.SnapshotService.getFileTree(id);
        const expression = regex ? new RegExp(query) : null;
        const output = [];
        for (const file of tree.filter((item) => item.kind === "doc")) {
          const document = await services.SnapshotService.readDoc(
            id,
            file.path,
            {},
          );
          document.lines.forEach((text, index) => {
            if (
              output.length < max_results &&
              (expression ? expression.test(text) : text.includes(query))
            ) {
              output.push({ path: file.path, line: index + 1, text });
            }
          });
        }
        return output;
      }),
  );

  server.tool(
    "list_history",
    "List project history",
    { project: z.string(), limit: z.number().optional() },
    async ({ project, limit = 50 }) =>
      run(async () => {
        const id = projectId(project, services);
        await access(services, req, id);
        const labels = await services.LabelService.listLabels(id);
        const updatesResponse = await services.fetchJson(
          `${services.settings.apis.project_history.url}/project/${id}/updates?min_count=${limit}`,
        );
        const updates = Array.isArray(updatesResponse)
          ? updatesResponse
          : updatesResponse?.updates || [];
        const normalizedLabels = (labels || []).map((label) => ({
          type: "label",
          version: label.version,
          comment: label.comment,
          user: label.user || label.user_id,
          created_at: label.created_at || label.createdAt || label.timestamp,
        }));
        const normalizedUpdates = updates.map((update) => ({
          type: "update",
          from_version: update.from_version ?? update.fromVersion,
          to_version: update.to_version ?? update.toVersion,
          origin: update.origin,
          users: update.users || (update.user_id ? [update.user_id] : []),
          timestamp: update.timestamp,
          pathnames: update.pathnames || update.paths,
        }));
        return [...normalizedLabels, ...normalizedUpdates]
          .sort(
            (left, right) =>
              new Date(right.created_at || right.timestamp || 0) -
              new Date(left.created_at || left.timestamp || 0),
          )
          .slice(0, limit);
      }),
  );

  server.tool(
    "diff",
    "Compare project versions",
    {
      project: z.string(),
      from_version: z.number(),
      to_version: z.number(),
      path: z.string().optional(),
    },
    async ({ project, from_version, to_version, path }) =>
      run(async () => {
        const id = projectId(project, services);
        await access(services, req, id);
        const url = path
          ? `${services.settings.apis.project_history.url}/project/${id}/diff?pathname=${encodeURIComponent(path)}&from=${from_version}&to=${to_version}`
          : `${services.settings.apis.project_history.url}/project/${id}/filetree/diff?from=${from_version}&to=${to_version}`;
        return services.fetchJson(url);
      }),
  );

  server.tool(
    "write_files",
    "Write project files",
    {
      project: z.string(),
      message: z.string(),
      files: z.array(
        z.object({
          path: z.string(),
          content: z.string().optional(),
          contentBase64: z.string().optional(),
          delete: z.boolean().optional(),
        }),
      ),
      base_version: z.number().optional(),
      agent: z.string().optional(),
    },
    async ({ project, message, files, base_version, agent }) => {
      try {
        const id = projectId(project, services);
        await access(services, req, id, "write");
        const result = await services.WriteService.writeFiles(id, userId, {
          baseVersion: base_version,
          message,
          agent: agent || clientName || "mcp",
          files,
        });
        return textResult(result);
      } catch (error) {
        return errorResult(
          error,
          error.code === "version_conflict"
            ? `re-read changed files and retry with base_version=${error.actualVersion}`
            : undefined,
        );
      }
    },
  );
  return server;
}

export function createMcpServer(options = {}) {
  const server = new McpServer({ name: "overleaf-mcp", version: "1.0.0" });
  registerTools(server, options);
  return server;
}
