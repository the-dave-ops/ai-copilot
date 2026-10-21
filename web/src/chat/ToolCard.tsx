import type { UIMessage } from 'ai';
import { useState } from 'react';
import type { ApiToolSummary } from './ChatPage';

type ToolPart =
  | Extract<UIMessage['parts'][number], { type: `tool-${string}` }>
  | Extract<UIMessage['parts'][number], { type: 'dynamic-tool' }>;

interface Props {
  part: ToolPart;
  toolMeta?: ApiToolSummary;
  onQuickPrompt?: (prompt: string) => void;
  dashboardBaseUrl?: string;
}

function toolName(part: ToolPart): string {
  return part.type === 'dynamic-tool' ? part.toolName : part.type.slice('tool-'.length);
}

function sectionDashboardUrl(
  base: string | undefined,
  name: string,
  input: Record<string, unknown>,
): { label: string; url: string } | null {
  if (!base) return null;
  const proj = input.projectIdentifier ?? input.name ?? input.projectName;
  const ver = input.version;
  if (name === 'get_release_details' && proj && ver) {
    return {
      label: 'Open Release in Dashboard ↗',
      url: `${base}/getapp/projects/${encodeURIComponent(String(proj))}/releases/${encodeURIComponent(String(ver))}`,
    };
  }
  if ((name === 'get_project_releases' || name === 'create_release') && proj) {
    return {
      label: 'Open Releases in Dashboard ↗',
      url: `${base}/getapp/projects/${encodeURIComponent(String(proj))}/releases`,
    };
  }
  if ((name === 'get_project' || name === 'create_project' || name === 'edit_project') && proj) {
    return {
      label: 'Open Project in Dashboard ↗',
      url: `${base}/getapp/projects/${encodeURIComponent(String(proj))}/overview`,
    };
  }
  if (name.includes('pending')) {
    return { label: 'Open Pending Versions ↗', url: `${base}/getapp/pending-versions` };
  }
  if (name.includes('offering')) {
    return { label: 'Open Catalog ↗', url: `${base}/getapp/catalog/projects` };
  }
  if (name.includes('project')) {
    return { label: 'Open Projects in Dashboard ↗', url: `${base}/getapp/projects` };
  }
  if (name.includes('device')) {
    return { label: 'Open Devices in Dashboard ↗', url: `${base}/getapp/devices` };
  }
  if (name.includes('group')) {
    return { label: 'Open Groups in Dashboard ↗', url: `${base}/getapp/groups/management` };
  }
  if (name.includes('map')) {
    return { label: 'Open Maps in Dashboard ↗', url: `${base}/getmap/maps` };
  }
  return null;
}

function rowDashboardUrl(
  base: string | undefined,
  name: string,
  row: Record<string, unknown>,
  input: Record<string, unknown>,
): string | null {
  if (!base) return null;
  if (name.includes('pending')) {
    return `${base}/getapp/pending-versions`;
  }
  if (name.includes('release')) {
    const proj = row.projectName ?? input.projectIdentifier ?? row.projectId;
    const ver = row.version;
    if (proj && ver) {
      return `${base}/getapp/projects/${encodeURIComponent(String(proj))}/releases/${encodeURIComponent(String(ver))}`;
    }
  }
  if (name.includes('project')) {
    const slug = row.name ?? row.id;
    if (slug) {
      return `${base}/getapp/projects/${encodeURIComponent(String(slug))}/overview`;
    }
  }
  if (name.includes('map')) {
    const cid = row.catalogId ?? row.id;
    return cid
      ? `${base}/getmap/maps/${encodeURIComponent(String(cid))}`
      : `${base}/getmap/maps`;
  }
  if (name.includes('device')) {
    return `${base}/getapp/devices`;
  }
  if (name.includes('group')) {
    return `${base}/getapp/groups/management`;
  }
  return null;
}

const STATUS_TONE: Record<string, string> = {
  released: 'ok',
  approved: 'ok',
  active: 'ok',
  online: 'ok',
  uploaded: 'ok',
  draft: 'wait',
  in_review: 'wait',
  pending: 'wait',
  archived: 'err',
  error: 'err',
  rejected: 'err',
};

const PAGE_SIZE = 12;

function formatCellValue(col: string, val: unknown, onCopy: (text: string) => void) {
  if (val === null || val === undefined || val === '') return <span className="muted">—</span>;

  if (col === 'status' && typeof val === 'string') {
    const tone = STATUS_TONE[val.toLowerCase()] ?? 'neutral';
    return <span className={`badge ${tone}`}>{val}</span>;
  }

  if (
    (col === 'updatedAt' || col === 'createdAt' || col === 'lastConnectionDate') &&
    typeof val === 'string'
  ) {
    const d = new Date(val);
    if (!Number.isNaN(d.getTime())) {
      return (
        <span className="muted">
          {d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}{' '}
          {d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      );
    }
  }

  if ((col === 'size' || col === 'availableStorage') && typeof val === 'number') {
    const mb =
      val > 1024 * 1024 ? `${(val / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(val / 1024)} KB`;
    return <span>{mb}</span>;
  }

  if (
    (col === 'id' || col === 'name' || col === 'catalogId') &&
    (typeof val === 'string' || typeof val === 'number')
  ) {
    const str = String(val);
    return (
      <button
        type="button"
        className="copy-pill"
        title="Click to copy"
        onClick={() => onCopy(str)}
      >
        {str}
      </button>
    );
  }

  if (typeof val === 'object') return <code>{JSON.stringify(val)}</code>;
  return <span>{String(val)}</span>;
}

function downloadCsv(filename: string, cols: string[], rows: Record<string, unknown>[]) {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  const csv = [cols.map(esc).join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join(
    '\n',
  );
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function ToolCard({
  part,
  toolMeta,
  onQuickPrompt,
  dashboardBaseUrl,
}: Props) {
  const [showRaw, setShowRaw] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(0);
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const name = toolName(part);
  const toolInput =
    typeof part.input === 'object' && part.input !== null
      ? (part.input as Record<string, unknown>)
      : {};
  const sectionLink = sectionDashboardUrl(dashboardBaseUrl, name, toolInput);

  const handleCopy = (text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopiedText(text);
    setTimeout(() => setCopiedText((c) => (c === text ? null : c)), 1400);
  };

  const handleSort = (col: string) => {
    if (sortCol === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
    setPage(0);
  };

  const summary =
    part.state === 'output-available'
      ? JSON.stringify(part.output, null, 2).slice(0, 4000)
      : part.state === 'output-error' || part.state === 'output-denied'
        ? String(part.errorText ?? 'denied')
        : JSON.stringify(part.input ?? {}, null, 2).slice(0, 4000);

  const badge =
    part.state === 'output-available' ? (
      <span className="badge ok">done</span>
    ) : part.state === 'output-error' || part.state === 'output-denied' ? (
      <span className="badge err">{part.state === 'output-denied' ? 'denied' : 'error'}</span>
    ) : part.state === 'approval-requested' || part.state === 'approval-responded' ? (
      <span className="badge wait">approval</span>
    ) : (
      <span className="badge wait">running…</span>
    );

  const extractRows = (data: unknown): Record<string, unknown>[] | null => {
    const unwrapped =
      typeof data === 'object' && data !== null && 'data' in data
        ? (data as { data?: unknown }).data
        : data;
    if (Array.isArray(unwrapped)) {
      return unwrapped.filter((r) => typeof r === 'object' && r !== null) as Record<
        string,
        unknown
      >[];
    }
    if (typeof unwrapped === 'object' && unwrapped !== null) {
      const obj = unwrapped as Record<string, unknown>;
      // Support key-value maps like Hebcal Zmanim `times: { alotHaShachar: "...", ... }`
      if (
        typeof obj.times === 'object' &&
        obj.times !== null &&
        !Array.isArray(obj.times) &&
        Object.keys(obj.times as Record<string, unknown>).length > 0
      ) {
        const locTitle =
          typeof obj.location === 'object' && obj.location !== null
            ? String((obj.location as Record<string, unknown>).title ?? '')
            : '';
        return Object.entries(obj.times as Record<string, unknown>).map(([k, v]) => ({
          halachicTime: k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()),
          time: String(v),
          ...(locTitle ? { location: locTitle } : {}),
        }));
      }
      for (const key of ['items', 'projects', 'data', 'releases', 'devices', 'groups', 'maps']) {
        const candidate = obj[key];
        if (Array.isArray(candidate)) {
          return candidate.filter((r) => typeof r === 'object' && r !== null) as Record<
            string,
            unknown
          >[];
        }
      }
      for (const val of Object.values(obj)) {
        if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object' && val[0] !== null) {
          return val as Record<string, unknown>[];
        }
      }
    }
    return null;
  };

  const renderRichTable = (data: unknown) => {
    const allRows = extractRows(data);
    if (!allRows || allRows.length === 0) return null;

    const q = filterText.trim().toLowerCase();
    const filtered = q
      ? allRows.filter((r) => JSON.stringify(r).toLowerCase().includes(q))
      : allRows;

    const sorted = sortCol
      ? [...filtered].sort((a, b) => {
          const av = a[sortCol];
          const bv = b[sortCol];
          if (typeof av === 'number' && typeof bv === 'number') {
            return sortDir === 'asc' ? av - bv : bv - av;
          }
          const as = String(av ?? '').toLowerCase();
          const bs = String(bv ?? '').toLowerCase();
          return sortDir === 'asc' ? as.localeCompare(bs) : bs.localeCompare(as);
        })
      : filtered;

    const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
    const safePage = Math.min(page, totalPages - 1);
    const pageRows = sorted.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

    const preferredCols = [
      'id',
      'name',
      'projectName',
      'version',
      'status',
      'projectType',
      'description',
      'OS',
      'availableStorage',
      'updatedAt',
    ];
    const allKeys = Array.from(new Set(allRows.slice(0, 10).flatMap((r) => Object.keys(r))));
    const cols = [
      ...preferredCols.filter((c) => allKeys.includes(c)),
      ...allKeys.filter((c) => !preferredCols.includes(c) && typeof allRows[0]?.[c] !== 'object'),
    ].slice(0, 5);

    if (cols.length === 0) return null;

    const isProjectTable = name.includes('project') && !name.includes('release');
    const isReleaseTable = name.includes('release');
    const isDeviceTable = name.includes('device');

    return (
      <div className="rich-table-wrap">
        <div className="table-filter-bar">
          <input
            value={filterText}
            onChange={(e) => {
              setFilterText(e.target.value);
              setPage(0);
            }}
            placeholder={`Search ${allRows.length} items…`}
          />
          <div className="table-bar-right">
            <span className="muted">
              {sorted.length === 0
                ? '0 results'
                : `${safePage * PAGE_SIZE + 1}–${Math.min((safePage + 1) * PAGE_SIZE, sorted.length)} of ${sorted.length}`}
            </span>
            {totalPages > 1 && (
              <div className="pager">
                <button
                  type="button"
                  disabled={safePage === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  ‹ Prev
                </button>
                <button
                  type="button"
                  disabled={safePage >= totalPages - 1}
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                >
                  Next ›
                </button>
              </div>
            )}
            <button
              type="button"
              className="csv-btn"
              onClick={() => downloadCsv(name, cols, sorted)}
              title="Export table to CSV"
            >
              ↓ CSV
            </button>
          </div>
        </div>
        <table className="rich-table">
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c} onClick={() => handleSort(c)} className="sortable-th">
                  <span>{c}</span>
                  {sortCol === c && <span className="sort-arrow">{sortDir === 'asc' ? ' ▲' : ' ▼'}</span>}
                </th>
              ))}
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row, idx) => {
              const slug = String(row.name ?? row.id ?? '');
              const ver = String(row.version ?? '');
              const rowLink = rowDashboardUrl(dashboardBaseUrl, name, row, toolInput);
              return (
                <tr key={idx}>
                  {cols.map((c) => (
                    <td key={c}>{formatCellValue(c, row[c], handleCopy)}</td>
                  ))}
                  <td className="row-actions">
                    {onQuickPrompt && isProjectTable && slug && (
                      <button
                        type="button"
                        className="row-action-btn"
                        onClick={() => onQuickPrompt(`Show releases for project ${slug}`)}
                      >
                        Releases →
                      </button>
                    )}
                    {onQuickPrompt && isReleaseTable && ver && (
                      <button
                        type="button"
                        className="row-action-btn"
                        onClick={() =>
                          onQuickPrompt(
                            `Get release details for version ${ver}${row.projectName ? ` of project ${String(row.projectName)}` : ''}`,
                          )
                        }
                      >
                        Details →
                      </button>
                    )}
                    {onQuickPrompt && isDeviceTable && slug && (
                      <button
                        type="button"
                        className="row-action-btn"
                        onClick={() => onQuickPrompt(`Get details for device ${slug}`)}
                      >
                        Inspect →
                      </button>
                    )}
                    {rowLink && (
                      <a
                        href={rowLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="row-dash-link"
                        title="Open directly in GetApp Dashboard"
                      >
                        Dashboard ↗
                      </a>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  const renderDetailCard = (data: unknown) => {
    const unwrapped =
      typeof data === 'object' && data !== null && 'data' in data
        ? (data as { data?: unknown }).data
        : data;
    if (typeof unwrapped !== 'object' || unwrapped === null || Array.isArray(unwrapped)) {
      return null;
    }
    const obj = unwrapped as Record<string, unknown>;
    const scalarEntries = Object.entries(obj).filter(
      ([, v]) => v !== null && v !== undefined && v !== '' && typeof v !== 'object',
    );
    if (scalarEntries.length === 0) return null;

    return (
      <div className="detail-card-grid">
        {scalarEntries.slice(0, 12).map(([k, v]) => (
          <div key={k} className="detail-kv">
            <span className="detail-key">{k}</span>
            <span className="detail-val">{formatCellValue(k, v, handleCopy)}</span>
          </div>
        ))}
      </div>
    );
  };

  const rich =
    part.state === 'output-available'
      ? (renderRichTable(part.output) ?? renderDetailCard(part.output))
      : null;

  const inferredMethod =
    toolMeta?.method ??
    (/^(post|create|add|push)/i.test(name)
      ? 'POST'
      : /^(put|edit|update|set)/i.test(name)
        ? 'PUT'
        : /^(delete|remove)/i.test(name)
          ? 'DELETE'
          : 'GET');

  return (
    <details className="tool-card" dir="auto" open={Boolean(rich)}>
      <summary>
        <span className={`http-badge ${inferredMethod.toLowerCase()}`}>{inferredMethod}</span>
        <span className="tool-card-name">{name}</span>
        {toolMeta?.path && <code className="tool-card-path">{toolMeta.path}</code>}
        {badge}
        {copiedText && <span className="copied-toast">Copied "{copiedText}"</span>}
        <span className="summary-actions" onClick={(e) => e.stopPropagation()}>
          {sectionLink && (
            <a
              href={sectionLink.url}
              target="_blank"
              rel="noopener noreferrer"
              className="dash-header-link"
            >
              {sectionLink.label}
            </a>
          )}
          {rich && (
            <button
              type="button"
              className="raw-toggle"
              onClick={(e) => {
                e.preventDefault();
                setShowRaw((v) => !v);
              }}
            >
              {showRaw ? 'Data Grid' : 'Raw JSON'}
            </button>
          )}
        </span>
      </summary>
      {rich && !showRaw ? rich : <pre>{summary}</pre>}
    </details>
  );
}
