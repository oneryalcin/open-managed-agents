// app.jsx — root: sessions list, routing, theme tweaks. Mounts everything.
const { useState, useEffect } = React;

function SessionsList({ sessions, openSession, onCreate, dataState = 'loaded' }) {
  const loading = dataState === 'loading';
  const error = dataState === 'error';
  const empty = dataState === 'empty' || sessions.length === 0;
  return (
    <div className="main-scroll scroll fade-in">
      <PageHead title="Sessions" sub="Trace and debug Managed Agents sessions." action={onCreate ? "Create session" : null} onAction={onCreate} />
      <div className="toolbar">
        <Field wide placeholder="Search by session ID" />
        <Select label="Created" value="All time" />
        <Select label="Agent" value="All" w={120} />
        <Select label="Status" value="Active" w={120} />
      </div>
      {loading ? <SkeletonTable rows={7} cols={[140, 'grow', 'pill', 160, 64]} />
       : error ? <ErrorState resource="sessions" onRetry={() => {}} />
       : empty ? <EmptyState icon="activity" title="No sessions yet"
            message="Sessions appear here as agents run. Create one to start a local Managed Agents session."
            actionLabel={onCreate ? "Create session" : null} onAction={onCreate} />
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
            <span className="td" style={{ width:96 }}><St k={s.status} /></span>
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

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [route, setRoute] = useState({ name:'sessions' });
  const [sessions, setSessions] = useState(SESSIONS);
  const [agents, setAgents] = useState(AGENTS);
  const [environments, setEnvironments] = useState(ENVIRONMENTS);
  const [files, setFiles] = useState(FILES);
  const [apiState, setApiState] = useState({ state:'loading', mode:'api', error:null, warnings:[] });
  const [modal, setModal] = useState(null);   // { kind:'session', presetAgent } | { kind:'agent' }

  useEffect(() => {
    const r = document.documentElement;
    r.classList.toggle('darker', !!t.darker);
    r.classList.toggle('compact', t.density === 'compact');
    r.style.setProperty('--accent', t.accent);
    r.style.setProperty('--font', UI_FONTS[t.uiFont] || UI_FONTS.geist);
    r.style.setProperty('--mono', MONO_FONTS[t.mono] || MONO_FONTS.geist);
  }, [t]);

  useEffect(() => {
    let alive = true;
    OmaConsoleApi.loadConsoleData()
      .then((data) => {
        if (!alive) return;
        setAgents(linkSessionsToAgents(data.agents, data.sessions));
        setSessions(data.sessions);
        setEnvironments(data.environments);
        setFiles(data.files);
        setApiState({ state:'loaded', mode:'api', error:null, warnings:data.warnings || [] });
      })
      .catch((error) => {
        if (!alive) return;
        setApiState({ state:'loaded', mode:'mock', error, warnings:[] });
      });
    return () => { alive = false; };
  }, []);

  const go = (name) => setRoute({ name });
  const openSession = (session) => {
    setRoute({ name:'session', session: { ...session, loadingEvents:true } });
    if (apiState.mode !== 'api') {
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
  const openAgent = (agent) => setRoute({ name:'agent', agent });
  const apiReadOnly = apiState.mode === 'api';

  const createSession = (preset) => {
    if (apiReadOnly) return;
    setModal({ kind:'session', presetAgent: preset });
  };
  const createAgent = () => {
    if (apiReadOnly) return;
    setModal({ kind:'agent' });
  };

  const onSessionCreated = (s) => {
    if (apiReadOnly) return;
    setSessions((prev) => [s, ...prev]);
    setModal(null);
    openSession(s);
  };
  const onAgentCreated = (a) => {
    if (apiReadOnly) return;
    setAgents((prev) => [a, ...prev]);
    setModal(null);
    openAgent(a);
  };

  const archiveSession = (s) => {
    if (apiReadOnly) return;
    setSessions((prev) => prev.map((x) => x.id === s.id ? { ...x, status:'archived' } : x));
  };
  const deleteSession = (s) => {
    if (apiReadOnly) return;
    setSessions((prev) => prev.filter((x) => x.id !== s.id));
    go('sessions');
  };
  const archiveAgent = (a) => {
    if (apiReadOnly) return;
    const upd = { ...a, status:'archived' };
    setAgents((prev) => prev.map((x) => x.id === a.id ? upd : x));
    setRoute({ name:'agent', agent: upd });
  };

  let view;
  const dataState = apiState.state === 'loading' ? 'loading' : t.dataState;
  if (route.name === 'sessions') view = <SessionsList sessions={sessions} openSession={openSession} onCreate={apiReadOnly ? null : () => createSession(null)} dataState={dataState} />;
  else if (route.name === 'session') view = <SessionDetail session={route.session} layout={t.layout} go={go} onArchive={archiveSession} onDelete={deleteSession} dataState={dataState} apiMode={apiState.mode} readOnly={apiReadOnly} />;
  else if (route.name === 'agents') view = <AgentsList agents={agents} openAgent={openAgent} onCreate={apiReadOnly ? null : createAgent} dataState={dataState} />;
  else if (route.name === 'agent') view = <AgentDetail agent={route.agent} go={go} onCreateSession={() => createSession(route.agent)} onArchive={() => archiveAgent(route.agent)} readOnly={apiReadOnly} />;
  else if (route.name === 'files') view = <FilesView files={files} dataState={dataState} />;

  return (
    <div className="app">
      <Sidebar route={route.name} go={go} />
      <main className="main">{view}</main>
      {apiState.mode === 'mock' && <div className="api-banner">
        <Icon name="alert" size={14} />
        API unavailable — showing bundled demo data.
      </div>}
      {apiState.mode === 'api' && apiState.warnings.length > 0 && <div className="api-banner warn">
        <Icon name="alert" size={14} />
        {apiState.warnings.join(' ')}
      </div>}

      {modal && modal.kind === 'session' &&
        <CreateSession agents={agents} environments={environments} presetAgent={modal.presetAgent} onClose={() => setModal(null)} onCreate={onSessionCreated} />}
      {modal && modal.kind === 'agent' &&
        <CreateAgent onClose={() => setModal(null)} onCreate={onAgentCreated} />}

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
        <TweakSelect label="Preview" value={t.dataState} options={['loaded', 'loading', 'empty', 'error']}
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
