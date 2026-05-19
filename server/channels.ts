import type { Channel, AlertEvent } from "../shared/types.ts";

export interface DispatchResult {
  status: AlertEvent["status"];
  response: string | null;
}

export async function dispatch(channel: Channel, message: string): Promise<DispatchResult> {
  switch (channel.type) {
    case "phone":
      return dispatchPhone(channel, message);
    default:
      return { status: "failed", response: `unknown channel type: ${channel.type}` };
  }
}

async function dispatchPhone(channel: Channel, message: string): Promise<DispatchResult> {
  const webhook = channel.config.webhook_url as string | undefined;
  if (!webhook) return { status: "failed", response: "missing webhook_url in channel config" };

  const url = new URL(webhook);
  url.searchParams.set("message", message);

  try {
    const res = await fetch(url, { method: "GET" });
    const body = await res.text();
    if (!res.ok) return { status: "failed", response: `HTTP ${res.status}: ${body.slice(0, 500)}` };
    if (body.includes("HARD_MOBILE_RATE_THROTTLE")) {
      return { status: "throttled", response: body.slice(0, 500) };
    }
    return { status: "ok", response: body.slice(0, 500) };
  } catch (e) {
    return { status: "failed", response: (e as Error).message };
  }
}
