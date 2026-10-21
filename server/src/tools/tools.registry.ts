import { Injectable, Optional } from '@nestjs/common';
import type { UIMessage } from 'ai';
import type { ToolSpec } from './types';
import {
  buildToolSpecFromGenerated,
  type GeneratedApiConfig,
  type SlashCommandConfig,
  type StarterCardConfig,
} from './dynamic-tool.builder';
import { StartupAgentService } from './startup-agent.service';
import { getDevice, getDeviceMaps, getDeviceSoftware, listDevices } from './definitions/devices';
import {
  getProject,
  getProjectReleases,
  getReleaseDetails,
  listProjects,
  searchProjects,
} from './definitions/projects';
import { getProjectOffering, listPendingVersions } from './definitions/catalog';
import { getMap, listMaps } from './definitions/maps';
import { listGroups } from './definitions/org';
import {
  acceptPendingVersion,
  addProjectMember,
  createGroup,
  createProject,
  createRelease,
  deleteGroup,
  deleteRelease,
  editGroup,
  editProject,
  editProjectMember,
  pushOffering,
  rejectPendingVersion,
  removeProjectMember,
  sendDeviceCommand,
  setGroupChildren,
  unpushOffering,
  updateDeviceProps,
} from './definitions/mutating';

const CORE_TOOLS: ToolSpec[] = [
  listDevices,
  getDevice,
  listProjects,
  searchProjects,
  getProject,
  getProjectReleases,
  getReleaseDetails,
  getProjectOffering,
  listPendingVersions,
  listMaps,
  getMap,
  listGroups,
  createProject,
  createRelease,
  pushOffering,
  updateDeviceProps,
  addProjectMember,
];

const DOMAIN_TOOLS: { pattern: RegExp; specs: ToolSpec[] }[] = [
  {
    pattern: /\b(device|software|map|command|reactive|push|discover|deploy)\b/i,
    specs: [getDeviceSoftware, getDeviceMaps, sendDeviceCommand],
  },
  {
    pattern: /\b(project|member|role|owner|admin|release|version|delete|edit|update|pending|accept|reject|approve|unpush|offering)\b/i,
    specs: [
      editProject,
      editProjectMember,
      removeProjectMember,
      deleteRelease,
      unpushOffering,
      acceptPendingVersion,
      rejectPendingVersion,
    ],
  },
  {
    pattern: /\b(group|unit|org|hierarchy|child|parent)\b/i,
    specs: [createGroup, editGroup, deleteGroup, setGroupChildren],
  },
];

const DEFAULT_SPECS: ToolSpec[] = [
  ...CORE_TOOLS,
  getDeviceSoftware,
  getDeviceMaps,
  editProject,
  editProjectMember,
  removeProjectMember,
  deleteRelease,
  unpushOffering,
  acceptPendingVersion,
  rejectPendingVersion,
  createGroup,
  editGroup,
  deleteGroup,
  setGroupChildren,
  sendDeviceCommand,
];

@Injectable()
export class ToolsRegistry {
  private cachedConfigRef: GeneratedApiConfig | null = null;
  private dynamicSpecs: ToolSpec[] = [];
  private dynamicCoreSpecs: ToolSpec[] = [];
  private dynamicDomainRules: { pattern: RegExp; spec: ToolSpec }[] = [];

  constructor(@Optional() private readonly startupAgent?: StartupAgentService) {}

  private ensureSynced(): GeneratedApiConfig | null {
    const cfg = this.startupAgent?.getLoadedConfig() ?? null;
    if (cfg && cfg !== this.cachedConfigRef) {
      this.cachedConfigRef = cfg;
      this.dynamicSpecs = [];
      this.dynamicCoreSpecs = [];
      this.dynamicDomainRules = [];

      cfg.tools.forEach((gen, idx) => {
        const spec = buildToolSpecFromGenerated(gen);
        this.dynamicSpecs.push(spec);
        if (gen.isCore ?? idx < 18) {
          this.dynamicCoreSpecs.push(spec);
        } else {
          const kws = (gen.domainKeywords ?? [])
            .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .filter(Boolean);
          const pattern =
            kws.length > 0
              ? new RegExp(`\\b(${kws.join('|')})\\b`, 'i')
              : new RegExp(gen.name.replace(/_/g, '|'), 'i');
          this.dynamicDomainRules.push({ pattern, spec });
        }
      });
    }
    return cfg;
  }

  get specs(): ToolSpec[] {
    const cfg = this.ensureSynced();
    return cfg && this.dynamicSpecs.length > 0 ? this.dynamicSpecs : DEFAULT_SPECS;
  }

  getGeneratedConfig(): GeneratedApiConfig | null {
    return this.ensureSynced();
  }

  getSlashCommands(): SlashCommandConfig[] | null {
    return this.ensureSynced()?.slashCommands ?? null;
  }

  getStarterCards(): StarterCardConfig[] | null {
    return this.ensureSynced()?.starterCards ?? null;
  }

  /**
   * Selects the core tools plus any domain-specific tools matched by
   * the conversation text or already referenced in tool parts.
   */
  selectForConversation(messages: UIMessage[]): ToolSpec[] {
    const cfg = this.ensureSynced();
    const isDynamic = Boolean(cfg && this.dynamicSpecs.length > 0);
    const selected = new Map<string, ToolSpec>();

    const coreList = isDynamic ? this.dynamicCoreSpecs : CORE_TOOLS;
    for (const s of coreList) {
      selected.set(s.name, s);
    }

    const textBlob = messages
      .flatMap((m) =>
        (m.parts ?? []).map((p) => {
          if (p.type === 'text') return p.text;
          if (p.type.startsWith('tool-')) return p.type.slice('tool-'.length);
          return '';
        }),
      )
      .join(' ');

    if (isDynamic) {
      for (const rule of this.dynamicDomainRules) {
        if (rule.pattern.test(textBlob)) {
          selected.set(rule.spec.name, rule.spec);
        }
      }
    } else {
      for (const group of DOMAIN_TOOLS) {
        if (group.pattern.test(textBlob)) {
          for (const s of group.specs) {
            selected.set(s.name, s);
          }
        }
      }
    }

    const allSpecs = this.specs;
    // Always include any tool that already has a part in the message history
    for (const m of messages) {
      for (const p of m.parts ?? []) {
        if (p.type.startsWith('tool-')) {
          const name = p.type.slice('tool-'.length);
          const found = allSpecs.find((s) => s.name === name);
          if (found) selected.set(found.name, found);
        }
      }
    }

    return Array.from(selected.values());
  }
}
