const { useState: useVaultState, useEffect: useVaultEffect, useRef: useVaultRef } = React;

const DEMO_VAULTS = [{ id: 'vlt_demo', display_name: 'Demo integrations', created_at: '2026-07-01T00:00:00Z', archived_at: null }];
const DEMO_CREDENTIALS = [{ id: 'vcrd_demo', display_name: 'Demo MCP OAuth', archived_at: null, auth: { type: 'mcp_oauth', mcp_server_url: 'https://mcp.example.test/mcp', expires_at: '2026-12-01T00:00:00Z', refresh: { token_endpoint: 'https://auth.example.test/token', scope: 'read', token_endpoint_auth: { type: 'none' } } } }];

async function runMcpOauthPopup(startFlow, api = window.OmaConsoleApi) {
  const popup = window.open('', 'oma-mcp-oauth', 'popup,width=720,height=760');
  if (!popup) throw new Error('The authorization window was blocked. Allow popups for this console and try again.');
  let flowId = null;
  let wakePoll = null;
  const onMessage = (event) => {
    if (event.origin !== window.location.origin || event.data?.type !== 'oma:mcp-oauth') return;
    if (flowId !== null && event.data.flowId !== flowId) return;
    wakePoll?.();
  };
  window.addEventListener('message', onMessage);
  try {
    const started = await startFlow();
    flowId = started.flow_id;
    popup.location.replace(started.authorization_url);
    const expiresAt = Date.parse(started.expires_at);
    while (Date.now() < expiresAt) {
      const status = await api.getMcpOauthFlow(started.flow_id);
      if (status.status === 'connected') { popup.close(); return status; }
      if (status.status === 'failed' || status.status === 'expired') {
        popup.close();
        throw new Error(status.error?.message || 'The provider did not complete authorization.');
      }
      if (popup.closed) throw new Error('The authorization window was closed before the connection completed.');
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 750);
        wakePoll = () => { clearTimeout(timer); resolve(); };
      });
      wakePoll = null;
    }
    throw new Error('The authorization window expired. Start Connect again.');
  } catch (error) {
    popup.close();
    throw error;
  } finally {
    window.removeEventListener('message', onMessage);
  }
}

function ToneBadge({ tone, children }) {
  return <span className={'badge ' + VaultsData.toneBadgeClass(tone)}><i className="dot" />{children}</span>;
}

function VaultsView({ mode, initialVaultId, onCreate, onCreateCredential, readOnly = false, onOpenVault, onBackToVaults }) {
  const [vaults, setVaults] = useVaultState(null);
  const [error, setError] = useVaultState(null);
  const [selected, setSelected] = useVaultState(null);
  const [credentials, setCredentials] = useVaultState(null);
  const [detailError, setDetailError] = useVaultState(null);
  const [warning, setWarning] = useVaultState(null);
  const [confirm, setConfirm] = useVaultState(null);
  const [validation, setValidation] = useVaultState(null);
  const [validating, setValidating] = useVaultState(false);
  const [oauthBusy, setOauthBusy] = useVaultState(null);
  const [oauthNotice, setOauthNotice] = useVaultState(null);
  const epoch = useVaultRef(0);
  const selectedId = selected?.id || null;

  const refresh = () => {
    const current = ++epoch.current;
    setError(null); setVaults(null); setSelected(null); setCredentials(null); setWarning(null); setOauthNotice(null);
    if (mode !== 'api') { setVaults(DEMO_VAULTS.map(VaultsData.vaultRow)); return; }
    OmaConsoleApi.listVaults().then((page) => {
      if (current !== epoch.current) return;
      setVaults(page.data.map(VaultsData.vaultRow));
      if (page.truncated) setWarning(VaultsData.truncationWarning('vaults'));
    }).catch((err) => { if (current === epoch.current) setError(err); });
  };
  useVaultEffect(refresh, [mode]);

  // The ref is the authority for a detail request: React state updates are
  // asynchronous, so an old response must not win a fast selection change.
  const selectedRef = useVaultRef(null);
  selectedRef.current = selectedId;
  const open = (vault) => {
    const current = ++epoch.current;
    selectedRef.current = vault.id; setSelected(vault); setCredentials(null); setDetailError(null); setValidation(null); setValidating(false); setOauthBusy(null); setOauthNotice(null); setWarning(null);
    if (mode !== 'api') { setCredentials(DEMO_CREDENTIALS.map(VaultsData.credentialRow)); return; }
    OmaConsoleApi.listVaultCredentials(vault.id).then((page) => {
      if (!VaultsData.isCurrentVaultResult(current, epoch.current, vault.id, selectedRef.current)) return;
      setCredentials(page.data.map(VaultsData.credentialRow));
      if (page.truncated) setWarning(VaultsData.truncationWarning('credentials'));
    }).catch((err) => { if (VaultsData.isCurrentVaultResult(current, epoch.current, vault.id, selectedRef.current)) setDetailError(err); });
  };
  const back = () => { ++epoch.current; setSelected(null); setCredentials(null); setValidation(null); setValidating(false); setOauthBusy(null); setOauthNotice(null); setWarning(null); onBackToVaults(); };
  const validate = (credential) => {
    // Guard the result the same way the list/detail fetches are guarded: a
    // probe can take seconds, and the operator can navigate to another vault
    // before it resolves. Without this, A's outcome renders under vault B.
    const startedEpoch = epoch.current;
    const vaultId = selected.id;
    const isCurrent = () => VaultsData.isCurrentVaultResult(startedEpoch, epoch.current, vaultId, selectedRef.current);
    setConfirm(null); setValidating(true); setValidation(null);
    if (mode === 'demo') { setValidation({ result: { status: 'valid', mcp_probe: { http_response: { status_code: 200 } } } }); setValidating(false); return; }
    OmaConsoleApi.validateMcpOauthCredential(vaultId, credential.id, mode)
      .then((result) => { if (isCurrent()) setValidation({ result }); })
      .catch((err) => { if (isCurrent()) setValidation({ error: err.message }); })
      .finally(() => { if (isCurrent()) setValidating(false); });
  };
  const reauthorize = async (credential) => {
    const startedEpoch = epoch.current;
    const vaultId = selected.id;
    const isCurrent = () => VaultsData.isCurrentVaultResult(startedEpoch, epoch.current, vaultId, selectedRef.current);
    setOauthBusy(credential.id); setOauthNotice(null);
    try {
      if (mode === 'demo') {
        setOauthNotice({ tone:'ok', message:'Demo OAuth connection renewed.' });
        return;
      }
      await runMcpOauthPopup(
        () => OmaConsoleApi.reauthorizeMcpOauthCredential(vaultId, credential.id),
      );
      const page = await OmaConsoleApi.listVaultCredentials(vaultId);
      if (isCurrent()) {
        setCredentials(page.data.map(VaultsData.credentialRow));
        setOauthNotice({ tone:'ok', message:'OAuth connection renewed. Automatic refresh remains enabled.' });
      }
    } catch (err) {
      if (isCurrent()) setOauthNotice({ tone:'error', message:err.message || 'Reauthorization failed.' });
    } finally {
      if (isCurrent()) setOauthBusy(null);
    }
  };
  const disconnect = async (credential) => {
    const startedEpoch = epoch.current;
    const vaultId = selected.id;
    const isCurrent = () => VaultsData.isCurrentVaultResult(startedEpoch, epoch.current, vaultId, selectedRef.current);
    setConfirm(null); setOauthBusy(credential.id); setOauthNotice(null);
    try {
      if (mode === 'demo') {
        if (isCurrent()) setCredentials((rows) => rows.map((row) => row.id === credential.id ? { ...row, archivedAt:new Date().toISOString() } : row));
      } else {
        const archived = VaultsData.credentialRow(await OmaConsoleApi.archiveVaultCredential(vaultId, credential.id));
        if (isCurrent()) setCredentials((rows) => rows.map((row) => row.id === credential.id ? archived : row));
      }
      if (isCurrent()) setOauthNotice({ tone:'neutral', message:'Credential disconnected and archived. Existing sessions can no longer use it.' });
    } catch (err) {
      if (isCurrent()) setOauthNotice({ tone:'error', message:err.message || 'Disconnect failed.' });
    } finally {
      if (isCurrent()) setOauthBusy(null);
    }
  };
  useVaultEffect(() => {
    if (!initialVaultId || !vaults || selected) return;
    const vault = vaults.find((item) => item.id === initialVaultId);
    if (vault) open(vault);
  }, [initialVaultId, vaults]);

  const body = selected
    ? <VaultDetail vault={selected} credentials={credentials} error={detailError} warning={warning}
        onBack={back} onRetry={() => open(selected)}
        mode={mode} readOnly={readOnly} onCreateCredential={() => onCreateCredential(selected)} validating={validating} validation={validation}
        oauthBusy={oauthBusy} oauthNotice={oauthNotice} onValidate={(credential) => setConfirm({ kind:'validate', credential })}
        onReauthorize={reauthorize} onDisconnect={(credential) => setConfirm({ kind:'disconnect', credential })} />
    : <div className="main-scroll scroll fade-in">
        <PageHead title="Vaults" sub="Manage workspace vaults and validate MCP OAuth credentials."
          action="Create vault" onAction={onCreate} readOnly={readOnly} endpoint="POST /v1/vaults" />
        {warning && <div className="inline-warn"><Icon name="alert" size={14} /><span>{warning}</span></div>}
        {vaults === null && !error ? <SkeletonTable rows={4} cols={[180, 'grow', 120, 100]} />
          : error ? <ErrorState resource="vaults" onRetry={refresh} />
          : vaults.length === 0 ? <EmptyState icon="database" title="No vaults" message="This workspace has no vaults. Create one before adding MCP credentials."
            actionLabel={!readOnly ? 'Create vault' : null} onAction={onCreate} />
          : <div className="panel">{vaults.map((vault) => <div className="trow" key={vault.id} style={{ opacity: vault.archivedAt ? 0.55 : 1 }} onClick={() => { onOpenVault(vault.id); open(vault); }}>
            <span className="td mono" style={{ width:180, fontSize:12 }}>{vault.id}</span>
            <span className="td grow cell-strong">{vault.displayName}</span>
            <span className="td mono" style={{ width:120, color:'var(--faint)', fontSize:12 }}>{VaultsData.relativeTime(vault.createdAt)}</span>
            <span className="td" style={{ width:100 }}>{vault.archivedAt ? <St k="archived" /> : <St k="active" />}</span>
          </div>)}</div>}
      </div>;

  // The dialog lives at the component root so it renders in both the list and
  // detail branches (an earlier revision nested it under the list only, which
  // made Validate a no-op once a vault was open).
  return <>
    {body}
    {confirm?.kind === 'validate' && <ConfirmDialog icon="alert" title="Validate credential"
      message="Validate contacts the MCP server with this credential and may refresh the token at the provider."
      confirmLabel="Validate" endpoint="POST /v1/vaults/:id/credentials/:id/mcp_oauth_validate"
      onClose={() => setConfirm(null)} onConfirm={() => validate(confirm.credential)} />}
    {confirm?.kind === 'disconnect' && <ConfirmDialog icon="archive" danger title="Disconnect credential"
      message="Archive this credential? Existing sessions will no longer be able to use it. Provider-side authorization is not revoked."
      confirmLabel="Disconnect" endpoint="POST /v1/vaults/:id/credentials/:id/archive"
      onClose={() => setConfirm(null)} onConfirm={() => disconnect(confirm.credential)} />}
  </>;
}

function VaultDetail({ vault, credentials, error, warning, onBack, onRetry, mode, readOnly, onCreateCredential, validating, validation, onValidate, oauthBusy, oauthNotice, onReauthorize, onDisconnect }) {
  return <div className="main-scroll scroll fade-in"><PageHead title={vault.displayName} sub={vault.id} />
    <div className="toolbar"><button className="btn" onClick={onBack}>Back to vaults</button>{!readOnly && <button className="btn btn-primary" onClick={onCreateCredential}><Icon name="plus" size={15} />Add credential</button>}</div>
    {warning && <div className="inline-warn"><Icon name="alert" size={14} /><span>{warning}</span></div>}
    {credentials === null && !error ? <SkeletonTable rows={3} cols={[180, 'grow', 120]} />
      : error ? <ErrorState resource="credentials" onRetry={onRetry} />
      : credentials.length === 0 ? <EmptyState icon="database" title="No credentials" message="This vault has no credentials. Add one to authorize a matching MCP server."
        actionLabel={!readOnly ? 'Add credential' : null} onAction={onCreateCredential} />
      : <div className="panel">{credentials.map((c) => <div className="trow" key={c.id} style={{ display:'block', cursor:'default', padding:'14px', opacity: c.archivedAt ? 0.55 : 1 }}>
        <div style={{ display:'flex', gap:12, alignItems:'center' }}><span className="mono" style={{ color:'var(--soft)' }}>{c.id}</span><b>{c.displayName}</b><span className="pill">{c.authType}</span>{c.archivedAt && <St k="archived" />}</div>
        <div className="field-hint" style={{ marginTop:6 }}>{c.serverUrl || 'No server URL'} · expires {VaultsData.relativeTime(c.expiresAt)}</div>
        {c.refresh && <div className="field-hint">token host {c.refresh.tokenEndpointHost} · {c.refresh.scope || 'no scope'} · {c.refresh.endpointAuth || 'no endpoint auth'}</div>}
        {mode !== 'mock' && !c.archivedAt && c.authType === 'mcp_oauth' && <div style={{ display:'flex', gap:8, marginTop:8 }}>
          <button className="btn" disabled={validating || oauthBusy === c.id} onClick={() => onValidate(c)}>{validating ? 'Validating…' : 'Validate'}</button>
          {c.refresh && <button className="btn" disabled={oauthBusy === c.id} onClick={() => onReauthorize(c)}>{oauthBusy === c.id ? 'Connecting…' : 'Reauthorize'}</button>}
          <button className="btn btn-danger" disabled={oauthBusy === c.id || readOnly} onClick={() => onDisconnect(c)}>Disconnect</button>
        </div>}
      </div>)}</div>}
    {oauthNotice && <div className={oauthNotice.tone === 'error' ? 'inline-warn' : 'panel'} role="status" style={{ marginTop:12, padding:14 }}><span>{oauthNotice.message}</span></div>}
    {validation && <ValidationResult value={validation} />}
  </div>;
}

function ValidationResult({ value }) {
  if (value.error) return <div className="inline-warn" style={{ marginTop:12 }}><Icon name="alert" size={14} /><span>{value.error}</span></div>;
  const outcome = VaultsData.validationOutcome(value.result);
  const detail = VaultsData.validationDetail(value.result);
  return <div className="panel" style={{ marginTop:12, padding:14 }}>
    <div style={{ display:'flex', gap:8, alignItems:'center' }}><ToneBadge tone={outcome.tone}>{value.result?.status || 'error'}</ToneBadge><b>{outcome.message}</b></div>
    {detail.probeStatus && <div className="field-hint" style={{ marginTop:6 }}>Probe HTTP {detail.probeStatus}</div>}
    {detail.refreshStatus && <div className="field-hint">Refresh {detail.refreshStatus}{detail.refreshHttpStatus ? ` · HTTP ${detail.refreshHttpStatus}` : ''}</div>}
    <details style={{ marginTop:8 }}><summary>Details</summary><pre className="code" style={{ whiteSpace:'pre-wrap' }}>{JSON.stringify(value.result ?? {}, null, 2)}</pre></details>
  </div>;
}

function CredentialHealthView({ workspaceId, onBack, onReauth }) {
  const [page, setPage] = useVaultState(null);
  const [error, setError] = useVaultState(null);
  const [cursor, setCursor] = useVaultState(null);
  const load = (next = null) => {
    setError(null); setPage(null); setCursor(next);
    OmaConsoleApi.listWorkspaceCredentialHealth(workspaceId, next)
      .then(setPage)
      .catch((err) => { if (err.status === 401) onReauth(); else setError(err); });
  };
  useVaultEffect(() => load(null), [workspaceId]);
  const groups = new Map();
  for (const row of page?.data || []) {
    const key = `${row.vaultId}:${row.vaultDisplayName}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return <div className="main-scroll scroll fade-in"><PageHead title="Credential health" sub={`Administrative health for ${workspaceId}.`} />
    <div className="toolbar"><button className="btn" onClick={onBack}>Back to Admin</button><button className="btn" onClick={() => load(cursor)}>Refresh</button></div>
    {page === null && !error ? <SkeletonTable rows={5} cols={['grow', 210, 120, 130]} />
      : error ? <ErrorState resource="credential health" onRetry={() => load(cursor)} />
      : page.data.length === 0 ? <EmptyState icon="database" title="No credentials" message="This workspace has no stored vault credentials." />
      : [...groups.entries()].map(([key, rows]) => <div className="panel" key={key} style={{ marginBottom:12, opacity: rows[0].vaultArchivedAt ? 0.6 : 1 }}>
        <div style={{ padding:'10px 14px', borderBottom:'1px solid var(--border)' }}><b>{rows[0].vaultDisplayName}</b>{rows[0].vaultArchivedAt && <span className="field-hint"> · archived</span>}</div>
        {rows.map((row) => { const state = VaultsData.healthState(row); return <div className="trow" key={row.credentialId} style={{ cursor:'default', opacity: row.credentialArchivedAt ? 0.55 : 1 }}>
          <span className="td grow"><b>{row.credentialDisplayName || row.credentialId}</b><span className="field-hint"> · {row.authType} · {VaultsData.urlHost(row.mcpServerUrl)}</span>{row.credentialArchivedAt && <span className="field-hint"> · archived</span>}</span>
          <span className="td" style={{ width:210, display:'flex', gap:6, alignItems:'center', flexWrap:'wrap' }}>
            <ToneBadge tone={state.tone}>{state.label}</ToneBadge>
            {state.label === 'transient' && <span className="field-hint">{row.refreshAttempts} attempts</span>}
            {row.authHintAt && <span className="badge st-action"><i className="dot" />Auth hint</span>}
          </span>
          <span className="td" style={{ width:120, color:'var(--faint)' }}>exp {VaultsData.relativeTime(row.expiresAt)}</span>
          <span className="td" style={{ width:130, color:'var(--faint)' }}>next {row.nextRefreshAt ? VaultsData.relativeTime(row.nextRefreshAt) : '—'}</span>
        </div>; })}
      </div>)}
    {page?.has_more && page.next_page && <button className="btn" onClick={() => load(page.next_page)}>Next page</button>}
  </div>;
}

Object.assign(window, { VaultsView, CredentialHealthView, runMcpOauthPopup, VaultsData: window.VaultsData || {} });
