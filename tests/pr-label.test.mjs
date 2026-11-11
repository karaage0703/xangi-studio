import test from "node:test";
import assert from "node:assert/strict";
import { pullRequestLabel } from "../shared/pr-label.mjs";

test("same-number pull requests from different repositories stay distinguishable", () => {
  assert.equal(
    pullRequestLabel({ kind: "github-pr", source: "owner/first", id: "8" }),
    "owner/first #8",
  );
  assert.equal(
    pullRequestLabel({ kind: "github-pr", source: "owner/second", id: "8" }),
    "owner/second #8",
  );
  assert.equal(
    pullRequestLabel({ kind: "artifact", source: "owner/first", id: "8" }),
    null,
  );
  assert.equal(pullRequestLabel(null), null);
});
