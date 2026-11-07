#!/usr/bin/env bash
set -euo pipefail

base_sha="${BASE_SHA:?BASE_SHA must identify the fork state before upstream merge}"
upstream_ref="${UPSTREAM_REF:-upstream/master}"

mapfile -d '' conflicts < <(git diff --name-only --diff-filter=U -z)
if ((${#conflicts[@]} == 0)); then
  echo "Upstream merge failed without any unresolved file conflicts."
  if git rev-parse -q --verify MERGE_HEAD >/dev/null; then git merge --abort; fi
  exit 1
fi

abort_merge() {
  if git rev-parse -q --verify MERGE_HEAD >/dev/null; then git merge --abort; fi
  exit 1
}

verify_known_source_conflict() {
  local path="$1" expected_fork_blob="$2" expected_upstream_blob="$3"
  local actual_fork_blob actual_upstream_blob
  actual_fork_blob="$(git rev-parse --verify "${base_sha}:${path}")"
  actual_upstream_blob="$(git rev-parse --verify "${upstream_ref}:${path}")"
  if [[ "$actual_fork_blob" != "$expected_fork_blob" || "$actual_upstream_blob" != "$expected_upstream_blob" ]]; then
    echo "Refusing to choose the fork copy for an unreviewed source conflict: $path"
    echo "Fork blob: expected $expected_fork_blob, found $actual_fork_blob"
    echo "Upstream blob: expected $expected_upstream_blob, found $actual_upstream_blob"
    return 1
  fi
}

for path in "${conflicts[@]}"; do
  case "$path" in
    pnpm-lock.yaml|tests/runner-e2e/report-lock.json|tests/runner-e2e/report-lock.patch|.github/workflows/daily-upstream-sync.yml)
      ;;
    tests/runner-e2e/prepare-report-lock.mjs)
      verify_known_source_conflict "$path" \
        "${EXPECTED_FORK_PREPARE_REPORT_LOCK_BLOB:-}" \
        "${EXPECTED_UPSTREAM_PREPARE_REPORT_LOCK_BLOB:-}" || abort_merge
      ;;
    tests/runner-e2e/prepare-report-lock.test.ts)
      verify_known_source_conflict "$path" \
        "${EXPECTED_FORK_PREPARE_REPORT_LOCK_TEST_BLOB:-}" \
        "${EXPECTED_UPSTREAM_PREPARE_REPORT_LOCK_TEST_BLOB:-}" || abort_merge
      ;;
    tests/runner-e2e/prepare-report-lock.d.mts)
      verify_known_source_conflict "$path" \
        "${EXPECTED_FORK_PREPARE_REPORT_LOCK_DECL_BLOB:-}" \
        "${EXPECTED_UPSTREAM_PREPARE_REPORT_LOCK_DECL_BLOB:-}" || abort_merge
      ;;
    *)
      echo "Upstream conflict outside the regenerated lock files, fork-owned workflow, or reviewed report-lock source:"
      printf '  %s\n' "$path"
      abort_merge
      ;;
  esac
done

echo "Resolving generated lock proofs and the fork-owned workflow from the fork baseline."
echo "Keeping report-lock source only after both conflict blobs match the reviewed pair."
for path in "${conflicts[@]}"; do
  git checkout --ours -- "$path"
  git add -- "$path"
done
GIT_EDITOR=true git merge --continue
