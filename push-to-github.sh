#!/usr/bin/env bash
#
# Initializes the repo, makes one commit per file (in build order), and pushes
# to GitHub. Run this from inside the project folder on your own machine, where
# your git identity and SSH key are configured.
#
#   chmod +x push-to-github.sh
#   ./push-to-github.sh
#
set -euo pipefail

REMOTE="git@github.com:afifaniks/scrobblr.git"

cd "$(dirname "$0")"

# Warn (don't fail) if no global git identity is set.
if ! git config user.name >/dev/null 2>&1 && ! git config --global user.name >/dev/null 2>&1; then
  echo "⚠  No git user.name/email configured. Set them first:"
  echo "     git config --global user.name  \"Your Name\""
  echo "     git config --global user.email \"you@example.com\""
  exit 1
fi

# Fresh start (removes any partial repo created earlier).
rm -rf .git
git init -q -b main
git remote add origin "$REMOTE"

commit () {
  local msg="$1"; shift
  # only add paths that exist
  local present=()
  for p in "$@"; do [ -e "$p" ] && present+=("$p"); done
  if [ ${#present[@]} -gt 0 ]; then
    git add -- "${present[@]}"
    git commit -q -m "$msg"
    echo "✓ $msg"
  fi
}

commit "Add .gitignore"                                                   .gitignore
commit "Add MIT license"                                                  LICENSE
commit "Add Manifest V3 manifest"                                         manifest.json
commit "Add local MD5 implementation for Last.fm request signing"         md5.js
commit "Add background service worker (auth, scrobbling, unscrobble)"     background.js
commit "Add shared built-in title-cleanup word list"                      noise.js
commit "Add page-context probe for YouTube player metadata"               inject.js
commit "Add content script (playback tracking, parsing, filtering)"       content.js
commit "Add popup markup"                                                 popup/popup.html
commit "Add popup styles"                                                 popup/popup.css
commit "Add popup logic (now playing, recents, unscrobble)"               popup/popup.js
commit "Add options page markup"                                          options/options.html
commit "Add options page styles"                                          options/options.css
commit "Add options page logic (creds, connect, categories, cleanup)"     options/options.js
commit "Add extension icons (active/idle indicator states)"               icons
commit "Add README"                                                       README.md
commit "Add security policy and review"                                   SECURITY.md

# Commit anything not explicitly listed above (safety net), then push.
if [ -n "$(git status --porcelain)" ]; then
  commit "Add remaining project files" .
fi

echo "------"
echo "Commits: $(git rev-list --count HEAD)"
echo "Pushing to $REMOTE ..."
git push -u origin main
echo "Done ✅  https://github.com/afifaniks/scrobblr"
