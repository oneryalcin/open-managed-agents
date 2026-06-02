# Copyright 2026 Anthropic PBC
# SPDX-License-Identifier: Apache-2.0
"""Streamlit-cached wrappers around the OMA SRE agent SDK helpers."""

from __future__ import annotations

import streamlit as st

import agent_core

client = agent_core.client


@st.cache_resource
def setup_agent() -> str:
    return agent_core.create_agent()


@st.cache_resource
def setup_environment() -> str:
    return agent_core.create_environment()


@st.cache_resource
def upload_log() -> str:
    return agent_core.upload_log()


def start_session(agent_id: str, env_id: str, log_file_id: str) -> str:
    return agent_core.start_session(agent_id, env_id, log_file_id)


def stream_reply(session_id: str, user_text: str):
    yield from agent_core.stream_reply(session_id, user_text)


def handle_tool(name: str, args: dict) -> str:
    return agent_core.handle_tool(name, args)


def delete_session(session_id: str) -> None:
    agent_core.delete_session(session_id)
