export type AiProvider = "deepseek";
export type AiRole = "user" | "assistant";
export type AiRestoreState = "local" | "restored" | "unavailable";

export type AiConversation = {
  id: string;
  provider: AiProvider;
  title: string;
  remoteRef: string;
  pinned: boolean;
  restoreState: AiRestoreState;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
};

export type AiMessage = {
  id: string;
  conversationId: string;
  role: AiRole;
  content: string;
  sequence: number;
  createdAt: string;
};

export type DeepSeekBridgeStatus =
  | "preparing"
  | "login_required"
  | "ready"
  | "generating"
  | "adapter_error";

export type DeepSeekSnapshot = {
  status: DeepSeekBridgeStatus;
  ready: boolean;
  generating: boolean;
  text: string;
  conversationRef: string;
  error: string;
  adapterVersion: number;
};
