import { planRenewalAction } from "@/lib/agent";

export async function POST() {
  return Response.json(await planRenewalAction("maria-demo"));
}
