#!/bin/sh
# One-time user-level migration: mini-ci -> mini-archipel/ci, with
# transitional symlinks so engines pinned to older commits keep working
# through their hardcoded ~/.local/{libexec,state,share}/mini-ci defaults.
# Remove the symlinks after every repository re-pins the shared engine.
set -e
umask 077
for base in .local/libexec .local/state .local/share; do
  src="$HOME/$base/mini-ci"
  dst="$HOME/$base/mini-archipel/ci"
  [ -d "$src" ] || continue
  mkdir -p "$(dirname "$dst")"
  if [ -d "$dst" ]; then
    for f in "$src"/* "$src"/.[!.]*; do [ -e "$f" ] && mv "$f" "$dst/"; done
    rmdir "$src"
  else
    mv "$src" "$dst"
  fi
  ln -s "$dst" "$src"
  echo "migrated $src -> $dst (transitional symlink kept)"
done
for env in "$HOME"/runners/*/.env; do
  [ -f "$env" ] || continue
  sed -i '' 's|\.local/libexec/mini-ci/|\.local/libexec/mini-archipel/ci/|g' "$env"
  echo "updated $env"
done
echo 'done'
