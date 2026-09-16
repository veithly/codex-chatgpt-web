import {
  availableChatGptWebModelRoutes,
  type ChatGptWebModelRoute,
} from "../chatgpt-web-models";
import type { AppConfig } from "../config";

/**
 * Gateway model mapping.
 *
 * Harness clients send whatever model string their configuration carries ("gpt-5.2",
 * "claude-sonnet-4-5", "my-proxy-model"). The gateway maps any string onto the best available
 * ChatGPT Web route; an explicit `chatgpt-web/<slug>` is honored verbatim and validated by the
 * normal route resolution (including account-capability errors).
 */

export class GatewayModelError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "GatewayModelError";
    this.status = status;
  }
}

type EffortTier = "light" | "medium" | "high" | "extra-high" | "pro";

function tierFromEffort(requested: string | undefined): EffortTier {
  switch (requested?.trim().toLowerCase()) {
    case "minimal":
    case "low":
      return "light";
    case "medium":
      return "medium";
    case "high":
    case undefined:
    case "":
      return "high";
    case "xhigh":
    case "extra-high":
      return "extra-high";
    case "max":
    case "ultra":
    case "pro":
      return "pro";
    default:
      return "high";
  }
}

/** Model-name flavor hints: cross-family aliases map onto the tiers a harness usually means. */
function tierFromFlavor(model: string): EffortTier | undefined {
  const normalized = model.toLowerCase();
  if (normalized.includes("opus")) return "pro";
  if (normalized.includes("sonnet")) return "high";
  if (normalized.includes("haiku") || normalized.includes("mini") || normalized.includes("nano")) return "light";
  return undefined;
}

function automaticRoutes(config: AppConfig): readonly ChatGptWebModelRoute[] {
  if (config.browserInteractionMode === "manual") {
    throw new GatewayModelError(
      "The gateway serves automatic ChatGPT Web routes only. Zero Risk (manual interaction) mode "
        + "has no automatic models; switch the launcher to With Automation to use external harnesses.",
    );
  }
  const routes = availableChatGptWebModelRoutes({
    browserInteractionMode: "automatic",
    solAvailable: config.solAvailable,
    proAvailable: config.proAvailable,
    experimentalBiggerContext: false,
  });
  const automatic = routes.filter(route => route.interactionMode === "automatic");
  if (automatic.length === 0) {
    throw new GatewayModelError("No automatic ChatGPT Web model is available for this configuration.");
  }
  return automatic;
}

function slugForTier(routes: readonly ChatGptWebModelRoute[], tier: EffortTier): string {
  const solTiers: Record<EffortTier, string[]> = {
    pro: ["pro", "extra-high", "high"],
    "extra-high": ["extra-high", "high"],
    high: ["high", "medium", "light"],
    medium: ["medium", "high", "light"],
    light: ["light", "medium", "high"],
  };
  for (const candidate of solTiers[tier]) {
    const match = routes.find(route => route.slug === `chatgpt-web/${candidate}`);
    if (match) return match.slug;
  }
  // Luna-only accounts expose luna/think instead of the sol tiers.
  const think = routes.find(route => route.slug === "chatgpt-web/think");
  const luna = routes.find(route => route.slug === "chatgpt-web/luna");
  if (tier === "light") return (luna ?? think ?? routes[0])!.slug;
  return (think ?? luna ?? routes[0])!.slug;
}

/**
 * Resolve any requested model string to a concrete `chatgpt-web/<slug>` route for this account.
 * An explicit `chatgpt-web/<slug>` is returned verbatim; everything else is mapped through the
 * account's available automatic routes using the requested effort (reasoning_effort) and the
 * model-name flavor as tier hints.
 */
export function resolveGatewayModelSlug(requestedModel: string, effort: string | undefined, config: AppConfig): string {
  if (requestedModel.startsWith("chatgpt-web/")) return requestedModel;
  return slugForTier(automaticRoutes(config), tierFromFlavor(requestedModel) ?? tierFromEffort(effort));
}

/** OpenAI-shaped `/v1/models` listing served to unauthenticated harness clients. */
export function gatewayModelCatalog(config: AppConfig): Record<string, unknown> {
  const created = 1_700_000_000;
  const models: Array<Record<string, unknown>> = automaticRoutes(config).map(route => ({
    id: route.slug,
    object: "model",
    created,
    owned_by: "chatgpt-web",
  }));
  // Stable cross-family aliases so harness configurations keep working when the account's
  // available routes change underneath them.
  for (const alias of ["chatgpt-web-auto", "gpt-5.6", "gpt-5", "claude-sonnet", "claude-opus", "claude-haiku"]) {
    models.push({ id: alias, object: "model", created, owned_by: "chatgpt-web-gateway-alias" });
  }
  return { object: "list", data: models };
}
