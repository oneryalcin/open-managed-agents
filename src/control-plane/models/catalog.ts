import {
  AuthStorage,
  ModelRegistry,
  type AuthStorageBackend,
} from "@earendil-works/pi-coding-agent";
import { scanModelConfigSecurity, type ModelConfigSecurityReport } from "./config-security.ts";

export interface PiModelRef {
  provider: string;
  id: string;
}

export type PiResolvedModel = NonNullable<ReturnType<ModelRegistry["find"]>>;

export interface PiModelCatalog {
  defaultModel: PiModelRef;
  allowedProviders: ReadonlySet<string>;
  authStorage: AuthStorage;
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

export function createPiModelCatalog(config: CreatePiModelCatalogConfig): PiModelCatalog {
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

  const authStorage = AuthStorage.fromStorage(config.authBackend);
  const authErrors = authStorage.drainErrors();
  if (authErrors.length > 0) {
    throw new Error(`Failed to load model auth storage: ${authErrors.map((error) => error.message).join("; ")}`);
  }

  const modelRegistry = ModelRegistry.create(authStorage, config.modelsPath);
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
    authStorage,
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
      // Deliberately model-scoped: provider status can report env credentials as
      // configured:false in Pi 0.80.6 while the resolved model is usable.
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
