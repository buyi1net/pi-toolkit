import { registerMessages, type MessageTables } from "../i18n/index.ts";
import type { ModuleDefinition } from "../kit/module.ts";
import { visionModule } from "./vision/index.ts";
import { VISION_MESSAGES } from "./vision/messages/index.ts";
import { providersModule } from "./providers/index.ts";
import { PROVIDERS_MESSAGES } from "./providers/messages/index.ts";
import { statusModule } from "./status/index.ts";
import { STATUS_MESSAGES } from "./status/messages/index.ts";
import { usageModule } from "./usage/index.ts";
import { USAGE_MESSAGES } from "./usage/messages/index.ts";
import { computerModule } from "./computer/index.ts";
import { COMPUTER_MESSAGES } from "./computer/messages/index.ts";
import { peersModule } from "./peers/index.ts";
import { PEERS_MESSAGES } from "./peers/messages/index.ts";
import { compressionModule } from "./compression/index.ts";
import { COMPRESSION_MESSAGES } from "./compression/messages/index.ts";
import { skillsModule } from "./skills/index.ts";
import { SKILLS_MESSAGES } from "./skills/messages/index.ts";
import { subagentsModule } from "./subagents/index.ts";
import { SUBAGENTS_MESSAGES } from "./subagents/messages/index.ts";
import { tuiModule } from "./tui/index.ts";
import { TUI_MESSAGES } from "./tui/messages/index.ts";

export const MODULE_MESSAGE_TABLES: Readonly<Record<string, MessageTables>> = {
  vision: VISION_MESSAGES,
  providers: PROVIDERS_MESSAGES,
  status: STATUS_MESSAGES,
  subagents: SUBAGENTS_MESSAGES,
  usage: USAGE_MESSAGES,
  computer: COMPUTER_MESSAGES,
  peers: PEERS_MESSAGES,
  compression: COMPRESSION_MESSAGES,
  skills: SKILLS_MESSAGES,
  tui: TUI_MESSAGES,
};

for (const tables of Object.values(MODULE_MESSAGE_TABLES)) {
  registerMessages(tables);
}

export const BUILT_IN_MODULES: readonly ModuleDefinition[] = [
  visionModule,
  subagentsModule,
  providersModule,
  statusModule,
  usageModule,
  computerModule,
  peersModule,
  compressionModule,
  skillsModule,
  tuiModule,
];
