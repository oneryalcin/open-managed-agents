import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { scanModelConfigSecurity, type ModelConfigSecurityReport } from "./config-security.ts";
import {
  InMemoryAuthStorageBackend,
  InMemoryModelsStore,
  OmaCredentialStore,
  type AuthStorageBackend,
  type AuthStorageData,
} from "./credential-store.ts";

export const PINNED_PI_MODEL_RUNTIME_VERSION = "0.85.1";

export interface PiModelRef {
  provider: string;
  id: string;
}

export type PiResolvedModel = NonNullable<ReturnType<ModelRegistry["find"]>>;
export type ReadOnlyAuthData = AuthStorageData;

export interface PiModelCatalog {
  defaultModel: PiModelRef;
  allowedProviders: ReadonlySet<string>;
  credentials: OmaCredentialStore;
  modelRuntime: ModelRuntime;
  modelRegistry: ModelRegistry;
  securityReport: ModelConfigSecurityReport;
  resolve(ref: PiModelRef): PiResolvedModel | undefined;
  list(options?: { provider?: string; availableOnly?: boolean }): PiResolvedModel[];
  hasConfiguredAuth(model: PiResolvedModel): boolean;
  providerAuthMetadata(provider: string): { source?: string; label?: string };
}

export interface CreatePiModelCatalogConfig {
  allowedProviders: readonly string[];
  defaultModel: PiModelRef;
  authBackend: AuthStorageBackend;
  authPath?: string;
  modelsPath?: string;
  allowModelAuthCommands?: boolean;
}

export function createPiModelCatalog(config: CreatePiModelCatalogConfig): Promise<PiModelCatalog> {
  return createCatalog(
    config,
    new OmaCredentialStore(config.authBackend, {
      commands: config.allowModelAuthCommands === true ? "execute" : "deny",
    }),
  );
}

/**
 * Read-only catalog construction for diagnostics. The caller supplies an
 * already-read credential snapshot, so Pi never opens, locks, or creates an
 * auth file. Runtime code must continue to use createPiModelCatalog().
 */
export function createReadOnlyPiModelCatalog(
  config: Omit<CreatePiModelCatalogConfig, "authBackend">,
  authData: ReadOnlyAuthData = {},
): Promise<PiModelCatalog> {
  // Diagnostics must stay side-effect free: never run command-backed keys.
  return createCatalog(
    config,
    new OmaCredentialStore(new InMemoryAuthStorageBackend(authData), { commands: "unresolved" }),
  );
}

async function createCatalog(
  config: Omit<CreatePiModelCatalogConfig, "authBackend">,
  credentials: OmaCredentialStore,
): Promise<PiModelCatalog> {
  const allowedProviders = new Set(config.allowedProviders);
  if (allowedProviders.size !== config.allowedProviders.length) {
    throw new Error("OMA_MODEL_PROVIDERS must not contain duplicate providers");
  }
  if (!allowedProviders.has(config.defaultModel.provider)) {
    throw new Error(`Default model provider ${config.defaultModel.provider} is not enabled on this deployment`);
  }

  const securityReport = scanModelConfigSecurity({
    modelsPath: config.modelsPath,
    authPath: config.authPath,
    allowedProviders,
    allowCommands: config.allowModelAuthCommands,
  });

  // Fail at startup on an unreadable or corrupt auth.json (Pi's own store
  // would keep serving its last in-memory snapshot).
  try {
    await credentials.list();
  } catch (error) {
    throw new Error(`Failed to load model auth storage: ${error instanceof Error ? error.message : String(error)}`);
  }

  const modelRuntime = await ModelRuntime.create({
    credentials,
    modelsPath: config.modelsPath,
    modelsStore: new InMemoryModelsStore(),
  });
  const modelRegistry = new ModelRegistry(modelRuntime);
  const registryError = modelRegistry.getError();
  if (registryError !== undefined) {
    throw new Error(registryError);
  }

  for (const provider of allowedProviders) {
    if (!modelRegistry.getAll().some((model) => model.provider === provider)) {
      throw new Error(`Model provider ${provider} is not available in the Pi model registry`);
    }
  }
  if (!modelRegistry.find(config.defaultModel.provider, config.defaultModel.id)) {
    throw new Error(`Default model ${config.defaultModel.provider}/${config.defaultModel.id} is not available on this deployment`);
  }

  return {
    defaultModel: { ...config.defaultModel },
    allowedProviders,
    credentials,
    modelRuntime,
    modelRegistry,
    securityReport,
    resolve(ref) {
      if (!allowedProviders.has(ref.provider)) return undefined;
      return modelRegistry.find(ref.provider, ref.id);
    },
    list(options = {}) {
      const models = options.availableOnly ? modelRegistry.getAvailable() : modelRegistry.getAll();
      return models.filter((model) => {
        if (!allowedProviders.has(model.provider)) return false;
        return options.provider === undefined || model.provider === options.provider;
      });
    },
    hasConfiguredAuth(model) {
      return modelRegistry.hasConfiguredAuth(model);
    },
    providerAuthMetadata(provider) {
      const status = modelRegistry.getProviderAuthStatus(provider);
      return {
        ...(status.source === undefined ? {} : { source: status.source }),
        ...(status.label === undefined ? {} : { label: status.label }),
      };
    },
  };
}
