import type { Query } from "./contract";

export type CredentialMode = "default" | "custom" | "incomplete";
export interface Credentials {
  clientId: string;
  clientSecret: string;
}
export interface SettingsSnapshot extends Credentials {
  mode: CredentialMode;
}
export interface DesktopError {
  message: string;
  code: string;
  status: number;
  retryAfter: number;
}
export type Reply<T> =
  | { ok: true; data: T }
  | { ok: false; error: DesktopError };
export interface DesktopBridge {
  query: (id: string, payload: Query) => Promise<Reply<{ report: unknown }>>;
  cancel: (id: string) => void;
  getSettings: () => Promise<Reply<SettingsSnapshot>>;
  saveSettings: (settings: Credentials) => Promise<Reply<SettingsSnapshot>>;
  copyNote: (text: string) => Promise<Reply<void>>;
  saveNote: (
    name: string,
    text: string,
  ) => Promise<Reply<{ canceled: boolean }>>;
  openCredentialsPage: () => Promise<Reply<void>>;
  version: () => Promise<Reply<string>>;
}
