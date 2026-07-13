declare const __ENGAGER_AGENT_VERSION__: string | undefined;

export const AGENT_VERSION =
  typeof __ENGAGER_AGENT_VERSION__ === "string" ? __ENGAGER_AGENT_VERSION__ : "0.9.0";
