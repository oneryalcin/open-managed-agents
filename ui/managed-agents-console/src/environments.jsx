// environments.jsx — readiness and environment list/create surfaces → window
const { useState: useStateE } = React;

const DEFAULT_ENV_CONFIG = {
  networking: { type: "limited", allowed_hosts: [] },
};

function EnvironmentError({ error }) {
  if (!error) return null;
  return (
    <div className="banner" role="alert">
      <Icon name="alert" size={16} />
      <div>
        <div className="b-main">Environment request failed</div>
        <div className="b-sub">{error.message}</div>
      </div>
    </div>
  );
}

function CreateEnvironmentModal({ mode, onClose, onCreated, onAuthExpired, api = window.OmaConsoleApi }) {
  const [name, setName] = useStateE("");
  const [busy, setBusy] = useStateE(false);
  const [error, setError] = useStateE(null);
  const trimmed = name.trim();
  const valid = trimmed.length > 0 && mode === "api" && !busy;

  const submit = () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    api.createEnvironment({ name: trimmed, config: DEFAULT_ENV_CONFIG })
      .then(onCreated)
      .catch((err) => {
        if (err.status === 401 && onAuthExpired) onAuthExpired();
        setError(err);
      })
      .finally(() => setBusy(false));
  };

  return (
    <Modal icon="database" title="Create environment" sub="Create a default-deny alpha environment for the configured sandbox provider." onClose={busy ? () => {} : onClose}
      footer={<>
        <span className="left">Sends to <span className="mono">POST /v1/environments</span></span>
        <button className="btn" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!valid} onClick={submit} aria-busy={busy}>
          <Icon name={busy ? "refresh" : "plus"} size={15} />{busy ? "Creating..." : "Create environment"}</button>
      </>}>
      {mode !== "api" && (
        <div className="inline-warn">
          <Icon name="alert" size={14} />
          <span>Environment creation is available only against the live API.</span>
        </div>
      )}
      <EnvironmentError error={error} />
      <Labeled label="Name" hint="Stored as the environment name. The API generates the environment ID.">
        <input className="input" autoFocus placeholder="e.g. default-docker-local" value={name}
          disabled={busy} onChange={(e) => { setName(e.target.value); setError(null); }} />
      </Labeled>
      <Labeled label="Preset" hint="Default-deny networking is the only field sent; model and sandbox-provider readiness are reported by action-time server errors.">
        <div className="env-preset" aria-label="Default-deny alpha preset">
          <div className="tool-ico"><Icon name="database" size={18} /></div>
          <div>
            <div className="cell-strong">Deployment sandbox · default-deny networking</div>
            <div className="mono env-config">{JSON.stringify({ config: DEFAULT_ENV_CONFIG })}</div>
          </div>
        </div>
      </Labeled>
    </Modal>
  );
}

function ReadinessView({ agents = [], environments = [], mode = "api", workspaceLoaded = false, go, onCreateEnvironment, onCreateAgent }) {
  const authReady = mode === "demo" || workspaceLoaded;
  const agentReady = agents.some((agent) => agent.status !== "archived");
  const envReady = environments.length > 0;
  const ready = authReady && agentReady && envReady;
  const items = [
    {
      key: "auth",
      title: "Workspace access",
      ok: authReady,
      detail: authReady ? "The console can read workspace-scoped /v1 resources." : "Enter a workspace key or browse from Admin.",
    },
    {
      key: "agent",
      title: "Agent present",
      ok: agentReady,
      detail: agentReady ? `${agents.filter((agent) => agent.status !== "archived").length} active agent(s) available.` : "Create an agent before starting a session.",
      action: agentReady ? () => go("agents") : onCreateAgent,
      actionLabel: agentReady ? "View agents" : "Open agents",
    },
    {
      key: "environment",
      title: "Environment present",
      ok: envReady,
      detail: envReady ? `${environments.length} environment(s) available for sessions.` : "Create a default-deny environment before starting a session.",
      action: envReady ? () => go("environments") : onCreateEnvironment,
      actionLabel: envReady ? "View environments" : "Create environment",
    },
  ];
  return (
    <div className="main-scroll scroll fade-in">
      <PageHead title="Start" sub="Observable readiness for the alpha console workflow." />
      <div className="readiness-summary panel">
        <div>
          <h2>{ready ? "Ready for session creation" : "Workspace setup is incomplete"}</h2>
          <p>Readiness is limited to authenticated workspace access plus agent and environment presence. Model, credential, and sandbox-provider failures appear during the action that hits them.</p>
        </div>
        <St k={ready ? "active" : "idle"} />
      </div>
      <div className="readiness-grid">
        {items.map((item) => (
          <div className="panel readiness-card" key={item.key}>
            <div className="readiness-card-head">
              <span className={'readiness-mark ' + (item.ok ? 'ok' : 'todo')}>
                <Icon name={item.ok ? "checkCircle" : "alert"} size={16} />
              </span>
              <div>
                <h3>{item.title}</h3>
                <p>{item.detail}</p>
              </div>
            </div>
            {item.action && <button className="btn btn-sm" onClick={item.action}>{item.actionLabel}</button>}
          </div>
        ))}
      </div>
    </div>
  );
}

function EnvironmentsView({ environments = [], mode = "api", dataState = "loaded", onCreate, createdEnvironmentId }) {
  const loading = dataState === "loading";
  const error = dataState === "error";
  const partial = dataState === "partial";
  const empty = dataState === "empty" || environments.length === 0;
  const readOnly = mode !== "api";
  return (
    <div className="main-scroll scroll fade-in">
      <PageHead title="Environments" sub="Sandbox execution environment configuration."
        action="Create environment" onAction={onCreate} readOnly={readOnly}
        endpoint="POST /v1/environments" />
      <div className="toolbar">
        <Field wide placeholder="Search by environment ID" />
        <Select label="Networking" value="All" w={150} />
      </div>
      {partial && <PartialNotice resource="environments" />}
      {createdEnvironmentId && (
        <div className="inline-ok" role="status">
          <Icon name="checkCircle" size={14} />
          <span>Created <span className="mono">{createdEnvironmentId}</span>. Refresh before retrying if a later request is ambiguous.</span>
        </div>
      )}
      {loading ? <SkeletonTable rows={4} cols={[150, 'grow', 210, 90]} lead={false} />
       : error ? <ErrorState resource="environments" onRetry={() => {}} />
       : empty ? <EmptyState icon="database" title="No environments yet"
            message="Create a default-deny alpha environment before starting a session."
            actionLabel={!readOnly ? "Create environment" : null} onAction={onCreate} />
       : <>
      <div className="panel">
        <div className="thead">
          <span className="th" style={{ width:150 }}>ID</span>
          <span className="th grow">Name</span>
          <span className="th" style={{ width:230 }}>Preset</span>
          <span className="th" style={{ width:90 }}>Status</span>
          <span className="th" style={{ width:70 }}>Created</span>
        </div>
        {environments.map((environment) => (
          <div className="trow env-row" key={environment.id}>
            <span className="td mono" style={{ width:150, fontSize:12, color:'var(--soft)' }}>{environment.id}</span>
            <span className="td grow cell-strong">{environment.label}</span>
            <span className="td mono" style={{ width:230, fontSize:12, color:'var(--soft)' }}>{environment.image}</span>
            <span className="td" style={{ width:90 }}><St k={environment.archived ? "archived" : "active"} /></span>
            <span className="td mono" style={{ width:70, color:'var(--faint)' }}>{environment.created || "—"}</span>
          </div>
        ))}
      </div>
      <Pager />
      </>}
    </div>
  );
}

Object.assign(window, {
  CreateEnvironmentModal,
  EnvironmentsView,
  ReadinessView,
});
