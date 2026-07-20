// detail.jsx — Session detail (split-pane / three-column) → window.SessionDetail
const { useState: useStateD, useEffect: useEffectD, useRef: useRefD } = React;

function Role({ r }) {
  const L = { user:'User', agent:'Agent', tool:'Tool', span:'Span', sys:'Sys' };
  return <span className={'role ' + r}>{L[r]}</span>;
}

function EvRow({ e, sel, onClick, mode }) {
  const errored = e.ok === false;
  return (
    <div className={'ev' + (sel ? ' sel' : '')} onClick={onClick}>
      <Role r={e.role} />
      {mode === 'debug'
        ? <>
            <span className="mono ev-type" style={{ width:186, flex:'0 0 auto', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{e.type}</span>
            <Pill>{e.tag}</Pill>
            {e.ok && <span className="badge st-active"><i className="dot" />ok</span>}
            {errored && <span className="badge st-error"><i className="dot" />error</span>}
            {e.open && <span className="badge st-open"><i className="dot" />open</span>}
            <span className="grow" />
          </>
        : <span className="ev-text">{e.text}</span>}
      {e.tokens && <span className="ev-tok mono">{e.tokens}</span>}
      <span className="ev-time mono">{e.time}</span>
    </div>
  );
}

function Inspector({ e, onClose }) {
  if (!e) return (
    <div className="panel inspector"><div className="empty">Select an event to inspect.</div></div>
  );
  return (
    <div className="panel inspector fade-in" key={e.id}>
      <div className="insp-head">
        <Role r={e.role} />
        <h3 className="mono" style={{ fontSize:14 }}>{e.type.split('.').pop()}</h3>
        <span className="grow" />
        {e.ok && <span className="badge st-active"><i className="dot" />ok</span>}
        {e.ok === false && <span className="badge st-error"><i className="dot" />error</span>}
        {e.open && <span className="badge st-open"><i className="dot" />open</span>}
        <span className="kebab" onClick={onClose}><Icon name="x" size={16} /></span>
      </div>
      <div className="insp-body scroll" style={{ overflow:'auto' }}>
        <div className="mono" style={{ fontSize:11.5, color:'var(--faint)' }}>{e.id} · {e.time}</div>
        {e.usage && <>
          <div className="divider" />
          <div className="kv"><span className="k">duration</span><span className="v mono">{e.dur}</span></div>
          <div className="kv"><span className="k">paired start</span><span className="v mono">{e.pairedStart}</span></div>
          <div className="sec-label" style={{ marginTop:4 }}>model usage</div>
          {Object.entries(e.usage).map(([k, v]) => (
            <div className="kv" key={k}><span className="k">{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</span><span className="v mono">{v}</span></div>
          ))}
        </>}
        {e.content && <>
          <div className="divider" />
          <div className="sec-label">content</div>
          <div className="content-block" style={{ whiteSpace:'pre-wrap' }}>{e.content}</div>
        </>}
        <div className="divider" />
        <div className="sec-label">raw event</div>
        <div className="code scroll"><pre>{e.raw}</pre></div>
      </div>
    </div>
  );
}

function SpansView({ spans = SPANS, onPick }) {
  return (
    <div className="panel" style={{ padding:'18px 18px 16px' }}>
      <div className="span-note">
        <span>Ordered by <span className="mono">processed_at</span>.</span>
        <span>Widths are approximate until per-span timing lands.</span>
      </div>
      <div className="axis">{['0s','7s','14s','20s','26s'].map((t) => <span key={t} className="mono">{t}</span>)}</div>
      <div style={{ display:'flex', flexDirection:'column', gap:13 }}>
        {spans.map((s, i) => (
          <div className="span-row" key={i}>
            <div className="span-label"><Role r={s.role} /><span className="mono" style={{ fontSize:11.5, color:'var(--soft)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{s.label}</span></div>
            <div className="span-track">
              <div className={'span-bar ' + s.kind} style={{ left:s.left + '%', width:s.width + '%' }}
                onClick={() => onPick && onPick(s.eventId || (s.kind === 'tool' ? 'sevt_…a06' : 'sevt_…a03'))}>
                <span className="mono">{s.info}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="legend">
        <span><i style={{ background:'var(--r-agent-bg)', borderColor:'var(--r-agent)' }} />model request</span>
        <span><i style={{ background:'var(--r-tool-bg)', borderColor:'var(--r-tool)' }} />tool</span>
        <span><i style={{ background:'var(--accent-wash)', borderColor:'var(--accent-line)' }} />open / unpaired</span>
        <span><i style={{ background:'var(--red-wash)', borderColor:'var(--red)' }} />error</span>
      </div>
    </div>
  );
}

function FilesPanel({ files = FILES }) {
  if (files.length === 0) {
    return <EmptyState icon="folder" title="No output files" message="This session hasn’t produced any output files yet. Generated files appear here with download links." />;
  }
  return (
    <div className="panel">
      <div className="thead">
        <span className="th" style={{ width:24 }} />
        <span className="th grow">Filename</span>
        <span className="th" style={{ width:80 }}>Type</span>
        <span className="th" style={{ width:80 }}>Size</span>
        <span className="th" style={{ width:70 }}>Created</span>
        <span className="th" style={{ width:110 }}>Download</span>
      </div>
      {files.map((f, i) => (
        <div className={'trow' + (f.dl ? '' : ' inert-row')} key={i}>
          <span className="file-ico" style={{ marginRight:-4 }}>{f.ext}</span>
          <span className="td grow cell-strong">{f.name}</span>
          <span className="td mono" style={{ width:80, fontSize:11.5, color:'var(--faint)' }}>{f.type}</span>
          <span className="td mono" style={{ width:80, color:'var(--soft)' }}>{f.size}</span>
          <span className="td mono" style={{ width:70, color:'var(--faint)' }}>{f.created}</span>
          <span className="td" style={{ width:110 }}>
            {f.dl && f.href ? <a className="dl" href="#" onClick={(e) => { e.preventDefault(); OmaConsoleApi.downloadFile(f.href, f.name); }}><Icon name="download" size={14} />Download</a> : <span className="inert">{f.dl ? '— demo file' : '— mounted input'}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

function SessionDetail({ session, layout, go, onArchive, onDelete, onSessionStateChange, onRefreshSession, dataState = 'loaded', apiMode = 'mock', readOnly = false, lifecycleReadOnly = readOnly, onAuthExpired }) {
  const s = session;
  const displayStatus = s.status === 'action' ? 'idle' : s.status;
  const isLive = displayStatus === 'running';
  const isConfirm = !!s.confirm || !!s.requiresAction;
  const [view, setView] = useStateD('transcript');           // transcript | debug | spans | files
  const [selId, setSel] = useStateD(isLive || isConfirm ? null : 'sevt_…a05');
  const [filters, setFilters] = useStateD([]);
  const [query, setQuery] = useStateD('');
  const threecol = layout === 'threecol';

  // ── live stream state ──
  const baseEvents = s.events ?? (apiMode === 'api' ? [] : EVENTS);
  const baseFiles = s.files ?? (apiMode === 'api' ? [] : FILES);
  const baseSpans = s.spans ?? (apiMode === 'api' ? [] : SPANS);
  const [shown, setShown] = useStateD(() => isLive && apiMode !== 'api' ? RUN_EVENTS.slice(0, 1) : isConfirm && apiMode !== 'api' ? CONFIRM_EVENTS : baseEvents);
  const [status, setStatus] = useStateD(displayStatus);
  const [working, setWorking] = useStateD(isLive);
  const [confirmState, setConfirmState] = useStateD(isConfirm ? 'pending' : null);
  const [menuOpen, setMenuOpen] = useStateD(false);
  const [dialog, setDialog] = useStateD(null);               // 'archive' | 'delete'
  const [message, setMessage] = useStateD('');
  const [actionBusy, setActionBusy] = useStateD(false);
  const [actionError, setActionError] = useStateD(null);
  const [lifecycleBusy, setLifecycleBusy] = useStateD(false);
  const [lifecycleError, setLifecycleError] = useStateD(null);
  const [streamState, setStreamState] = useStateD(apiMode === 'api' ? 'connecting' : 'closed');
  const aliveRef = useRefD(true);
  const idxRef = useRefD(1);
  const timerRef = useRefD(null);
  const streamRef = useRefD(null);
  const messageIntentRef = useRefD(null);
  const interruptIntentRef = useRefD(null);
  const confirmationIntentRef = useRefD(null);
  const running = status === 'running';

  useEffectD(() => {
    setStatus(displayStatus);
    setWorking(isLive);
    setConfirmState(isConfirm ? 'pending' : null);
    setSel(isLive || isConfirm ? null : 'sevt_…a05');
    setView('transcript');
    setFilters([]);
    setQuery('');
    setMessage('');
    setActionError(null);
    setLifecycleError(null);
    setStreamState(apiMode === 'api' ? 'connecting' : 'closed');
    messageIntentRef.current = OmaConsoleApi.createIdempotencyIntent();
    interruptIntentRef.current = OmaConsoleApi.createIdempotencyIntent();
    confirmationIntentRef.current = OmaConsoleApi.createIdempotencyIntent();
  }, [s.id]);

  useEffectD(() => {
    if (!isLive || apiMode === 'api') return;
    aliveRef.current = true;
    idxRef.current = 1;
    const tick = () => {
      if (!aliveRef.current) return;
      if (idxRef.current >= RUN_EVENTS.length) { setStatus('idle'); setWorking(false); return; }
      const ev = RUN_EVENTS[idxRef.current];
      timerRef.current = setTimeout(() => {
        if (!aliveRef.current) return;
        setShown((prev) => [...prev, ev]);
        if (ev.type === 'session.status_idle') { setStatus('idle'); setWorking(false); }
        idxRef.current += 1;
        tick();
      }, ev.gap == null ? 1200 : ev.gap);
    };
    setWorking(true);
    tick();
    return () => { aliveRef.current = false; clearTimeout(timerRef.current); };
  }, [isLive, apiMode]);

  useEffectD(() => {
    if (isLive && apiMode !== 'api') return;
    if (isConfirm && apiMode !== 'api') return;
    setShown(baseEvents);
  }, [s.id, s.events, apiMode]);

  useEffectD(() => {
    if (apiMode !== 'api' || s.loadingEvents || s.eventError) return;
    const controller = new AbortController();
    const lastPersistedId = baseEvents.length > 0 ? baseEvents[baseEvents.length - 1].id : undefined;
    setStreamState('connecting');
    OmaConsoleApi.followSessionEvents(s.id, {
      signal: controller.signal,
      lastEventId: lastPersistedId,
      onState: ({ status: next, error }) => {
        setStreamState(next);
        if (next === 'failed') {
          setActionError(error?.message || 'The live event stream failed. Persisted history remains available.');
          if (error?.status === 401 && onAuthExpired) onAuthExpired();
        }
      },
      onEvent: (event) => {
        const mapped = OmaConsoleApi.toUiSessionEvent(event);
        setShown((current) => current.some((item) => item.id === mapped.id)
          ? current
          : [...current, mapped]);
        if (event.type === 'session.status_running') {
          setStatus('running');
          setWorking(true);
          setConfirmState(null);
          if (onSessionStateChange) onSessionStateChange(s.id, { status:'running', requiresAction:false });
        } else if (event.type === 'session.status_idle') {
          const requiresAction = event.stop_reason?.type === 'requires_action';
          setStatus('idle');
          setWorking(false);
          setConfirmState(requiresAction ? 'pending' : null);
          if (onSessionStateChange) onSessionStateChange(s.id, { status:'idle', requiresAction });
          if (onRefreshSession) onRefreshSession({ ...s, status:'idle' });
        } else if (event.type === 'session.status_terminated') {
          setStatus('terminated');
          setWorking(false);
          setConfirmState(null);
          if (onSessionStateChange) onSessionStateChange(s.id, { status:'terminated', requiresAction:false });
        } else if (event.type === 'session.error') {
          setWorking(false);
        } else if (event.type === 'user.tool_confirmation') {
          setConfirmState(event.result === 'allow' ? 'allowed' : 'denied');
        }
      },
    }).catch((error) => {
      if (controller.signal.aborted) return;
      setActionError(error?.message || 'The live event stream failed. Persisted history remains available.');
    });
    return () => controller.abort();
  }, [apiMode, s.id, s.loadingEvents, s.eventError]);

  // auto-scroll the live stream as events arrive (no scrollIntoView)
  useEffectD(() => {
    if (!running) return;
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown, view, running]);

  const interrupt = async () => {
    if (apiMode === 'api') {
      if (actionBusy) return;
      setActionBusy(true);
      setActionError(null);
      try {
        interruptIntentRef.current ||= OmaConsoleApi.createIdempotencyIntent();
        await OmaConsoleApi.sendSessionEvents(s.id, [{ type:'user.interrupt' }], { intent:interruptIntentRef.current });
        interruptIntentRef.current = null;
      } catch (error) {
        setActionError(error.message || 'Interrupt request failed.');
        if (error.status === 401 && onAuthExpired) onAuthExpired();
      } finally {
        setActionBusy(false);
      }
      return;
    }
    aliveRef.current = false;
    clearTimeout(timerRef.current);
    const t = '0:00:06';
    setShown((prev) => [
      ...prev,
      { id:'sevt_…int', role:'user', type:'user.interrupt', tag:'interrupt', transcript:true, time:t,
        text:'user.interrupt · operator requested stop',
        content:'Interrupt requested by operator. The agent will stop after the current step.',
        raw:JSON.stringify({ type:'user.interrupt', id:'sevt_…int', reason:'operator' }, null, 2) },
      { id:'sevt_…idl', role:'sys', type:'session.status_idle', tag:'interrupted', time:t,
        text:'session.status_idle · interrupted',
        content:'Session went idle after interrupt. requires_action: false.',
        raw:JSON.stringify({ type:'session.status_idle', id:'sevt_…idl', interrupted:true, requires_action:false }, null, 2) },
    ]);
    setStatus('idle');
    setWorking(false);
  };

  const pool = apiMode === 'api' || isLive || isConfirm || s.events ? shown : EVENTS;
  const usesSessionEvents = Array.isArray(s.events);
  const sel = pool.find((e) => e.id === selId) ||
    (!usesSessionEvents ? EVENTS.find((e) => e.id === selId) : null);
  const queryText = query.trim().toLowerCase();
  const eventMatchesQuery = (event) => {
    if (!queryText) return true;
    return [event.id, event.type, event.tag, event.text, event.content, event.raw]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(queryText));
  };
  const eventMatchesType = (event) =>
    filters.length === 0 || filters.some((filter) => event.type.includes(filter));
  const filteredPool = pool.filter((event) =>
    eventMatchesQuery(event) && (view === 'debug' ? eventMatchesType(event) : true));
  const txEvents = filteredPool.filter((e) => e.transcript);
  const dbgEvents = filteredPool;
  const tabFor = (view === 'spans' || view === 'debug') ? 'debug' : view;
  const fileCount = Array.isArray(baseFiles) ? baseFiles.length : 0;
  const needsAction = Boolean(confirmState === 'pending' || confirmState === 'submitting');
  const resultCount = view === 'debug' ? dbgEvents.length : txEvents.length;
  const eventSearchVisible = view !== 'files' && view !== 'spans';

  // resolve a pending tool confirmation → emit user.tool_confirmation + follow-up
  const resolveConfirm = async (decision) => {
    if (apiMode === 'api') {
      if (!pendingTool || actionBusy) return;
      setActionBusy(true);
      setActionError(null);
      setConfirmState('submitting');
      const event = {
        type:'user.tool_confirmation',
        tool_use_id:pendingTool.id,
        result:decision,
        ...(decision === 'deny' ? { deny_message:'Denied in the OMA console.' } : {}),
      };
      try {
        confirmationIntentRef.current ||= OmaConsoleApi.createIdempotencyIntent();
        await OmaConsoleApi.sendSessionEvents(s.id, [event], { intent:confirmationIntentRef.current });
        confirmationIntentRef.current = null;
      } catch (error) {
        setConfirmState('pending');
        setActionError(error.message || 'Tool confirmation failed.');
        if (error.status === 401 && onAuthExpired) onAuthExpired();
      } finally {
        setActionBusy(false);
      }
      return;
    }
    const allow = decision === 'allow';
    const t = '0:00:02';
    const extra = allow
      ? [
          { id:'sevt_…c05', role:'user', type:'user.tool_confirmation', tag:'allow', transcript:true, time:t,
            text:'user.tool_confirmation · allow · bash rm -rf build/',
            content:'Operator allowed the tool call.',
            raw:JSON.stringify({ type:'user.tool_confirmation', id:'sevt_…c05', tool_use_id:'sevt_…c03', decision:'allow' }, null, 2) },
          { id:'sevt_…c06', role:'tool', type:'agent.tool_result', tag:'exit 0', transcript:true, time:'0:00:03',
            text:'agent.tool_result · exit 0 · build/ removed',
            content:'exit 0 · removed build/ (42 files)', raw:JSON.stringify({ type:'agent.tool_result', id:'sevt_…c06', tool_use_id:'sevt_…c03', is_error:false }, null, 2) },
          { id:'sevt_…c07', role:'agent', type:'agent.message', tag:'message', transcript:true, time:'0:00:04', tokens:'5.4k / 120',
            text:'Done — build/ removed and export.sh re-run. 3 artifacts written.',
            content:'Done — build/ removed and export.sh re-run. 3 artifacts written.', raw:JSON.stringify({ type:'agent.message', id:'sevt_…c07' }, null, 2) },
        ]
      : [
          { id:'sevt_…c05', role:'user', type:'user.tool_confirmation', tag:'deny', transcript:true, time:t,
            text:'user.tool_confirmation · deny · bash rm -rf build/',
            content:'Operator denied the tool call.',
            raw:JSON.stringify({ type:'user.tool_confirmation', id:'sevt_…c05', tool_use_id:'sevt_…c03', decision:'deny' }, null, 2) },
          { id:'sevt_…c07', role:'agent', type:'agent.message', tag:'message', transcript:true, time:'0:00:03', tokens:'5.2k / 88',
            text:'Understood — I\u2019ll leave build/ in place. Let me know how you\u2019d like to proceed.',
            content:'Understood — I\u2019ll leave build/ in place. Let me know how you\u2019d like to proceed.', raw:JSON.stringify({ type:'agent.message', id:'sevt_…c07' }, null, 2) },
        ];
    const idle = { id:'sevt_…c08', role:'sys', type:'session.status_idle', tag:'requires_action', time:'0:00:04',
      text:'session.status_idle · requires_action: none', content:'Session idle. requires_action: false.',
      raw:JSON.stringify({ type:'session.status_idle', id:'sevt_…c08', requires_action:false }, null, 2) };
    setShown((prev) => [...prev, ...extra, idle]);
    setConfirmState(allow ? 'allowed' : 'denied');
    setStatus('idle');
  };

  const confirmedToolIds = new Set(pool
    .filter((event) => event.type === 'user.tool_confirmation')
    .map((event) => event.source?.tool_use_id)
    .filter(Boolean));
  const latestRequiredIds = [...pool].reverse()
    .find((event) => event.type === 'session.status_idle' && event.source?.stop_reason?.type === 'requires_action')
    ?.source?.stop_reason?.event_ids;
  const pendingTool = apiMode === 'api'
    ? [...pool].reverse().find((event) =>
        (event.type === 'agent.tool_use' || event.type === 'agent.mcp_tool_use') &&
        (event.confirm || event.source?.evaluated_permission === 'ask') &&
        !confirmedToolIds.has(event.id) &&
        (!Array.isArray(latestRequiredIds) || latestRequiredIds.includes(event.id)))
    : (isConfirm ? CONFIRM_EVENTS.find((e) => e.confirm) : null);
  const renderConfirmCard = () => {
    if ((confirmState !== 'pending' && confirmState !== 'submitting') || !pendingTool) return null;
    const endpoint = 'POST /v1/sessions/:id/events';
    return (
      <div className="confirm-card">
        <div className="cc-head">
          <div className="cc-ic"><Icon name="alert" size={16} /></div>
          <div>
            <div className="cc-label">Requires action · tool confirmation</div>
            <div className="cc-title">The agent wants to run a tool that needs your approval.</div>
          </div>
        </div>
        <div className="cc-body">
          <div className="cc-tool"><span className="tn">{pendingTool.tool || 'tool'}</span><span style={{ color:'var(--faint)' }}>$</span>{pendingTool.cmd || JSON.stringify(pendingTool.source?.input || {})}</div>
        </div>
        <div className="cc-actions">
          <button className="btn btn-accent" disabled={readOnly || actionBusy}
            title={readOnly ? `Read-only API mode · ${endpoint}` : undefined}
            onClick={() => !readOnly && resolveConfirm('allow')}>
            <Icon name="checkCircle" size={14} />{actionBusy ? 'Submitting…' : 'Allow'}
          </button>
          <button className="btn btn-danger" disabled={readOnly || actionBusy}
            title={readOnly ? `Read-only API mode · ${endpoint}` : undefined}
            onClick={() => !readOnly && resolveConfirm('deny')}>
            <Icon name="x" size={14} />Deny
          </button>
          <span style={{ flex:1 }} />
          <span className="field-hint" style={{ alignSelf:'center' }}>
            {readOnly ? <>Disabled · <span className="mono">{endpoint}</span></> : <>Emits <span className="mono">user.tool_confirmation</span></>}
          </span>
        </div>
      </div>
    );
  };

  const sendMessage = async () => {
    const text = message.trim();
    if (!text || running || readOnly || actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    const event = { type:'user.message', content:[{ type:'text', text }] };
    try {
      messageIntentRef.current ||= OmaConsoleApi.createIdempotencyIntent();
      await OmaConsoleApi.sendSessionEvents(s.id, [event], { intent:messageIntentRef.current });
      messageIntentRef.current = null;
      setMessage('');
      setStatus('running');
      setWorking(true);
      if (onSessionStateChange) onSessionStateChange(s.id, { status:'running', requiresAction:false });
    } catch (error) {
      setActionError(error.message || 'Message submission failed.');
      if (error.status === 401 && onAuthExpired) onAuthExpired();
    } finally {
      setActionBusy(false);
    }
  };

  const runLifecycle = async (kind) => {
    if (lifecycleBusy) return;
    const action = kind === 'archive' ? onArchive : onDelete;
    if (!action) return;
    setLifecycleBusy(true);
    setLifecycleError(null);
    try {
      await action(s);
      if (kind === 'archive') setStatus('archived');
      setDialog(null);
    } catch (error) {
      setLifecycleError(error);
    } finally {
      setLifecycleBusy(false);
    }
  };

  const inspectorVisible = view !== 'files';

  const renderStreamHeader = () => (
    <>
      {!threecol && (
        <div className="toolbar" style={{ marginBottom:12 }}>
          <div className="tabs">
            {['transcript','debug','files'].map((t) => (
              <div key={t} className={'tab' + (tabFor === t ? ' active' : '')}
                onClick={() => setView(t)} style={{ textTransform:'capitalize' }}>
                {t}{t === 'files' && fileCount > 0 ? ` (${fileCount})` : ''}
              </div>
            ))}
          </div>
          {tabFor === 'debug' && (
            <div className="tabs">
              <div className={'tab' + (view === 'debug' ? ' active' : '')} onClick={() => setView('debug')}>Events</div>
              <div className={'tab' + (view === 'spans' ? ' active' : '')} onClick={() => setView('spans')}>Spans</div>
            </div>
          )}
          <span style={{ width:1, height:22, background:'var(--border)' }} />
          {eventSearchVisible && <Field icon="search" placeholder="Search events" value={query} onChange={setQuery} style={{ width:260, maxWidth:260 }} />}
          {eventSearchVisible && <span className="mono result-count">{resultCount} events</span>}
          <span className="grow" />
          <button className="btn btn-icon btn-ghost"><Icon name="copy" size={15} /></button>
          <button className="btn btn-icon btn-ghost"><Icon name="download" size={15} /></button>
        </div>
      )}
    </>
  );

  const WorkingRow = () => (
    <div className="ev working-row">
      <Role r="agent" />
      <span className="working"><i /><i /><i /></span>
      <span className="ev-text" style={{ color:'var(--faint)' }}>Agent is working…</span>
    </div>
  );

  const renderStream = () => {
    if (dataState === 'loading' || s.loadingEvents) return <SkeletonStream rows={6} />;
    if (dataState === 'error' || s.eventError) return <ErrorState resource="events" onRetry={() => {}} />;
    if (view === 'files') return <FilesPanel files={baseFiles} />;
    if (view === 'spans') return <SpansView spans={baseSpans} onPick={setSel} />;
    if (view === 'debug') return (
      <div>
        <div className="chips">
          {EVENT_TYPES.map((t) => {
            const on = filters.includes(t);
            return <div key={t} className={'chip' + (on ? ' on' : '')}
              onClick={() => setFilters(on ? filters.filter((x) => x !== t) : [...filters, t])}>
              <span className="x" />{t}</div>;
          })}
          {filters.length > 0 && <div className="chip" onClick={() => setFilters([])} style={{ color:'var(--faint)' }}>clear</div>}
          {query && <div className="chip" onClick={() => setQuery('')} style={{ color:'var(--faint)' }}>clear search</div>}
        </div>
        <div className="panel">
          {dbgEvents.map((e) => <EvRow key={e.id} e={e} mode="debug" sel={e.id === selId} onClick={() => setSel(e.id)} />)}
          {dbgEvents.length === 0 && <div className="empty">No events match the current filters.</div>}
          {working && running && WorkingRow()}
        </div>
        {renderConfirmCard()}
      </div>
    );
    // transcript
    return (
      <div>
        <div className="scrubber"><div className="fill" style={{ width: running ? '100%' : '54%' }} /><div className="hd" style={{ left: running ? 'calc(100% - 3px)' : '54%' }} /></div>
        <div className="panel">
          {txEvents.map((e) => <EvRow key={e.id} e={e} mode="transcript" sel={e.id === selId} onClick={() => setSel(e.id)} />)}
          {txEvents.length === 0 && <div className="empty">No transcript events match the current search.</div>}
          {working && running && WorkingRow()}
        </div>
        {renderConfirmCard()}
      </div>
    );
  };

  const renderRail = () => {
    const items = [
      ['transcript','Transcript','activity'],
      ['debug','Debug events','terminal'],
      ['spans','Spans · timing','zap'],
      ['files',`Files · output${fileCount > 0 ? ` (${fileCount})` : ''}`,'folder'],
    ];
    return (
      <div>
        <div className="rail">
          {items.map(([k, l, ic]) => (
            <div key={k} className={'rail-item' + (view === k ? ' active' : '')} onClick={() => setView(k)}>
              <Icon name={ic} size={15} />{l}
            </div>
          ))}
        </div>
        <div className="divider" style={{ margin:'12px 6px' }} />
        {view === 'debug' && <div className="chips" style={{ marginTop:0 }}>
          {EVENT_TYPES.map((t) => {
            const on = filters.includes(t);
            return <div key={t} className={'chip' + (on ? ' on' : '')}
              onClick={() => setFilters(on ? filters.filter((x) => x !== t) : [...filters, t])}>
              <span className="x" />{t}</div>;
          })}
        </div>}
        {eventSearchVisible && <Field icon="search" placeholder="Search events" value={query} onChange={setQuery} style={{ marginTop:8, maxWidth:'none' }} />}
      </div>
    );
  };

  return (
    <div className="main-scroll scroll fade-in">
      <Crumbs items={[{ label:'Sessions', onClick:() => go('sessions') }, { label:s.short }]} />
      <div className="sess-head">
        <div>
          <div className="sess-title">
            <h1>{s.title}</h1>
            {running ? <span className="badge st-running live"><i className="dot" />Live</span> : <St k={status} />}
            {needsAction && <NeedsAction />}
          </div>
          <div className="meta-row">
            <Pill icon="bot">{s.agent}</Pill>
            <span className="dotsep">·</span>
            <Pill icon="database">{s.env}</Pill>
            <span className="dotsep">·</span>
            <Pill icon="folder">{fileCount} files</Pill>
            <span className="dotsep">·</span>
            <span className="m" title="Session-level duration is not reported by the API. Per-request timing appears on model span events."><Icon name="clock" />{running ? 'running…' : s.dur}</span>
            <span className="m" title="Session-level usage is not reported by the API. Per-request tokens appear on span.model_request_end.model_usage."><Icon name="layers" />{s.tokens}</span>
            <span className="m mono" style={{ color:'var(--faint)' }}>{s.id}</span>
          </div>
        </div>
        <div style={{ display:'flex', gap:9 }}>
          <div className="menu-wrap">
            <button className="btn" onClick={() => setMenuOpen(!menuOpen)}>Actions<Icon name="chevDown" size={14} /></button>
            {menuOpen && (
              <>
                <div style={{ position:'fixed', inset:0, zIndex:40 }} onClick={() => setMenuOpen(false)} />
                <div className="menu">
                  <div className="menu-item" onClick={() => { setMenuOpen(false); }}><Icon name="copy" />Copy session ID</div>
                  <div className="menu-item" onClick={() => { setMenuOpen(false); }}><Icon name="download" />Export events (JSON)</div>
                  {!lifecycleReadOnly && <>
                    <div className="menu-sep" />
                    {status !== 'archived' && <div className="menu-item" onClick={() => { setMenuOpen(false); setLifecycleError(null); setDialog('archive'); }}><Icon name="archive" />Archive session</div>}
                    <div className="menu-item danger" onClick={() => { setMenuOpen(false); setLifecycleError(null); setDialog('delete'); }}><Icon name="x" />Delete session</div>
                  </>}
                </div>
              </>
            )}
          </div>
          {running
            ? <button className="btn btn-danger" disabled={readOnly || actionBusy} title={readOnly ? 'Connect a live workspace to send session events.' : undefined}
                onClick={() => !readOnly && interrupt()}><Icon name="stop" size={14} />Interrupt</button>
            : <button className="btn btn-accent" disabled={readOnly} title={readOnly ? 'Connect a live workspace to send session events.' : undefined}
                onClick={() => !readOnly && setView('transcript')}>
                <Icon name="sparkles" size={15} />Ask Claude</button>}
        </div>
      </div>

      {s.sessionError && (
        <div className="banner">
          <Icon name="alert" size={16} />
          <div>
            <div className="b-main">Session emitted <span className="mono">{s.sessionError.type}</span></div>
            <div className="b-sub">{s.sessionError.message}</div>
          </div>
        </div>
      )}

      {Array.isArray(s.warnings) && s.warnings.length > 0 && (
        <div className="inline-warn">
          <Icon name="alert" size={14} />
          <span>{s.warnings.join(' ')}</span>
        </div>
      )}

      {apiMode === 'api' && streamState !== 'connected' && streamState !== 'closed' && (
        <div className={streamState === 'failed' ? 'inline-warn' : 'inline-ok'} role="status">
          <Icon name={streamState === 'failed' ? 'alert' : 'refresh'} size={14} />
          <span>{streamState === 'reconnecting' ? 'Live events disconnected; reconnecting with replay…'
            : streamState === 'failed' ? 'Live events are unavailable. Persisted history is still shown.'
            : 'Connecting to live session events…'}</span>
        </div>
      )}

      {actionError && (
        <div className="inline-warn" role="alert">
          <Icon name="alert" size={14} /><span>{actionError}</span>
        </div>
      )}
      {s.refreshError && (
        <div className="inline-warn" role="alert">
          <Icon name="alert" size={14} /><span>Session finished, but files/history refresh failed: {s.refreshError.message}</span>
        </div>
      )}

      {dialog === 'archive' &&
        <ConfirmDialog icon="archive" title="Archive this session?"
          message={<>Archiving <b>{s.title}</b> hides it from the default list. Its events stay intact and it can be restored. </>}
          confirmLabel="Archive session" endpoint="POST /v1/sessions/:id/archive"
          onClose={() => setDialog(null)}
          onConfirm={() => runLifecycle('archive')} busy={lifecycleBusy} error={lifecycleError} />}
      {dialog === 'delete' &&
        <ConfirmDialog icon="x" danger title="Delete this session?"
          message={<>Deleting <b>{s.title}</b> permanently removes the session and its events. This cannot be undone.</>}
          confirmLabel="Delete session" endpoint="DELETE /v1/sessions/:id"
          onClose={() => setDialog(null)}
          onConfirm={() => runLifecycle('delete')} busy={lifecycleBusy} error={lifecycleError} />}

      {renderStreamHeader()}

      <div className={'detail-grid' + (threecol ? ' threecol' : '')}>
        {threecol && renderRail()}
        <div className={'stream' + (running ? ' live scroll' : '')} ref={streamRef}>{renderStream()}</div>
        {inspectorVisible && <Inspector e={sel} onClose={() => setSel(null)} />}
      </div>

      {view !== 'files' && (
        <div className={'composer' + (readOnly ? ' ro' : '')}>
          <Icon name="terminal" size={16} style={{ color:'var(--faint)' }} />
          <input id="session-message-composer" name="message" aria-label="Session message"
            placeholder={readOnly ? 'Connect a live workspace to send session events.' : running ? 'Streaming live — interrupt to send a message…' : 'Send a message to this session…'}
            value={message} onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); } }}
            disabled={running || readOnly || actionBusy} />
          {running
            ? <button className="btn btn-sm btn-danger" disabled={readOnly || actionBusy} title={readOnly ? 'POST /v1/sessions/:id/events' : undefined} onClick={() => !readOnly && interrupt()}><Icon name="stop" size={13} />{actionBusy ? 'Stopping…' : 'Interrupt'}</button>
            : <button className="btn btn-sm btn-primary" disabled={readOnly || actionBusy || !message.trim()} title={readOnly ? 'POST /v1/sessions/:id/events' : undefined} onClick={sendMessage}><Icon name="send" size={13} />{actionBusy ? 'Sending…' : 'Send'}</button>}
        </div>
      )}
    </div>
  );
}

window.SessionDetail = SessionDetail;
