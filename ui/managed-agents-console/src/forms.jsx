// forms.jsx — Create-session / create-agent modals → window
const { useState: useStateF } = React;

function Modal({ icon, title, sub, onClose, children, footer }) {
  const stop = (e) => e.stopPropagation();
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={stop} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div className="ic"><Icon name={icon} size={18} /></div>
          <div>
            <h2>{title}</h2>
            {sub && <p>{sub}</p>}
          </div>
          <span className="kebab x" onClick={onClose}><Icon name="x" size={17} /></span>
        </div>
        <div className="modal-body scroll">{children}</div>
        <div className="modal-foot">{footer}</div>
      </div>
    </div>
  );
}

function Labeled({ label, opt, hint, htmlFor, children }) {
  return (
    <div className="form-row">
      <label className="form-label" htmlFor={htmlFor}>{label}{opt && <span className="opt">optional</span>}</label>
      {children}
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

// ─────────── Create session ───────────
function CreateSession({ agents = AGENTS, environments = ENVIRONMENTS, vaults = [], presetAgent, onClose, onCreate, onAuthExpired, apiMode = 'demo', api = window.OmaConsoleApi }) {
  const choices = agents.filter((a) => a.status === 'active');
  const activeEnvironments = environments.filter((environment) => !environment.archived);
  const activePreset = presetAgent?.status === 'active' ? presetAgent : null;
  const [agentId, setAgentId] = useStateF((activePreset && activePreset.id) || (choices[0] && choices[0].id));
  const [env, setEnv] = useStateF(() => apiMode === 'api'
    ? (activeEnvironments[0]?.id || '')
    : (activeEnvironments[0]?.id || ENVIRONMENTS[0].id));
  const [customEnv, setCustomEnv] = useStateF('');
  const [title, setTitle] = useStateF('');
  const [msg, setMsg] = useStateF('');
  const [vaultIds, setVaultIds] = useStateF([]);
  const [vaultCredentialStates, setVaultCredentialStates] = useStateF({});
  const [busy, setBusy] = useStateF(false);
  const [error, setError] = useStateF('');
  const [partial, setPartial] = useStateF(null);
  const [sessionIntent] = useStateF(() => api?.createIdempotencyIntent?.());
  const [eventIntent] = useStateF(() => api?.createIdempotencyIntent?.());

  const agent = agents.find((a) => a.id === agentId);
  const usingCustom = env === '__custom';
  const finalEnv = usingCustom ? customEnv.trim() : env;
  const live = apiMode === 'api';
  const selectedVaultCompatibility = vaultIds.map((vaultId) => ({
    vault: vaults.find((item) => item.id === vaultId),
    result: window.SessionVaultsData.vaultCompatibility(agent, vaultCredentialStates[vaultId]),
  }));
  const incompatibleVaults = selectedVaultCompatibility.filter(({ result }) => result.status === 'incompatible');
  const unavailableVaults = selectedVaultCompatibility.filter(({ result }) => result.status === 'error');
  const loadingVaults = selectedVaultCompatibility.filter(({ result }) => result.status === 'loading');
  const agentHasMcp = window.SessionVaultsData.agentMcpServerUrls(agent).length > 0;
  const vaultsReady = !live || selectedVaultCompatibility.every(({ result }) => result.compatible);
  const valid = !!agentId && !!finalEnv && !busy && vaultsReady;
  const initialMessageEvent = () => ({
    type: 'user.message',
    content: [{ type: 'text', text: msg.trim() }],
  });

  const demoSession = () => ({
    id:'sesn_01' + Math.random().toString(36).slice(2, 8) + '…new',
    short:'sesn_…' + Math.random().toString(36).slice(2, 8),
    title: title.trim() || (msg.trim() ? msg.trim().slice(0, 42) : 'Untitled session'),
    status: msg.trim() ? 'running' : 'idle',
    agent: agent.name, env: finalEnv,
    created:'Just now', updated:'Just now', dur:'—', tokens:'0 / 0', resources:0,
  });

  const toggleVault = async (vault) => {
    const selected = vaultIds.includes(vault.id);
    if (selected) {
      setVaultIds((current) => current.filter((id) => id !== vault.id));
      return;
    }
    if (live && !agentHasMcp) return;
    setVaultIds((current) => [...current, vault.id]);
    if (!live || vaultCredentialStates[vault.id]) return;
    setVaultCredentialStates((current) => ({
      ...current,
      [vault.id]: { status:'loading', credentials:[] },
    }));
    try {
      const page = await api.listVaultCredentials(vault.id);
      setVaultCredentialStates((current) => ({
        ...current,
        [vault.id]: { status:'loaded', credentials:page.data },
      }));
    } catch (credentialError) {
      setVaultCredentialStates((current) => ({
        ...current,
        [vault.id]: { status:'error', credentials:[], error:credentialError.message || 'Request failed' },
      }));
      if (credentialError.status === 401 && onAuthExpired) onAuthExpired();
    }
  };

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError('');
    setPartial(null);
    if (!live) {
      onCreate(demoSession());
      setBusy(false);
      return;
    }
    const body = {
      agent: agentId,
      environment_id: finalEnv,
      ...(vaultIds.length ? { vault_ids:vaultIds } : {}),
      ...(title.trim() ? { title: title.trim() } : {}),
    };
    try {
      const session = await api.createSession(body, {
        intent: sessionIntent,
        agentNames: new Map(agents.map((item) => [item.id, item.name])),
      });
      if (!msg.trim()) {
        onCreate({ ...session, firstMessage: { status: 'not_sent' } });
        return;
      }
      try {
        const firstMessage = await api.sendSessionEvents(session.id, [initialMessageEvent()], {
          intent: eventIntent,
        });
        onCreate({ ...session, status:'running', firstMessage: { status:'sent', response:firstMessage } });
      } catch (messageError) {
        setPartial({ session, error: messageError.message || 'First message failed.' });
        setError(`Session ${session.short || session.id} was created, but the first message was not accepted: ${messageError.message || 'Request failed'}`);
        if (messageError.status === 401 && onAuthExpired) onAuthExpired();
      }
    } catch (createError) {
      setError(createError.message || 'Session creation failed.');
      if (createError.status === 401 && onAuthExpired) onAuthExpired();
    } finally {
      setBusy(false);
    }
  };

  const retryFirstMessage = async () => {
    if (!partial || !msg.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const firstMessage = await api.sendSessionEvents(partial.session.id, [initialMessageEvent()], {
        intent: eventIntent,
      });
      onCreate({ ...partial.session, status:'running', firstMessage: { status:'sent_after_retry', response:firstMessage } });
    } catch (messageError) {
      setError(`Session ${partial.session.short || partial.session.id} exists, but the first message retry failed: ${messageError.message || 'Request failed'}`);
      if (messageError.status === 401 && onAuthExpired) onAuthExpired();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal icon="activity" title="Create session" sub="Start a new Managed Agents session against a local environment." onClose={onClose}
      footer={<>
        <span className="left">Sends to <span className="mono">POST /v1/sessions</span>{msg.trim() && <> then <span className="mono">POST /v1/sessions/:id/events</span></>}</span>
        <button className="btn" onClick={onClose}>{partial ? 'Close' : 'Cancel'}</button>
        {partial && <button className="btn" disabled={busy} onClick={() => onCreate(partial.session)}>Open session</button>}
        {partial && msg.trim() && <button className="btn btn-primary" disabled={busy} onClick={retryFirstMessage} style={{ opacity: busy ? .5 : 1 }}>
          <Icon name="send" size={15} />Retry message</button>}
        {!partial && <button className="btn btn-primary" disabled={!valid} onClick={submit} style={{ opacity: valid ? 1 : .5 }}>
          <Icon name="plus" size={15} />{busy ? 'Creating…' : 'Create session'}</button>}
      </>}>
      <Labeled label="Agent" htmlFor="create-session-agent">
        <select id="create-session-agent" name="agent" className="selectbox" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          {choices.map((a) => (
            <option key={a.id} value={a.id}>{a.name} · {a.model}</option>
          ))}
        </select>
        {agent && <div className="field-hint">{agent.short} · system prompt {agent.system.length} chars · {agent.tools} tools</div>}
      </Labeled>

      <Labeled label="Environment" htmlFor="create-session-environment" hint="Pick an existing environment or enter an ID manually.">
        <select id="create-session-environment" name="environment" className="selectbox" value={env} onChange={(e) => setEnv(e.target.value)}>
          {live && activeEnvironments.length === 0 && <option value="" disabled>Create an active environment first…</option>}
          {activeEnvironments.map((en) => <option key={en.id} value={en.id}>{en.label} — {en.image}</option>)}
          <option value="__custom">Enter an environment ID manually…</option>
        </select>
      </Labeled>
      {live && activeEnvironments.length === 0 && !usingCustom && (
        <div className="inline-warn" role="status"><Icon name="alert" size={14} /><span>No active live environments exist. Close this dialog and create one, or select “Enter an environment ID manually”.</span></div>
      )}
      {usingCustom && (
        <Labeled label="Environment ID" htmlFor="create-session-environment-id">
          <input id="create-session-environment-id" name="environment_id" className="input mono" placeholder="env_…" value={customEnv} onChange={(e) => setCustomEnv(e.target.value)} />
        </Labeled>
      )}

      <Labeled label="Credential vaults" opt hint="Vaults are attached to this session. Credentials remain write-only and are matched to the agent's MCP server URLs at runtime.">
        {vaults.length === 0 ? <div className="field-hint">No active vaults in this workspace.</div>
          : <div className="seg-tools">{vaults.filter((vault) => !vault.archived_at).map((vault) => {
            const selected = vaultIds.includes(vault.id);
            const compatibility = live && vaultCredentialStates[vault.id]
              ? window.SessionVaultsData.vaultCompatibility(agent, vaultCredentialStates[vault.id])
              : null;
            const disabled = live && (!agentHasMcp || (!selected && compatibility && !compatibility.compatible));
            const title = !agentHasMcp
              ? 'The selected agent declares no MCP servers.'
              : compatibility?.status === 'incompatible'
                ? 'No active credential exactly matches this agent’s MCP server URLs.'
                : compatibility?.status === 'error'
                  ? 'Credential compatibility could not be verified.'
                  : undefined;
            return <button type="button" key={vault.id} className={'tool-toggle' + (selected ? ' on' : '')} aria-pressed={selected}
              disabled={disabled} title={title} onClick={() => toggleVault(vault)}>
              <span className="chk">{selected && <Icon name="checkCircle" size={9} />}</span><span>{vault.display_name}</span>
            </button>;
          })}</div>}
      </Labeled>
      {live && vaults.length > 0 && !agentHasMcp && <div className="inline-warn" role="status"><Icon name="alert" size={14} /><span>The selected agent declares no MCP servers. Choose an MCP-enabled agent before attaching a credential vault.</span></div>}
      {live && loadingVaults.length > 0 && <div className="inline-note" role="status"><Icon name="info" size={14} /><span>Checking whether the selected vault contains a credential matching this agent’s MCP server URLs…</span></div>}
      {live && incompatibleVaults.length > 0 && <div className="inline-warn" role="alert"><Icon name="alert" size={14} /><span>{incompatibleVaults.map(({ vault }) => vault?.display_name || vault?.id).join(', ')} has no active credential whose server URL exactly matches this agent. Choose a compatible vault or update the agent’s MCP server URL.</span></div>}
      {live && unavailableVaults.length > 0 && <div className="inline-warn" role="alert"><Icon name="alert" size={14} /><span>Could not verify credentials in {unavailableVaults.map(({ vault }) => vault?.display_name || vault?.id).join(', ')}. Remove the vault or retry after reconnecting the workspace.</span></div>}

      <Labeled label="Title" htmlFor="create-session-title" opt hint="Defaults to the first message if left blank.">
        <input id="create-session-title" name="title" className="input" placeholder="e.g. Ship your first Managed Agent" value={title} onChange={(e) => setTitle(e.target.value)} />
      </Labeled>

      <Labeled label="First message" htmlFor="create-session-message" opt hint="Send an initial user.message — the session starts running immediately.">
        <textarea id="create-session-message" name="message" className="textarea" placeholder="Send a message to start the session…" value={msg} onChange={(e) => setMsg(e.target.value)} />
      </Labeled>
      {error && <div className="inline-warn" role="alert"><Icon name="alert" size={14} /><span>{error}</span></div>}
    </Modal>
  );
}

// ─────────── Create agent ───────────
function CreateVaultModal({ onClose, onCreated, onAuthExpired, apiMode = 'demo', api = window.OmaConsoleApi }) {
  const [displayName, setDisplayName] = useStateF('');
  const [busy, setBusy] = useStateF(false);
  const [error, setError] = useStateF('');
  const submit = async () => {
    if (!displayName.trim() || busy) return;
    setBusy(true); setError('');
    try {
      if (apiMode !== 'api') { onCreated({ id:`vlt_demo_${Date.now()}`, display_name:displayName.trim() }); return; }
      onCreated(await api.createVault({ display_name:displayName.trim() }));
    } catch (createError) {
      setError(createError.message || 'Vault creation failed.');
      if (createError.status === 401 && onAuthExpired) onAuthExpired();
    } finally { setBusy(false); }
  };
  return <Modal icon="database" title="Create vault" sub="Create a workspace-scoped container for credentials." onClose={onClose}
    footer={<><span className="left">Sends to <span className="mono">POST /v1/vaults</span></span><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!displayName.trim() || busy} onClick={submit}>{busy ? 'Creating…' : 'Create vault'}</button></>}>
    <Labeled label="Vault name" htmlFor="create-vault-name" hint="Names are visible in the console; credential values are never shown again."><input id="create-vault-name" className="input" autoFocus value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></Labeled>
    {error && <div className="inline-warn" role="alert"><Icon name="alert" size={14} /><span>{error}</span></div>}
  </Modal>;
}

function CreateVaultCredentialModal({ vault, onClose, onCreated, onAuthExpired, apiMode = 'demo', api = window.OmaConsoleApi }) {
  const [displayName, setDisplayName] = useStateF('');
  const [type, setType] = useStateF('mcp_oauth');
  const [serverUrl, setServerUrl] = useStateF('');
  const [token, setToken] = useStateF('');
  const [busy, setBusy] = useStateF(false);
  const [error, setError] = useStateF('');
  const validUrl = /^https?:\/\//.test(serverUrl.trim());
  const valid = validUrl && (type === 'mcp_oauth' || token.trim().length >= 8) && !busy;
  const submit = async () => {
    if (!valid) return;
    setBusy(true); setError('');
    try {
      if (type === 'mcp_oauth') {
        if (apiMode !== 'api') {
          onCreated({ id:`vcrd_demo_${Date.now()}`, vault_id:vault.id, display_name:displayName.trim() || null, auth:{ type, mcp_server_url:serverUrl.trim() } });
          return;
        }
        const status = await runMcpOauthPopup(
          () => api.startMcpOauthFlow(vault.id, displayName.trim(), serverUrl.trim()),
          api,
        );
        onCreated({ id:status.credential_id, vault_id:vault.id });
        return;
      }
      const auth = { type, mcp_server_url:serverUrl.trim(), token:token.trim() };
      if (apiMode !== 'api') { onCreated({ id:`vcrd_demo_${Date.now()}`, vault_id:vault.id, display_name:displayName.trim() || null, auth }); return; }
      onCreated(await api.createVaultCredential(vault.id, { ...(displayName.trim() ? { display_name:displayName.trim() } : {}), auth }));
    } catch (createError) {
      setError(createError.message || 'Credential connection failed.');
      if (createError.status === 401 && onAuthExpired) onAuthExpired();
    } finally { setBusy(false); }
  };
  const endpoint = type === 'mcp_oauth' ? 'POST /console/mcp-oauth/flows' : 'POST /v1/vaults/:id/credentials';
  return <Modal icon="database" title="Add credential" sub={`Authorize an MCP server for ${vault.display_name || vault.displayName}.`} onClose={onClose}
    footer={<><span className="left">Sends to <span className="mono">{endpoint}</span></span><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!valid} onClick={submit}>{busy ? (type === 'mcp_oauth' ? 'Connecting…' : 'Saving…') : (type === 'mcp_oauth' ? 'Connect' : 'Save credential')}</button></>}>
    <Labeled label="Credential name" htmlFor="credential-name" opt><input id="credential-name" className="input" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></Labeled>
    <Labeled label="Credential type" htmlFor="credential-type"><select id="credential-type" className="selectbox" value={type} onChange={(event) => setType(event.target.value)}><option value="mcp_oauth">Connect with OAuth</option><option value="static_bearer">Static bearer token</option></select></Labeled>
    <Labeled label="MCP server URL" htmlFor="credential-server-url" hint="Use the URL configured on the agent, for example https://mcp.notion.com/mcp."><input id="credential-server-url" className="input mono" placeholder="https://mcp.example.com/mcp" value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} /></Labeled>
    {type === 'static_bearer' && <Labeled label="Bearer token" htmlFor="credential-token" hint="Write-only. OMA never returns or renders this value after it is submitted."><input id="credential-token" type="password" className="input mono" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} /></Labeled>}
    {type === 'mcp_oauth' && <div className="field-hint">Connect opens the provider in a new window. OMA stores the resulting credential and refreshes it automatically; the browser never receives an access or refresh token.</div>}
    {error && <div className="inline-warn" role="alert"><Icon name="alert" size={14} /><span>{error}</span></div>}
  </Modal>;
}

function CreateSkillModal({ onClose, onCreated, onAuthExpired, apiMode = 'demo', api = window.OmaConsoleApi }) {
  const [title, setTitle] = useStateF('');
  const [files, setFiles] = useStateF([]);
  const [busy, setBusy] = useStateF(false);
  const [error, setError] = useStateF('');
  const valid = files.length > 0 && !busy;
  const submit = async () => {
    if (!valid) return;
    setBusy(true); setError('');
    try {
      if (apiMode !== 'api') { onCreated({ id:`skill_demo_${Date.now()}`, display_title:title || 'Demo skill', latest_version:'1' }); return; }
      onCreated(await api.createSkill(title.trim(), files));
    } catch (createError) {
      setError(createError.message || 'Skill upload failed.');
      if (createError.status === 401 && onAuthExpired) onAuthExpired();
    } finally { setBusy(false); }
  };
  return <Modal icon="fileText" title="Upload custom skill" sub="Upload a .zip bundle containing SKILL.md and any supporting files." onClose={onClose}
    footer={<><span className="left">Sends multipart data to <span className="mono">POST /v1/skills</span></span><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!valid} onClick={submit}>{busy ? 'Uploading…' : 'Upload skill'}</button></>}>
    <Labeled label="Display title" htmlFor="skill-title" opt><input id="skill-title" className="input" placeholder="Defaults to the skill manifest title" value={title} onChange={(event) => setTitle(event.target.value)} /></Labeled>
    <Labeled label="Skill bundle" htmlFor="skill-files" hint="Select one .zip with a single top-level folder containing SKILL.md. The API validates the bundle and limits each request to 30 MB."><input id="skill-files" type="file" className="input" accept=".zip,application/zip" onChange={(event) => setFiles([...event.target.files])} />{files.length > 0 && <div className="field-hint">{files.map((file) => file.name).join(', ')}</div>}</Labeled>
    {error && <div className="inline-warn" role="alert"><Icon name="alert" size={14} /><span>{error}</span></div>}
  </Modal>;
}

function CreateAgent({ models = [], skills = [], onClose, onCreate, onAuthExpired, apiMode = 'demo', api = window.OmaConsoleApi }) {
  const defaultModel = models.find((item) => item.default) || models[0] || null;
  const [name, setName] = useStateF('');
  const [provider, setProvider] = useStateF(defaultModel?.provider || '');
  const [model, setModel] = useStateF(defaultModel?.id || '');
  const [prompt, setPrompt] = useStateF('');
  const [description, setDescription] = useStateF('');
  const [mcpName, setMcpName] = useStateF('');
  const [mcpUrl, setMcpUrl] = useStateF('');
  const [skillIds, setSkillIds] = useStateF([]);
  const [metadata, setMetadata] = useStateF('');
  const [tools, setTools] = useStateF(['bash']);
  const [toolPolicy, setToolPolicy] = useStateF('always_ask');
  const [busy, setBusy] = useStateF(false);
  const [error, setError] = useStateF('');

  const live = apiMode === 'api';
  const providers = [...new Set(models.map((item) => item.provider))];
  const providerModels = models.filter((item) => item.provider === provider);
  const selectedModel = providerModels.find((item) => item.id === model) || null;
  const hasMcp = mcpName.trim() || mcpUrl.trim();
  const mcpValid = !hasMcp || (mcpName.trim().length > 0 && /^https?:\/\//.test(mcpUrl.trim()));
  const valid = name.trim().length > 0 && selectedModel !== null && mcpValid && !busy;
  const toggle = (t) => setTools(tools.includes(t) ? tools.filter((x) => x !== t) : [...tools, t]);
  const chooseProvider = (nextProvider) => {
    setProvider(nextProvider);
    const choices = models.filter((item) => item.provider === nextProvider);
    const nextModel = choices.find((item) => item.default) || choices[0] || null;
    setModel(nextModel?.id || '');
  };
  const chooseSkills = (event) => {
    const nextSkills = [...event.target.selectedOptions].map((option) => option.value);
    setSkillIds(nextSkills);
    if (nextSkills.length > 0) setTools((current) => current.includes('read') ? current : [...current, 'read']);
  };

  const demoAgent = () => ({
    id:'agent_01' + Math.random().toString(36).slice(2, 8) + '…new',
    short:'agent_…' + Math.random().toString(36).slice(2, 8),
    name: name.trim(), model:`${provider}/${model}`, modelProvider:provider, modelId:model,
    status:'active', created:'Just now', updated:'Just now', version:'v1',
    tools: tools.length + (hasMcp ? 1 : 0), system: prompt.trim() || 'No system prompt set.', description:description.trim() || null,
    mcpServers: hasMcp ? [{ name:mcpName.trim(), url:mcpUrl.trim() }] : [], skills:skillIds.map((id) => ({ skill_id:id })), metadata:{},
    toolset:'agent_toolset_20260401',
    toolPermission:toolPolicy === 'always_allow' ? 'Allow automatically' : 'Ask before use',
    sessions:[],
  });

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError('');
    if (!live) {
      onCreate(demoAgent());
      setBusy(false);
      return;
    }
    let parsedMetadata;
    try {
      parsedMetadata = metadata.trim() ? JSON.parse(metadata) : null;
      if (parsedMetadata !== null && (Array.isArray(parsedMetadata) || typeof parsedMetadata !== 'object' || Object.values(parsedMetadata).some((value) => typeof value !== 'string'))) {
        throw new Error('Metadata must be a JSON object with string values.');
      }
    } catch (metadataError) {
      setError(metadataError.message || 'Metadata must be valid JSON.');
      setBusy(false);
      return;
    }
    const mcpServers = hasMcp ? [{ type:'url', name:mcpName.trim(), url:mcpUrl.trim() }] : [];
    const body = {
      name: name.trim(),
      model: api.modelInputForSelection(selectedModel),
      ...(prompt.trim() ? { system: prompt.trim() } : {}),
      ...(description.trim() ? { description:description.trim() } : {}),
      ...(parsedMetadata ? { metadata:parsedMetadata } : {}),
      ...(mcpServers.length ? { mcp_servers:mcpServers } : {}),
      ...(skillIds.length ? { skills:skillIds.map((skillId) => ({ type:'custom', skill_id:skillId })) } : {}),
      tools: [{
        type: 'agent_toolset_20260401',
        configs: TOOL_OPTIONS.map((tool) => ({
          name:tool,
          enabled:tools.includes(tool),
          ...(tools.includes(tool) ? { permission_policy:{ type:toolPolicy } } : {}),
        })),
      }, ...mcpServers.map((server) => ({
        type:'mcp_toolset',
        mcp_server_name:server.name,
        default_config:{ enabled:true, permission_policy:{ type:toolPolicy } },
      }))],
    };
    try {
      const agent = await api.createAgent(body);
      onCreate(agent);
    } catch (createError) {
      setError(createError.message || 'Agent creation failed. Refresh the agent list before retrying if the request may have reached the server.');
      if (createError.status === 401 && onAuthExpired) onAuthExpired();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal icon="bot" title="Create agent" sub="Define a reusable agent template — model, prompt, and tools." onClose={onClose}
      footer={<>
        <span className="left">Sends to <span className="mono">POST /v1/agents</span></span>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!valid} onClick={submit} style={{ opacity: valid ? 1 : .5 }}>
          <Icon name="plus" size={15} />{busy ? 'Creating…' : 'Create agent'}</button>
      </>}>
      <div className="form-row two">
        <Labeled label="Name" htmlFor="create-agent-name">
          <input id="create-agent-name" name="name" className="input" placeholder="e.g. cwc-agent" value={name} onChange={(e) => setName(e.target.value)} />
        </Labeled>
        <Labeled label="Provider" htmlFor="create-agent-provider">
          <select id="create-agent-provider" name="provider" className="selectbox mono" value={provider} onChange={(e) => chooseProvider(e.target.value)}>
            {providers.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </Labeled>
      </div>

      <Labeled label="Model" htmlFor="create-agent-model" hint="Search the deployment-enabled Pi catalog for this provider.">
        <input id="create-agent-model" name="model" className="input mono" list="oma-model-suggestions" value={model} onChange={(e) => setModel(e.target.value)} />
        <datalist id="oma-model-suggestions">{providerModels.map((item) => <option key={`${item.provider}/${item.id}`} value={item.id}>{item.name}</option>)}</datalist>
      </Labeled>
      {selectedModel && <div className={selectedModel.credentials_configured ? 'field-hint' : 'inline-warn'} role={selectedModel.credentials_configured ? undefined : 'status'}>
        {!selectedModel.credentials_configured && <Icon name="alert" size={14} />}
        <span>{selectedModel.credentials_configured
          ? `${selectedModel.provider_name || selectedModel.provider} credentials are configured on this appliance.`
          : `Credentials are not configured for ${selectedModel.provider}/${selectedModel.id}. You can create the agent, but sessions will be rejected until the operator runs oma auth set ${selectedModel.provider} and restarts oma up.`}</span>
      </div>}
      {live && models.length === 0 && <div className="inline-warn" role="alert"><Icon name="alert" size={14} /><span>No deployment-enabled models were returned. Agent creation is unavailable.</span></div>}

      <Labeled label="System prompt" htmlFor="create-agent-system" opt hint="Plain text. Markdown is preserved.">
        <textarea id="create-agent-system" name="system" className="textarea" placeholder="You help me navigate…" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </Labeled>

      <Labeled label="Description" htmlFor="create-agent-description" opt hint="A short, user-facing summary of what this agent is for.">
        <input id="create-agent-description" name="description" className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
      </Labeled>

      <Labeled label="MCP server" opt hint="Declare one URL-based MCP server. A matching MCP toolset is created automatically; attach credentials through a vault when starting a session.">
        <div className="form-row two"><input className="input" placeholder="Name, e.g. notion" value={mcpName} onChange={(e) => setMcpName(e.target.value)} />
          <input className="input mono" placeholder="https://mcp.example.com/mcp" value={mcpUrl} onChange={(e) => setMcpUrl(e.target.value)} /></div>
        {hasMcp && !mcpValid && <div className="inline-warn" role="alert"><Icon name="alert" size={14} /><span>Provide both an MCP name and an http(s) URL.</span></div>}
      </Labeled>

      <Labeled label="Custom skills" opt hint="Attach uploaded workspace skills to this immutable agent version.">
        {skills.length === 0 ? <div className="field-hint">No custom skills uploaded yet.</div>
          : <select className="selectbox" multiple value={skillIds} onChange={chooseSkills}>
            {skills.map((skill) => <option key={skill.id} value={skill.id}>{skill.display_title}{skill.latest_version ? ` · ${skill.latest_version}` : ''}</option>)}
          </select>}
        {skillIds.length > 0 && <div className="field-hint">The <span className="mono">read</span> tool is enabled automatically because custom skills require it at session admission.</div>}
      </Labeled>

      <Labeled label="Metadata" htmlFor="create-agent-metadata" opt hint="Advanced: JSON object with string values. Stored with the agent version.">
        <textarea id="create-agent-metadata" className="textarea mono" placeholder={'{"template":"support-agent"}'} value={metadata} onChange={(e) => setMetadata(e.target.value)} />
      </Labeled>

      <Labeled label="Built-in tools" hint="Choose which sandbox-backed tools the agent may use.">
        <div className="seg-tools">
          {TOOL_OPTIONS.map((t) => {
            const on = tools.includes(t);
            const requiredForSkills = skillIds.length > 0 && t === 'read';
            return (
              <button type="button" key={t} className={'tool-toggle' + (on ? ' on' : '')}
                aria-pressed={on} disabled={requiredForSkills} title={requiredForSkills ? 'Custom skills require the read tool.' : undefined} onClick={() => toggle(t)}>
                <span className="chk">{on && <Icon name="checkCircle" size={9} />}</span>
                <span className="mono">{t}</span>
              </button>
            );
          })}
        </div>
      </Labeled>
      <Labeled label="Tool approval" hint="This applies to every enabled built-in tool on this agent.">
        <div className="env-preset-grid" role="radiogroup" aria-label="Tool approval policy">
          <button type="button" className={'env-choice' + (toolPolicy === 'always_ask' ? ' on' : '')}
            role="radio" aria-checked={toolPolicy === 'always_ask'} disabled={busy}
            onClick={() => setToolPolicy('always_ask')}>
            <span className="dot-r" />
            <span><span className="r-main">Ask before use</span><span className="r-sub">Show Allow/Deny before each tool call.</span></span>
          </button>
          <button type="button" className={'env-choice' + (toolPolicy === 'always_allow' ? ' on' : '')}
            role="radio" aria-checked={toolPolicy === 'always_allow'} disabled={busy}
            onClick={() => setToolPolicy('always_allow')}>
            <span className="dot-r" />
            <span><span className="r-main">Allow automatically</span><span className="r-sub">No confirmation prompts. Sandbox and network restrictions still apply.</span></span>
          </button>
        </div>
        {toolPolicy === 'always_allow' && <div className="inline-warn" role="status"><Icon name="alert" size={14} /><span>The model may run every enabled tool without asking. Use this for trusted, disposable coding sessions.</span></div>}
      </Labeled>
      {live && <div className="field-hint">Only the currently supported sandbox-backed tools are offered. Disabled tools are persisted explicitly.</div>}
      {error && <div className="inline-warn" role="alert"><Icon name="alert" size={14} /><span>{error}</span></div>}
    </Modal>
  );
}

Object.assign(window, { Modal, CreateSession, CreateAgent, ConfirmDialog });

// ─────────── Archive / delete confirmation ───────────
function ConfirmDialog({ icon = 'archive', danger, title, message, confirmLabel, endpoint, onClose, onConfirm, busy = false, error = null }) {
  return (
    <div className="overlay" onClick={() => { if (!busy) onClose(); }}>
      <div className="modal sm" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div className={'ic' + (danger ? ' danger' : '')}><Icon name={icon} size={18} /></div>
          <div><h2>{title}</h2></div>
          <span className="kebab x" onClick={() => { if (!busy) onClose(); }}><Icon name="x" size={17} /></span>
        </div>
        <div className="modal-body">
          <div className="confirm-msg">{message}</div>
          {error && <div className="inline-warn" role="alert"><Icon name="alert" size={14} /><span>{error.message || String(error)}</span></div>}
        </div>
        <div className="modal-foot">
          {endpoint && <span className="left">Sends to <span className="mono">{endpoint}</span></span>}
          <button className="btn" disabled={busy} onClick={onClose}>Cancel</button>
          <button className={'btn ' + (danger ? 'btn-danger' : 'btn-primary')} disabled={busy} onClick={onConfirm}>{busy ? 'Working…' : confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
