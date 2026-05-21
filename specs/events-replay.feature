# Specification for the session event log surface: events.list, events.stream,
# and lossless reconnect via cursor. Invariants here must hold per ADR 0007.
# Scenarios are written before routes exist and serve as the design contract.

Feature: Session event log — list + stream + lossless reconnect
  As a client of the Managed Agents API
  I want to consume a session's event log via both list and stream endpoints
  So that I can recover from connection drops without losing or duplicating events

  Background:
    Given the API server is running
    And I have a valid authentication token
    And a session "sesn_abc" exists with at least one historical event

  # ── events.list ────────────────────────────────────────────────────────────

  Scenario: List all events from the beginning
    When I GET /v1/sessions/sesn_abc/events
    Then the response status is 200
    And the response contains the full ordered event history for sesn_abc
    And every event has a stable server-assigned ID matching "sevt_[0-9a-f-]+"
    And event IDs are strictly increasing in lexical order

  Scenario: Paginate the event log
    Given the session has 1500 events
    When I GET /v1/sessions/sesn_abc/events with cursor=after_id={lastEventId}&limit=500
    Then I receive 500 events
    And the first event has an ID lexically greater than {lastEventId}
    And paginating until the page size is less than the limit returns all 1500 events with no gaps or duplicates

  # ── events.stream (SSE) ────────────────────────────────────────────────────

  Scenario: Open a fresh SSE stream
    When I GET /v1/sessions/sesn_abc/events/stream
    Then the response is a Server-Sent Events stream
    And I receive every historical event for sesn_abc in order
    And subsequent events published to the session are delivered live as they occur

  Scenario: Reconnect with a cursor mid-stream
    Given I previously received events up to "sevt_a1b2c3"
    When I GET /v1/sessions/sesn_abc/events/stream with header "Last-Event-ID: sevt_a1b2c3"
    Then I receive every event with id > "sevt_a1b2c3" exactly once
    And no event with id <= "sevt_a1b2c3" is re-delivered

  Scenario: Reconnect after a burst of events
    Given my client was disconnected
    And during the disconnection the server published 5000 events to sesn_abc
    When I reconnect with the last seen event ID
    Then I receive all 5000 missed events in order
    And the stream then transitions to live tail for events published thereafter
    And no events are duplicated or lost in the transition

  # ── Persistence invariants ─────────────────────────────────────────────────

  Scenario: Persist-before-publish
    When the agent emits an event
    Then the event is written to the durable event log before any SSE listener receives it
    And a subscriber that connects after that emission can recover the event via events.list
