# Specification for the Managed Agents custom-tool round-trip. Defines the
# exact event sequence the server emits when an agent calls a custom tool and
# the orchestrator's reply contract. Implements ADR 0005's pattern.

Feature: Custom tool round-trip with requires_action signaling
  As a developer using a Managed Agents client SDK
  I want the agent's custom tool calls to surface as well-formed events
  So that my orchestrator can execute the tool and reply without ambiguity

  Background:
    Given the API server is running
    And an agent "agent_xyz" is configured with a custom tool "ask_user"
    And a session "sesn_ct" is running this agent

  Scenario: Agent calls a custom tool — server emits the pause signal
    Given the agent decides to call "ask_user" with input {"question": "continue?"}
    When the server processes the agent turn
    Then an "agent.custom_tool_use" event is emitted with:
      | field            | value                                             |
      | id               | sevt_<server-assigned>                            |
      | name             | ask_user                                          |
      | input            | {"question": "continue?"}                         |
    And immediately after, a "session.status_idle" event is emitted with:
      | field                  | value                                       |
      | stop_reason.type       | requires_action                             |
      | stop_reason.event_ids  | [<id of the agent.custom_tool_use above>]   |
    And no other events are emitted until the orchestrator replies

  Scenario: Orchestrator replies with the tool result
    Given an "agent.custom_tool_use" event with id "sevt_aaa" is pending
    When I POST /v1/sessions/sesn_ct/events with:
      """json
      {
        "events": [{
          "type": "user.custom_tool_result",
          "custom_tool_use_id": "sevt_aaa",
          "content": [{"type": "text", "text": "yes"}]
        }]
      }
      """
    Then the response status is 200
    And the field "custom_tool_use_id" — NOT "tool_use_id" — is required on this event
    And the agent resumes execution with the tool result
    And a "session.status_running" event is emitted

  Scenario: Orchestrator replies with an error
    When I POST /v1/sessions/sesn_ct/events with is_error: true
    Then the agent receives the result as an error tool_result
    And the agent loop continues (does NOT retry the tool automatically)
    And the agent decides next action based on its system prompt

  Scenario: Session aborted while custom tool is in flight
    Given a custom tool execute() is awaiting a result
    When I POST /v1/sessions/sesn_ct/events with type: "user.interrupt"
    Then the AbortSignal fires inside execute()
    And the pending Promise rejects with AbortError
    And the resolver is cleared from the pending-call map
    And no subsequent reply for that custom_tool_use_id is accepted

  Scenario: Custom tool result references an unknown ID
    When I POST a user.custom_tool_result with custom_tool_use_id: "sevt_does_not_exist"
    Then the response status is 404
    And the error type is "invalid_request_error"
