// auth.jsx — login view + admin panel (plan 0120 §3.4). → window
//
// Keys are session-scoped: they live in api.js module memory only and are
// re-entered after a reload. The minted plaintext is rendered exactly once,
// never stored, never logged.
const { useState: useStateA, useEffect: useEffectA } = React;

function LoginView({ onAdminLogin, onWorkspaceLogin, error, busy }) {
  const [tier, setTier] = useStateA('admin');
  const [key, setKey] = useStateA('');
  const valid = key.trim().length > 0 && !busy;
  const submit = (e) => {
    e.preventDefault();
    if (!valid) return;
    (tier === 'admin' ? onAdminLogin : onWorkspaceLogin)(key.trim());
  };
  return (
    <div className="main-scroll scroll fade-in">
      <PageHead title="Connect" sub="This OMA server requires a key. Nothing is stored — a reload asks again." />
      <div className="panel" style={{ maxWidth: 520, padding: 22 }}>
        <form onSubmit={submit}>
          <Labeled label="Credential">
            <div className="seg-tools">
              {[['admin', 'Admin key'], ['workspace', 'Workspace key']].map(([value, label]) => (
                <span key={value} className={'tool-toggle' + (tier === value ? ' on' : '')}
                  onClick={() => setTier(value)}>
                  <span className="chk">{tier === value && <Icon name="checkCircle" size={9} />}</span>
                  <span className="mono">{label}</span>
                </span>
              ))}
            </div>
          </Labeled>
          <Labeled label={tier === 'admin' ? 'OMA_ADMIN_KEY' : 'x-api-key'}
            hint={tier === 'admin'
              ? 'Manage workspaces and API keys via /admin.'
              : 'Browse this workspace’s agents, sessions, and files via /v1.'}>
            <input className="input mono" type="password" autoComplete="off"
              placeholder={tier === 'admin' ? 'base64 admin key…' : 'oma_…'}
              value={key} onChange={(e) => setKey(e.target.value)} autoFocus />
          </Labeled>
          {error && <div className="inline-warn"><Icon name="alert" size={14} /><span>{error}</span></div>}
          <div className="actions" style={{ marginTop: 14 }}>
            <button className="btn btn-primary" type="submit" disabled={!valid}
              style={{ opacity: valid ? 1 : .5 }}>
              <Icon name="arrowRight" size={15} />{busy ? 'Checking…' : 'Connect'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function MintedKeyModal({ minted, onClose, onBrowse }) {
  const [copied, setCopied] = useStateA(false);
  const copy = () => {
    // Clipboard can be unavailable (non-secure context, denied permission);
    // the plaintext stays visible in the modal either way.
    navigator.clipboard.writeText(minted.api_key)
      .then(() => setCopied(true))
      .catch(() => {});
  };
  return (
    <Modal icon="hash" title="Workspace key minted"
      sub="Shown once. The server stores only a hash — copy it now." onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Close</button>
        <button className="btn" onClick={copy}>{copied ? 'Copied' : 'Copy key'}</button>
        <button className="btn btn-primary" onClick={() => onBrowse(minted.api_key)}>
          Browse as this workspace</button>
      </>}>
      <div className="code scroll" style={{ padding: 12 }}>
        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{minted.api_key}</pre>
      </div>
      <div className="field-hint" style={{ marginTop: 10 }}>
        {minted.workspace_id} · {minted.label || 'no label'} · sha256 {shortId(minted.key_sha256)}
      </div>
    </Modal>
  );
}

function AdminPanel({ onBrowseWorkspace, onReauth }) {
  const [workspaces, setWorkspaces] = useStateA(null);
  const [error, setError] = useStateA(null);
  const [name, setName] = useStateA('');
  const [open, setOpen] = useStateA(null);      // expanded workspace id
  const [keys, setKeys] = useStateA({});        // workspace id -> metadata[]
  const [label, setLabel] = useStateA('');
  const [minted, setMinted] = useStateA(null);
  const [minting, setMinting] = useStateA(false);
  const [revoking, setRevoking] = useStateA(null);

  const fail = (err) => {
    if (err.status === 401) onReauth();
    else setError(err.message);
  };
  const refresh = () => {
    OmaConsoleApi.listWorkspaces().then(setWorkspaces).catch(fail);
  };
  const refreshKeys = (workspaceId) => {
    OmaConsoleApi.listKeys(workspaceId)
      .then((list) => setKeys((prev) => ({ ...prev, [workspaceId]: list })))
      .catch(fail);
  };
  useEffectA(refresh, []);

  const create = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    OmaConsoleApi.createWorkspace(name.trim())
      .then(() => { setName(''); refresh(); })
      .catch(fail);
  };
  const toggle = (workspaceId) => {
    const next = open === workspaceId ? null : workspaceId;
    setOpen(next);
    setLabel('');
    if (next) refreshKeys(next);
  };
  const mint = (workspaceId) => {
    if (minting) return; // UI guard; api.js also dedupes in-flight mints
    setMinting(true);
    OmaConsoleApi.mintKey(workspaceId, label.trim() || undefined)
      .then((key) => { setMinted(key); setLabel(''); refreshKeys(workspaceId); })
      .catch(fail)
      .finally(() => setMinting(false));
  };
  const revoke = (key) => {
    OmaConsoleApi.revokeKey(key.key_sha256)
      .then(() => { setRevoking(null); refreshKeys(key.workspace_id); })
      .catch(fail);
  };

  return (
    <div className="main-scroll scroll fade-in">
      <PageHead title="Admin" sub="Workspaces and API keys. Every action is audit-logged server-side." />
      {error && <div className="inline-warn"><Icon name="alert" size={14} /><span>{error}</span></div>}

      <form className="toolbar" onSubmit={create}>
        <Field icon="plus" placeholder="New workspace name" wide value={name} onChange={setName} />
        <button className="btn btn-primary" type="submit" disabled={!name.trim()}
          style={{ opacity: name.trim() ? 1 : .5 }}>
          <Icon name="plus" size={15} />Create workspace</button>
      </form>

      {workspaces === null ? <SkeletonTable rows={4} cols={[160, 'grow', 90]} />
       : workspaces.length === 0 ? <EmptyState icon="database" title="No workspaces"
            message="Create a workspace, then mint an API key for it." />
       : <div className="panel">
        <div className="thead">
          <span className="th" style={{ width: 170 }}>ID</span>
          <span className="th grow">Name</span>
          <span className="th" style={{ width: 110 }}>Created</span>
          <span className="th" style={{ width: 70 }} />
        </div>
        {workspaces.map((workspace) => (
          <React.Fragment key={workspace.id}>
            <div className="trow" onClick={() => toggle(workspace.id)}>
              <span className="td mono" style={{ width: 170, fontSize: 12, color: 'var(--soft)' }}>{workspace.id}</span>
              <span className="td grow ell cell-strong">{workspace.name}</span>
              <span className="td mono" style={{ width: 110, color: 'var(--faint)' }}>{shortDate(workspace.created_at)}</span>
              <span className="td" style={{ width: 70, color: 'var(--faint)' }}>
                {open === workspace.id ? 'close' : 'keys'}</span>
            </div>
            {open === workspace.id && (
              <div style={{ padding: '10px 14px 16px', borderBottom: '1px solid var(--border)' }}>
                <div className="toolbar" style={{ marginBottom: 8 }}>
                  <Field icon="hash" placeholder="Key label (optional)" value={label} onChange={setLabel} style={{ width: 240 }} />
                  <button className="btn btn-primary" onClick={() => mint(workspace.id)}
                    disabled={minting} style={{ opacity: minting ? .5 : 1 }}>
                    <Icon name="plus" size={15} />{minting ? 'Minting…' : 'Mint key'}</button>
                </div>
                {(keys[workspace.id] || []).length === 0
                  ? <div className="field-hint">No keys yet.</div>
                  : (keys[workspace.id] || []).map((key) => (
                    <div className="trow" key={key.key_sha256} style={{ cursor: 'default' }}>
                      <span className="td mono" style={{ width: 150, fontSize: 12 }}>{shortId(key.key_sha256)}</span>
                      <span className="td grow ell">{key.label || '—'}</span>
                      <span className="td" style={{ width: 96 }}>
                        {key.revoked_at ? <St k="archived" /> : <St k="active" />}</span>
                      <span className="td mono" style={{ width: 110, color: 'var(--faint)' }}>{shortDate(key.created_at)}</span>
                      <span className="td" style={{ width: 80 }}>
                        {!key.revoked_at &&
                          <button className="btn" onClick={() => setRevoking(key)}>Revoke</button>}
                      </span>
                    </div>
                  ))}
              </div>
            )}
          </React.Fragment>
        ))}
      </div>}

      {minted && <MintedKeyModal minted={minted} onClose={() => setMinted(null)}
        onBrowse={(plaintext) => { setMinted(null); onBrowseWorkspace(plaintext); }} />}
      {revoking && <ConfirmDialog icon="alert" danger title="Revoke key"
        message={`Revoke ${revoking.label || shortId(revoking.key_sha256)}? Clients using it get 401 immediately.`}
        confirmLabel="Revoke" endpoint="DELETE /admin/keys/:sha256"
        onClose={() => setRevoking(null)} onConfirm={() => revoke(revoking)} />}
    </div>
  );
}

function shortId(id) {
  if (!id || id.length <= 14) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

function shortDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(value));
}

Object.assign(window, { LoginView, AdminPanel });
