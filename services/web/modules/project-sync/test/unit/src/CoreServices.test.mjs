import { describe, it, expect, vi } from "vitest";
import sinon from "sinon";
describe("project-sync core services", () => {
  it("parses project ids and URLs", async () => {
    vi.resetModules();
    vi.doMock("@overleaf/settings", () => ({
      default: { siteUrl: "https://ol" },
    }));
    const { default: ProjectRef } =
      await import("../../../app/src/ProjectRef.mjs");
    expect(ProjectRef.parse("68c1f9a3e4b0c2d1a5f6e7b8")).toEqual({
      projectId: "68c1f9a3e4b0c2d1a5f6e7b8",
    });
    expect(
      ProjectRef.parse("https://x/project/68c1f9a3e4b0c2d1a5f6e7b8/foo"),
    ).toEqual({ projectId: "68c1f9a3e4b0c2d1a5f6e7b8" });
    expect(() => ProjectRef.parse("bad")).toThrow();
  });
  it("flushes document updater before history", async () => {
    vi.resetModules();
    const order = [];
    vi.doMock("@overleaf/settings", () => ({
      default: { apis: { project_history: { url: "http://history" } } },
    }));
    vi.doMock("@overleaf/fetch-utils", () => ({
      fetchJson: sinon.stub().callsFake(async () => {
        order.push("fetch");
        return { version: 3 };
      }),
    }));
    vi.doMock(
      "../../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs",
      () => ({
        default: {
          promises: { flushProjectToMongo: async () => order.push("doc") },
        },
      }),
    );
    vi.doMock(
      "../../../../../app/src/Features/History/HistoryManager.mjs",
      () => ({
        default: { promises: { flushProject: async () => order.push("hist") } },
      }),
    );
    const { default: VersionService } =
      await import("../../../app/src/VersionService.mjs");
    await VersionService.getLatestVersion("p");
    expect(order).toEqual(["doc", "hist", "fetch"]);
  });
});

describe("WriteService", () => {
  it("rejects stale base versions before writing", async () => {
    vi.resetModules();
    const lock = { promises: { runWithLock: async (_n, _id, fn) => fn() } };
    vi.doMock("@overleaf/settings", () => ({
      default: { path: { dumpFolder: "/tmp" } },
    }));
    vi.doMock("../../../../../app/src/infrastructure/LockManager.mjs", () => ({
      default: lock,
    }));
    vi.doMock(
      "../../../../../app/src/Features/ThirdPartyDataStore/UpdateMerger.mjs",
      () => ({
        default: {
          promises: { _mergeUpdate: sinon.stub(), deleteUpdate: sinon.stub() },
        },
      }),
    );
    vi.doMock(
      "../../../../../app/src/Features/Project/ProjectEntityHandler.mjs",
      () => ({ default: { promises: { getAllEntities: sinon.stub() } } }),
    );
    vi.doMock("../../../app/src/VersionService.mjs", () => ({
      default: {
        promises: { getLatestVersion: sinon.stub().resolves({ version: 4 }) },
      },
    }));
    vi.doMock("../../../app/src/LabelService.mjs", () => ({
      default: { promises: { createLabel: sinon.stub() } },
    }));
    const { default: WriteService } =
      await import("../../../app/src/WriteService.mjs");
    let error;
    try {
      await WriteService.writeFiles("p", "u", {
        baseVersion: 3,
        message: "m",
        files: [],
      });
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({
      code: "version_conflict",
      expectedVersion: 3,
      actualVersion: 4,
    });
  });
});

describe("WriteService labels", () => {
  it("does not create a label when no files are applied", async () => {
    vi.resetModules();
    const lock = { promises: { runWithLock: async (_n, _id, fn) => fn() } };
    const createLabel = sinon.stub();
    vi.doMock("@overleaf/settings", () => ({
      default: { path: { dumpFolder: "/tmp" } },
    }));
    vi.doMock("../../../../../app/src/infrastructure/LockManager.mjs", () => ({
      default: lock,
    }));
    vi.doMock(
      "../../../../../app/src/Features/ThirdPartyDataStore/UpdateMerger.mjs",
      () => ({
        default: {
          promises: { _mergeUpdate: sinon.stub(), deleteUpdate: sinon.stub() },
        },
      }),
    );
    vi.doMock(
      "../../../../../app/src/Features/Project/ProjectEntityHandler.mjs",
      () => ({ default: { promises: { getAllEntities: sinon.stub() } } }),
    );
    vi.doMock("../../../app/src/VersionService.mjs", () => ({
      default: {
        promises: { getLatestVersion: sinon.stub().resolves({ version: 4 }) },
      },
    }));
    vi.doMock("../../../app/src/LabelService.mjs", () => ({
      default: { promises: { createLabel } },
    }));
    const { default: WriteService } =
      await import("../../../app/src/WriteService.mjs");

    const result = await WriteService.writeFiles("p", "u", {
      message: "m",
      files: [],
    });

    expect(result).toEqual({
      version: 4,
      label: null,
      applied: [],
      failed: [],
    });
    expect(createLabel.called).toBe(false);
  });
});
