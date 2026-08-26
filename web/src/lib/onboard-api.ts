/**
 * Client for the onboard-automation Python backend (FastAPI on :3001).
 * All calls go through the Caddy gateway using ?XTransformPort=3001.
 */

const PORT = 3001;

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${path}${sep}XTransformPort=${PORT}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    let detail: string = res.statusText;
    try {
      const body = await res.json();
      // FastAPI validation errors put an ARRAY in detail; others a string
      const d = body?.detail;
      detail =
        typeof d === "string" ? d : d ? JSON.stringify(d) : detail;
    } catch {
      /* keep statusText */
    }
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  return res.json() as Promise<T>;
}

export interface Health {
  status: string;
  service: string;
  version: string;
  db: string;
  deps: Record<string, boolean | string> & { ok: boolean };
}

export interface Stats {
  accounts: number;
  provisioned: number;
  workspaces: number;
  trialing: number;
  api_keys: number;
  chats: number;
  jobs: number;
  distinct_signup_ips: number;
}

export interface Account {
  id: number;
  email: string;
  user_id: string | null;
  status: string;
  signup_route: string | null;
  signup_ip: string | null;
  proxy_country: string | null;
  mail_provider: string | null;
  created_at: string;
  updated_at: string | null;
  workspaces_n: number;
  keys_n: number;
  chats_n: number;
  token_v2?: string;
}

export interface Workspace {
  space_id: string;
  name: string | null;
  icon: string | null;
  trial_status: string | null;
  trial_tier: string | null;
  active: number;
}

export interface ApiKey {
  name: string | null;
  token: string;
  workspace_id: string | null;
  verified: number;
}

export interface ChatRecord {
  id: number;
  thread_id: string | null;
  prompt: string | null;
  reply: string | null;
  model: string | null;
  route: string | null;
  created_at: string;
}

export interface PageRecord {
  page_id: string;
  title: string | null;
  url: string | null;
  kind: string | null;
}

export interface AccountDetail extends Account {
  workspaces: Workspace[];
  api_keys: ApiKey[];
  chats: ChatRecord[];
  pages: PageRecord[];
}

export interface JobItem {
  id: number;
  label: string;
  status: string;
  account_id: number | null;
  detail: Record<string, unknown> | null;
  updated_at: string | null;
}

export interface Job {
  id: number;
  type: string;
  status: string;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  items?: JobItem[];
}

export interface ModelInfo {
  codename: string;
  name: string;
  family: string | null;
  display_group: string | null;
  efforts: string[];
  default_effort: string | null;
  context_tokens: number | null;
}

export interface IpRow {
  ip: string;
  country: string | null;
  route: string | null;
  accounts: number;
  first_at: string;
  last_at: string;
}

export const api = {
  health: () => req<Health>("/api/health"),
  stats: () => req<Stats>("/api/stats"),
  models: () => req<ModelInfo[]>("/api/models"),
  ips: () => req<IpRow[]>("/api/ips"),
  accounts: () => req<Account[]>("/api/accounts"),
  account: (id: number, reveal = false) =>
    req<AccountDetail>(`/api/accounts/${id}${reveal ? "?reveal=1" : ""}`),
  deleteAccount: (id: number) =>
    req<{ deleted: number }>(`/api/accounts/${id}`, { method: "DELETE" }),
  exportSession: (id: number) =>
    req<{
      session_path: string;
      email: string;
      has_token: boolean;
      created: boolean;
    }>(`/api/accounts/${id}/export-session`, { method: "POST" }),
  signup: (body: Record<string, unknown>) =>
    req<{ job_id: number }>("/api/signup", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  batch: (body: Record<string, unknown>) =>
    req<{ job_id: number }>("/api/batch", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  tail: (id: number, body: Record<string, unknown>) =>
    req<{ job_id: number }>(`/api/accounts/${id}/tail`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  chat: (id: number, body: Record<string, unknown>) =>
    req<{ job_id: number }>(`/api/accounts/${id}/chat`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  jobs: () => req<Job[]>("/api/jobs"),
  job: (id: number) => req<Job>(`/api/jobs/${id}`),
  cancelJob: (id: number) =>
    req<{ cancelled: boolean }>(`/api/jobs/${id}/cancel`, { method: "POST" }),
};
