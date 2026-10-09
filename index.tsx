import type { GloomPlugin } from "gloomberb/types/plugin";
import { attachGrowthepiePersistence, resetGrowthepiePersistence } from "./cache";
import { growthepieHeadless } from "./headless";
import { GrowthepiePane } from "./pane";
import { GROWTHEPIE_PANE_ID, GROWTHEPIE_PLUGIN_ID } from "./types";

export const growthepiePlugin: GloomPlugin = {
  id: GROWTHEPIE_PLUGIN_ID,
  name: "growthepie",
  version: "1.0.0",
  description: "Ethereum and Layer-2 metrics from growthepie (CC BY 4.0)",
  homepage: "https://github.com/gloom-sh/gloom-growthepie",
  toggleable: true,

  // Public JSON over HTTPS, so every renderer. The host is declared so the web
  // app proxies it and the plugin directory lists where the pane reaches.
  targets: ["cli", "tui", "desktop", "web"],
  hosts: ["api.growthepie.com"],

  setup(ctx) {
    attachGrowthepiePersistence(ctx.persistence);
  },

  dispose() {
    resetGrowthepiePersistence();
  },

  panes: [
    {
      id: GROWTHEPIE_PANE_ID,
      name: "growthepie",
      icon: "G",
      component: GrowthepiePane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 104, height: 32 },
      tableExport: true,
      headless: growthepieHeadless,
    },
  ],

  paneTemplates: [
    {
      id: "growthepie-pane",
      paneId: GROWTHEPIE_PANE_ID,
      label: "growthepie",
      description: "Ethereum and Layer-2 chains side by side: transactions, active addresses, fees, transaction cost, throughput, stablecoin supply and total value secured, with a daily history chart. Data from growthepie.",
      keywords: ["growthepie", "gtp", "ethereum", "layer 2", "l2", "rollups", "tvl", "fees", "stablecoins", "base", "arbitrum", "optimism"],
      shortcut: {
        prefix: "GTP",
        argPlaceholder: "chain",
        argKind: "text",
        argOptional: true,
        openWithoutArg: true,
      },
      headless: growthepieHeadless,
      createInstance: (_context, options) => {
        const chain = options?.arg?.trim();
        return {
          placement: "floating",
          settings: chain ? { chain } : undefined,
        };
      },
    },
  ],
};

export default growthepiePlugin;
