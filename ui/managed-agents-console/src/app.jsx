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
  if (route.name === 'agents') return '#agents';
  if (route.name === 'files') return '#files';
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
  if (rawHash === 'agents') return { name:'agents' };
  if (rawHash === 'files') return { name:'files' };
  return null;
}

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const demoMode = new URLSearchParams(window.location.search).get('mode') === 'demo';
  const [route, setRoute] = useState({ name:'sessions' });
  const [sessions, setSessions] = useState(SESSIONS);
  const [agents, setAgents] = useState(AGENTS);
  const [environments, setEnvironments] = useState(ENVIRONMENTS);
  const [files, setFiles] = useState(FILES);
  const [apiState, setApiState] = useState({ state:'loading', mode: demoMode ? 'demo' : 'api', error:null, warnings:[] });
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
    if (demoMode) {
      setApiState({ state:'loaded', mode:'demo', error:null, warnings:[] });
      const target = readRouteTarget(SESSIONS, AGENTS);
      if (target) setRoute(target);
      return () => { alive = false; };
    }
    OmaConsoleApi.loadConsoleData()
      .then((data) => {
        if (!alive) return;
        const linkedAgents = linkSessionsToAgents(data.agents, data.sessions);
        setAgents(linkedAgents);
        setSessions(data.sessions);
        setEnvironments(data.environments);
        setFiles(data.files);
        setApiState({ state:'loaded', mode:'api', error:null, warnings:data.warnings || [] });
        const target = readRouteTarget(data.sessions, linkedAgents);
        if (target?.name === 'session') openSession(target.session, 'api');
        else if (target) setRoute(target);
      })
      .catch((error) => {
        if (!alive) return;
        setApiState({ state:'loaded', mode:'mock', error, warnings:[] });
        const target = readRouteTarget(SESSIONS, AGENTS);
        if (target) setRoute(target);
      });
    return () => { alive = false; };
  }, [demoMode]);

  const go = (name) => {
    const next = { name };
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
  const readOnly = apiState.mode !== 'demo';

  const createSession = (preset) => {
    if (readOnly) return;
    setModal({ kind:'session', presetAgent: preset });
  };
  const createAgent = () => {
    if (readOnly) return;
    setModal({ kind:'agent' });
  };

  const onSessionCreated = (s) => {
    if (readOnly) return;
    setSessions((prev) => [s, ...prev]);
    setModal(null);
    openSession(s);
  };
  const onAgentCreated = (a) => {
    if (readOnly) return;
    setAgents((prev) => [a, ...prev]);
    setModal(null);
    openAgent(a);
  };

  const archiveSession = (s) => {
    if (readOnly) return;
    setSessions((prev) => prev.map((x) => x.id === s.id ? { ...x, status:'archived' } : x));
  };
  const deleteSession = (s) => {
    if (readOnly) return;
    setSessions((prev) => prev.filter((x) => x.id !== s.id));
    go('sessions');
  };
  const archiveAgent = (a) => {
    if (readOnly) return;
    const upd = { ...a, status:'archived' };
    setAgents((prev) => prev.map((x) => x.id === a.id ? upd : x));
    setRoute({ name:'agent', agent: upd });
  };

  let view;
  const dataState = apiState.state === 'loading' ? 'loading' : t.dataState;
  if (route.name === 'sessions') view = <SessionsList sessions={sessions} openSession={openSession} onCreate={() => createSession(null)} dataState={dataState} readOnly={readOnly} />;
  else if (route.name === 'session') view = <SessionDetail session={route.session} layout={t.layout} go={go} onArchive={archiveSession} onDelete={deleteSession} dataState={dataState} apiMode={apiState.mode} readOnly={readOnly} />;
  else if (route.name === 'agents') view = <AgentsList agents={agents} openAgent={openAgent} onCreate={createAgent} dataState={dataState} readOnly={readOnly} />;
  else if (route.name === 'agent') view = <AgentDetail agent={route.agent} go={go} onCreateSession={() => createSession(route.agent)} onArchive={() => archiveAgent(route.agent)} readOnly={readOnly} />;
  else if (route.name === 'files') view = <FilesView files={files} dataState={dataState} readOnly={readOnly} />;

  return (
    <div className="app">
      <Sidebar route={route.name} go={go} />
      <main className="main">
        {apiState.state !== 'loading' && <ModeBar mode={apiState.mode} warnings={apiState.warnings} />}
        {view}
      </main>

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
