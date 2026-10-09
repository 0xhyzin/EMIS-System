#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  echo 'يلزم تثبيت Node.js 22.13 أو أحدث أولًا.' >&2
  exit 1
fi
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major<22||(major===22&&minor<13)){console.error("يلزم Node.js 22.13 أو أحدث.");process.exit(1)}'
if [[ ! -d node_modules ]]; then npm ci; fi
if [[ "${1:-}" == '--lan' ]]; then
  exec npm run start:lan
fi
exec npm start
