import {
  lstat,
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(
  new URL("../skills/xs-xangi-studio", import.meta.url),
);

async function exists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function installSkill(workspace, { check = false } = {}) {
  if (!workspace || !isAbsolute(workspace))
    throw new Error("--workspace requires an existing absolute directory");
  const root = await realpath(workspace);
  if (!(await lstat(root)).isDirectory())
    throw new Error("--workspace must be a directory");
  const canonical = await realpath(source);
  const skill = await readFile(join(canonical, "SKILL.md"), "utf8");
  const frontmatter = skill.match(/^---\n[\s\S]*?\n---/);
  if (!frontmatter) throw new Error("Bundled SKILL.md has no frontmatter");
  const wrapper = `${frontmatter[0]}\n\n# xangi-studio skill entry\n\nRead ${JSON.stringify(join(canonical, "SKILL.md"))} completely before acting. Resolve references and resources from that canonical file, not this forwarding entry.\n`;
  const targets = [
    { path: join(root, "skills/xs-xangi-studio"), kind: "link" },
    { path: join(root, ".claude/skills/xs-xangi-studio"), kind: "link" },
    { path: join(root, ".agents/skills/xs-xangi-studio"), kind: "wrapper" },
  ];
  // Resolve aliases even when the final skill entry has not been created yet.
  const physicalPath = async (path) => {
    if (await exists(path)) return realpath(path);
    return join(await physicalPath(dirname(path)), basename(path));
  };
  const destinations = await Promise.all(
    targets.map(async (target) =>
      join(await physicalPath(dirname(target.path)), basename(target.path)),
    ),
  );
  if (destinations.slice(0, 2).includes(destinations[2]))
    throw new Error(
      "Codex forwarding directory aliases a linked skill directory; reconcile manually before installation",
    );
  const state = async ({ path, kind }) => {
    const info = await exists(path);
    if (!info) return "missing";
    if (kind === "link" && info.isSymbolicLink()) {
      if ((await realpath(path).catch(() => null)) === canonical)
        return "ready";
    }
    if (kind === "wrapper" && info.isDirectory()) {
      if (
        (await readFile(join(path, "SKILL.md"), "utf8").catch(() => null)) ===
        wrapper
      )
        return "ready";
    }
    throw new Error(
      `Existing skill conflicts; keep it and reconcile manually: ${path}`,
    );
  };
  // Preflight every entry before writing, including a legacy discovery location.
  const legacy = join(root, ".codex/skills/xs-xangi-studio");
  if (await exists(legacy)) {
    if ((await realpath(legacy).catch(() => null)) !== canonical)
      throw new Error(
        `Legacy skill may shadow this one; reconcile manually: ${legacy}`,
      );
  }
  for (const target of targets) await state(target);
  if (!check) {
    for (const target of targets) {
      // Parent skill directories can alias each other through symlinks.
      if ((await state(target)) === "ready") continue;
      if (target.kind === "link") {
        await mkdir(resolve(target.path, ".."), { recursive: true });
        await symlink(canonical, target.path, "dir");
      } else {
        await mkdir(target.path, { recursive: true });
        await writeFile(join(target.path, "SKILL.md"), wrapper, { flag: "wx" });
      }
    }
  }
  const entries = [];
  for (const target of targets)
    entries.push({ ...target, status: await state(target) });
  return {
    workspace: root,
    source: canonical,
    ready: entries.every((e) => e.status === "ready"),
    entries,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(
      "Usage: node scripts/install-skill.mjs --workspace /absolute/workspace [--check]\nInstalls workspace skill entries without overwriting existing skills. --check is read-only and exits 1 if entries are missing.",
    );
  } else {
    try {
      const i = args.indexOf("--workspace");
      if (
        i < 0 ||
        args.some(
          (arg, n) => n !== i + 1 && !["--workspace", "--check"].includes(arg),
        )
      )
        throw new Error(
          "Use --workspace /absolute/workspace [--check]; see --help",
        );
      const result = await installSkill(args[i + 1], {
        check: args.includes("--check"),
      });
      console.log(JSON.stringify(result, null, 2));
      if (!result.ready) process.exitCode = 1;
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
