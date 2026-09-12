import { snapTool } from "./snapTool";
import { AgentAction } from "./types";

export async function planRenewalAction(userId: string): Promise<AgentAction> {
  const documents = await snapTool.getRequiredDocuments(userId);
  const missing = documents.find((document) => document.status === "MISSING");

  if (missing) {
    return {
      type: "SEND_DOCUMENT_REQUEST",
      document: missing,
      uploadUrl: `https://dropbox.example.com/request/${userId}/${missing.id}`
    };
  }

  const draft = await snapTool.createRenewalDraft(userId, {});
  return { type: "CREATE_RENEWAL_DRAFT", draftId: draft.draftId };
}
