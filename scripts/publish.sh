#!/usr/bin/env bash
#
# Manual publish — build the committed site and deploy it to the gh-pages branch.
#
# We can't use GitHub Actions (account billing), so this runs locally:
#
#     pnpm run publish:site        # or: bash scripts/publish.sh
#
# Modelled on ~/npalladium/blog's worktree-based deploy: the site is built from a
# detached worktree of HEAD, so untracked/uncommitted files (drafts, WIP, the
# docs/proposals notes) can never leak into the published site — only committed
# files are deployed.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if ! git rev-parse --verify --quiet HEAD >/dev/null; then
	echo "error: no commits yet — nothing to publish" >&2
	exit 1
fi

if ! git remote get-url origin >/dev/null 2>&1; then
	echo "error: no 'origin' remote — add one before publishing" >&2
	exit 1
fi

build_wt="$(mktemp -d)"
pages_wt="$(mktemp -d)"

cleanup() {
	git worktree remove --force "$build_wt" 2>/dev/null || true
	git worktree remove --force "$pages_wt" 2>/dev/null || true
}
trap cleanup EXIT

# 1. Clean checkout of HEAD — only committed files are present.
git worktree add --detach "$build_wt" HEAD

# 2. Worktree for the gh-pages branch (create the orphan branch the first time).
if git show-ref --verify --quiet refs/heads/gh-pages; then
	git worktree add "$pages_wt" gh-pages
else
	git worktree add --detach "$pages_wt" HEAD
	git -C "$pages_wt" checkout --orphan gh-pages
	git -C "$pages_wt" rm -rf . >/dev/null 2>&1 || true
fi

# 3. Build the static site inside the clean checkout.
(
	cd "$build_wt"
	pnpm install --frozen-lockfile
	pnpm build
)

# 4. Replace the gh-pages contents with the fresh build output.
find "$pages_wt" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
cp -R "$build_wt/build/." "$pages_wt/"
touch "$pages_wt/.nojekyll" # belt-and-braces: GitHub Pages must not run Jekyll

# 5. Commit and push.
(
	cd "$pages_wt"
	git add -A
	if git diff --cached --quiet; then
		echo "Nothing to publish — the live site already matches HEAD."
	else
		git commit -m "Deploy site $(date -u '+%Y-%m-%d %H:%M:%SZ')"
		# --no-verify: this pushes the built static output, not source, so the
		# repo's pre-push gate (pnpm lint/check/test) can't run here — there's no
		# package.json in this worktree. The source was already gated when main
		# was pushed; re-running it against build output would only ever fail.
		git push --no-verify origin gh-pages
		echo "Published to gh-pages."
	fi
)
