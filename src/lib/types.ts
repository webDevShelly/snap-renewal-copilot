export type DocumentStatus = "RECEIVED" | "MISSING" | "NEEDS_REVIEW";

export type RequiredDocument = {
  id: string;
  label: string;
  status: DocumentStatus;
  dueDate?: string;
};

export type RenewalStatus = {
  benefitEndDate: string;
  renewalDueDate: string;
  status: "NOT_DUE" | "DUE_SOON" | "ACTION_REQUIRED" | "READY_FOR_REVIEW" | "SUBMITTED";
  portalMessage: string;
};

export type AgentAction =
  | { type: "SEND_DOCUMENT_REQUEST"; document: RequiredDocument; uploadUrl: string }
  | { type: "CREATE_RENEWAL_DRAFT"; draftId: string }
  | { type: "NO_ACTION"; reason: string };
