import type { SessionFlavor } from "grammy";
import type { ConversationFlavor } from "@grammyjs/conversations";
import type { SessionData } from "../session/types.js";

type BaseContext = import("grammy").Context & SessionFlavor<SessionData>;

export type Context = BaseContext & ConversationFlavor<BaseContext>;
