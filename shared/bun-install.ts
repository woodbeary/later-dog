export const BUN_INSTALL = String.raw`laterdog_bun() {
  local laterdog_bun_pin laterdog_bun_version
  export PATH="$HOME/.local/bin:$PATH"
  laterdog_bun_pin=$(node --input-type=commonjs -e 'const p=require(process.cwd()+"/package.json"); const m=p.packageManager; if(typeof m==="string" && m.startsWith("bun@")) { if(!/^bun@\d+\.\d+\.\d+$/.test(m)) { console.error("An exact Bun version is required"); process.exit(1); } process.stdout.write(m.slice(4)); }') || return
  laterdog_bun_version=""
  if command -v bun >/dev/null 2>&1; then laterdog_bun_version=$(bun --version) || return; fi
  if [ -n "$laterdog_bun_pin" ]; then
    if [ "$laterdog_bun_version" != "$laterdog_bun_pin" ]; then
      npm install -g --prefix "$HOME/.local" "bun@$laterdog_bun_pin" || return
      hash -r
    fi
    laterdog_bun_version=$(bun --version) || return
    if [ "$laterdog_bun_version" != "$laterdog_bun_pin" ]; then
      printf 'Bun %s is required; installed version is %s\n' "$laterdog_bun_pin" "$laterdog_bun_version" >&2
      return 1
    fi
  elif [ -z "$laterdog_bun_version" ]; then
    npm install -g --prefix "$HOME/.local" bun || return
    hash -r
  fi
  if node --input-type=commonjs -e 'const p=require(process.cwd()+"/package.json"); process.exit(p.name==="laterdog" && p.repository?.url==="https://github.com/woodbeary/later-dog.git" ? 0 : 1)'; then
    bun install --frozen-lockfile --cpu=arm64 --cpu=x64
  else
    bun install --frozen-lockfile
  fi
}
`;
