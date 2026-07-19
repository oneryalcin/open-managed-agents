#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const image = process.argv[2] ?? "oma-sandbox:dev";
const script = String.raw`
set -eu

test "$(id -u):$(id -g)" = "65534:65534"
test "$PWD" = /workspace
test "$HOME" = /workspace
test "$XDG_CACHE_HOME" = /workspace/.cache
test "$TMPDIR" = /workspace
test "$TMP" = /workspace
test "$TEMP" = /workspace
test "$UV_CACHE_DIR" = /workspace/.cache/uv
test "$NPM_CONFIG_CACHE" = /workspace/.cache/npm
test "$NPM_CONFIG_PREFIX" = /workspace/.local

node --version | grep -Fqx v24.18.0
npm --version | grep -Fqx 11.16.0
python3 --version | grep -Fqx 'Python 3.13.5'
python --version | grep -Fqx 'Python 3.13.5'
uv --version | grep -Eq '^uv 0\.11\.29( |$)'
uvx --version | grep -Eq '^uvx 0\.11\.29( |$)'
git --version >/dev/null
curl --version >/dev/null
jq --version >/dev/null
rg --version | grep -Fqx 'ripgrep 14.1.1'
cc --version >/dev/null
c++ --version >/dev/null
make --version >/dev/null
pkg-config --version >/dev/null

mkdir -p .local/bin
for name in rg find cat bash; do
  printf '#!/bin/sh\nexit 97\n' > ".local/bin/$name"
  chmod 700 ".local/bin/$name"
done
test "$(command -v rg)" = /usr/bin/rg
test "$(command -v find)" = /usr/bin/find
test "$(command -v cat)" = /usr/bin/cat
test "$(command -v bash)" = /usr/bin/bash

mkdir node-smoke
cd node-smoke
printf '%s\n' '{"scripts":{"test":"node test.mjs"}}' > package.json
printf '%s\n' 'import assert from "node:assert/strict"; assert.equal(6 * 7, 42);' > test.mjs
npm install --offline --ignore-scripts --no-audit --no-fund
npm test
cd ..

uv venv --python /usr/bin/python3 .venv
.venv/bin/python -c 'assert sum([19, 23]) == 42'

printf '%s\n' '#include <stdio.h>' 'int main(void) { puts("native-ok"); return 0; }' > native.c
cc native.c -o native
test "$(./native)" = native-ok

mkdir python-native
cd python-native
printf '%s\n' \
  '#include <Python.h>' \
  'static PyObject *answer(PyObject *self, PyObject *args) { return PyLong_FromLong(42); }' \
  'static PyMethodDef methods[] = {{"answer", answer, METH_NOARGS, "Return the smoke answer."}, {NULL, NULL, 0, NULL}};' \
  'static struct PyModuleDef module = {PyModuleDef_HEAD_INIT, "oma_native", NULL, -1, methods};' \
  'PyMODINIT_FUNC PyInit_oma_native(void) { return PyModule_Create(&module); }' \
  > oma_native.c
cc -shared -fPIC $(python3-config --includes) oma_native.c -o "oma_native$(python3-config --extension-suffix)"
python3 -c 'import oma_native; assert oma_native.answer() == 42'
cd ..

if touch /tmp/oma-must-not-write 2>/dev/null; then
  echo 'read-only root write unexpectedly succeeded' >&2
  exit 1
fi
temp_path=$(mktemp)
case "$temp_path" in /workspace/*) ;; *) echo "unsafe temp path: $temp_path" >&2; exit 1;; esac
rm -f "$temp_path"
if curl --connect-timeout 2 --max-time 3 -fsS https://example.com >/dev/null 2>&1; then
  echo 'network-none request unexpectedly succeeded' >&2
  exit 1
fi
`;

const result = spawnSync("docker", [
  "run",
  "--rm",
  "--network", "none",
  "--read-only",
  "--cap-drop", "ALL",
  "--security-opt", "no-new-privileges",
  "--pids-limit", "128",
  "--memory", "1g",
  "--tmpfs", "/workspace:rw,exec,nosuid,nodev,uid=65534,gid=65534,mode=700,size=256m",
  image,
  "/bin/bash", "-lc", script,
], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });

process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`coding sandbox smoke passed: ${image}`);
