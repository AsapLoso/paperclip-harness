import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../resolve-daily-upstream-sync-conflicts.sh", import.meta.url));
const bash = process.platform === "win32"
  ? path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")
  : "bash";
const sourcePaths = [
  "tests/runner-e2e/prepare-report-lock.mjs",
  "tests/runner-e2e/prepare-report-lock.test.ts",
  "tests/runner-e2e/prepare-report-lock.d.mts",
];
const lockPaths = [
  "pnpm-lock.yaml",
  "tests/runner-e2e/report-lock.json",
  "tests/runner-e2e/report-lock.patch",
];
const allConflictPaths = [...sourcePaths, ...lockPaths];
const workflow = readFileSync(new URL("../../workflows/daily-upstream-sync.yml", import.meta.url), "utf8");

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function fixture(t, upstreamSourceContents) {
  const root = await mkdtemp(path.join(tmpdir(), "paperclip-upstream-conflict-"));
  assert.equal(path.dirname(root), tmpdir(), "cleanup is confined to the newly created temp directory");
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "master");
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");

  for (const file of allConflictPaths) {
    const fullPath = path.join(root, file);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, "base\n");
  }
  git(root, "add", "--", ...sourcePaths);
  git(root, "commit", "-qm", "common source baseline");
  const baseSha = git(root, "rev-parse", "HEAD");

  git(root, "checkout", "-qb", "fork");
  for (const file of sourcePaths) await writeFile(path.join(root, file), "reviewed upstream behavior plus fork mode\n");
  for (const file of lockPaths) await writeFile(path.join(root, file), "fork generated lock proof\n");
  git(root, "add", "--", ...allConflictPaths);
  git(root, "commit", "-qm", "reviewed combined fork source");
  const forkSha = git(root, "rev-parse", "HEAD");

  git(root, "checkout", "-qb", "upstream", baseSha);
  for (let index = 0; index < sourcePaths.length; index += 1) {
    await writeFile(path.join(root, sourcePaths[index]), `${upstreamSourceContents[index]}\n`);
  }
  for (const file of lockPaths) await writeFile(path.join(root, file), "upstream generated lock proof\n");
  git(root, "add", "--", ...allConflictPaths);
  git(root, "commit", "-qm", "upstream source update");
  const upstreamSha = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", "refs/remotes/upstream/master", upstreamSha);

  git(root, "checkout", "fork");
  const merge = spawnSync("git", ["merge", "--no-edit", "upstream/master"], { cwd: root, encoding: "utf8" });
  assert.notEqual(merge.status, 0, "fixture must reproduce a source conflict");

  const expected = Object.fromEntries(sourcePaths.map((file) => [
    file,
    {
      forkBlob: git(root, "rev-parse", `${forkSha}:${file}`),
      upstreamBlob: git(root, "rev-parse", `${upstreamSha}:${file}`),
    },
  ]));
  return { root, baseSha: forkSha, expected, upstreamSha };
}

function resolverEnv(f) {
  return {
    ...process.env,
    BASE_SHA: f.baseSha,
    UPSTREAM_REF: "upstream/master",
    EXPECTED_FORK_PREPARE_REPORT_LOCK_BLOB: f.expected[sourcePaths[0]].forkBlob,
    EXPECTED_UPSTREAM_PREPARE_REPORT_LOCK_BLOB: f.expected[sourcePaths[0]].upstreamBlob,
    EXPECTED_FORK_PREPARE_REPORT_LOCK_TEST_BLOB: f.expected[sourcePaths[1]].forkBlob,
    EXPECTED_UPSTREAM_PREPARE_REPORT_LOCK_TEST_BLOB: f.expected[sourcePaths[1]].upstreamBlob,
    EXPECTED_FORK_PREPARE_REPORT_LOCK_DECL_BLOB: f.expected[sourcePaths[2]].forkBlob,
    EXPECTED_UPSTREAM_PREPARE_REPORT_LOCK_DECL_BLOB: f.expected[sourcePaths[2]].upstreamBlob,
  };
}

test("resolves only the reviewed source blob pairs and continues the merge", async (t) => {
  const f = await fixture(t, ["upstream behavior", "upstream test behavior", "upstream declaration"]);
  const result = spawnSync(bash, [script], { cwd: f.root, env: resolverEnv(f), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(git(f.root, "rev-parse", "HEAD^1"), f.baseSha);
  assert.equal(git(f.root, "rev-parse", "HEAD^2"), f.upstreamSha);
  for (const file of sourcePaths) {
    const contents = (await readFile(path.join(f.root, file), "utf8")).replaceAll("\r\n", "\n");
    assert.equal(contents, "reviewed upstream behavior plus fork mode\n");
  }
  for (const file of lockPaths) {
    const contents = (await readFile(path.join(f.root, file), "utf8")).replaceAll("\r\n", "\n");
    assert.equal(contents, "fork generated lock proof\n");
  }
});

test("aborts and preserves the fork branch when upstream changes a reviewed source blob", async (t) => {
  const f = await fixture(t, ["unreviewed upstream behavior", "upstream test behavior", "upstream declaration"]);
  const env = resolverEnv(f);
  env.EXPECTED_UPSTREAM_PREPARE_REPORT_LOCK_BLOB = execFileSync("git", ["hash-object", "--stdin"], {
    cwd: f.root,
    input: Buffer.from("upstream behavior\n"),
    encoding: "utf8",
  }).trim();
  const result = spawnSync(bash, [script], { cwd: f.root, env, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Refusing to choose the fork copy/);
  assert.equal(git(f.root, "rev-parse", "HEAD"), f.baseSha);
  assert.notEqual(spawnSync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: f.root }).status, 0);
  const contents = (await readFile(path.join(f.root, sourcePaths[0]), "utf8")).replaceAll("\r\n", "\n");
  assert.equal(contents, "reviewed upstream behavior plus fork mode\n");
});

test("the daily workflow calls the guarded resolver with reviewed blob pins", () => {
  assert.match(workflow, /bash \.github\/scripts\/resolve-daily-upstream-sync-conflicts\.sh/);
  for (const name of [
    "EXPECTED_FORK_PREPARE_REPORT_LOCK_BLOB",
    "EXPECTED_UPSTREAM_PREPARE_REPORT_LOCK_BLOB",
    "EXPECTED_FORK_PREPARE_REPORT_LOCK_TEST_BLOB",
    "EXPECTED_UPSTREAM_PREPARE_REPORT_LOCK_TEST_BLOB",
    "EXPECTED_FORK_PREPARE_REPORT_LOCK_DECL_BLOB",
    "EXPECTED_UPSTREAM_PREPARE_REPORT_LOCK_DECL_BLOB",
  ]) {
    assert.match(workflow, new RegExp(`${name}: [0-9a-f]{40}`));
  }
});
