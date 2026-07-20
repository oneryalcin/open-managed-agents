# Scheduled deployments

> [!WARNING] Status: **Not ready in v1.** OMA has no deployment, deployment-run, cron, pause, archive, or manual-run API.

Run sessions from your own scheduler only if you can own the credential, idempotency, monitoring, retry, and cleanup behavior around it. OMA does not yet expose a managed scheduling contract or webhook-based deployment reporting.
