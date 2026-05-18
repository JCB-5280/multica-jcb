"use client";

import { use } from "react";
import { IssueDetail } from "@mato/views/issues/components";
import { ErrorBoundary } from "@mato/ui/components/common/error-boundary";

export default function IssueDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <ErrorBoundary resetKeys={[id]}>
      <IssueDetail issueId={id} />
    </ErrorBoundary>
  );
}
