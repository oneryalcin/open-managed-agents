// agents-files.jsx — Agents list/detail + workspace Files → window
const { useState: useStateA } = React;

function AgentsList({ agents, openAgent, onCreate, dataState = 'loaded', readOnly = false }) {
  const loading = dataState === 'loading';
  const error = dataState === 'error';
  const partial = dataState === 'partial';
  const empty = dataState === 'empty' || agents.length === 0;
  return (
    <div className="main-scroll scroll fade-in">
      <PageHead title="Agents" sub="Templates that define model + prompt. Create and manage Managed Agents."
        action="Create agent" onAction={onCreate} readOnly={readOnly}
        endpoint="POST /v1/agents" />
      <div className="toolbar">
        <Field wide placeholder="Search by agent ID" />
        <Select label="Created" value="All time" />
        <Select label="Status" value="Active" w={130} />
      </div>
      {partial && <PartialNotice resource="agents" />}
      {loading ? <SkeletonTable rows={5} cols={[150, 'grow', 170, 'pill', 70, 70]} />
       : error ? <ErrorState resource="agents" onRetry={() => {}} />
       : empty ? <EmptyState icon="bot" title="No agents yet"
            message="Agents are reusable templates that define a model, system prompt, and tools. Create one to get started."
            actionLabel={!readOnly ? "Create agent" : null} onAction={onCreate} />
       : <>
      <div className="panel">
        <div className="thead">
          <span className="th" style={{ width:150 }}>ID</span>
          <span className="th grow">Name</span>
          <span className="th" style={{ width:170 }}>Model</span>
          <span className="th" style={{ width:90 }}>Status</span>
          <span className="th" style={{ width:70 }}>Created</span>
          <span className="th" style={{ width:70 }}>Updated</span>
          <span className="th" style={{ width:20 }} />
        </div>
        {agents.map((a) => (
          <div className="trow" key={a.id} onClick={() => openAgent(a)}>
            <span className="td mono" style={{ width:150, fontSize:12, color:'var(--soft)' }}>{a.short}</span>
            <span className="td grow cell-strong">{a.name}</span>
            <span className="td mono" style={{ width:170, fontSize:12.5, color:'var(--soft)' }}>{a.model}</span>
            <span className="td" style={{ width:90 }}><St k={a.status} /></span>
            <span className="td mono" style={{ width:70, color:'var(--faint)' }}>{a.created}</span>
            <span className="td mono" style={{ width:70, color:'var(--faint)' }}>{a.updated}</span>
            <span className="td" style={{ width:20 }}><Kebab /></span>
          </div>
        ))}
      </div>
      <Pager />
      </>}
    </div>
  );
}

function AgentDetail({ agent, go, onCreateSession, onArchive, readOnly = false }) {
  const a = agent;
  const [tab, setTab] = useStateA('agent');
  const [dialog, setDialog] = useStateA(false);
  const archived = a.status === 'archived';
  return (
    <div className="main-scroll scroll fade-in">
      <Crumbs items={[{ label:'Agents', onClick:() => go('agents') }, { label:a.name }]} />
      <div className="sess-head">
        <div>
          <div className="sess-title"><h1>{a.name}</h1><St k={a.status} /></div>
          <div className="meta-row mono" style={{ fontSize:12.5, color:'var(--faint)' }}>{a.id} · Last updated {a.updated}</div>
        </div>
        <div style={{ display:'flex', gap:9 }}>
          <button className="btn" disabled={archived || readOnly} title={readOnly ? 'Read-only API mode · POST /v1/agents/:id/archive' : undefined}
            style={{ opacity: archived || readOnly ? .5 : 1 }} onClick={() => !readOnly && setDialog(true)}>
            <Icon name="archive" size={14} />{archived ? 'Archived' : 'Archive'}
          </button>
          <button className="btn btn-primary" disabled={readOnly} title={readOnly ? 'Read-only API mode · POST /v1/sessions' : undefined}
            onClick={() => !readOnly && onCreateSession()}>
            <Icon name="plus" size={15} />Create session
          </button>
        </div>
      </div>

      {dialog &&
        <ConfirmDialog icon="archive" title="Archive this agent?"
          message={<>Archiving <b>{a.name}</b> hides it from the default list and stops it appearing in new-session pickers. Existing sessions are unaffected.</>}
          confirmLabel="Archive agent" endpoint="POST /v1/agents/:id/archive"
          onClose={() => setDialog(false)}
          onConfirm={() => { setDialog(false); onArchive && onArchive(); }} />}

      <div style={{ display:'flex', gap:20, borderBottom:'1px solid var(--border)', marginBottom:22 }}>
        {['agent','sessions'].map((t) => (
          <div key={t} onClick={() => setTab(t)} style={{ padding:'0 0 11px', cursor:'pointer', textTransform:'capitalize',
            color: tab === t ? 'var(--ink)' : 'var(--soft)', fontWeight: tab === t ? 600 : 400,
            borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent', marginBottom:-1 }}>
            {t === 'agent' ? 'Agent' : 'Sessions'}
          </div>
        ))}
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 250px', gap:24, alignItems:'start' }}>
        <div>
          <div className="field select" style={{ width:120, marginBottom:22 }}>
            <span style={{ color:'var(--faint)' }}>Version</span><b>{a.version}</b><Icon name="chevDown" size={14} className="chev" />
          </div>
          <div className="section">
            <div className="sec-label" style={{ marginBottom:8 }}>Model</div>
            <div className="mono" style={{ fontSize:14 }}>{a.model}</div>
          </div>
          <div className="section">
            <div className="sec-label" style={{ marginBottom:8 }}>System prompt</div>
            <div className="prompt-box">{a.system}</div>
          </div>
          <div className="section">
            <div className="sec-label" style={{ marginBottom:8 }}>MCPs and tools</div>
            <div className="panel">
              <div className="tool-card">
                <div className="tool-ico"><Icon name="cpu" size={18} /></div>
                <div><div className="cell-strong" style={{ fontSize:13.5 }}>Built-in tools</div>
                  <div className="mono" style={{ fontSize:11.5, color:'var(--faint)', marginTop:2 }}>{a.toolset}</div></div>
              </div>
              <div className="disclosure">
                <div style={{ display:'flex', alignItems:'center', gap:9 }}>
                  <Icon name="chevRight" size={14} style={{ color:'var(--faint)' }} />
                  <span style={{ fontSize:13.5 }}>Tool permissions</span>
                  <span className="pill" style={{ height:20 }}>{a.tools}</span>
                </div>
                <span style={{ display:'flex', alignItems:'center', gap:6, color:'var(--soft)', fontSize:12.5 }}>
                  <Icon name="checkCircle" size={14} style={{ color:'var(--green)' }} />Always allow</span>
              </div>
            </div>
          </div>
          <div className="section">
            <div className="sec-label" style={{ marginBottom:8 }}>Skills</div>
            <div style={{ color:'var(--faint)', fontSize:13.5 }}>No skills configured.</div>
          </div>
        </div>

        <div className="panel" style={{ padding:'14px 16px' }}>
          <div className="sec-label" style={{ marginBottom:6 }}>Linked sessions</div>
          {a.sessions.length === 0 && <div style={{ color:'var(--faint)', fontSize:13, padding:'8px 0' }}>None yet.</div>}
          {a.sessions.map((t, i) => (
            <div className="linked" key={i}>
              <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{t}</span>
              <St k="idle" />
            </div>
          ))}
          {a.sessions.length > 0 && <div className="dl" style={{ marginTop:10 }}>View all {a.sessions.length}<Icon name="arrowRight" size={13} /></div>}
        </div>
      </div>
    </div>
  );
}

function FilesView({ files = FILES, dataState = 'loaded', readOnly = false }) {
  const [scoped, setScoped] = useStateA(true);
  const loading = dataState === 'loading';
  const error = dataState === 'error';
  const partial = dataState === 'partial';
  const empty = dataState === 'empty';
  return (
    <div className="main-scroll scroll fade-in">
      <PageHead title="Files" sub="Workspace uploads and session-scoped output files."
        action="Upload file" readOnly={true} endpoint="POST /v1/files" />
      <div className="toolbar">
        <Field wide placeholder="Search files" />
        <div className="field select" onClick={() => setScoped(!scoped)} style={{ width:210 }}>
          <span style={{ color:'var(--faint)' }}>Scope</span>
          <b>{scoped ? 'Session · …VcyvLi' : 'All workspace'}</b>
          <Icon name="chevDown" size={14} className="chev" />
        </div>
        <Select label="Type" value="All" w={110} />
      </div>
      {partial && <PartialNotice resource="files" />}
      {loading ? <SkeletonTable rows={5} cols={['grow', 90, 80, 70, 110]} />
       : error ? <ErrorState resource="files" onRetry={() => {}} />
       : empty ? <EmptyState icon="folder" title="No files here"
            message="No output files for this session yet. Files generated by the agent appear here and can be downloaded."
            actionLabel={null} onAction={() => {}} />
       : <>
      <div className="panel">
        <div className="thead">
          <span className="th" style={{ width:15 }}><span className="checkbox" /></span>
          <span className="th grow">Filename</span>
          <span className="th" style={{ width:90 }}>Type</span>
          <span className="th" style={{ width:80 }}>Size</span>
          <span className="th" style={{ width:70 }}>Created</span>
          <span className="th" style={{ width:110 }}>Download</span>
        </div>
        {files.map((f, i) => (
          <div className={'trow' + (f.dl ? '' : ' inert-row')} key={i}>
            <span className="td" style={{ width:15 }}><span className="checkbox" /></span>
            <span className="td grow" style={{ display:'flex', alignItems:'center', gap:11 }}>
              <span className="file-ico">{f.ext}</span><span className="cell-strong">{f.name}</span></span>
            <span className="td mono" style={{ width:90, fontSize:11.5, color:'var(--faint)' }}>{f.type}</span>
            <span className="td mono" style={{ width:80, color:'var(--soft)' }}>{f.size}</span>
            <span className="td mono" style={{ width:70, color:'var(--faint)' }}>{f.created}</span>
            <span className="td" style={{ width:110 }}>
              {f.dl ? <a className="dl" href={f.href || '#'}><Icon name="download" size={14} />Download</a> : <span className="inert">— mounted input</span>}
            </span>
          </div>
        ))}
      </div>
      <Pager />
      </>}
    </div>
  );
}

Object.assign(window, { AgentsList, AgentDetail, FilesView });
