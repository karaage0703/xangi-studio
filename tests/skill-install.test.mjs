import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installSkill } from "../scripts/install-skill.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "studio-skill-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace with spaces");
  await mkdir(workspace);
  return workspace;
}

test("fresh workspace exposes the bundled skill; check is read-only and installation is repeatable", async (t) => {
  const workspace = await fixture(t);
  assert.equal((await installSkill(workspace, { check: true })).ready, false);
  assert.deepEqual(await readdir(workspace), []);
  const result = await installSkill(workspace);
  assert.equal(result.ready, true);
  for (const dir of ["skills", ".claude/skills"]) {
    const path = join(workspace, dir, "xs-xangi-studio");
    assert.equal(await realpath(path), result.source);
    const skill = await readFile(join(path, "SKILL.md"), "utf8");
    assert.match(skill, /^---\nname: xs-xangi-studio\n/);
    await readFile(join(path, "references/api.md"));
  }
  const entry = join(workspace, ".agents/skills/xs-xangi-studio/SKILL.md");
  const wrapper = await readFile(entry, "utf8");
  assert.match(wrapper, /^---\nname: xs-xangi-studio\n/);
  assert.ok(wrapper.includes(JSON.stringify(join(result.source, "SKILL.md"))));
  assert.deepEqual(await installSkill(workspace), result);
  assert.deepEqual(await installSkill(workspace, { check: true }), result);
  assert.equal(await readFile(entry, "utf8"), wrapper);
});

test("workspace-wide Claude skills symlink can alias the standard directory", async (t) => {
  const workspace = await fixture(t);
  await mkdir(join(workspace, "skills"));
  await mkdir(join(workspace, ".claude"));
  await symlink("../skills", join(workspace, ".claude/skills"));
  assert.equal((await installSkill(workspace)).ready, true);
  assert.equal((await installSkill(workspace, { check: true })).ready, true);
});

test("conflicting skills at every discovery location are preserved before any writes", async (t) => {
  for (const dir of [
    "skills",
    ".claude/skills",
    ".agents/skills",
    ".codex/skills",
  ]) {
    await t.test(dir, async (t) => {
      const workspace = await fixture(t);
      const existing = join(workspace, dir, "xs-xangi-studio");
      await mkdir(existing, { recursive: true });
      const content = "Existing PR-only skill; keep me";
      await writeFile(join(existing, "SKILL.md"), content);
      const before = await readdir(workspace, { recursive: true });
      await assert.rejects(installSkill(workspace), /reconcile manually/);
      assert.equal(await readFile(join(existing, "SKILL.md"), "utf8"), content);
      assert.deepEqual(await readdir(workspace, { recursive: true }), before);
    });
  }
});

test("broken skill links are reported without replacing them", async (t) => {
  const workspace = await fixture(t);
  await mkdir(join(workspace, "skills"));
  const target = join(workspace, "skills/xs-xangi-studio");
  await symlink("/missing/old-checkout", target);
  await assert.rejects(installSkill(workspace), /Existing skill conflicts/);
  await assert.rejects(realpath(target), { code: "ENOENT" });
  await assert.rejects(
    readFile(join(workspace, ".agents/skills/xs-xangi-studio/SKILL.md")),
    { code: "ENOENT" },
  );
});

test("aliased Codex index is rejected before any source or workspace entry is written", async (t) => {
  const workspace = await fixture(t);
  await mkdir(join(workspace, "skills"));
  await mkdir(join(workspace, ".agents"));
  await symlink("../skills", join(workspace, ".agents/skills"));
  await assert.rejects(installSkill(workspace), /forwarding directory aliases/);
  assert.deepEqual(await readdir(join(workspace, "skills")), []);
  await assert.rejects(
    readFile(join(workspace, ".claude/skills/xs-xangi-studio/SKILL.md")),
    { code: "ENOENT" },
  );
});

test("CLI help/check failures do not install into a guessed workspace", async (t) => {
  const workspace = await fixture(t);
  const script = fileURLToPath(
    new URL("../scripts/install-skill.mjs", import.meta.url),
  );
  const run = (...args) =>
    spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      cwd: workspace,
    });
  assert.equal(run("--help").status, 0);
  assert.equal(run().status, 1);
  assert.equal(run("--workspace", "relative").status, 1);
  assert.equal(run("--workspace", workspace, "--force").status, 1);
  const missing = run("--workspace", workspace, "--check");
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stdout).ready, false);
  assert.deepEqual(await readdir(workspace), []);
  const installed = run("--workspace", workspace);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(JSON.parse(installed.stdout).ready, true);
  const checked = run("--workspace", workspace, "--check");
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).ready, true);
});
