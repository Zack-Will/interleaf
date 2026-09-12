import { beforeEach, describe, expect, it, vi } from "vitest";
import sinon from "sinon";

describe("project-sync module hooks", () => {
  beforeEach(async (ctx) => {
    vi.resetModules();
    ctx.listTokens = sinon.stub().resolves([{ id: "t" }]);
    ctx.revokeAllForUser = sinon.stub().resolves({ deletedCount: 1 });
    vi.doMock("../../../app/src/TokenService.mjs", () => ({
      default: {
        promises: {
          listTokens: ctx.listTokens,
          revokeAllForUser: ctx.revokeAllForUser,
        },
      },
    }));
    vi.doMock("../../../app/src/ProjectSyncRouter.mjs", () => ({
      default: { apply: sinon.stub(), applyNonCsrfRouter: sinon.stub() },
    }));
    ctx.module = (await import("../../../index.mjs")).default;
  });

  it("exposes listPersonalAccessTokens and cleanupPersonalAccessTokens hooks", async (ctx) => {
    expect(
      await ctx.module.hooks.promises.listPersonalAccessTokens("u"),
    ).toEqual([{ id: "t" }]);
    expect(
      await ctx.module.hooks.promises.cleanupPersonalAccessTokens("u"),
    ).toEqual({ deletedCount: 1 });
    sinon.assert.calledWith(ctx.listTokens, "u");
    sinon.assert.calledWith(ctx.revokeAllForUser, "u");
  });
});
