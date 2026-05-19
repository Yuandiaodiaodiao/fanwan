import { channelRepo, entryRepo, eventRepo } from "./db.ts";
import { dispatch } from "./channels.ts";

export async function triggerEntry(entryId: number): Promise<{ ok: boolean; event?: ReturnType<typeof eventRepo.create>; error?: string }> {
  const entry = entryRepo.get(entryId);
  if (!entry) return { ok: false, error: "entry not found" };
  if (entry.channel_id == null) return { ok: false, error: "entry has no channel" };
  const channel = channelRepo.get(entry.channel_id);
  if (!channel) return { ok: false, error: "channel not found" };

  const result = await dispatch(channel, entry.content);
  const event = eventRepo.create({
    entry_id: entry.id,
    channel_id: channel.id,
    message: entry.content,
    status: result.status,
    response: result.response,
  });

  entryRepo.update(entry.id, {
    status: result.status === "ok" ? "triggered" : result.status === "throttled" ? "pending" : "failed",
  });

  return { ok: result.status === "ok", event };
}

let timer: Timer | null = null;

export function startScheduler(intervalMs: number) {
  if (timer) return;
  const tick = async () => {
    try {
      const due = entryRepo.list({ due: true, limit: 20 });
      for (const e of due) {
        // eslint-disable-next-line no-await-in-loop
        await triggerEntry(e.id);
      }
    } catch (e) {
      console.error("[scheduler] tick error:", e);
    }
  };
  timer = setInterval(tick, intervalMs);
  // Run once on boot in case we missed events while down.
  void tick();
  console.log(`[scheduler] started (every ${intervalMs}ms)`);
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
