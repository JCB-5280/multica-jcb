"use client";

import { IssuesPage } from "@mato/views/issues/components";
import { ErrorBoundary } from "@mato/ui/components/common/error-boundary";

export default function Page() {
  return (
    <ErrorBoundary>
      <IssuesPage />
    </ErrorBoundary>
  );
}
