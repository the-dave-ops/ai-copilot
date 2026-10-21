import { useChat } from '@ai-sdk/react';
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type UIMessage,
} from 'ai';
import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Me } from '../App';
import { ApprovalCard } from './ApprovalCard';
import { ToolCard } from './ToolCard';

type MsgPart = UIMessage['parts'][number];
type ToolPart =
  | Extract<MsgPart, { type: `tool-${string}` }>
  | Extract<MsgPart, { type: 'dynamic-tool' }>;

function isToolPart(part: MsgPart): part is ToolPart {
  return part.type === 'dynamic-tool' || part.type.startsWith('tool-');
}

const pendingOverrides: Record<string, Record<string, unknown>> = {};
const knownFileNamesById: Record<string, string> = {};

const transport = new DefaultChatTransport({
  api: '/api/chat',
  prepareSendMessagesRequest: ({ messages }) => {
    const overrides = { ...pendingOverrides };
    return {
      body: {
        messages,
        ...(Object.keys(overrides).length > 0 ? { toolInputOverrides: overrides } : {}),
      },
    };
  },
  // any 401 → reload to show the authentication screen
  fetch: async (input, init) => {
    const res = await fetch(input, init);
    if (res.status === 401) {
      window.location.href = '/';
    }
    return res;
  },
});

const STARTER_CARDS: {
  title: string;
  desc: string;
  cmd: string;
}[] = [
  {
    title: 'My Projects',
    desc: 'Browse projects and inspect releases',
    cmd: '/projects',
  },
  {
    title: 'Upload a Release',
    desc: 'Publish a version and attach artifacts',
    cmd: '/release',
  },
  {
    title: 'Registered Devices',
    desc: 'View connected devices and storage',
    cmd: '/devices',
  },
  {
    title: 'Pending Versions',
    desc: 'Review releases awaiting approval',
    cmd: '/pending',
  },
  {
    title: 'Create a Project',
    desc: 'Set up a new application or product',
    cmd: '/project',
  },
  {
    title: 'Device Groups',
    desc: 'Inspect organization hierarchy units',
    cmd: '/groups',
  },
];

interface SlashParamField {
  key: string;
  label: string;
  placeholder?: string;
  defaultValue?: string;
  options?: string[];
  required?: boolean;
}

interface SlashCommandSpec {
  cmd: string;
  aliases?: string[];
  category: 'Read' | 'Write' | 'App';
  desc: string;
  usage?: string;
  mode: 'instant' | 'form' | 'ui';
  prompt?: string;
  openFilePicker?: boolean;
  fields?: SlashParamField[];
  promptTemplate?: string;
  inlineArgPromptTemplate?: string;
  buildPrompt?: (values: Record<string, string>) => string;
  inlineArgPrompt?: (argText: string) => string;
  uiAction?: 'new' | 'theme' | 'activity' | 'threads';
}

export interface ApiToolSummary {
  name: string;
  method: string;
  path: string;
  description: string;
  readOnly: boolean;
  paramCount?: number;
}

interface DynamicApiConfigResponse {
  apiTitle?: string | null;
  apiDescription?: string | null;
  apiBaseUrl?: string | null;
  slashCommands?: SlashCommandSpec[] | null;
  starterCards?: { title: string; desc: string; cmd: string }[] | null;
  paramEnums?: Record<string, string[]> | null;
  paramLabels?: Record<string, string> | null;
  tools?: ApiToolSummary[] | null;
  toolCount?: number;
}

function interpolateTemplate(tpl: string, values: Record<string, string>): string {
  return tpl
    .replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k: string) => values[k] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function hydrateSlashCommand(spec: SlashCommandSpec): SlashCommandSpec {
  return {
    ...spec,
    buildPrompt:
      spec.buildPrompt ??
      (spec.promptTemplate
        ? (v) => interpolateTemplate(spec.promptTemplate!, v)
        : spec.fields && spec.fields.length > 0
          ? (v) =>
              `${spec.desc}: ` +
              Object.entries(v)
                .filter(([, val]) => val?.trim())
                .map(([k, val]) => `${k}="${val}"`)
                .join(', ')
          : undefined),
    inlineArgPrompt:
      spec.inlineArgPrompt ??
      (spec.inlineArgPromptTemplate
        ? (arg) => interpolateTemplate(spec.inlineArgPromptTemplate!, { arg })
        : undefined),
  };
}

const SLASH_COMMANDS: SlashCommandSpec[] = [
  {
    cmd: '/projects',
    aliases: ['/p', '/list-projects'],
    category: 'Read',
    desc: 'List all projects you are a member of',
    usage: '/projects',
    mode: 'instant',
    prompt: 'List my projects',
  },
  {
    cmd: '/releases',
    aliases: ['/versions', '/rel-list'],
    category: 'Read',
    desc: 'List releases for a specific project',
    usage: '/releases <project-slug>',
    mode: 'form',
    fields: [{ key: 'project', label: 'Project slug', placeholder: 'e.g. david-gpt-2', required: true }],
    buildPrompt: (v) => `List all releases for project ${v.project}`,
    inlineArgPrompt: (arg) => `List all releases for project ${arg}`,
  },
  {
    cmd: '/search',
    aliases: ['/find'],
    category: 'Read',
    desc: 'Search projects by keyword or type',
    usage: '/search <query>',
    mode: 'form',
    fields: [
      { key: 'query', label: 'Search query', placeholder: 'e.g. agent', required: true },
      {
        key: 'type',
        label: 'Type',
        defaultValue: '',
        options: ['', 'application', 'product', 'lib', 'bundle', 'infra', 'config'],
      },
    ],
    buildPrompt: (v) =>
      `Search projects matching "${v.query}"${v.type ? ` of type ${v.type}` : ''}`,
    inlineArgPrompt: (arg) => `Search projects matching "${arg}"`,
  },
  {
    cmd: '/devices',
    aliases: ['/dev'],
    category: 'Read',
    desc: 'List all registered devices',
    usage: '/devices',
    mode: 'instant',
    prompt: 'List all registered devices',
    inlineArgPrompt: (arg) => `Get details for device ${arg}`,
  },
  {
    cmd: '/pending',
    aliases: ['/review'],
    category: 'Read',
    desc: 'List pending catalog versions awaiting review',
    usage: '/pending',
    mode: 'instant',
    prompt: 'List pending catalog versions awaiting review',
  },
  {
    cmd: '/groups',
    aliases: ['/org'],
    category: 'Read',
    desc: 'List organization device groups',
    usage: '/groups',
    mode: 'instant',
    prompt: 'List all organization device groups',
  },
  {
    cmd: '/maps',
    aliases: ['/map'],
    category: 'Read',
    desc: 'List maps in the catalog',
    usage: '/maps',
    mode: 'instant',
    prompt: 'List all maps',
    inlineArgPrompt: (arg) => `Get details for map ${arg}`,
  },
  {
    cmd: '/release',
    aliases: ['/new-release', '/create-release'],
    category: 'Write',
    desc: 'Create a software release & attach artifact files',
    usage: '/release <project> <version>',
    mode: 'form',
    openFilePicker: true,
    fields: [
      { key: 'project', label: 'Project slug', placeholder: 'e.g. david-gpt-2', required: true },
      { key: 'version', label: 'Version', placeholder: '0.0.1', defaultValue: '0.0.1', required: true },
      {
        key: 'status',
        label: 'Status',
        defaultValue: 'draft',
        options: ['draft', 'in_review', 'approved', 'released'],
      },
      { key: 'notes', label: 'Release notes', placeholder: 'Optional notes' },
    ],
    buildPrompt: (v) =>
      `Create release ${v.version} for project ${v.project} with status ${v.status || 'draft'}${v.notes ? ` and releaseNotes "${v.notes}"` : ''}`,
    inlineArgPrompt: (arg) => {
      const [proj, ver = '0.0.1'] = arg.split(/\s+/);
      return `Create release ${ver} for project ${proj}`;
    },
  },
  {
    cmd: '/project',
    aliases: ['/new-project', '/create-project'],
    category: 'Write',
    desc: 'Create a new GetApp project',
    usage: '/project <slug> <display-name>',
    mode: 'form',
    fields: [
      { key: 'name', label: 'Project slug', placeholder: 'e.g. my-service', required: true },
      { key: 'projectName', label: 'Display name', placeholder: 'e.g. My Service', required: true },
      {
        key: 'projectType',
        label: 'Type',
        defaultValue: 'application',
        options: ['application', 'product', 'lib', 'bundle', 'infra', 'config', 'config_map'],
      },
      { key: 'description', label: 'Description', placeholder: 'Optional description' },
    ],
    buildPrompt: (v) =>
      `Create a new ${v.projectType || 'application'} project named ${v.name} with display name "${v.projectName || v.name}"${v.description ? ` and description "${v.description}"` : ''}`,
    inlineArgPrompt: (arg) => `Create a new application project named ${arg}`,
  },
  {
    cmd: '/push',
    aliases: ['/deploy'],
    category: 'Write',
    desc: 'Push a catalog offering to target devices',
    usage: '/push <catalogId> <deviceId>',
    mode: 'form',
    fields: [
      { key: 'catalogId', label: 'Catalog ID', placeholder: 'e.g. 2490.app@0.0.1', required: true },
      {
        key: 'itemType',
        label: 'Item type',
        defaultValue: 'software',
        options: ['software', 'map', 'cache', 'config'],
      },
      { key: 'devices', label: 'Device IDs', placeholder: 'dev-1, dev-2', required: true },
    ],
    buildPrompt: (v) =>
      `Push offering catalogId "${v.catalogId}" (${v.itemType || 'software'}) to devices [${v.devices}]`,
  },
  {
    cmd: '/member',
    aliases: ['/add-member'],
    category: 'Write',
    desc: 'Add a member to a project with a role',
    usage: '/member <project> <email>',
    mode: 'form',
    fields: [
      { key: 'project', label: 'Project slug', placeholder: 'e.g. david-gpt-2', required: true },
      { key: 'email', label: 'Member email', placeholder: 'user@example.com', required: true },
      {
        key: 'role',
        label: 'Role',
        defaultValue: 'project-member',
        options: ['project-member', 'project-admin', 'project-owner'],
      },
    ],
    buildPrompt: (v) =>
      `Add member ${v.email} to project ${v.project} with role ${v.role || 'project-member'}`,
  },
  {
    cmd: '/command',
    aliases: ['/cmd'],
    category: 'Write',
    desc: 'Send a reactive command to connected device(s)',
    usage: '/command <deviceId> <action>',
    mode: 'form',
    fields: [
      { key: 'deviceId', label: 'Device ID (or "all")', placeholder: 'dev-1 or all', required: true },
      {
        key: 'action',
        label: 'Action',
        defaultValue: 'Discovery',
        options: [
          'Discovery',
          'Push',
          'DeliveryStart',
          'DeliveryStop',
          'DeliveryCancel',
          'DeliveryDelete',
          'DeployStart',
          'MetadataRequest',
        ],
      },
      { key: 'catalogId', label: 'Catalog ID', placeholder: 'Optional catalogId' },
    ],
    buildPrompt: (v) =>
      `Send reactive command ${v.action || 'Discovery'} to device ${v.deviceId}${v.catalogId ? ` with catalogId ${v.catalogId}` : ''}`,
  },
  {
    cmd: '/new',
    aliases: ['/clear', '/reset'],
    category: 'App',
    desc: 'Start a fresh conversation thread',
    usage: '/new',
    mode: 'ui',
    uiAction: 'new',
  },
  {
    cmd: '/theme',
    aliases: ['/dark', '/light'],
    category: 'App',
    desc: 'Switch between Dark and Light mode',
    usage: '/theme',
    mode: 'ui',
    uiAction: 'theme',
  },
  {
    cmd: '/activity',
    aliases: ['/audit', '/logs'],
    category: 'App',
    desc: 'Toggle the API Activity Log drawer',
    usage: '/activity',
    mode: 'ui',
    uiAction: 'activity',
  },
  {
    cmd: '/threads',
    aliases: ['/history'],
    category: 'App',
    desc: 'Toggle the Saved Conversations sidebar',
    usage: '/threads',
    mode: 'ui',
    uiAction: 'threads',
  },
];

interface AuditEntry {
  id: string;
  timestamp: string;
  tool: string;
  args: unknown;
  status: number | string;
  durationMs: number;
}

interface ChatThread {
  id: string;
  title: string;
  updatedAt: string;
  messages: UIMessage[];
}

type ApproveFn = (args: { id: string; approved: boolean; reason?: string }) => unknown;

function deriveFollowUps(message: UIMessage): { label: string; text: string }[] {
  const suggestions: { label: string; text: string }[] = [];
  const seen = new Set<string>();
  const add = (label: string, text: string) => {
    const key = label.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      suggestions.push({ label, text });
    }
  };

  let ctxProject = '';
  let ctxDevice = '';

  for (const part of message.parts ?? []) {
    if (!isToolPart(part)) continue;
    const tName = part.type === 'dynamic-tool' ? part.toolName : part.type.slice('tool-'.length);
    const input = (part.input ?? {}) as Record<string, unknown>;
    const proj = String(input.projectIdentifier ?? input.name ?? input.projectName ?? '');
    const ver = String(input.version ?? '');
    const dev = String(input.deviceId ?? '');
    if (proj) ctxProject = proj;
    if (dev) ctxDevice = dev;

    if (tName === 'create_project' && part.state === 'output-available' && proj) {
      add(`Create release 0.0.1 for ${proj}`, `Create release 0.0.1 for project ${proj}`);
      add(`Inspect ${proj}`, `Get project details for ${proj}`);
    } else if (tName === 'create_release' && part.state === 'output-available' && proj && ver) {
      add(`Inspect release ${ver}`, `Get release details for version ${ver} of project ${proj}`);
      add(`List all releases of ${proj}`, `List releases for project ${proj}`);
    } else if (tName === 'get_device' && part.state === 'output-available' && dev) {
      add(`Installed software`, `Show installed software for device ${dev}`);
      add(`Installed maps`, `Show installed maps for device ${dev}`);
      add(`Send Discovery command`, `Send reactive command Discovery to device ${dev}`);
    } else if (tName === 'get_project' && part.state === 'output-available' && proj) {
      add(`View releases of ${proj}`, `List releases for project ${proj}`);
      add(`View offering of ${proj}`, `Get catalog offering for project ${proj}`);
      add(`Create release for ${proj}`, `Create release 0.0.1 for project ${proj}`);
    }
  }

  // Also parse explicit [[action: Label | Prompt]] tags or natural-language questions in text
  const fullText = (message.parts ?? [])
    .filter((p): p is Extract<MsgPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n');

  const tagRe = /\[\[action:\s*([^|\]]+?)\s*\|\s*([^\]]+?)\s*\]\]/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(fullText)) !== null) {
    add(m[1].trim(), m[2].trim());
  }

  const lower = fullText.toLowerCase();
  const devTarget = ctxDevice ? `device ${ctxDevice}` : 'this device';
  const projTarget = ctxProject ? `project ${ctxProject}` : 'this project';

  if (/installed software|check.*software/i.test(lower)) {
    add('Check installed software', `Show installed software for ${devTarget}`);
  }
  if (/installed maps|check.*maps|device.*maps/i.test(lower)) {
    add('Check installed maps', `Show installed maps for ${devTarget}`);
  }
  if (/\bdiscovery\b/i.test(lower)) {
    add('Send Discovery command', `Send reactive command Discovery to ${devTarget}`);
  }
  if (/\bpush\b.*command|command.*\bpush\b|or push\b/i.test(lower)) {
    add('Send Push command', `Send reactive command Push to ${devTarget}`);
  }
  if (/metadata\s*request/i.test(lower)) {
    add('Request device metadata', `Send reactive command MetadataRequest to ${devTarget}`);
  }
  if (/check.*releases|view.*releases|list.*releases/i.test(lower) && ctxProject) {
    add(`Show releases (${ctxProject})`, `List releases for ${projTarget}`);
  }
  if (/create.*release|new.*release/i.test(lower) && ctxProject) {
    add(`Create release for ${ctxProject}`, `Create release 0.0.1 for ${projTarget}`);
  }

  return suggestions.slice(0, 4);
}

function stripActionTags(text: string): string {
  return text.replace(/^\s*\[\[action:\s*[^|\]]+?\s*\|\s*[^\]]+?\s*\]\]\s*$/gim, '').trim();
}

/**
 * Repairs single-line collapsed Markdown pipe tables (e.g. `| a | b | |---| | 1 | 2 |`)
 * emitted by some LLMs so remark-gfm renders them as proper HTML tables.
 */
function normalizeMarkdownTables(text: string): string {
  if (!text.includes('|')) return text;
  let out = text.replace(/\|\s*(\|[\s:]*-{2,}[\s:|-]*\|)/g, '|\n$1\n');
  if (/\|[\s:]*-{2,}[\s:|-]*\|/.test(out)) {
    out = out.replace(/\|\s+\|(?=\s*[^|\n])/g, '|\n|');
  }
  return out;
}

/**
 * Extracts `[Attached files for release: ...]` from user text so the UI shows
 * clean attachment pills instead of raw UUIDs.
 */
function splitAttachmentNote(text: string): {
  cleanText: string;
  attachments: { name: string; size: string }[];
} {
  const match = text.match(/\n*\s*\[Attached files for release:\s*(.+?)\]\s*$/s);
  if (!match) return { cleanText: text, attachments: [] };
  const cleanText = text.slice(0, match.index).trim();
  const attachments: { name: string; size: string }[] = [];
  const itemRegex = /([^\s,(]+)\s*\(fileId:\s*"[^"]+",\s*([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = itemRegex.exec(match[1])) !== null) {
    attachments.push({ name: m[1], size: m[2] });
  }
  return { cleanText, attachments };
}

function MessageParts({
  message,
  approve,
  onQuickPrompt,
  dashboardBaseUrl,
  extraEnumOptions,
  extraLabels,
  toolsByName,
}: {
  message: UIMessage;
  approve: ApproveFn;
  onQuickPrompt: (prompt: string) => void;
  dashboardBaseUrl?: string;
  extraEnumOptions?: Record<string, string[]>;
  extraLabels?: Record<string, string>;
  toolsByName?: Record<string, ApiToolSummary>;
}) {
  return (
    <>
      {message.parts.map((part, i) => {
        if (part.type === 'text') {
          if (message.role === 'user') {
            const { cleanText, attachments } = splitAttachmentNote(part.text);
            return (
              <div key={i} className="md-content">
                {cleanText && <p>{cleanText}</p>}
                {attachments.length > 0 && (
                  <div className="user-att-chips">
                    {attachments.map((a, idx) => (
                      <span key={idx} className="user-att-chip">
                        📎 {a.name} <small>({a.size})</small>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          }
          return (
            <div key={i} className="md-content">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {normalizeMarkdownTables(stripActionTags(part.text))}
              </ReactMarkdown>
            </div>
          );
        }
        if (isToolPart(part)) {
          const approval = (part as { approval?: { id: string; approved?: boolean } }).approval;
          const tName = part.type === 'dynamic-tool' ? part.toolName : part.type.slice('tool-'.length);
          const meta = toolsByName?.[tName];
          return (
            <div key={i}>
              {approval && (
                <ApprovalCard
                  part={part}
                  toolMeta={meta}
                  fileNamesById={knownFileNamesById}
                  extraEnumOptions={extraEnumOptions}
                  extraLabels={extraLabels}
                  onDecide={(id, approved, toolCallId, override) => {
                    if (override && toolCallId) {
                      pendingOverrides[toolCallId] = override;
                    }
                    approve({ id, approved });
                  }}
                />
              )}
              {(!approval || approval.approved !== undefined) && (
                <ToolCard
                  part={part}
                  toolMeta={meta}
                  onQuickPrompt={onQuickPrompt}
                  dashboardBaseUrl={dashboardBaseUrl}
                />
              )}
            </div>
          );
        }
        return null;
      })}
    </>
  );
}

interface UploadedFileItem {
  fileId: string;
  fileName: string;
  size: number;
}

function makeThreadId(): string {
  return `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function ChatPage({ me, onLogout }: { me: Me; onLogout?: () => void }) {
  const {
    messages,
    sendMessage,
    regenerate,
    stop,
    status,
    error,
    setMessages,
    addToolApprovalResponse,
  } = useChat({
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  });

  const [input, setInput] = useState('');
  const [slashIndex, setSlashIndex] = useState(0);
  const [activeSlashForm, setActiveSlashForm] = useState<SlashCommandSpec | null>(null);
  const [slashFormValues, setSlashFormValues] = useState<Record<string, string>>({});
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [attachedFiles, setAttachedFiles] = useState<UploadedFileItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string>(() => makeThreadId());
  const [showSidebar, setShowSidebar] = useState(false);
  const [showAudit, setShowAudit] = useState(false);
  const [showCatalog, setShowCatalog] = useState(false);
  const [catalogSearch, setCatalogSearch] = useState('');
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [showJumpBottom, setShowJumpBottom] = useState(false);
  const [slashCommands, setSlashCommands] = useState<SlashCommandSpec[]>(SLASH_COMMANDS);
  const [starterCards, setStarterCards] = useState(STARTER_CARDS);
  const [apiTitle, setApiTitle] = useState('API');
  const [apiDesc, setApiDesc] = useState(
    'Query endpoints, inspect records, and execute approval-gated operations using your own permissions.',
  );
  const [apiBaseUrl, setApiBaseUrl] = useState<string>('');
  const [apiTools, setApiTools] = useState<ApiToolSummary[]>([]);
  const [extraEnums, setExtraEnums] = useState<Record<string, string[]>>({});
  const [extraLabels, setExtraLabels] = useState<Record<string, string>>({});
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (localStorage.getItem('dgpt-theme') as 'dark' | 'light') || 'dark',
  );
  const listRef = useRef<HTMLDivElement>(null);
  const slashListRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottomRef = useRef(true);
  const busy = status === 'submitted' || status === 'streaming';

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('dgpt-theme', theme);
  }, [theme]);

  // Load persisted threads + active conversation + generated API config on initial mount
  useEffect(() => {
    Promise.all([
      fetch('/api/threads').then((r) => (r.ok ? r.json() : { threads: [] })),
      fetch('/api/history').then((r) => (r.ok ? r.json() : { messages: [] })),
      fetch('/api/config').then((r) => (r.ok ? r.json() : null)),
    ])
      .then(
        ([tRes, hRes, cfgRes]: [
          { threads?: ChatThread[] },
          { messages?: UIMessage[] },
          DynamicApiConfigResponse | null,
        ]) => {
          const list = Array.isArray(tRes.threads) ? tRes.threads : [];
          setThreads(list);
          if (list.length > 0) {
            setActiveThreadId(list[0].id);
            setMessages(list[0].messages);
          } else if (Array.isArray(hRes.messages) && hRes.messages.length > 0) {
            setMessages(hRes.messages);
          }
          if (cfgRes) {
            if (cfgRes.apiTitle) {
              setApiTitle(cfgRes.apiTitle);
              document.title = `${cfgRes.apiTitle} — API Copilot`;
            }
            if (cfgRes.apiDescription) setApiDesc(cfgRes.apiDescription);
            if (cfgRes.apiBaseUrl) setApiBaseUrl(cfgRes.apiBaseUrl);
            if (Array.isArray(cfgRes.tools)) setApiTools(cfgRes.tools);
            if (Array.isArray(cfgRes.slashCommands) && cfgRes.slashCommands.length > 0) {
              setSlashCommands(cfgRes.slashCommands.map(hydrateSlashCommand));
            }
            if (Array.isArray(cfgRes.starterCards) && cfgRes.starterCards.length > 0) {
              setStarterCards(cfgRes.starterCards);
            }
            if (cfgRes.paramEnums) setExtraEnums(cfgRes.paramEnums);
            if (cfgRes.paramLabels) setExtraLabels(cfgRes.paramLabels);
          }
        },
      )
      .catch(() => {})
      .finally(() => setHistoryLoaded(true));
  }, [setMessages]);

  // Persist current thread + history whenever streaming settles
  useEffect(() => {
    if (!historyLoaded || busy || messages.length === 0) return;
    void fetch(`/api/threads/${encodeURIComponent(activeThreadId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { threads?: ChatThread[] } | null) => {
        if (d?.threads) setThreads(d.threads);
      })
      .catch(() => {});
  }, [messages, busy, historyLoaded, activeThreadId]);

  // Smart sticky auto-scroll as tokens stream in
  useEffect(() => {
    const el = listRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  // Global keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        textareaRef.current?.focus();
      } else if (e.key === 'Escape') {
        if (showCatalog) setShowCatalog(false);
        else if (showAudit) setShowAudit(false);
        else if (showSidebar) setShowSidebar(false);
        else if (busy) void stop();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, showAudit, showCatalog, showSidebar, stop]);

  const handleScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distance < 80;
    setShowJumpBottom(distance > 180);
  };

  const scrollToBottom = () => {
    stickToBottomRef.current = true;
    setShowJumpBottom(false);
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  };

  const openAuditDrawer = async () => {
    setShowSidebar(false);
    setShowCatalog(false);
    setShowAudit((v) => !v);
    try {
      const res = await fetch('/api/audit');
      if (res.ok) {
        const d = (await res.json()) as { entries: AuditEntry[] };
        setAuditEntries(d.entries ?? []);
      }
    } catch {
      // ignore
    }
  };

  const openCatalogDrawer = () => {
    setShowSidebar(false);
    setShowAudit(false);
    setShowCatalog((v) => !v);
  };

  const handleNewChat = () => {
    setActiveThreadId(makeThreadId());
    setMessages([]);
    void fetch('/api/history', { method: 'DELETE' }).catch(() => {});
  };

  const handleSelectThread = (thread: ChatThread) => {
    if (busy) return;
    setActiveThreadId(thread.id);
    setMessages(thread.messages);
    setShowSidebar(false);
  };

  const handleDeleteThread = async (threadId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const res = await fetch(`/api/threads/${encodeURIComponent(threadId)}`, { method: 'DELETE' });
      if (res.ok) {
        const d = (await res.json()) as { threads: ChatThread[] };
        setThreads(d.threads ?? []);
        if (threadId === activeThreadId) {
          handleNewChat();
        }
      }
    } catch {
      // ignore
    }
  };

  const uploadFileList = useCallback(async (files: FileList | File[]) => {
    const arr = Array.from(files);
    if (!arr.length) return;
    setUploading(true);
    setUploadError(null);
    try {
      const form = new FormData();
      for (const file of arr) {
        form.append('files', file);
      }
      const res = await fetch('/api/uploads', { method: 'POST', body: form });
      if (res.status === 401) {
        window.location.href = '/auth/login';
        return;
      }
      if (!res.ok) {
        throw new Error(`Upload failed (${res.status})`);
      }
      const data = (await res.json()) as { files: UploadedFileItem[] };
      for (const f of data.files) {
        knownFileNamesById[f.fileId] = f.fileName;
      }
      setAttachedFiles((prev) => [...prev, ...data.files]);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, []);

  const removeAttachedFile = async (fileId: string) => {
    setAttachedFiles((prev) => prev.filter((f) => f.fileId !== fileId));
    await fetch(`/api/uploads/${encodeURIComponent(fileId)}`, { method: 'DELETE' }).catch(() => {});
  };

  const sendPromptText = (rawText: string) => {
    const trimmed = rawText.trim();
    if ((!trimmed && attachedFiles.length === 0) || busy || uploading) return;
    const attachmentNote =
      attachedFiles.length > 0
        ? '\n\n[Attached files for release: ' +
          attachedFiles
            .map((f) => `${f.fileName} (fileId: "${f.fileId}", ${f.size} bytes)`)
            .join(', ') +
          ']'
        : '';
    const text = (trimmed || 'Upload attached files to a release') + attachmentNote;
    setInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    setAttachedFiles([]);
    stickToBottomRef.current = true;
    void sendMessage({ text });
  };

  const submit = () => {
    const trimmed = input.trim();
    if (trimmed.startsWith('/')) {
      const [cmdToken, ...rest] = trimmed.split(/\s+/);
      const argText = rest.join(' ').trim();
      const exact = slashCommands.find(
        (s) => s.cmd === cmdToken.toLowerCase() || s.aliases?.includes(cmdToken.toLowerCase()),
      );
      if (exact) {
        if (argText && exact.inlineArgPrompt) {
          sendPromptText(exact.inlineArgPrompt(argText));
          return;
        }
        applySlashCommand(exact);
        return;
      }
      if (matchingSlash.length > 0) {
        applySlashCommand(matchingSlash[safeSlashIndex]);
        return;
      }
    }
    sendPromptText(input);
  };

  const slashQuery =
    input.startsWith('/') && !input.includes('\n') ? input.trim().toLowerCase() : '';
  const slashToken = slashQuery.split(/\s+/)[0] ?? '';
  const hasInlineArgs = slashQuery.includes(' ');

  const matchingSlash =
    slashToken && !hasInlineArgs
      ? slashCommands.filter((s) => {
          const q = slashToken.slice(1);
          if (!q) return true;
          return (
            s.cmd.slice(1).includes(q) ||
            s.aliases?.some((a) => a.slice(1).includes(q)) ||
            s.desc.toLowerCase().includes(q) ||
            s.category.toLowerCase().includes(q)
          );
        })
      : [];

  const safeSlashIndex =
    matchingSlash.length > 0 ? Math.min(slashIndex, matchingSlash.length - 1) : 0;

  useEffect(() => {
    const listEl = slashListRef.current;
    if (!listEl) return;
    const activeEl = listEl.querySelector<HTMLElement>('.slash-item.active');
    activeEl?.scrollIntoView({ block: 'nearest' });
  }, [safeSlashIndex, matchingSlash.length]);

  const applySlashCommand = (item: SlashCommandSpec) => {
    setInput('');
    setSlashIndex(0);
    if (item.mode === 'ui') {
      if (item.uiAction === 'new') handleNewChat();
      else if (item.uiAction === 'theme') setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
      else if (item.uiAction === 'activity') void openAuditDrawer();
      else if (item.uiAction === 'threads') {
        setShowAudit(false);
        setShowSidebar((v) => !v);
      }
      return;
    }
    if (item.mode === 'instant' && item.prompt) {
      sendPromptText(item.prompt);
      return;
    }
    if (item.mode === 'form' && item.fields) {
      const defaults: Record<string, string> = {};
      for (const f of item.fields) {
        defaults[f.key] = f.defaultValue ?? '';
      }
      setSlashFormValues(defaults);
      setActiveSlashForm(item);
      if (item.openFilePicker && attachedFiles.length === 0) {
        fileInputRef.current?.click();
      }
    }
  };

  const submitSlashForm = () => {
    if (!activeSlashForm?.buildPrompt) return;
    const missing = activeSlashForm.fields?.find(
      (f) => f.required && !slashFormValues[f.key]?.trim(),
    );
    if (missing) return;
    const built = activeSlashForm.buildPrompt(slashFormValues);
    setActiveSlashForm(null);
    setSlashFormValues({});
    sendPromptText(built);
  };

  const isEmpty = messages.length === 0;
  const toolsByName: Record<string, ApiToolSummary> = {};
  for (const t of apiTools) {
    toolsByName[t.name] = t;
  }
  const filteredCatalogTools = catalogSearch.trim()
    ? apiTools.filter((t) =>
        `${t.name} ${t.method} ${t.path} ${t.description}`
          .toLowerCase()
          .includes(catalogSearch.trim().toLowerCase()),
      )
    : apiTools;

  return (
    <div
      className={`shell ${isDragging ? 'dragging' : ''} ${isEmpty ? 'is-empty' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setIsDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        if (e.dataTransfer.files?.length) {
          void uploadFileList(e.dataTransfer.files);
        }
      }}
    >
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <button
              type="button"
              className={`nav-btn ${showSidebar ? 'active' : ''}`}
              onClick={() => {
                setShowAudit(false);
                setShowCatalog(false);
                setShowSidebar((v) => !v);
              }}
              title="Conversation threads"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="12" x2="15" y2="12" />
                <line x1="3" y1="18" x2="18" y2="18" />
              </svg>
              {threads.length > 0 && <span className="nav-count">{threads.length}</span>}
            </button>
            <div className="brand-identity">
              <div className="brand-logo-mark small">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="12 2 2 7 12 12 22 7 12 2" />
                  <polyline points="2 17 12 22 22 17" />
                  <polyline points="2 12 12 17 22 12" />
                </svg>
              </div>
              <span className="title">{apiTitle}</span>
              <span className="brand-tag">Copilot</span>
            </div>
            {apiBaseUrl && (
              <span className="target-host-pill" title={apiBaseUrl}>
                <span className="status-dot online" />
                <span>{apiBaseUrl.replace(/^https?:\/\//, '')}</span>
              </span>
            )}
          </div>

          <div className="topbar-actions">
            <button
              type="button"
              className={`topbar-btn ${showCatalog ? 'active' : ''}`}
              onClick={openCatalogDrawer}
              title="Browse discovered API endpoints & tools"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="16 18 22 12 16 6" />
                <polyline points="8 6 2 12 8 18" />
              </svg>
              <span>API Endpoints</span>
              {apiTools.length > 0 && <span className="pill-counter">{apiTools.length}</span>}
            </button>

            <button
              type="button"
              className={`topbar-btn ${showAudit ? 'active' : ''}`}
              onClick={() => void openAuditDrawer()}
              title="Inspect API request audit trail"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
              </svg>
              <span>Activity</span>
              {auditEntries.length > 0 && <span className="pill-counter">{auditEntries.length}</span>}
            </button>

            <button type="button" className="topbar-btn primary-ghost" onClick={handleNewChat}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              <span>New Chat</span>
            </button>

            <button
              type="button"
              className="topbar-btn icon-only"
              onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
              title="Toggle Dark / Light theme"
            >
              {theme === 'dark' ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="5" />
                  <line x1="12" y1="1" x2="12" y2="3" />
                  <line x1="12" y1="21" x2="12" y2="23" />
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                  <line x1="1" y1="12" x2="3" y2="12" />
                  <line x1="21" y1="12" x2="23" y2="12" />
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              )}
            </button>

            <div className="topbar-divider" />

            <div className="user-session-badge">
              <span className="user-avatar">
                {(me.name ?? me.email ?? me.sub ?? 'U').charAt(0).toUpperCase()}
              </span>
              <div className="user-meta">
                <span className="user-name">{me.name ?? me.email ?? me.sub}</span>
                {me.authMethod && (
                  <span className="user-auth-protocol">{me.authMethod.replace(/_/g, ' ')}</span>
                )}
              </div>
              <button
                type="button"
                className="logout-icon-btn"
                title="Switch Authentication / Disconnect"
                onClick={() => {
                  void fetch('/auth/logout', { method: 'POST' })
                    .catch(() => {})
                    .finally(() => {
                      if (onLogout) onLogout();
                      else window.location.href = '/';
                    });
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </header>

      {(showSidebar || showAudit || showCatalog) && (
        <div
          className="drawer-backdrop"
          onClick={() => {
            setShowSidebar(false);
            setShowAudit(false);
            setShowCatalog(false);
          }}
        />
      )}

      {showCatalog && (
        <aside className="audit-slideover catalog-slideover">
          <div className="audit-header">
            <div>
              <strong>Discovered API Endpoints</strong>
              <div className="muted">{apiTools.length} active tools registered by startup agent</div>
            </div>
            <button type="button" onClick={() => setShowCatalog(false)}>
              ✕
            </button>
          </div>
          <div className="catalog-search-wrap">
            <input
              value={catalogSearch}
              onChange={(e) => setCatalogSearch(e.target.value)}
              placeholder="Filter endpoints by method, path, or name…"
            />
          </div>
          <div className="audit-list">
            {filteredCatalogTools.map((t) => (
              <div key={t.name} className="catalog-endpoint-card">
                <div className="catalog-endpoint-top">
                  <span className={`http-badge ${t.method.toLowerCase()}`}>{t.method}</span>
                  <code className="catalog-path">{t.path}</code>
                  <span className={`badge ${t.readOnly ? 'ok' : 'wait'}`}>
                    {t.readOnly ? 'Read' : 'Approval'}
                  </span>
                </div>
                <div className="catalog-tool-desc">{t.description}</div>
                <div className="catalog-endpoint-footer">
                  <code className="catalog-tool-id">{t.name}</code>
                  <button
                    type="button"
                    className="row-action-btn"
                    onClick={() => {
                      setShowCatalog(false);
                      sendPromptText(`Run ${t.name}: ${t.description}`);
                    }}
                  >
                    Invoke →
                  </button>
                </div>
              </div>
            ))}
          </div>
        </aside>
      )}

      {showSidebar && (
        <aside className="thread-sidebar">
          <div className="sidebar-top">
            <span className="sidebar-heading">Conversations</span>
            <div className="sidebar-top-actions">
              <button
                type="button"
                className="sidebar-new-btn"
                onClick={() => {
                  handleNewChat();
                  setShowSidebar(false);
                }}
                title="Start new conversation"
              >
                + New
              </button>
              <button
                type="button"
                className="sidebar-close-btn"
                onClick={() => setShowSidebar(false)}
                title="Close sidebar"
              >
                ✕
              </button>
            </div>
          </div>

          {threads.length === 0 ? (
            <div className="sidebar-empty">
              No saved conversations yet. Send a message to start one.
            </div>
          ) : (
            <div className="thread-list">
              {threads.map((t) => {
                const isActive = t.id === activeThreadId;
                const msgCount = t.messages?.length ?? 0;
                return (
                  <div
                    key={t.id}
                    className={`thread-item ${isActive ? 'active' : ''}`}
                    onClick={() => handleSelectThread(t)}
                  >
                    <div className="thread-info">
                      <div className="thread-title">{t.title}</div>
                      <div className="thread-meta">
                        <span>
                          {new Date(t.updatedAt).toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                          })}
                        </span>
                        <span>·</span>
                        <span>{msgCount} {msgCount === 1 ? 'msg' : 'msgs'}</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="thread-del"
                      title="Delete conversation"
                      onClick={(e) => void handleDeleteThread(t.id, e)}
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </aside>
      )}

      {showAudit && (
        <aside className="audit-slideover">
          <div className="audit-header">
            <strong>API Activity Log</strong>
            <button type="button" onClick={() => setShowAudit(false)}>
              ✕
            </button>
          </div>
          {auditEntries.length === 0 ? (
            <div className="audit-empty">No tool calls recorded in this session yet.</div>
          ) : (
            <div className="audit-list">
              {auditEntries.map((e) => (
                <div key={e.id} className="audit-card">
                  <div className="audit-card-top">
                    <code>{e.tool}</code>
                    <span className={`badge ${Number(e.status) < 400 ? 'ok' : 'err'}`}>
                      {String(e.status)}
                    </span>
                    <span className="muted">{e.durationMs}ms</span>
                    <span className="muted">{new Date(e.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <div className="audit-args">{JSON.stringify(e.args)}</div>
                </div>
              ))}
            </div>
          )}
        </aside>
      )}

      <div className="messages" ref={listRef} onScroll={handleScroll}>
        {isEmpty && (
          <div className="center-note">
            <div className="hero-badge-row">
              <span className="hero-pill">
                <span className="status-dot online" />
                <span>{apiTools.length || 20} Endpoints Ready</span>
              </span>
              <span className="hero-pill subtle">Human-in-the-Loop Protected</span>
            </div>
            <h2>How can I help with {apiTitle} today?</h2>
            <p className="muted">{apiDesc}</p>
          </div>
        )}
        {messages.map((m, idx) => {
          const hasTool = m.parts?.some(isToolPart);
          const textParts = stripActionTags(
            (m.parts ?? [])
              .filter((p): p is Extract<MsgPart, { type: 'text' }> => p.type === 'text')
              .map((p) => p.text)
              .join('\n')
              .trim(),
          );
          const isLastAssistant = m.role === 'assistant' && idx === messages.length - 1;
          const msgActions =
            m.role === 'assistant' && (!busy || !isLastAssistant) ? deriveFollowUps(m) : [];
          return (
            <div
              key={m.id}
              className={`msg ${m.role} ${hasTool ? 'has-tool' : ''}`}
              dir="auto"
            >
              <MessageParts
                message={m}
                approve={addToolApprovalResponse}
                onQuickPrompt={sendPromptText}
                dashboardBaseUrl={me.dashboardBaseUrl}
                extraEnumOptions={extraEnums}
                extraLabels={extraLabels}
                toolsByName={toolsByName}
              />
              {msgActions.length > 0 && (
                <div className="msg-suggested-actions">
                  {msgActions.map((act) => (
                    <button
                      key={act.label}
                      type="button"
                      className="suggested-action-btn"
                      disabled={busy}
                      onClick={() => sendPromptText(act.text)}
                    >
                      <span>{act.label}</span>
                      <span className="suggested-action-arrow">→</span>
                    </button>
                  ))}
                </div>
              )}
              {m.role === 'assistant' && !busy && (
                <div className="msg-footer-actions">
                  {textParts && (
                    <button
                      type="button"
                      className="msg-action-btn"
                      onClick={() => {
                        void navigator.clipboard?.writeText(textParts);
                        setCopiedMsgId(m.id);
                        setTimeout(
                          () => setCopiedMsgId((id) => (id === m.id ? null : id)),
                          1400,
                        );
                      }}
                    >
                      {copiedMsgId === m.id ? '✓ Copied' : 'Copy'}
                    </button>
                  )}
                  {isLastAssistant && (
                    <button
                      type="button"
                      className="msg-action-btn"
                      onClick={() => void regenerate()}
                    >
                      ↻ Retry
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {busy && (
          <div className="thinking-pill">
            <span className="thinking-dots">
              <span />
              <span />
              <span />
            </span>
            <span>Working on it… (Esc to stop)</span>
          </div>
        )}
        {error && (
          <div className="status-line" style={{ color: 'var(--danger)' }}>
            Error: {String(error.message)}
          </div>
        )}
      </div>

      {!isEmpty && showJumpBottom && (
        <button type="button" className="jump-bottom" onClick={scrollToBottom}>
          ↓ Jump to latest
        </button>
      )}

      {uploadError && (
        <div className="status-line" style={{ color: 'var(--danger)' }}>
          {uploadError}
        </div>
      )}

      <div className="composer-shell">
        <div className="composer-box-wrap">
          {matchingSlash.length > 0 && (
            <div className="slash-menu">
              <div className="slash-menu-header">
                <span>Slash Commands ({matchingSlash.length})</span>
                <span className="muted">↑↓ navigate · Enter / Tab select · Esc close</span>
              </div>
              <div className="slash-menu-list" ref={slashListRef}>
                {matchingSlash.map((item, idx) => (
                  <button
                    key={item.cmd}
                    type="button"
                    className={`slash-item ${idx === safeSlashIndex ? 'active' : ''}`}
                    onMouseEnter={() => setSlashIndex(idx)}
                    onClick={() => applySlashCommand(item)}
                  >
                    <div className="slash-item-left">
                      <code>{item.usage ?? item.cmd}</code>
                      <span className="slash-desc">{item.desc}</span>
                    </div>
                    <span
                      className={`badge ${
                        item.category === 'Write'
                          ? 'wait'
                          : item.category === 'Read'
                            ? 'ok'
                            : 'neutral'
                      }`}
                    >
                      {item.mode === 'instant'
                        ? 'Instant'
                        : item.mode === 'form'
                          ? 'Guided'
                          : 'Action'}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="composer-card">
          {activeSlashForm && (
            <div className="slash-form-bar">
              <div className="slash-form-header">
                <div>
                  <code>{activeSlashForm.cmd}</code>
                  <span className="muted"> — {activeSlashForm.desc}</span>
                </div>
                <button
                  type="button"
                  className="slash-form-close"
                  onClick={() => setActiveSlashForm(null)}
                >
                  ✕
                </button>
              </div>
              <div className="slash-form-grid">
                {activeSlashForm.fields?.map((f) => (
                  <label key={f.key} className="slash-form-field">
                    <span>
                      {f.label}
                      {f.required ? ' *' : ''}
                    </span>
                    {f.options ? (
                      <select
                        value={slashFormValues[f.key] ?? ''}
                        onChange={(e) =>
                          setSlashFormValues((prev) => ({ ...prev, [f.key]: e.target.value }))
                        }
                      >
                        {f.options.map((opt) => (
                          <option key={opt} value={opt}>
                            {opt || 'Any'}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={slashFormValues[f.key] ?? ''}
                        placeholder={f.placeholder}
                        onChange={(e) =>
                          setSlashFormValues((prev) => ({ ...prev, [f.key]: e.target.value }))
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            submitSlashForm();
                          }
                        }}
                      />
                    )}
                  </label>
                ))}
              </div>
              <div className="slash-form-actions">
                {activeSlashForm.openFilePicker && (
                  <button
                    type="button"
                    className="attach-btn"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    📎 Attach artifact files
                  </button>
                )}
                <button
                  type="button"
                  className="action-btn send"
                  onClick={submitSlashForm}
                  disabled={Boolean(
                    activeSlashForm.fields?.some(
                      (f) => f.required && !slashFormValues[f.key]?.trim(),
                    ),
                  )}
                >
                  Run {activeSlashForm.cmd} ↵
                </button>
              </div>
            </div>
          )}

          {attachedFiles.length > 0 && (
            <div className="attached-files">
              {attachedFiles.map((f) => (
                <span key={f.fileId} className="file-chip">
                  <span className="file-chip-name">{f.fileName}</span>
                  <span className="file-chip-size">
                    {Math.max(1, Math.round(f.size / 1024))} KB
                  </span>
                  <button
                    type="button"
                    title="Remove file"
                    onClick={() => void removeAttachedFile(f.fileId)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <textarea
            ref={textareaRef}
            rows={1}
            value={input}
            dir="auto"
            placeholder={`Message ${apiTitle} Copilot… (type / for commands)`}
            onChange={(e) => {
              setInput(e.target.value);
              setSlashIndex(0);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
            }}
            onKeyDown={(e) => {
              if (matchingSlash.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setSlashIndex((i) => (i + 1) % matchingSlash.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setSlashIndex((i) => (i - 1 + matchingSlash.length) % matchingSlash.length);
                  return;
                }
                if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                  e.preventDefault();
                  applySlashCommand(matchingSlash[safeSlashIndex]);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setInput('');
                  return;
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            disabled={busy}
          />

          <div className="composer-toolbar">
            <div className="composer-left">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={(e) => e.target.files && void uploadFileList(e.target.files)}
              />
              <button
                type="button"
                className="attach-btn"
                onClick={() => {
                  setInput((prev) => (prev.startsWith('/') ? '' : '/'));
                  setSlashIndex(0);
                  textareaRef.current?.focus();
                }}
                disabled={busy}
                title="Browse slash commands (/)"
              >
                <code>/</code>
                <span>Commands</span>
              </button>
              <button
                type="button"
                className="attach-btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy || uploading}
                title="Attach files for a release (or drag & drop anywhere)"
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
                <span>{uploading ? 'Uploading…' : 'Add files'}</span>
              </button>
              <span className="composer-hint">Type / for commands · Enter ↵ to send</span>
            </div>

            <div className="composer-right">
              {busy ? (
                <button type="button" className="action-btn stop" onClick={() => void stop()}>
                  <span className="stop-square" />
                  <span>Stop</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="action-btn send"
                  onClick={submit}
                  disabled={uploading || (!input.trim() && attachedFiles.length === 0)}
                >
                  <span>Send</span>
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="12" y1="19" x2="12" y2="5" />
                    <polyline points="5 12 12 5 19 12" />
                  </svg>
                </button>
              )}
            </div>
          </div>
          </div>
        </div>

        {isEmpty && (
          <div className="starter-grid">
            {starterCards.map((card) => {
              const matchedSlash = slashCommands.find((s) => s.cmd === card.cmd);
              const isWrite = matchedSlash?.category === 'Write';
              return (
                <button
                  key={card.cmd}
                  type="button"
                  className="starter-card"
                  onClick={() => {
                    if (matchedSlash) applySlashCommand(matchedSlash);
                    else sendPromptText(card.desc || card.title);
                  }}
                >
                  <div className="starter-card-body">
                    <div className="starter-card-top">
                      <span className="starter-card-title">{card.title}</span>
                      <code className={`starter-cmd-chip ${isWrite ? 'write' : 'read'}`}>
                        {card.cmd}
                      </code>
                    </div>
                    <div className="starter-card-desc">{card.desc}</div>
                  </div>
                  <span className="starter-card-arrow">→</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
