import { redirect } from "next/navigation";
import { requirePageClient } from "@/lib/access";

// Old page: lead notifications moved into Notifications & reports.
export default async function LeadNotifyRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePageClient(id);
  redirect(`/clients/${id}/notify`);
}
