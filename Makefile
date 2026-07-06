SHELL := /bin/sh

NPM ?= npm
NPX ?= npx
OMA_PROBE_PORT ?= 40178
OMA_CONSOLE_API_BASE ?= http://127.0.0.1:$(OMA_PROBE_PORT)
OMA_PARALLEL_SMOKE_SESSIONS ?= 3

.PHONY: help install test typecheck check ui server docker-smoke parallel-docker-smoke console-image-smoke cwc-smoke gated-smoke

help:
	@printf '%s\n' 'Open Managed Agents dev targets'
	@printf '%s\n' ''
	@printf '%s\n' '  make install                 npm install'
	@printf '%s\n' '  make test                    run the Vitest suite'
	@printf '%s\n' '  make typecheck               run TypeScript typecheck'
	@printf '%s\n' '  make check                   typecheck + tests'
	@printf '%s\n' '  make ui                      serve the managed agents console'
	@printf '%s\n' '  make server                  run the CWC example OMA server'
	@printf '%s\n' '  make docker-smoke            run deterministic Docker-local deployment smoke'
	@printf '%s\n' '  make parallel-docker-smoke   run N Docker-local sandboxes concurrently'
	@printf '%s\n' '  make console-image-smoke     build the appliance image and smoke /console'
	@printf '%s\n' '  make cwc-smoke               run the Python SDK CWC happy-path smoke'
	@printf '%s\n' '  make gated-smoke             run the Python SDK ask-gated smoke'
	@printf '%s\n' ''
	@printf '%s\n' 'Variables: OMA_PROBE_PORT=40178 OMA_PARALLEL_SMOKE_SESSIONS=3'

install:
	$(NPM) install

test:
	$(NPM) test

typecheck:
	$(NPM) run typecheck

check: typecheck test

ui:
	OMA_CONSOLE_API_BASE=$(OMA_CONSOLE_API_BASE) $(NPM) run ui:dev

server:
	OMA_SANDBOX_PROVIDER=docker-local \
	OMA_ALLOW_DOCKER_LOCAL=true \
	OMA_PROBE_PORT=$(OMA_PROBE_PORT) \
	$(NPX) tsx examples/ship-your-first-managed-agent/oma-server.ts

docker-smoke:
	$(NPX) tsx scratch/23-e3-deployment-docker-smoke.ts

parallel-docker-smoke:
	OMA_PARALLEL_SMOKE_SESSIONS=$(OMA_PARALLEL_SMOKE_SESSIONS) \
	$(NPX) tsx scratch/40-docker-parallel-sessions-smoke.ts

console-image-smoke:
	$(NPX) tsx scratch/41-console-image-smoke.ts

cwc-smoke:
	cd examples/ship-your-first-managed-agent && uv run --with-requirements requirements.txt python smoke.py

gated-smoke:
	cd examples/ship-your-first-managed-agent && uv run --with-requirements requirements.txt python smoke_tool_confirmation.py
