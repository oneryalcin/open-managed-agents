// docs.jsx — Markdown-backed, public in-console documentation. → window
// Content lives in docs/*.md so the reader, copy action, and raw source share
// one OMA-authored page. The small renderer intentionally supports only the
// safe Markdown subset used by those local pages; it never renders raw HTML.
const { useEffect: useEffectDocs, useMemo: useMemoDocs, useState: useStateDocs } = React;

const DOC_NAV = [
  { label:'First steps', pages:[['overview', 'Overview'], ['quickstart', 'Quickstart'], ['console', 'Prototype in Console'], ['migration', 'Migration']] },
  { label:'Define your agent', pages:[['agents', 'Agent setup'], ['tools', 'Tools'], ['permissions', 'Permission policies'], ['skills', 'Skills'], ['integrations', 'MCP connector']] },
  { label:'Configure agent environment', pages:[['environments', 'Environments'], ['sandbox-reference', 'Cloud sandbox reference'], ['self-hosted-sandboxes', 'Self-hosted sandboxes'], ['sandbox-security', 'Sandbox security']] },
  { label:'Delegate work to your agent', pages:[['sessions', 'Start a session'], ['session-operations', 'Session operations'], ['events', 'Session event stream'], ['files', 'Files'], ['vaults', 'Vaults']] },
  { label:'Beyond v1', pages:[['github', 'GitHub'], ['outcomes', 'Define outcomes'], ['memory', 'Memory'], ['dreams', 'Dreams'], ['multiagent', 'Multi-agent orchestration'], ['scheduled-deployments', 'Scheduled deployments'], ['webhooks', 'Webhooks']] },
  { label:'Reference', pages:[['reference', 'API reference and compatibility']] },
];

const DOC_PAGES = Object.fromEntries(DOC_NAV.flatMap((section) => section.pages.map(([id, label]) => [id, {
  label,
  crumb:section.label,
  path:`docs/${id}.md`,
}])));

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function openDocumentationTarget(target) {
  if (target.startsWith('/') || /^https:\/\//.test(target)) window.open(target, target.startsWith('https://') ? '_blank' : '_self', 'noopener,noreferrer');
}

function InlineMarkdown({ text, onNavigate }) {
  const parts = text.split(/(`[^`]+`|\[[^\]]+\]\([^\s)]+\)|\*\*[^*]+\*\*)/g);
  return <>{parts.map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    const link = /^\[([^\]]+)\]\(([^\s)]+)\)$/.exec(part);
    if (link) {
      const [, label, target] = link;
      if (target.startsWith('#docs=')) return <button type="button" key={index} className="docs-inline-link" onClick={() => onNavigate(target.slice(6))}>{label}</button>;
      if (target.startsWith('/') || /^https:\/\//.test(target)) return <button type="button" key={index} className="docs-inline-link" onClick={() => openDocumentationTarget(target)}>{label}</button>;
      return <React.Fragment key={index}>{label}</React.Fragment>;
    }
    return <React.Fragment key={index}>{part}</React.Fragment>;
  })}</>;
}

function MarkdownDocument({ markdown, onNavigate }) {
  const rendered = useMemoDocs(() => {
    const lines = markdown.replace(/\r\n/g, '\n').split('\n');
    const nodes = [];
    const headings = [];
    let index = 0;

    const paragraph = () => {
      const words = [];
      while (index < lines.length && lines[index].trim() && !/^(#{1,3}\s|```|> \[!|[-*] |\d+\. |\|)/.test(lines[index])) {
        words.push(lines[index].trim());
        index += 1;
      }
      if (words.length) nodes.push(<p key={`p-${index}`}><InlineMarkdown text={words.join(' ')} onNavigate={onNavigate} /></p>);
    };

    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) { index += 1; continue; }
      const heading = /^(#{1,3})\s+(.+)$/.exec(line);
      if (heading) {
        const [, marks, text] = heading;
        const id = slug(text);
        if (marks.length === 1) nodes.push(<h1 key={`h1-${id}`}>{text}</h1>);
        else if (marks.length === 2) {
          headings.push([id, text]);
          nodes.push(<h2 id={id} key={`h2-${id}`}>{text}</h2>);
        } else {
          headings.push([id, text]);
          nodes.push(<h3 id={id} key={`h3-${id}`}>{text}</h3>);
        }
        index += 1;
        continue;
      }
      const callout = /^> \[!(NOTE|WARNING)\]\s*(.*)$/.exec(line);
      if (callout) {
        const [, tone, text] = callout;
        nodes.push(<aside key={`callout-${index}`} className={'docs-callout ' + (tone === 'WARNING' ? 'warn' : 'info')}><Icon name={tone === 'WARNING' ? 'alert' : 'info'} size={16} /><div><InlineMarkdown text={text} onNavigate={onNavigate} /></div></aside>);
        index += 1;
        continue;
      }
      if (line.startsWith('```')) {
        const body = [];
        index += 1;
        while (index < lines.length && !lines[index].startsWith('```')) { body.push(lines[index]); index += 1; }
        if (index < lines.length) index += 1;
        nodes.push(<pre className="docs-code" key={`code-${index}`}><code>{body.join('\n')}</code></pre>);
        continue;
      }
      if (/^[-*] /.test(line) || /^\d+\. /.test(line)) {
        const ordered = /^\d+\. /.test(line);
        const items = [];
        while (index < lines.length && (ordered ? /^\d+\. /.test(lines[index]) : /^[-*] /.test(lines[index]))) {
          items.push(lines[index].replace(ordered ? /^\d+\. / : /^[-*] /, ''));
          index += 1;
        }
        const List = ordered ? 'ol' : 'ul';
        nodes.push(<List className={ordered ? 'docs-steps compact' : 'docs-list'} key={`list-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}><InlineMarkdown text={item} onNavigate={onNavigate} /></li>)}</List>);
        continue;
      }
      if (line.startsWith('|') && index + 1 < lines.length && /^\|?\s*:?-{3,}/.test(lines[index + 1])) {
        const header = line.split('|').slice(1, -1).map((cell) => cell.trim());
        index += 2;
        const rows = [];
        while (index < lines.length && lines[index].startsWith('|')) { rows.push(lines[index].split('|').slice(1, -1).map((cell) => cell.trim())); index += 1; }
        nodes.push(<div className="docs-table-wrap" key={`table-${index}`}><table className="docs-table"><thead><tr>{header.map((cell) => <th key={cell}>{cell}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}><InlineMarkdown text={cell} onNavigate={onNavigate} /></td>)}</tr>)}</tbody></table></div>);
        continue;
      }
      paragraph();
    }
    return { nodes, headings };
  }, [markdown, onNavigate]);
  return <>{rendered.nodes}</>;
}

function markdownHeadings(markdown) {
  return markdown.match(/^#{2,3}\s+.+$/gm)?.map((line) => {
    const text = line.replace(/^#{2,3}\s+/, '');
    return [slug(text), text, line.startsWith('###')];
  }) || [];
}

function DocsView({ page = 'overview', onNavigate, goConsole }) {
  const activePage = DOC_PAGES[page] ? page : 'overview';
  const current = DOC_PAGES[activePage];
  const [markdown, setMarkdown] = useStateDocs('');
  const [state, setState] = useStateDocs('loading');
  const [copied, setCopied] = useStateDocs(false);
  const headings = markdownHeadings(markdown);

  useEffectDocs(() => {
    const controller = new AbortController();
    setState('loading');
    setCopied(false);
    fetch(current.path, { signal:controller.signal })
      .then((response) => response.ok ? response.text() : Promise.reject(new Error(`Documentation unavailable (${response.status})`)))
      .then((text) => { setMarkdown(text); setState('loaded'); })
      .catch((error) => { if (error.name !== 'AbortError') { setMarkdown(''); setState('error'); } });
    return () => controller.abort();
  }, [current.path]);

  const copyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const openMarkdown = () => window.open(new URL(current.path, window.location.href).toString(), '_blank', 'noopener,noreferrer');
  const go = (next) => onNavigate(DOC_PAGES[next] ? next : 'overview');

  return <div className="docs-shell">
    <nav className="docs-nav scroll" aria-label="Documentation navigation">
      <button type="button" className="docs-nav-brand" onClick={() => goConsole('start')}><span className="brand-mark">O</span><span>OMA Documentation<small>Alpha guide</small></span></button>
      {DOC_NAV.map((section) => <div className="docs-nav-group" key={section.label}><div className="docs-nav-label">{section.label}</div>{section.pages.map(([id, label]) => <button key={id} className={'docs-nav-link' + (id === activePage ? ' active' : '')} onClick={() => go(id)}>{label}</button>)}</div>)}
      <div className="docs-nav-footer"><a className="docs-nav-api" href="/docs/"><Icon name="terminal" size={15} />OpenAPI reference</a><button type="button" className="docs-nav-console" onClick={() => goConsole('start')}><Icon name="arrowRight" size={15} />Open console</button></div>
    </nav>
    <article className="docs-article scroll">
      <div className="docs-crumbs">Documentation <span>/</span> {current.crumb}</div>
      <div className="docs-page-actions"><button type="button" className="btn" onClick={copyMarkdown} disabled={state !== 'loaded'}><Icon name="copy" size={15} />{copied ? 'Copied Markdown' : 'Copy as Markdown'}</button><button type="button" className="btn" onClick={openMarkdown}><Icon name="arrowRight" size={15} />Open Markdown</button></div>
      {state === 'loading' && <div className="docs-loading" aria-busy="true">Loading documentation…</div>}
      {state === 'error' && <div className="docs-loading error"><Icon name="alert" size={16} />The local Markdown source could not be loaded.</div>}
      {state === 'loaded' && <MarkdownDocument markdown={markdown} onNavigate={go} />}
    </article>
    <aside className="docs-toc" aria-label="On this page"><strong>On this page</strong>{headings.map(([id, label, nested]) => <button key={id} className={nested ? 'nested' : ''} onClick={() => document.getElementById(id)?.scrollIntoView({ behavior:'smooth', block:'start' })}>{label}</button>)}</aside>
  </div>;
}

window.DocsView = DocsView;
