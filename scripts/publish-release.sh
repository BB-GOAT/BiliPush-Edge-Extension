#!/usr/bin/env bash
set -euo pipefail

tag="v$VERSION"
ref="refs/tags/$tag"
asset="BiliPush-Edge-$VERSION.crx"
commit=$(git rev-parse HEAD)

# 复用指向同一提交的 Tag，保留已发布的版本与附件。
existing=$(git ls-remote origin "$ref" "$ref^{}")
if [[ -z "$existing" ]]; then
  git push origin "$commit:$ref"
else
  target=$(awk -v ref="$ref" '$2 == ref {tag = $1} $2 == ref "^{}" {peeled = $1} END {print peeled ? peeled : tag}' <<< "$existing")
  if [[ "$target" != "$commit" ]]; then
    echo "Tag $tag 已指向 $target，预期为 $commit，停止发布。" >&2
    exit 1
  fi
fi

# 用发行版列表查询状态，避免把 GitHub 网络或权限错误当成「没有 Release」。
release=$(gh api --paginate "repos/$GITHUB_REPOSITORY/releases?per_page=100" \
  --jq ".[] | select(.tag_name == \"$tag\") | [.draft, ([.assets[] | select(.name == \"$asset\" and .state == \"uploaded\")]|length)] | @tsv")
case "$release" in
  '')
    gh release create "$tag" --verify-tag --title "$tag" \
      --notes-file "$RUNNER_TEMP/release-notes.md" "$RUNNER_TEMP/$asset"
    ;;
  $'true\t0')
    gh release upload "$tag" "$RUNNER_TEMP/$asset" --clobber
    gh release edit "$tag" --draft=false
    ;;
  $'true\t1')
    gh release edit "$tag" --draft=false
    ;;
  $'false\t1')
    echo "$tag 已发布，并已包含 $asset。"
    ;;
  *)
    echo "$tag 的现有 Release 状态与预期不符，请在 GitHub 检查。" >&2
    exit 1
    ;;
esac
