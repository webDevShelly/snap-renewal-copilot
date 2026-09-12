import type { TextMessage } from "./sms";

/** What wakes the agent up: a text from the household, or a scheduled/system event. */
export type TurnInput =
  | { kind: "inbound_text"; body: string }
  | { kind: "event"; name: string; detail?: string };

export type TurnResult = {
  userId: string;
  /** The agent's internal one-line summary (never shown to the household). */
  summary: string;
  /** Texts the agent sent during this turn. */
  sent: TextMessage[];
  /** Tool names invoked this turn, in order. */
  toolCalls: string[];
};
