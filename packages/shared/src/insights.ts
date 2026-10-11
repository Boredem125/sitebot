// What visitors asked that the bot could not answer, and the contact details they left.
//
// GET    /api/sites/:id/unanswered                          -> { questions: UnansweredQuestion[] }   (session)
// GET    /api/sites/:id/leads                               -> { leads: Lead[] }                     (session)
// POST   /v1/lead                            LeadRequest    -> { ok: true }   (public; same Origin rules as /v1/chat)

/** Visitor questions that got no grounded answer, grouped by wording, most recent first. */
export interface UnansweredQuestion {
  question: string;
  /** How many times this wording was asked. */
  count: number;
  lastAskedAt: number;
  /** The most recent conversation it came up in. */
  conversationId: string;
}

export interface Lead {
  id: string;
  email: string;
  /** The question the visitor wanted answered. May be empty. */
  question: string;
  conversationId: string | null;
  createdAt: number;
}

export interface LeadRequest {
  siteKey: string;
  email: string;
  conversationId?: string;
  question?: string;
}

export const INSIGHT_LIMITS = {
  suggestedQuestions: 3,
  suggestedQuestionMaxChars: 80,
  emailMaxChars: 254,
} as const;
