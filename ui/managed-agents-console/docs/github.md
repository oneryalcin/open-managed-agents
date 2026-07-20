# Accessing GitHub

> [!WARNING] Status: **Not ready in v1.** OMA does not currently provide CMA-style GitHub repository resources, repository mounts, pull-request creation, or token rotation for GitHub integration.

## What works today

An environment may allow approved GitHub HTTPS hosts for sandbox commands when Docker-local egress is enabled. That is ordinary bounded network access, not a GitHub integration feature.

## Do not assume

OMA does not clone or mount a repository from a session resource, manage repository credentials, create pull requests on a user's behalf, or expose hosted GitHub lifecycle controls. A future GitHub integration will be documented only when its resource, credential, permission, and audit behavior exist.
