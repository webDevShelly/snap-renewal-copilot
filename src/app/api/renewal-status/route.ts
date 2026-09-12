import { snapTool } from "@/lib/snapTool";

export async function GET() {
  return Response.json(await snapTool.getRenewalStatus("maria-demo"));
}
