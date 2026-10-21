import type { UIMessage } from 'ai';
import { useState } from 'react';

type ToolPart =
  | Extract<UIMessage['parts'][number], { type: `tool-${string}` }>
  | Extract<UIMessage['parts'][number], { type: 'dynamic-tool' }>;

interface Props {
  part: ToolPart;
  fileNamesById?: Record<string, string>;
  extraEnumOptions?: Record<string, string[]>;
  extraLabels?: Record<string, string>;
  onDecide: (
    approvalId: string,
    approved: boolean,
    toolCallId: string,
    override?: Record<string, unknown>,
  ) => void;
}

const ENUM_OPTIONS: Record<string, string[]> = {
  projectType: ['application', 'product', 'lib', 'bundle', 'infra', 'config', 'config_map'],
  status: ['draft', 'in_review', 'approved', 'released', 'archived', 'error'],
  role: ['project-owner', 'project-admin', 'project-member'],
  itemType: ['software', 'map', 'cache', 'config'],
  action: [
    'Discovery',
    'Push',
    'DeliveryStart',
    'DeliveryStop',
    'DeliveryCancel',
    'DeliveryDelete',
    'DeployStart',
    'MetadataRequest',
  ],
};

const FRIENDLY_LABELS: Record<string, string> = {
  name: 'Project slug',
  projectName: 'Display name',
  projectIdentifier: 'Project',
  projectType: 'Project type',
  description: 'Description',
  version: 'Version',
  releaseNotes: 'Release notes',
  status: 'Release status',
  fileIds: 'Attached artifacts',
  isInstallationFile: 'Installation file',
  isDraft: 'Draft mode',
  email: 'Member email',
  role: 'Member role',
  memberId: 'Member ID',
  deviceId: 'Device ID',
  catalogId: 'Catalog ID',
  itemType: 'Item type',
  groupId: 'Group ID',
};

function prettyToolTitle(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function ApprovalCard({
  part,
  fileNamesById = {},
  extraEnumOptions,
  extraLabels,
  onDecide,
}: Props) {
  const approval = (part as { approval?: { id: string; approved?: boolean } }).approval;
  const initialInput =
    typeof part.input === 'object' && part.input !== null
      ? (part.input as Record<string, unknown>)
      : {};
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(initialInput)) {
      out[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
    return out;
  });

  if (!approval) return null;
  const name = part.type === 'dynamic-tool' ? part.toolName : part.type.slice('tool-'.length);

  // Post-decision progression view while the API request runs or completes
  if (approval.approved !== undefined) {
    const isApproved = approval.approved === true;
    const isDone = part.state === 'output-available';
    const isErr = part.state === 'output-error' || part.state === 'output-denied';
    return (
      <div className={`approval approval-progress ${isApproved ? 'approved' : 'rejected'}`} dir="auto">
        <div className="approval-header">
          <span className="approval-title">{prettyToolTitle(name)}</span>
          <span className="steps-inline">
            <span className="step done">{isApproved ? '✓ Approved' : '✕ Rejected'}</span>
            {isApproved && (
              <>
                <span className="step-sep">→</span>
                <span className={`step ${isDone ? 'done' : isErr ? 'err' : 'active'}`}>
                  {isDone ? '✓ Executed' : isErr ? '✕ Failed' : 'Calling API…'}
                </span>
              </>
            )}
          </span>
        </div>
      </div>
    );
  }

  const buildOverride = (): Record<string, unknown> | undefined => {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [k, orig] of Object.entries(initialInput)) {
      if (k === 'fileIds') continue;
      const raw = draft[k] ?? '';
      if (typeof orig === 'string') {
        next[k] = raw;
        if (raw !== orig) changed = true;
      } else if (typeof orig === 'boolean') {
        const b = raw === 'true';
        next[k] = b;
        if (b !== orig) changed = true;
      } else {
        try {
          const parsed: unknown = JSON.parse(raw);
          next[k] = parsed;
          if (JSON.stringify(parsed) !== JSON.stringify(orig)) changed = true;
        } catch {
          next[k] = orig;
        }
      }
    }
    return changed ? next : undefined;
  };

  return (
    <div className="approval" dir="auto">
      <div className="approval-header">
        <div>
          <span className="approval-eyebrow">Requires confirmation</span>
          <div className="approval-title">{prettyToolTitle(name)}</div>
        </div>
        <code>{name}</code>
      </div>
      <div className="approval-fields">
        {Object.entries(initialInput).map(([key, origVal]) => {
          const label = extraLabels?.[key] ?? FRIENDLY_LABELS[key] ?? key;
          const enumVals = extraEnumOptions?.[key] ?? ENUM_OPTIONS[key];

          if (key === 'fileIds' && Array.isArray(origVal)) {
            return (
              <div key={key} className="approval-field">
                <span>{label}</span>
                <div className="approval-file-chips">
                  {origVal.map((fid) => (
                    <span key={String(fid)} className="file-chip">
                      📎 {fileNamesById[String(fid)] ?? `${String(fid).slice(0, 8)}…`}
                    </span>
                  ))}
                </div>
              </div>
            );
          }

          if (typeof origVal === 'boolean') {
            return (
              <label key={key} className="approval-field">
                <span>{label}</span>
                <input
                  type="checkbox"
                  className="approval-checkbox"
                  checked={(draft[key] ?? String(origVal)) === 'true'}
                  onChange={(e) =>
                    setDraft((prev) => ({ ...prev, [key]: e.target.checked ? 'true' : 'false' }))
                  }
                />
              </label>
            );
          }

          if (enumVals) {
            return (
              <label key={key} className="approval-field">
                <span>{label}</span>
                <select
                  value={draft[key] ?? ''}
                  onChange={(e) => setDraft((prev) => ({ ...prev, [key]: e.target.value }))}
                >
                  {enumVals.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </label>
            );
          }

          return (
            <label key={key} className="approval-field">
              <span>{label}</span>
              <input
                value={draft[key] ?? ''}
                onChange={(e) => setDraft((prev) => ({ ...prev, [key]: e.target.value }))}
              />
            </label>
          );
        })}
      </div>
      <div className="actions">
        <button
          type="button"
          className="approve"
          onClick={() => onDecide(approval.id, true, part.toolCallId, buildOverride())}
        >
          ✓ Approve & Run
        </button>
        <button
          type="button"
          className="reject"
          onClick={() => onDecide(approval.id, false, part.toolCallId)}
        >
          Reject
        </button>
      </div>
    </div>
  );
}
