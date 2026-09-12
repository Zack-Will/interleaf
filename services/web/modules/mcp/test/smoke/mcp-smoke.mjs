#!/usr/bin/env node

// A dependency-light smoke check for the MCP wiring.  It uses the SDK's
// in-memory transport, so no web process (or Docker services) are required.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "../../app/src/McpTools.mjs";

const projectId = "0123456789abcdef01234567";

const services = {
  ProjectRef: {
    parse(value) {
      if (
        value === projectId ||
        value === `https://example.test/project/${projectId}`
      ) {
        return { projectId };
      }
      throw new Error(`invalid project: ${value}`);
    },
    urlFor(id) {
      return `https://example.test/project/${id}`;
    },
    async requireAccess() {},
  },
  VersionService: {
    async getLatestVersion() {
      return { version: 3, timestamp: new Date().toISOString() };
    },
  },
  SnapshotService: {
    async readDoc(_id, path, { startLine = 1, endLine } = {}) {
      const lines = [
        "\\section{Introduction}",
        "Hello from the smoke test.",
        "Done.",
      ];
      const first = Math.max(1, startLine);
      const last = Math.min(lines.length, endLine ?? lines.length);
      return {
        path,
        lines: lines.slice(first - 1, last),
        totalLines: lines.length,
        sha256: "smoke-sha256",
        docVersion: 3,
      };
    },
  },
};

const server = createMcpServer({
  services,
  req: { syncUser: { userId: "smoke-user" } },
  clientName: "smoke-client",
});

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "smoke-client", version: "1.0.0" });

await server.connect(serverTransport);
await client.connect(clientTransport);

const listed = await client.listTools();
const read = await client.callTool(
  {
    name: "read_file",
    arguments: {
      project: projectId,
      path: "main.tex",
      start_line: 2,
      end_line: 2,
    },
  },
  CallToolResultSchema,
);

console.log(`tools/list: ${listed.tools.map((tool) => tool.name).join(", ")}`);
console.log(`read_file: ${JSON.stringify(read)}`);

await client.close();
await server.close();
