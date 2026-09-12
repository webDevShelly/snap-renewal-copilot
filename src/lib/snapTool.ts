import { RequiredDocument, RenewalStatus } from "./types";

const mariaDocuments: RequiredDocument[] = [
  { id: "income-proof", label: "Most recent pay stub", status: "MISSING", dueDate: "2026-10-31" },
  { id: "identity-proof", label: "Photo identification", status: "RECEIVED" }
];

/**
 * Adapter boundary for a state SNAP portal. This hackathon implementation is
 * intentionally seeded demo data—never store portal credentials in this app.
 */
export const snapTool = {
  async getRenewalStatus(_userId: string): Promise<RenewalStatus> {
    return {
      benefitEndDate: "2026-11-15",
      renewalDueDate: "2026-10-31",
      status: "ACTION_REQUIRED",
      portalMessage: "Upload proof of income and complete household income section."
    };
  },

  async getRequiredDocuments(_userId: string): Promise<RequiredDocument[]> {
    return mariaDocuments;
  },

  async createRenewalDraft(_userId: string, _answers: Record<string, string>) {
    return { draftId: "renewal-demo-001", status: "READY_FOR_REVIEW" as const };
  },

  async submitRenewal(draftId: string, userConfirmed: boolean) {
    if (!userConfirmed) throw new Error("User confirmation is required before submission.");
    return { draftId, confirmationNumber: "SNAP-DEMO-48291" };
  }
};
