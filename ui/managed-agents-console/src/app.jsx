// app.jsx — root: sessions list, routing, theme tweaks. Mounts everything.
const { useState, useEffect } = React;

function SessionsList({ sessions, openSession, onCreate, dataState = 'loaded', readOnly = false }) {
  const loading = dataState === 'loading';
  const error = dataState === 'error';
  const partial = dataState === 'partial';
  const empty = dataState === 'empty' || sessions.length === 0;
  return (
    <div className="main-scroll scroll fade-in">
      <PageHead title="Sessions" sub="Trace and debug Managed Agents sessions."
        action="Create session" onAction={onCreate} readOnly={readOnly}
        endpoint="POST /v1/sessions" />
      <div className="toolbar">
        <Field wide placeholder="Search by session ID" />
        <Select label="Created" value="All time" />
        <Select label="Agent" value="All" w={120} />
        <Select label="Status" value="Active" w={120} />
      </div>
      {partial && <PartialNotice resource="sessions" />}
      {loading ? <SkeletonTable rows={7} cols={[140, 'grow', 'pill', 160, 64]} />
       : error ? <ErrorState resource="sessions" onRetry={() => {}} />
       : empty ? <EmptyState icon="activity" title="No sessions yet"
            message="Sessions appear here as agents run. Create one to start a local Managed Agents session."
            actionLabel={!readOnly ? "Create session" : null} onAction={onCreate} />
       : <>
      <div className="panel">
        <div className="thead">
          <span className="th" style={{ width:15 }}><span className="checkbox" /></span>
          <span className="th" style={{ width:140 }}>ID</span>
          <span className="th grow">Name</span>
          <span className="th" style={{ width:96 }}>Status</span>
          <span className="th" style={{ width:200 }}>Agent</span>
          <span className="th" style={{ width:64 }}>Created</span>
          <span className="th" style={{ width:20 }} />
        </div>
        {sessions.map((s) => (
          <div className={'trow' + (s.focus ? '' : '')} key={s.id} onClick={() => openSession(s)}>
            <span className="td" style={{ width:15 }}><span className="checkbox" /></span>
            <span className="td mono" style={{ width:140, fontSize:12, color:'var(--soft)' }}>{s.short}</span>
            <span className="td grow ell cell-strong">{s.title}</span>
            <span className="td" style={{ width:96, display:'flex', gap:6, flexWrap:'wrap' }}>
              <St k={s.status} />{(s.requiresAction || s.confirm) && <NeedsAction />}
            </span>
            <span className="td" style={{ width:200 }}><Pill icon="bot">{s.agent}</Pill></span>
            <span className="td mono" style={{ width:64, color:'var(--faint)' }}>{s.created}</span>
            <span className="td" style={{ width:20 }}><Kebab /></span>
          </div>
        ))}
      </div>
      <Pager />
      </>}
    </div>
  );
}

const UI_FONTS = {
  geist: "'Geist', ui-sans-serif, system-ui, sans-serif",
  plex:  "'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif",
};
const MONO_FONTS = {
  geist:     "'Geist Mono', ui-monospace, monospace",
  jetbrains: "'JetBrains Mono', ui-monospace, monospace",
  plex:      "'IBM Plex Mono', ui-monospace, monospace",
};

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "#eab44c",
  "density": "comfortable",
  "darker": false,
  "layout": "split",
  "uiFont": "geist",
  "mono": "geist",
  "dataState": "loaded"
}/*EDITMODE-END*/;

function routeHash(route) {
  if (route.name === 'session') return `#session=${encodeURIComponent(route.session.id)}`;
  if (route.name === 'agent') return `#agent=${encodeURIComponent(route.agent.id)}`;
  if (route.name === 'start') return '#start';
  if (route.name === 'agents') return '#agents';
  if (route.name === 'environments') return '#environments';
  if (route.name === 'files') return '#files';
  if (route.name === 'skills') return '#skills';
  if (route.name === 'vaults') return route.vaultId ? `#vault=${encodeURIComponent(route.vaultId)}` : '#vaults';
  if (route.name === 'credentialHealth') return `#credential-health=${encodeURIComponent(route.workspaceId)}`;
  if (route.name === 'admin') return '#admin';
  if (route.name === 'documentation') return `#docs=${encodeURIComponent(route.page || 'overview')}`;
  return '#sessions';
}

function writeRouteHash(route) {
  const url = new URL(window.location.href);
  url.searchParams.delete('session_id');
  url.searchParams.delete('agent_id');
  url.hash = routeHash(route);
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (current !== next) window.history.replaceState(null, '', next);
}

function readRouteTarget(sessions, agents) {
  const params = new URLSearchParams(window.location.search);
  const rawHash = window.location.hash.replace(/^#/, '');
  const hashParams = new URLSearchParams(rawHash.includes('=') ? rawHash : '');
  const sessionId = params.get('session_id') || hashParams.get('session');
  if (sessionId) {
    const session = sessions.find((item) => item.id === sessionId || item.short === sessionId);
    if (session) return { name:'session', session };
  }
  const agentId = params.get('agent_id') || hashParams.get('agent');
  if (agentId) {
    const agent = agents.find((item) => item.id === agentId || item.short === agentId);
    if (agent) return { name:'agent', agent };
  }
  if (rawHash === 'start') return { name:'start' };
  if (rawHash === 'agents') return { name:'agents' };
  if (rawHash === 'environments') return { name:'environments' };
  if (rawHash === 'files') return { name:'files' };
  if (rawHash === 'skills') return { name:'skills' };
  if (rawHash === 'vaults') return { name:'vaults' };
  if (hashParams.get('vault')) return { name:'vaults', vaultId:hashParams.get('vault') };
  if (hashParams.get('credential-health')) return { name:'credentialHealth', workspaceId:hashParams.get('credential-health') };
  if (rawHash === 'docs' || rawHash === 'documentation') return { name:'documentation', page:'overview' };
  if (hashParams.get('docs')) return { name:'documentation', page:hashParams.get('docs') };
  if (hashParams.get('documentation')) return { name:'documentation', page:'overview' };
  return null;
}

function takeBootstrapHandoff() {
  const rawHash = window.location.hash.replace(/^#/, '');
  const params = new URLSearchParams(rawHash);
  const nonce = params.get('bootstrap');
  if (!nonce) return null;
  params.delete('bootstrap');
  const nextHash = params.toString();
  // Clear the bearer value before the network exchange so reload, copy/paste,
  // browser history, and later application code cannot recover it.
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${nextHash ? `#${nextHash}` : '#start'}`);
  return nonce;
}

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const demoMode = new URLSearchParams(window.location.search).get('mode') === 'demo';
  const [route, setRoute] = useState(() => readRouteTarget([], []) || { name:'start' });
  const [sessions, setSessions] = useState(SESSIONS);
  const [agents, setAgents] = useState(AGENTS);
  const [environments, setEnvironments] = useState(ENVIRONMENTS);
  const [files, setFiles] = useState(FILES);
  const [vaults, setVaults] = useState([]);
  const [vaultRefresh, setVaultRefresh] = useState(0);
  const [skills, setSkills] = useState([]);
  const [networkingCatalog, setNetworkingCatalog] = useState({
    deployment:{ provider:null, egress_supported:false, reason:"Networking capability has not been loaded." },
    presets:[],
    custom:{ https_only:true, wildcard_matches_bare_domain:false },
  });
  const [models, setModels] = useState(demoMode ? MODELS.map((id) => ({
    type:'model', provider:'anthropic', id, name:id,
    credentials_configured:true, default:id === MODELS[0],
  })) : []);
  const [workspaceLoaded, setWorkspaceLoaded] = useState(false);
  const [apiState, setApiState] = useState({ state:'loading', mode: demoMode ? 'demo' : 'api', error:null, warnings:[] });
  const [modal, setModal] = useState(null);   // { kind:'session', presetAgent } | { kind:'agent' } | { kind:'environment' }
  const [createdEnvironmentId, setCreatedEnvironmentId] = useState(null);
  // Raw credentials are used only for the login exchange. After that the
  // server holds a revocable, opaque HttpOnly console session and page reloads
  // restore it without exposing any key to browser storage or JavaScript.
  const [auth, setAuth] = useState({ phase: demoMode ? 'ready' : 'boot', admin:false, workspace:null, error:null, busy:false });

  useEffect(() => {
    const r = document.documentElement;
    r.classList.toggle('darker', !!t.darker);
    r.classList.toggle('compact', t.density === 'compact');
    r.style.setProperty('--accent', t.accent);
    r.style.setProperty('--font', UI_FONTS[t.uiFont] || UI_FONTS.geist);
    r.style.setProperty('--mono', MONO_FONTS[t.mono] || MONO_FONTS.geist);
  }, [t]);

  const loadLiveData = () => OmaConsoleApi.loadConsoleData()
    .then((data) => {
      const linkedAgents = linkSessionsToAgents(data.agents, data.sessions);
      setAgents(linkedAgents);
      setSessions(data.sessions);
      setEnvironments(data.environments);
      setFiles(data.files);
      setVaults(data.vaults);
      setSkills(data.skills);
      setNetworkingCatalog(data.networkingCatalog);
      setModels(data.models);
      setApiState({ state:'loaded', mode:'api', error:null, warnings:data.warnings || [] });
      setWorkspaceLoaded(true);
      const target = readRouteTarget(data.sessions, linkedAgents);
      if (target?.name === 'session') openSession(target.session, 'api');
      else if (target) setRoute(target);
    });

  useEffect(() => {
    let alive = true;
    if (demoMode) {
      setApiState({ state:'loaded', mode:'demo', error:null, warnings:[] });
      const target = readRouteTarget(SESSIONS, AGENTS);
      if (target) setRoute(target);
      return () => { alive = false; };
    }
    const bootstrapNonce = takeBootstrapHandoff();
    const bootstrap = bootstrapNonce
      ? OmaConsoleApi.consumeConsoleBootstrap(bootstrapNonce)
      : Promise.resolve(undefined);
    bootstrap
      .then(() => OmaConsoleApi.getConsoleAuthStatus())
      .then((status) => {
        if (!alive) return undefined;
        setAuth({ phase: status.workspace || !status.auth_required || status.admin ? 'ready' : 'login', admin:status.admin, workspace:status.workspace, error:null, busy:false });
        if (!status.workspace && status.auth_required) {
          setApiState({ state:'loaded', mode:'api', error:null, warnings:[] });
          return undefined;
        }
        return loadLiveData();
      })
      // When the server requires authentication but this browser has no
      // console session, the preceding branch intentionally returns
      // `undefined`. Keep the login screen visible instead of immediately
      // overwriting it with the ready/no-workspace state.
      .then((loaded) => { if (alive && loaded !== undefined) setAuth((a) => ({ ...a, phase:'ready' })); })
      .catch((error) => {
        if (!alive) return;
        if (error.status === 401) {
          // Server requires a key: ask for one instead of quietly showing
          // bundled demo data behind a login wall.
          setAuth((a) => ({ ...a, phase:'login' }));
          return;
        }
        setAgents([]);
        setSessions([]);
        setEnvironments([]);
        setFiles([]);
        setVaults([]);
        setSkills([]);
        setNetworkingCatalog({
          deployment: { provider:null, egress_supported:false, reason:"Networking capability failed to load." },
          presets:[],
          custom:{ https_only:true, wildcard_matches_bare_domain:false },
        });
        setModels([]);
        setWorkspaceLoaded(false);
        setApiState({ state:'error', mode:'error', error, warnings:[] });
        setAuth((a) => ({ ...a, phase:'ready' }));
      });
    return () => { alive = false; };
  }, [demoMode]);

  const adminLogin = (key) => {
    setAuth((a) => ({ ...a, busy:true, error:null }));
    OmaConsoleApi.loginConsoleAdmin(key)
      .then(() => {
        setAuth((a) => ({ ...a, phase:'ready', admin:true, error:null, busy:false }));
        setApiState({ state:'loaded', mode:'api', error:null, warnings:[] });
        setRoute({ name:'admin' });
      })
      .catch((error) => {
        setAuth((a) => ({ ...a, busy:false, error: error.status === 401
          ? 'The server rejected that admin key.'
          : error.message }));
      });
  };
  const workspaceLogin = (key) => {
    setAuth((a) => ({ ...a, busy:true, error:null }));
    OmaConsoleApi.loginConsoleWorkspace(key)
      .then((result) => loadLiveData().then(() => result))
      .then((result) => {
        setAuth((a) => ({ ...a, phase:'ready', workspace:result.workspace, busy:false, error:null }));
      })
      .catch((error) => {
        setAuth((a) => ({ ...a, busy:false, error: error.status === 401
          ? 'The server rejected that workspace key.'
          : error.message }));
      });
  };
  const browseAsWorkspace = (plaintextKey) => {
    OmaConsoleApi.loginConsoleWorkspace(plaintextKey)
      .then((result) => loadLiveData().then(() => result))
      .then((result) => {
        setAuth((a) => ({ ...a, workspace:result.workspace, phase:'ready', error:null }));
        setRoute({ name:'sessions' });
        writeRouteHash({ name:'sessions' });
      })
      .catch((error) => {
        // A just-minted key failing to browse is worth a loud re-login, not
        // a silently ignored click.
        setAuth((a) => ({ ...a, phase:'login', error:
          `Browsing with the minted key failed (${error.status ?? error.message}). Enter a key to continue.` }));
      });
  };
  const reauth = () => setAuth((a) => ({ ...a, phase:'login', admin:false, workspace:null, error:'Your console session expired. Enter a key to continue.' }));
  const workspaceReauth = () => {
    setAuth((a) => ({ ...a, phase:'login', admin:false, workspace:null, error:'Your workspace session expired. Enter a key to continue.' }));
  };
  const selectWorkspace = (workspaceId) => {
    OmaConsoleApi.selectConsoleWorkspace(workspaceId)
      .then((result) => loadLiveData().then(() => result))
      .then((result) => {
        setAuth((a) => ({ ...a, workspace:result.workspace, phase:'ready', error:null }));
        go('start');
      })
      .catch((error) => {
        if (error.status === 401) reauth();
      });
  };
  const signOut = () => {
    OmaConsoleApi.logoutConsole().catch(() => undefined).finally(() => {
      setWorkspaceLoaded(false);
      setAuth({ phase:'login', admin:false, workspace:null, error:null, busy:false });
      setRoute({ name:'start' });
    });
  };

  const go = (name) => {
    const next = name === 'documentation' ? { name, page:'overview' } : { name };
    setRoute(next);
    writeRouteHash(next);
  };
  const openDocumentation = (page) => {
    const next = { name:'documentation', page };
    setRoute(next);
    writeRouteHash(next);
  };
  const openSession = (session, mode = apiState.mode) => {
    writeRouteHash({ name:'session', session });
    setRoute({ name:'session', session: { ...session, loadingEvents:true } });
    if (mode !== 'api') {
      setRoute({ name:'session', session });
      return;
    }
    OmaConsoleApi.hydrateSession(session)
      .then((hydrated) => {
        setRoute((current) => current.name === 'session' && current.session.id === session.id
          ? { name:'session', session: hydrated }
          : current);
      })
      .catch((error) => {
        setRoute((current) => current.name === 'session' && current.session.id === session.id
          ? { name:'session', session: { ...session, eventError:error } }
          : current);
      });
  };
  const openAgent = (agent) => {
    const next = { name:'agent', agent };
    setRoute(next);
    writeRouteHash(next);
  };
  const mutationReadOnly = apiState.state !== 'loaded'
    || (apiState.mode !== 'api' && apiState.mode !== 'demo');
  const lifecycleReadOnly = mutationReadOnly;

  const createSession = (preset) => {
    if (mutationReadOnly) return;
    setModal({ kind:'session', presetAgent: preset });
  };
  const createAgent = () => {
    if (mutationReadOnly) return;
    setModal({ kind:'agent' });
  };
  const createEnvironment = () => {
    if (apiState.mode !== 'api') return;
    setModal({ kind:'environment' });
  };
  const createVault = () => {
    if (mutationReadOnly) return;
    setModal({ kind:'vault' });
  };
  const createCredential = (vault) => {
    if (mutationReadOnly) return;
    setModal({ kind:'credential', vault });
  };
  const createSkill = () => {
    if (mutationReadOnly) return;
    setModal({ kind:'skill' });
  };

  const onSessionCreated = (s) => {
    if (mutationReadOnly) return;
    setSessions((prev) => [s, ...prev]);
    setModal(null);
    openSession(s);
  };
  const onAgentCreated = (a) => {
    if (mutationReadOnly) return;
    setAgents((prev) => [a, ...prev]);
    setModal(null);
    openAgent(a);
  };
  const onEnvironmentCreated = (environment) => {
    setEnvironments((prev) => [environment, ...prev]);
    setCreatedEnvironmentId(environment.id);
    setModal(null);
    const next = { name:'environments' };
    setRoute(next);
    writeRouteHash(next);
  };
  const onVaultCreated = (vault) => {
    setVaults((prev) => [vault, ...prev.filter((item) => item.id !== vault.id)]);
    setVaultRefresh((current) => current + 1);
    setModal(null);
    const next = { name:'vaults', vaultId:vault.id };
    setRoute(next);
    writeRouteHash(next);
  };
  const onCredentialCreated = (credential) => {
    setVaultRefresh((current) => current + 1);
    setModal(null);
    const next = { name:'vaults', vaultId:credential.vault_id };
    setRoute(next);
    writeRouteHash(next);
  };
  const onSkillCreated = (skill) => {
    setSkills((prev) => [skill, ...prev]);
    setModal(null);
  };
  const onSessionStateChange = (sessionId, patch) => {
    setSessions((current) => current.map((session) => session.id === sessionId
      ? { ...session, ...patch }
      : session));
  };
  const refreshOpenSession = (session) => {
    if (apiState.mode !== 'api') return;
    OmaConsoleApi.hydrateSession(session)
      .then((hydrated) => {
        setRoute((current) => current.name === 'session' && current.session.id === session.id
          ? { name:'session', session:hydrated }
          : current);
      })
      .catch((error) => setRoute((current) => current.name === 'session' && current.session.id === session.id
        ? { name:'session', session:{ ...current.session, refreshError:error } }
        : current));
  };

  const archiveSession = async (s) => {
    if (lifecycleReadOnly) return;
    if (apiState.mode === 'api') {
      try {
        await OmaConsoleApi.archiveSession(s.id);
      } catch (error) {
        if (error.status === 401) workspaceReauth();
        throw error;
      }
    }
    setSessions((prev) => prev.map((x) => x.id === s.id ? { ...x, status:'archived' } : x));
  };
  const deleteSession = async (s) => {
    if (lifecycleReadOnly) return;
    if (apiState.mode === 'api') {
      try {
        await OmaConsoleApi.deleteSession(s.id);
      } catch (error) {
        if (error.status === 401) workspaceReauth();
        throw error;
      }
    }
    setSessions((prev) => prev.filter((x) => x.id !== s.id));
    go('sessions');
  };
  const archiveAgent = async (a) => {
    if (lifecycleReadOnly) return;
    let upd = { ...a, status:'archived' };
    if (apiState.mode === 'api') {
      try {
        upd = { ...await OmaConsoleApi.archiveAgent(a.id), sessions:a.sessions || [] };
      } catch (error) {
        if (error.status === 401) workspaceReauth();
        throw error;
      }
    }
    setAgents((prev) => prev.map((x) => x.id === a.id ? upd : x));
    const next = { name:'agent', agent:upd };
    setRoute(next);
    writeRouteHash(next);
  };
  const archiveEnvironment = async (environment) => {
    if (lifecycleReadOnly) return;
    try {
      const updated = await OmaConsoleApi.archiveEnvironment(environment.id);
      setEnvironments((prev) => prev.map((item) => item.id === environment.id ? updated : item));
    } catch (error) {
      if (error.status === 401) workspaceReauth();
      throw error;
    }
  };
  const deleteEnvironment = async (environment) => {
    if (lifecycleReadOnly) return;
    try {
      await OmaConsoleApi.deleteEnvironment(environment.id);
      setEnvironments((prev) => prev.filter((item) => item.id !== environment.id));
    } catch (error) {
      if (error.status === 401) workspaceReauth();
      throw error;
    }
  };
  const updateAgentToolPermission = async (a, policy) => {
    if (mutationReadOnly) return;
    let upd;
    try {
      upd = apiState.mode === 'api'
        ? { ...await OmaConsoleApi.updateAgentToolPermission(a, policy), sessions:a.sessions || [] }
        : {
            ...a,
            version:`v${(a.apiVersion || Number(String(a.version).replace(/^v/, '')) || 1) + 1}`,
            apiVersion:(a.apiVersion || 1) + 1,
            toolPermission:policy === 'always_allow' ? 'Always allow' : 'Ask before use',
          };
    } catch (error) {
      if (error.status === 401) workspaceReauth();
      throw error;
    }
    setAgents((prev) => prev.map((x) => x.id === a.id ? upd : x));
    const next = { name:'agent', agent:upd };
    setRoute(next);
    writeRouteHash(next);
  };

  if (auth.phase === 'login' && route.name !== 'documentation') {
    return (
      <div className="app">
        <Sidebar route={route.name} go={go} workspace={auth.workspace} admin={auth.admin}
          onSelectWorkspace={selectWorkspace} onSwitchWorkspace={workspaceReauth} onSignOut={signOut} />
        <main className="main">
          <LoginView onAdminLogin={adminLogin} onWorkspaceLogin={workspaceLogin}
            error={auth.error} busy={auth.busy} />
        </main>
      </div>
    );
  }

  let view;
  const dataState = apiState.state === 'loading' ? 'loading' : t.dataState;
  // Admin-only sessions never loaded /v1: the state still holds the bundled
  // demo rows, which must not render as if they were live tenant data.
  const needsWorkspaceKey = apiState.state !== 'loading' && apiState.mode === 'api'
    && !demoMode && !workspaceLoaded && route.name !== 'admin' && route.name !== 'credentialHealth' && route.name !== 'documentation';
  if (route.name === 'documentation') view = <DocsView page={route.page} onNavigate={openDocumentation} goConsole={go} />;
  else if (apiState.state === 'error') view = (
    <div className="main-scroll scroll fade-in">
      <PageHead title="Live API unavailable" sub="The console will not substitute demo data for a failed live server." />
      <ErrorState resource="workspace data" onRetry={() => {
        setApiState({ state:'loading', mode:'api', error:null, warnings:[] });
        loadLiveData().catch((error) => {
          if (error.status === 401) {
            setAuth((current) => ({ ...current, phase:'login', error:'Session expired — enter a workspace key to retry.' }));
          } else {
            setApiState({ state:'error', mode:'error', error, warnings:[] });
          }
        });
      }} />
    </div>
  );
  else if (needsWorkspaceKey) view = (
    <div className="main-scroll scroll fade-in">
      <PageHead title="No workspace selected" sub="Browsing /v1 needs a workspace key." />
      <EmptyState icon="database" title="Connect a workspace"
        message="Mint a key in Admin and choose “Browse as this workspace”, or reload and enter a workspace key."
        actionLabel={auth.admin ? 'Open Admin' : null} onAction={() => go('admin')} />
    </div>
  );
  else if (route.name === 'admin') view = <AdminPanel onBrowseWorkspace={browseAsWorkspace} onReauth={reauth} onCredentialHealth={(workspaceId) => { const next = { name:'credentialHealth', workspaceId }; setRoute(next); writeRouteHash(next); }} />;
  else if (route.name === 'credentialHealth') view = <CredentialHealthView workspaceId={route.workspaceId} onBack={() => go('admin')} onReauth={reauth} />;
  else if (route.name === 'start') view = <ReadinessView agents={agents} environments={environments} models={models} mode={apiState.mode} workspaceLoaded={workspaceLoaded || demoMode} go={go} onCreateAgent={createAgent} onCreateEnvironment={createEnvironment} onCreateSession={() => createSession(null)} />;
  else if (route.name === 'sessions') view = <SessionsList sessions={sessions} openSession={openSession} onCreate={() => createSession(null)} dataState={dataState} readOnly={mutationReadOnly} />;
  else if (route.name === 'session') view = <SessionDetail session={route.session} layout={t.layout} go={go} onArchive={archiveSession} onDelete={deleteSession} onSessionStateChange={onSessionStateChange} onRefreshSession={refreshOpenSession} dataState={dataState} apiMode={apiState.mode} readOnly={mutationReadOnly} lifecycleReadOnly={lifecycleReadOnly} onAuthExpired={workspaceReauth} />;
  else if (route.name === 'agents') view = <AgentsList agents={agents} openAgent={openAgent} onCreate={createAgent} dataState={dataState} readOnly={mutationReadOnly} />;
  else if (route.name === 'agent') view = <AgentDetail agent={route.agent} go={go} onCreateSession={() => createSession(route.agent)} onArchive={() => archiveAgent(route.agent)} onUpdateToolPermission={(policy) => updateAgentToolPermission(route.agent, policy)} createSessionReadOnly={mutationReadOnly} archiveReadOnly={lifecycleReadOnly} />;
  else if (route.name === 'environments') view = <EnvironmentsView environments={environments} mode={apiState.mode} dataState={dataState} onCreate={createEnvironment} createdEnvironmentId={createdEnvironmentId} onArchive={archiveEnvironment} onDelete={deleteEnvironment} />;
  else if (route.name === 'files') view = <FilesView files={files} dataState={dataState} readOnly={true} />;
  else if (route.name === 'vaults') view = <VaultsView key={`${route.vaultId || 'vaults'}:${vaultRefresh}`} mode={apiState.mode} initialVaultId={route.vaultId} onCreate={createVault} onCreateCredential={createCredential} readOnly={mutationReadOnly} onOpenVault={(vaultId) => { const next = { name:'vaults', vaultId }; setRoute(next); writeRouteHash(next); }} onBackToVaults={() => go('vaults')} />;
  else if (route.name === 'skills') view = <SkillsView skills={skills} mode={apiState.mode} onCreate={createSkill} readOnly={mutationReadOnly} />;

  if (route.name === 'documentation') return <div className="docs-app">{view}</div>;

  return (
    <div className="app">
      <Sidebar route={route.name} go={go} showAdmin={auth.admin} workspace={auth.workspace} admin={auth.admin}
        onSelectWorkspace={selectWorkspace} onSwitchWorkspace={workspaceReauth} onSignOut={signOut} />
      <main className="main">
        {route.name !== 'documentation' && apiState.state !== 'loading' && <ModeBar mode={apiState.mode} warnings={apiState.warnings} />}
        {view}
      </main>

      {modal && modal.kind === 'session' &&
        <CreateSession agents={agents} environments={environments} vaults={vaults} presetAgent={modal.presetAgent} onClose={() => setModal(null)} onCreate={onSessionCreated} onAuthExpired={workspaceReauth} apiMode={apiState.mode} />}
      {modal && modal.kind === 'agent' &&
        <CreateAgent models={models} skills={skills} onClose={() => setModal(null)} onCreate={onAgentCreated} onAuthExpired={workspaceReauth} apiMode={apiState.mode} />}
      {modal && modal.kind === 'environment' &&
        <CreateEnvironmentModal mode={apiState.mode}
          networkingCatalog={networkingCatalog}
          onClose={() => setModal(null)} onCreated={onEnvironmentCreated}
          onAuthExpired={workspaceReauth} />}
      {modal && modal.kind === 'vault' &&
        <CreateVaultModal onClose={() => setModal(null)} onCreated={onVaultCreated} onAuthExpired={workspaceReauth} apiMode={apiState.mode} />}
      {modal && modal.kind === 'credential' &&
        <CreateVaultCredentialModal vault={modal.vault} onClose={() => setModal(null)} onCreated={onCredentialCreated} onAuthExpired={workspaceReauth} apiMode={apiState.mode} />}
      {modal && modal.kind === 'skill' &&
        <CreateSkillModal onClose={() => setModal(null)} onCreated={onSkillCreated} onAuthExpired={workspaceReauth} apiMode={apiState.mode} />}

      <TweaksPanel>
        <TweakSection label="Theme" />
        <TweakColor label="Accent" value={t.accent}
          options={['#eab44c', '#e8855b', '#4cc2bd', '#6ea8e6']}
          onChange={(v) => setTweak('accent', v)} />
        <TweakToggle label="Darker surface" value={t.darker} onChange={(v) => setTweak('darker', v)} />
        <TweakRadio label="Density" value={t.density} options={['compact', 'comfortable']}
          onChange={(v) => setTweak('density', v)} />

        <TweakSection label="Session detail" />
        <TweakRadio label="Layout" value={t.layout} options={['split', 'threecol']}
          onChange={(v) => setTweak('layout', v)} />

        <TweakSection label="Data state" />
        <TweakSelect label="Preview" value={t.dataState} options={['loaded', 'loading', 'partial', 'empty', 'error']}
          onChange={(v) => setTweak('dataState', v)} />

        <TweakSection label="Typeface" />
        <TweakRadio label="UI font" value={t.uiFont} options={['geist', 'plex']}
          onChange={(v) => setTweak('uiFont', v)} />
        <TweakSelect label="Mono" value={t.mono} options={['geist', 'jetbrains', 'plex']}
          onChange={(v) => setTweak('mono', v)} />

        <TweakSection label="Jump to" />
        <TweakButton label="Open running session (live)" onClick={() => openSession(SESSIONS.find((s) => s.status === 'running'))} />
        <TweakButton label="Open tool-confirmation session" onClick={() => openSession(SESSIONS.find((s) => s.confirm))} />
        <TweakButton label="Open focus session" onClick={() => openSession(SESSIONS.find((s) => s.focus))} />
      </TweaksPanel>
    </div>
  );
}

function linkSessionsToAgents(agents, sessions) {
  const titlesByAgent = new Map();
  for (const session of sessions) {
    const key = session.agentId;
    if (!key) continue;
    const list = titlesByAgent.get(key) || [];
    list.push(session.title);
    titlesByAgent.set(key, list.slice(0, 5));
  }
  return agents.map((agent) => ({
    ...agent,
    sessions: titlesByAgent.get(agent.id) ?? agent.sessions ?? [],
  }));
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
