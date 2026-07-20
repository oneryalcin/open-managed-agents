# Files

> [!NOTE] Status: **Shipped alpha for uploads, session mounts, output files, listing, downloading, and deletion.**

## Upload and inspect

Files are workspace-scoped resources. Use the Files console screen or API to upload, list, download, and delete them. Session output files remain available for inspection through the session and Files surfaces.

## Mount files when creating a session

Pass file resources at session creation. OMA validates ownership and creates the internal snapshot required by the selected sandbox provider before the session starts.

> [!WARNING] A session accepts at most 10 mounted files, while CMA documents 100. OMA also rewrites mount paths below its session uploads root and returns the original upload file ID; do not rely on CMA's literal mount-path or session-scoped file-ID behavior.

## Running-session changes

OMA does not support adding, listing, or deleting mounts on an already-created session. Create a new session when its file inputs need to change.
