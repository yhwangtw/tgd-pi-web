import data from "./capabilities.json";

export type CapabilityFoundation = "pi-sdk" | "pi-extension-api" | "pi-package-format" | "pi-web";
export type CapabilityWebSupport = "native" | "adapted";
export type CapabilityPackaging = "built-in";
export type CapabilityTrust = "none" | "workspace" | "decision" | "host" | "endpoint" | "operator";

export interface LocalizedCapabilityText {
  en: string;
  zh: string;
}

export interface ProductCapability {
  id: string;
  title: LocalizedCapabilityText;
  summary: LocalizedCapabilityText;
  foundation: CapabilityFoundation;
  webSupport: CapabilityWebSupport;
  packaging: CapabilityPackaging;
  globalPiCliRequired: boolean;
  backgroundServerRequired: boolean;
  trust: CapabilityTrust;
  evidence: string[];
}

export interface ProductCapabilityManifest {
  schemaVersion: number;
  capabilities: ProductCapability[];
}

export const PRODUCT_CAPABILITIES = data as ProductCapabilityManifest;
