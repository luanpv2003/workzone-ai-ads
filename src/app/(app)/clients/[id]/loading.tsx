import { PageSkeleton } from "@/components/page-skeleton";

// Rendered inside the client layout: client name, buttons and tab bar stay put; only the tab content shows a skeleton.
export default function Loading() {
  return <PageSkeleton compact />;
}
