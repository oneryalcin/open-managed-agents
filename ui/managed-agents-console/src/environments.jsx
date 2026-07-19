// environments.jsx — readiness and environment list/create surfaces → window
const { useState: useStateE } = React;

const DEFAULT_ENV_CONFIG = {
  networking: { type: "limited", allowed_hosts: [] },
};

function presetCopy(preset) {
  return {
    label: preset.label || preset.id,
    description: preset.description || "Deployment-defined limited egress preset.",
  };
}

function networkingConfigForHosts(hosts) {
  return { networking: { type: "limited", allowed_hosts: hosts } };
}

function splitCustomHosts(text) {
  return text
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function previewHosts(hosts) {
  if (!hosts.length) return "No hosts; all outbound network access remains blocked.";
  return hosts.join("\n");
}

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

function CreateEnvironmentModal({ mode, networkingCatalog, onClose, onCreated, onAuthExpired, api = window.OmaConsoleApi }) {
  const [name, setName] = useStateE("");
  const catalog = networkingCatalog?.presets?.length
    ? networkingCatalog.presets
    : [{ id:"offline-v1", label:"Offline", description:"No external network access.", allowed_hosts:[], config:DEFAULT_ENV_CONFIG }];
  const deployment = networkingCatalog?.deployment ?? {
    provider:null,
    egress_supported:false,
    reason:"Networking capability was not reported by this deployment.",
  };
  const [presetId, setPresetId] = useStateE(catalog[0].id);
  const [customHostsText, setCustomHostsText] = useStateE("");
  const [validatedHosts, setValidatedHosts] = useStateE(null);
  const [validationBusy, setValidationBusy] = useStateE(false);
  const [busy, setBusy] = useStateE(false);
  const [error, setError] = useStateE(null);
  const trimmed = name.trim();
  const selectedPreset = catalog.find((preset) => preset.id === presetId) ?? catalog[0];
  const selectedCopy = presetId === "custom"
    ? { label:"Custom allowlist", description:"Validated custom limited egress." }
    : presetCopy(selectedPreset);
  const customHosts = splitCustomHosts(customHostsText);
  const selectedHosts = presetId === "custom"
    ? (validatedHosts ?? [])
    : (selectedPreset?.config?.networking?.allowed_hosts ?? selectedPreset?.allowed_hosts ?? []);
  const selectedConfig = networkingConfigForHosts(selectedHosts);
  const selectedNeedsEgress = selectedHosts.length > 0;
  const capabilityReady = !selectedNeedsEgress || deployment.egress_supported === true;
  const customValid = presetId !== "custom" || (Array.isArray(validatedHosts) && validatedHosts.length > 0);
  const valid = trimmed.length > 0 && mode === "api" && !busy && !validationBusy && customValid && capabilityReady;

  const choosePreset = (id) => {
    setPresetId(id);
    setValidatedHosts(null);
    setError(null);
  };

  const validateCustom = () => {
    if (mode !== "api" || !customHosts.length || validationBusy || busy) return;
    setValidationBusy(true);
    setError(null);
    api.validateEnvironmentNetworkingHosts(customHosts)
      .then((hosts) => setValidatedHosts(hosts))
      .catch((err) => {
        if (err.status === 401 && onAuthExpired) onAuthExpired();
        setValidatedHosts(null);
        setError(err);
      })
      .finally(() => setValidationBusy(false));
  };

  const submit = () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    api.createEnvironment({ name: trimmed, config: selectedConfig })
      .then(onCreated)
      .catch((err) => {
        if (err.status === 401 && onAuthExpired) onAuthExpired();
        setError(err);
      })
      .finally(() => setBusy(false));
  };

  return (
    <Modal icon="database" title="Create environment" sub="Create an immutable sandbox environment with an explicit limited-network policy." onClose={busy ? () => {} : onClose}
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
      <Labeled label="Name" htmlFor="create-environment-name" hint="Stored as the environment name. The API generates the environment ID.">
        <input id="create-environment-name" name="name" className="input" autoFocus placeholder="e.g. default-docker-local" value={name}
          disabled={busy} onChange={(e) => { setName(e.target.value); setError(null); }} />
      </Labeled>
      <Labeled label="Networking preset" hint="Policy controls allowed destinations. The server separately reports whether this deployment can enforce egress.">
        <div className={deployment.egress_supported ? "inline-ok" : "inline-warn"} role="status">
          <Icon name={deployment.egress_supported ? "checkCircle" : "alert"} size={14} />
          <span>{deployment.egress_supported
            ? `${deployment.provider || "This deployment"} supports approved HTTPS egress.`
            : (deployment.reason || "This deployment cannot run network-enabled environments.")}</span>
        </div>
        <div className="env-preset-grid" role="radiogroup" aria-label="Networking preset">
          {catalog.map((preset) => {
            const copy = presetCopy(preset);
            return (
              <button type="button" className={'env-choice' + (presetId === preset.id ? ' on' : '')} key={preset.id}
                disabled={busy || (preset.config?.networking?.allowed_hosts?.length > 0 && !deployment.egress_supported)} role="radio" aria-checked={presetId === preset.id} onClick={() => choosePreset(preset.id)}>
                <span className="dot-r" />
                <span>
                  <span className="r-main">{copy.label}</span>
                  <span className="r-sub">{copy.description}</span>
                </span>
              </button>
            );
          })}
          <button type="button" className={'env-choice' + (presetId === "custom" ? ' on' : '')}
            disabled={busy || !deployment.egress_supported} role="radio" aria-checked={presetId === "custom"} onClick={() => choosePreset("custom")}>
            <span className="dot-r" />
            <span>
              <span className="r-main">Custom allowlist</span>
              <span className="r-sub">Enter exact hosts or supported leading wildcards.</span>
            </span>
          </button>
        </div>
      </Labeled>
      {presetId === "custom" && (
        <Labeled label="Allowed hosts" htmlFor="create-environment-hosts" hint="Use commas or new lines. A wildcard such as *.example.com matches subdomains only; add example.com separately for the bare domain.">
          <textarea id="create-environment-hosts" className="textarea" value={customHostsText} disabled={busy}
            placeholder={"registry.npmjs.org\n*.pypi.org\nfiles.pythonhosted.org"}
            onChange={(event) => { setCustomHostsText(event.target.value); setValidatedHosts(null); setError(null); }} />
          <div className="env-actions">
            <button className="btn btn-sm" disabled={!customHosts.length || validationBusy || busy || mode !== "api"} onClick={validateCustom}>
              <Icon name={validationBusy ? "refresh" : "checkCircle"} size={14} />{validationBusy ? "Validating..." : "Validate hosts"}
            </button>
            <span className="field-hint">{validatedHosts ? `${validatedHosts.length} normalized host(s) accepted by server validation.` : "Create remains disabled until validation succeeds."}</span>
          </div>
        </Labeled>
      )}
      <Labeled label="Exact generated hosts" hint="Environment policies are immutable. To change networking, create a new environment and start a new session. No secrets are stored in the environment or shown to the guest.">
        <div className="env-preset" aria-label="Generated networking policy preview">
          <div className="tool-ico"><Icon name="database" size={18} /></div>
          <div className="grow">
            <div className="cell-strong">{presetId === "custom" ? "Custom limited egress" : selectedCopy.label}</div>
            <pre className="mono env-host-preview">{previewHosts(selectedHosts)}</pre>
            <div className="mono env-config">{JSON.stringify({ config: selectedConfig })}</div>
          </div>
        </div>
      </Labeled>
    </Modal>
  );
}

function ReadinessView({ agents = [], environments = [], models = [], mode = "api", workspaceLoaded = false, go, onCreateEnvironment, onCreateAgent, onCreateSession }) {
  const authReady = mode === "demo" || workspaceLoaded;
  const activeAgents = agents.filter((agent) => agent.status !== "archived");
  const envReady = environments.length > 0;
  const modelReady = models.length > 0;
  const credentialReady = models.some((model) => model.credentials_configured);
  const readyModelKeys = new Set(models.filter((model) => model.credentials_configured).map((model) => `${model.provider}/${model.id}`));
  const agentModelKey = (agent) => agent.modelProvider && agent.modelId
    ? `${agent.modelProvider}/${agent.modelId}`
    : String(agent.model || "").includes("/") ? String(agent.model) : `anthropic/${agent.model}`;
  const agentReady = activeAgents.some((agent) => readyModelKeys.has(agentModelKey(agent)));
  const ready = authReady && agentReady && envReady && modelReady && credentialReady;
  const items = [
    {
      key: "auth",
      title: "Workspace access",
      ok: authReady,
      detail: authReady ? "The console can read workspace-scoped /v1 resources." : "Enter a workspace key or browse from Admin.",
    },
    {
      key: "model",
      title: "Model and credentials",
      ok: modelReady && credentialReady,
      detail: !modelReady
        ? "No selectable models were returned by this deployment."
        : credentialReady
          ? `${models.filter((model) => model.credentials_configured).length} selectable model(s) report configured credentials.`
          : "Models are registered, but none report configured credentials. Run oma doctor, then oma auth set <provider>.",
    },
    {
      key: "agent",
      title: "Runnable agent present",
      ok: agentReady,
      detail: agentReady
        ? `${activeAgents.filter((agent) => readyModelKeys.has(agentModelKey(agent))).length} active agent(s) use a credential-ready model.`
        : activeAgents.length > 0
          ? "Active agents exist, but none use a credential-ready model. Create an agent with a ready model."
          : "Create an agent before starting a session.",
      action: agentReady ? () => go("agents") : onCreateAgent,
      actionLabel: agentReady ? "View agents" : "Create agent",
    },
    {
      key: "environment",
      title: "Environment present",
      ok: envReady,
      detail: envReady ? `${environments.length} environment(s) available for sessions.` : "Create a default-deny environment before starting a session.",
      action: envReady ? () => go("environments") : onCreateEnvironment,
      actionLabel: envReady ? "View environments" : "Create environment",
    },
    {
      key: "sandbox",
      title: "Sandbox verification",
      ok: null,
      detail: "Sandbox execution is verified by the first session tool run, not guessed by the browser. Run oma doctor for local prerequisite checks.",
    },
  ];
  return (
    <div className="main-scroll scroll fade-in">
      <PageHead title="Start" sub="Observable readiness for the alpha console workflow." />
      <div className="readiness-summary panel">
        <div>
          <h2>{ready ? "Ready for session creation" : "Workspace setup is incomplete"}</h2>
          <p>Readiness uses the live workspace model catalog and credential flags. Sandbox execution remains unverified until a session runs a tool.</p>
        </div>
        <St k={ready ? "active" : "idle"} />
      </div>
      <div className="readiness-grid">
        {items.map((item) => (
          <div className="panel readiness-card" key={item.key}>
            <div className="readiness-card-head">
              <span className={'readiness-mark ' + (item.ok ? 'ok' : 'todo')}>
                <Icon name={item.ok === null ? "info" : item.ok ? "checkCircle" : "alert"} size={16} />
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
      {ready && <button className="btn btn-primary" onClick={onCreateSession}><Icon name="plus" size={15} />Create session</button>}
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
            <span className="td mono" style={{ width:230, fontSize:12, color:'var(--soft)' }}>{environment.networkingSummary || environment.image}</span>
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
