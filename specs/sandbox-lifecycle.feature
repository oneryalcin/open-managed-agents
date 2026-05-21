# Specification for the per-session sandbox lifecycle: provision on session
# create, route tool execution through the sandbox, destroy on session end,
# orphan-sandbox sweep on crash recovery. Implements the lifecycle separation
# from ADR 0003 + ADR 0007 Pattern 3.

Feature: Per-session sandbox lifecycle
  As a developer running Managed Agents
  I want each session to get a fresh, isolated sandbox
  So that agent tool calls don't leak state across sessions

  Background:
    Given the API server is running
    And an environment "env_default" is configured to use the Modal sandbox provider

  Scenario: Provision a sandbox on session create
    When I POST /v1/sessions with agent_id and environment_id "env_default"
    Then a new Modal sandbox is provisioned for this session
    And the response status is 200
    And the response body contains the session id
    And the sandbox is reachable via the agent's bash/read/write tools

  Scenario: Tool execution routes through the sandbox
    Given a session is running on an active sandbox
    When the agent calls the bash tool with command "echo HELLO"
    Then the command executes inside the per-session Modal sandbox
    And the stdout "HELLO" is captured and surfaced as the tool result
    And no command is ever executed on the control-plane host

  Scenario: Sandbox is destroyed on session end
    Given a session is in status "running"
    When the session reaches status "terminated"
    Then the Modal sandbox is destroyed within 10 seconds
    And subsequent attempts to invoke tools on this session return 410 Gone

  Scenario: Crash recovery — orphan sandbox sweep
    Given the control plane was killed while sessions were running
    When the control plane restarts
    Then it lists active Modal sandboxes
    And any sandbox whose session is in a terminal state is destroyed
    And the result is logged for operator review

  Scenario: Resource mount at session create
    When I POST /v1/sessions with resources: [{"type": "file", "file_id": "...", "mount_path": "/workspace/data.csv"}]
    Then the session-create blocks until the file is materialized inside the sandbox
    And the agent's read tool returns the file's bytes when given the mount_path

  Scenario: Session output files retrieval
    Given the agent has written a file to /mnt/session/outputs/report.pdf
    When the session reaches status "idle" with stop_reason "end_turn"
    Then GET /v1/files?scope_id=<session_id> returns the file's metadata
    And GET /v1/files/{file_id}/content returns the file bytes
