// Shared types between server, scripts, and web.

export type ChannelType = "phone";

export interface Channel {
  id: number;
  type: ChannelType;
  name: string;
  config: Record<string, unknown>;
  created_at: string;
}

export type EntryStatus = "pending" | "triggered" | "done" | "cancelled" | "failed";

export interface Entry {
  id: number;
  content: string;
  scheduled_at: string | null; // ISO 8601 UTC
  channel_id: number | null;
  alert: boolean; // whether scheduled_at firing should ring channel_id
  status: EntryStatus;
  tags: string | null;
  created_at: string;
  updated_at: string;
}

export interface AlertEvent {
  id: number;
  entry_id: number | null;
  channel_id: number;
  message: string;
  status: "ok" | "throttled" | "failed";
  response: string | null;
  triggered_at: string;
}

export interface ApiError {
  error: string;
}
