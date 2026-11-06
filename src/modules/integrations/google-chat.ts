import { z } from "zod";
import { createGoogleHttp, type GoogleHttpOptions } from "./google-http";
import { ProviderApiError, ProviderAuthError, ProviderSourceUnavailableError } from "./types";

/**
 * Google Chat REST client (app authentication only; see docs/GOOGLE_CHAT.md). Reads messages of a space the Chat app was added to.
 * Same rules as the Gmail client: responses are validated with Zod, and errors carry a status code only.
 */
export const CHAT_APP_MESSAGES_READONLY_SCOPE = "https://www.googleapis.com/auth/chat.app.messages.readonly";

/** `spaces/<id>`: the only shape accepted anywhere a space is named, so a name can never smuggle a path or a query. */
export const SPACE_NAME = /^spaces\/[A-Za-z0-9_-]{1,128}$/;

const messageSchema = z.object({
  name: z.string().regex(/^spaces\/[A-Za-z0-9_-]{1,128}\/messages\/[A-Za-z0-9_.-]{1,256}$/),
  createTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/),
  sender: z.object({ name: z.string().min(1).max(200), displayName: z.string().max(500).optional(), type: z.string().optional() }).passthrough().optional(),
  text: z.string().optional(),
  thread: z.object({ name: z.string().min(1).max(500) }).passthrough().optional(),
  threadReply: z.boolean().optional(),
  deleteTime: z.string().optional(),
}).passthrough();
export type ChatMessage = z.infer<typeof messageSchema>;

const listResponse = z.object({ messages: z.array(messageSchema).default([]), nextPageToken: z.string().min(1).optional() }).passthrough();

export interface ChatClientOptions extends GoogleHttpOptions { chatBase: string }

export function createChatClient(opts: ChatClientOptions) {
  const { send, parse } = createGoogleHttp(opts);
  return {
    /**
     * Messages created strictly after `afterCreateTime`, oldest first. System messages and deleted messages are not returned by Chat.
     * A space the app cannot read (removed, never added, or access not approved) is ProviderSourceUnavailableError.
     */
    async listMessages(token: string, space: string, p: { afterCreateTime: string; pageToken?: string | undefined; pageSize: number }): Promise<{ messages: ChatMessage[]; nextPageToken?: string }> {
      if (!SPACE_NAME.test(space)) throw new ProviderApiError(400);
      const url = new URL(`${opts.chatBase}/${space}/messages`);
      url.searchParams.set("pageSize", String(Math.max(1, Math.min(p.pageSize, 1000))));
      url.searchParams.set("filter", `createTime > "${p.afterCreateTime}"`);
      if (p.pageToken) url.searchParams.set("pageToken", p.pageToken);
      try {
        const { json } = await send(url.toString(), { headers: { authorization: `Bearer ${token}` } });
        const r = parse(listResponse, json ?? {}); // a space with no messages answers {}
        return { messages: r.messages.filter((m) => !m.deleteTime), ...(r.nextPageToken ? { nextPageToken: r.nextPageToken } : {}) };
      } catch (e) {
        if ((e instanceof ProviderAuthError && e.code === "forbidden") || (e instanceof ProviderApiError && e.status === 404)) throw new ProviderSourceUnavailableError();
        throw e;
      }
    },
  };
}
export type ChatClient = ReturnType<typeof createChatClient>;
