# Managed Agents Console

Static first-pass implementation of the OMA Managed Agents Console handoff.

Run it from the repository root:

```bash
npm run ui:dev
```

Then open:

```text
http://127.0.0.1:4177/
```

This first slice is intentionally mock-data backed. It implements the visual and
interaction surface from the handoff bundle without coupling the UI to
control-plane stores. Wiring this shell to the public OMA REST/SSE APIs should
be a follow-up slice.
