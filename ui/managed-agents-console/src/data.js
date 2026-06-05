// data.js — mock data for the OMA Managed Agents console (plain JS → window)

window.AGENTS = [
  { id:'agent_01KLjw6BFUkSNuApePpqQnnN', short:'agent_…pqQnnN', name:'cwc-agent',
    model:'claude-opus-4-7', status:'active', created:'May 20', updated:'May 20', version:'v1',
    tools:8, system:'You help me navigate Code w/ Claude 2026 — sessions, schedule, venue, and where to find resources.',
    toolset:'agent_toolset_20260401', sessions:['Schedule','Ship your first Managed Agent','Day 1 keynote notes'] },
  { id:'agent_01H9k7Kd2aLpVrn8x', short:'agent_…7Kd2aL', name:'oma-span-probe-sonnet',
    model:'claude-sonnet-4-6', status:'active', created:'Jun 2', updated:'Jun 2', version:'v2',
    tools:6, system:'Probe agent for OMA model-request span pairing. Run bash, emit spans, then idle.',
    toolset:'agent_toolset_20260401', sessions:['OMA span bash probe sonnet'] },
  { id:'agent_01Q9xZb1mTg4Pk', short:'agent_…Q9xZb1', name:'oma-toolspan-probe-sonnet',
    model:'claude-sonnet-4-6', status:'active', created:'Jun 2', updated:'Jun 2', version:'v1',
    tools:6, system:'Probe agent for tool-span timing. Exercises tool_use / tool_result pairs.',
    toolset:'agent_toolset_20260401', sessions:['OMA real tool span probe sonnet'] },
  { id:'agent_01m4Tg0pQ9Lz', short:'agent_…m4Tg0p', name:'oma-tool-confirm-allow',
    model:'claude-sonnet-4-6', status:'archived', created:'May 29', updated:'May 29', version:'v1',
    tools:4, system:'Confirmation-flow probe (allow path).', toolset:'agent_toolset_20260401', sessions:[] },
];

window.SESSIONS = [
  { id:'sesn_01J3kQr8…5fMAqj', short:'sesn_…5fMAqj', title:'OMA real tool span probe sonnet',
    status:'running', agent:'oma-toolspan-probe-sonnet', env:'oma-toolspan-probe-sonnet-env',
    created:'Jun 2', updated:'Jun 2', dur:'18.4s', tokens:'31.2k / 1.1k', resources:2 },
  { id:'sesn_01TBKa9…TBKTMC', short:'sesn_…TBKTMC', title:'OMA span bash probe sonnet',
    status:'idle', agent:'oma-span-probe-sonnet', env:'oma-span-probe-sonnet-env',
    created:'Jun 2', updated:'Jun 2', dur:'12.4s', tokens:'18.2k / 640', resources:1 },
  { id:'sesn_01CucM8…CucMUa', short:'sesn_…CucMUa', title:'OMA span bash probe',
    status:'idle', agent:'oma-span-probe', env:'oma-span-probe-env',
    created:'Jun 2', updated:'Jun 2', dur:'9.1s', tokens:'11.0k / 410', resources:1 },
  { id:'sesn_01QB1k…QB11BH', short:'sesn_…QB11BH', title:'Clean build directory & re-export',
    status:'idle', agent:'oma-tool-confirm', env:'oma-tool-confirm-env', confirm:true, requiresAction:true,
    created:'May 29', updated:'May 29', dur:'4.2s', tokens:'5.4k / 120', resources:0 },
  { id:'sesn_017Ajs…7AjsFV', short:'sesn_…7AjsFV', title:'oma-tool-confirmation-deny',
    status:'idle', agent:'oma-tool-confirm-deny', env:'oma-tool-confirm-deny-env',
    created:'May 29', updated:'May 29', dur:'3.8s', tokens:'5.1k / 98', resources:0 },
  { id:'sesn_01ciQ8…ciQBoJ', short:'sesn_…ciQBoJ', title:'Schedule',
    status:'idle', agent:'cwc-agent', env:'cwc-env',
    created:'May 20', updated:'May 20', dur:'31.7s', tokens:'27.9k / 920', resources:3 },
  { id:'sesn_01WJxQr8…VcyvLi', short:'sesn_…VcyvLi', title:'Ship your first Managed Agent',
    status:'idle', agent:'cwc-agent', env:'cwc-env',
    created:'May 20', updated:'May 20', dur:'26.2s', tokens:'23.4k / 843', resources:2, focus:true },
  { id:'sesn_01Js2k…Js2Bjq', short:'sesn_…Js2Bjq', title:'Day 1 keynote notes',
    status:'idle', agent:'cwc-agent', env:'cwc-env',
    created:'May 20', updated:'May 20', dur:'14.9s', tokens:'12.8k / 470', resources:1 },
];

const J = (o) => JSON.stringify(o, null, 2);

// Events for the focused session (sesn_…VcyvLi). transcript:true → shows in Transcript.
window.EVENTS = [
  { id:'sevt_…a01', role:'user', type:'user.message', tag:'message', transcript:true, time:'0:00:08',
    text:'Just finished the 11am Ship your first Managed Agent workshop with the OMA team.',
    content:'Just finished the 11am Ship your first Managed Agent workshop with the OMA team. Logging it so the agent has context for the rest of the day.',
    raw:J({ type:'user.message', id:'sevt_…a01', content:[{type:'text',text:'Just finished the 11am…'}], processed_at:'2026-05-20T11:42:08Z' }) },
  { id:'sevt_…a02', role:'span', type:'span.model_request_start', tag:'model', time:'0:00:08',
    text:'model_request_start', startId:'sevt_…a02',
    raw:J({ type:'span.model_request_start', id:'sevt_…a02', processed_at:'2026-05-20T11:42:08.120Z' }) },
  { id:'sevt_…a03', role:'span', type:'span.model_request_end', tag:'312ms', time:'0:00:08', ok:true, tokens:'7.5k / 280',
    text:'model_request_end', dur:'312 ms', pairedStart:'sevt_…a02',
    usage:{ input:'7,520', output:'280', cacheRead:'4,096', cacheWrite:'0' },
    raw:J({ type:'span.model_request_end', id:'sevt_…a03', model_request_start_id:'sevt_…a02', is_error:false, model_usage:{ input_tokens:7520, output_tokens:280, cache_read_tokens:4096 }, processed_at:'2026-05-20T11:42:08.432Z' }) },
  { id:'sevt_…a04', role:'agent', type:'agent.message', tag:'message', transcript:true, time:'0:00:08', tokens:'7.5k / 280',
    text:'Got it — logged for context: · Workshop: Ship your first Managed Agent · Time: 11am',
    content:'Got it — logged for context:\n· Workshop: Ship your first Managed Agent\n· Time: 11am\n· Attendees: OMA team\nI\u2019ll keep this in mind for the rest of the day.',
    raw:J({ type:'agent.message', id:'sevt_…a04', content:[{type:'text',text:'Got it — logged…'}] }) },
  { id:'sevt_…a05', role:'user', type:'user.message', tag:'message', transcript:true, time:'0:00:14', focus:true,
    text:'I learned that agents are templates that define model and prompt configuration…',
    content:'I learned that agents are templates that define model and prompt configuration, and environments are templates that define container configuration.',
    raw:J({ type:'user.message', id:'sevt_…7gtZWu7', content:[{type:'text',text:'I learned that agents are templates…'}], processed_at:'2026-05-20T11:42:14Z' }) },
  { id:'sevt_…a06', role:'tool', type:'agent.tool_use', tag:'bash', time:'0:00:09',
    text:'agent.tool_use · bash · append to notes.md',
    content:'bash: echo "- Agents = templates (model + prompt)" >> notes.md',
    raw:J({ type:'agent.tool_use', id:'sevt_…a06', name:'bash', input:{ command:'echo "- Agents = templates" >> notes.md' } }) },
  { id:'sevt_…a07', role:'tool', type:'agent.tool_result', tag:'exit 0', time:'0:00:11',
    text:'agent.tool_result · exit 0',
    content:'exit code 0 · stdout: (empty)',
    raw:J({ type:'agent.tool_result', id:'sevt_…a07', tool_use_id:'sevt_…a06', is_error:false, content:'' }) },
  { id:'sevt_…a08', role:'span', type:'span.model_request_start', tag:'model', time:'0:00:13', open:true,
    text:'model_request_start · (open — no end)', startId:'sevt_…a08',
    raw:J({ type:'span.model_request_start', id:'sevt_…a08', processed_at:'2026-05-20T11:42:13.900Z' }) },
  { id:'sevt_…a09', role:'agent', type:'agent.message', tag:'message', transcript:true, time:'0:00:14', tokens:'7.8k / 233',
    text:'Noted — adding to your running notes: · Agents = templates that define model + prompt…',
    content:'Noted — adding to your running notes:\n· Agents = templates that define model + prompt\n· Environments = templates that define container config',
    raw:J({ type:'agent.message', id:'sevt_…a09', content:[{type:'text',text:'Noted — adding…'}] }) },
  { id:'sevt_…a10', role:'user', type:'user.message', tag:'message', transcript:true, time:'0:00:25',
    text:'Also learned that I can add MCP integrations and define client-side tools.',
    content:'Also learned that I can add MCP integrations and define client-side tools on the agent.',
    raw:J({ type:'user.message', id:'sevt_…a10', content:[{type:'text',text:'Also learned…'}] }) },
  { id:'sevt_…a11', role:'agent', type:'agent.message', tag:'message', transcript:true, time:'0:00:25', tokens:'8.1k / 330',
    text:'Added to your notes: · Agents = templates defining model + prompt · MCP + client tools…',
    content:'Added to your notes:\n· Agents = templates defining model + prompt\n· MCP integrations + client-side tools can be attached',
    raw:J({ type:'agent.message', id:'sevt_…a11', content:[{type:'text',text:'Added to your notes…'}] }) },
  { id:'sevt_…a12', role:'sys', type:'session.status_idle', tag:'requires_action', time:'0:00:25',
    text:'session.status_idle · requires_action: none',
    content:'Session went idle. requires_action: false.',
    raw:J({ type:'session.status_idle', id:'sevt_…a12', requires_action:false }) },
];

// ── live stream for the RUNNING session (sesn_…5fMAqj) ──
// `gap` = ms to wait before this event appears (streamed in order).
window.RUN_EVENTS = [
  { id:'sevt_…r01', role:'user', type:'user.message', tag:'message', transcript:true, time:'0:00:00', gap:0,
    text:'Run the span probe: list the workspace, read config.json, then summarise findings.',
    content:'Run the span probe: list the workspace, read config.json, then summarise findings.',
    raw:J({ type:'user.message', id:'sevt_…r01', content:[{type:'text',text:'Run the span probe…'}], processed_at:'2026-06-05T09:14:00Z' }) },
  { id:'sevt_…r02', role:'span', type:'span.model_request_start', tag:'model', time:'0:00:00', gap:900, startId:'sevt_…r02',
    text:'model_request_start',
    raw:J({ type:'span.model_request_start', id:'sevt_…r02', processed_at:'2026-06-05T09:14:00.140Z' }) },
  { id:'sevt_…r03', role:'span', type:'span.model_request_end', tag:'287ms', time:'0:00:01', gap:1500, ok:true, tokens:'6.2k / 142',
    text:'model_request_end', dur:'287 ms', pairedStart:'sevt_…r02',
    usage:{ input:'6,210', output:'142', cacheRead:'2,048', cacheWrite:'0' },
    raw:J({ type:'span.model_request_end', id:'sevt_…r03', model_request_start_id:'sevt_…r02', is_error:false, model_usage:{ input_tokens:6210, output_tokens:142, cache_read_tokens:2048 }, processed_at:'2026-06-05T09:14:00.427Z' }) },
  { id:'sevt_…r04', role:'agent', type:'agent.message', tag:'message', transcript:true, time:'0:00:01', gap:1100, tokens:'6.2k / 142',
    text:'On it — I\u2019ll list the workspace first, then read the config.',
    content:'On it — I\u2019ll list the workspace first, then read the config.',
    raw:J({ type:'agent.message', id:'sevt_…r04', content:[{type:'text',text:'On it…'}] }) },
  { id:'sevt_…r05', role:'tool', type:'agent.tool_use', tag:'bash', transcript:true, time:'0:00:02', gap:1300,
    text:'agent.tool_use · bash · ls -la',
    content:'bash: ls -la', raw:J({ type:'agent.tool_use', id:'sevt_…r05', name:'bash', input:{ command:'ls -la' } }) },
  { id:'sevt_…r06', role:'tool', type:'agent.tool_result', tag:'exit 0', transcript:true, time:'0:00:03', gap:1700,
    text:'agent.tool_result · exit 0 · 7 entries',
    content:'exit 0 · config.json, src/, README.md, notes.md …', raw:J({ type:'agent.tool_result', id:'sevt_…r06', tool_use_id:'sevt_…r05', is_error:false }) },
  { id:'sevt_…r07', role:'span', type:'span.model_request_start', tag:'model', time:'0:00:03', gap:1000, startId:'sevt_…r07',
    text:'model_request_start', raw:J({ type:'span.model_request_start', id:'sevt_…r07', processed_at:'2026-06-05T09:14:03.010Z' }) },
  { id:'sevt_…r08', role:'tool', type:'agent.tool_use', tag:'bash', transcript:true, time:'0:00:04', gap:1400,
    text:'agent.tool_use · bash · cat config.json',
    content:'bash: cat config.json', raw:J({ type:'agent.tool_use', id:'sevt_…r08', name:'bash', input:{ command:'cat config.json' } }) },
  { id:'sevt_…r09', role:'tool', type:'agent.tool_result', tag:'exit 0', transcript:true, time:'0:00:05', gap:1800,
    text:'agent.tool_result · exit 0 · 1.2 KB',
    content:'exit 0 · { "model": "claude-sonnet-4-6", "max_steps": 12 }', raw:J({ type:'agent.tool_result', id:'sevt_…r09', tool_use_id:'sevt_…r08', is_error:false }) },
  { id:'sevt_…r10', role:'agent', type:'agent.message', tag:'message', transcript:true, time:'0:00:06', gap:2000, tokens:'9.4k / 318',
    text:'Summary: workspace has 7 entries; config targets sonnet-4-6 with a 12-step cap. Probe complete.',
    content:'Summary:\n· Workspace: 7 entries (config.json, src/, README.md, notes.md…)\n· Config targets claude-sonnet-4-6, max_steps 12\nProbe complete.',
    raw:J({ type:'agent.message', id:'sevt_…r10', content:[{type:'text',text:'Summary…'}] }) },
  { id:'sevt_…r11', role:'sys', type:'session.status_idle', tag:'requires_action', time:'0:00:06', gap:1200,
    text:'session.status_idle · requires_action: none',
    content:'Session went idle. requires_action: false.', raw:J({ type:'session.status_idle', id:'sevt_…r11', requires_action:false }) },
];

// transcript for a session that pauses on a tool confirmation (requires_action)
window.CONFIRM_EVENTS = [
  { id:'sevt_…c01', role:'user', type:'user.message', tag:'message', transcript:true, time:'0:00:00',
    text:'Clean the build directory, then re-run the export script.',
    content:'Clean the build directory, then re-run the export script.',
    raw:J({ type:'user.message', id:'sevt_…c01', content:[{type:'text',text:'Clean the build directory…'}] }) },
  { id:'sevt_…c02', role:'agent', type:'agent.message', tag:'message', transcript:true, time:'0:00:01', tokens:'4.1k / 96',
    text:'I\u2019ll remove build/ and then re-run export.sh. The delete needs your approval first.',
    content:'I\u2019ll remove build/ and then re-run export.sh. The delete needs your approval first.',
    raw:J({ type:'agent.message', id:'sevt_…c02', content:[{type:'text',text:'I\u2019ll remove build/…'}] }) },
  { id:'sevt_…c03', role:'tool', type:'agent.tool_use', tag:'bash', transcript:true, time:'0:00:01', confirm:true,
    text:'agent.tool_use · bash · rm -rf build/',
    content:'bash: rm -rf build/', tool:'bash', cmd:'rm -rf build/',
    raw:J({ type:'agent.tool_use', id:'sevt_…c03', name:'bash', input:{ command:'rm -rf build/' }, requires_confirmation:true }) },
  { id:'sevt_…c04', role:'sys', type:'session.status_idle', tag:'requires_action', time:'0:00:01',
    text:'session.status_idle · requires_action: tool_confirmation',
    content:'Waiting for operator approval on a tool call. requires_action: true.',
    raw:J({ type:'session.status_idle', id:'sevt_…c04', requires_action:true, action:{ type:'tool_confirmation', tool_use_id:'sevt_…c03' } }) },
];

// span waterfall (positions are % of total duration)
window.SPANS = [
  { role:'span', kind:'model', label:'model_request', left:4, width:22, info:'312ms · 7.5k/280' },
  { role:'tool', kind:'tool',  label:'tool_use · bash', left:27, width:13, info:'queued' },
  { role:'tool', kind:'tool',  label:'tool_result', left:41, width:8, info:'exit 0' },
  { role:'span', kind:'model', label:'model_request', left:52, width:27, info:'498ms · 7.8k/233' },
  { role:'span', kind:'open',  label:'model_request', left:80, width:16, info:'open — no end' },
];

window.FILES = [
  { name:'report-final.md', ext:'md', type:'text/markdown', size:'2.4 KB', created:'Jun 2', dl:true },
  { name:'summary.txt', ext:'txt', type:'text/plain', size:'812 B', created:'Jun 2', dl:true },
  { name:'data-export.csv', ext:'csv', type:'text/csv', size:'41 KB', created:'Jun 2', dl:true },
  { name:'chart.png', ext:'png', type:'image/png', size:'188 KB', created:'Jun 2', dl:true },
  { name:'input-corpus.zip', ext:'zip', type:'application/zip', size:'1.2 MB', created:'May 29', dl:false },
];

window.EVENT_TYPES = ['message','thinking','tool_use','tool_result','custom_tool','model_request','status','error'];

window.ENVIRONMENTS = [
  { id:'cwc-env', label:'cwc-env', image:'docker-local · python-3.12' },
  { id:'oma-span-probe-sonnet-env', label:'oma-span-probe-sonnet-env', image:'docker-local · node-22' },
  { id:'oma-toolspan-probe-sonnet-env', label:'oma-toolspan-probe-sonnet-env', image:'docker-local · node-22' },
  { id:'oma-span-probe-env', label:'oma-span-probe-env', image:'docker-local · node-22' },
];

window.MODELS = ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'];
window.TOOL_OPTIONS = ['bash', 'text_editor', 'web_search', 'computer_use'];
