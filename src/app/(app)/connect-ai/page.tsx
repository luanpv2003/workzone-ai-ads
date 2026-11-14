import { ConnectAiView } from "@/components/connect-ai-view";
import { getT } from "@/i18n/server";

export async function generateMetadata() {
  return { title: (await getT())("system.settingsNav.connectAi") };
}

// "Nối AI của bạn" (Connect your AI) from the main menu; same content as the System settings tab /connections/mcp.
export default function ConnectAiPage() {
  return <ConnectAiView />;
}
