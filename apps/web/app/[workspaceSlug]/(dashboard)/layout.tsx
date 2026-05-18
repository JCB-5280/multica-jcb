"use client";

import { DashboardLayout } from "@mato/views/layout";
import { MATOIcon } from "@mato/ui/components/common/mato-icon";
import { SearchCommand, SearchTrigger } from "@mato/views/search";
import { ChatFab, ChatWindow } from "@mato/views/chat";
import { StarterContentPrompt } from "@mato/views/onboarding";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <DashboardLayout
      loadingIndicator={<MATOIcon className="size-6" />}
      searchSlot={<SearchTrigger />}
      extra={
        <>
          <SearchCommand />
          <ChatWindow />
          <ChatFab />
          <StarterContentPrompt />
        </>
      }
    >
      {children}
    </DashboardLayout>
  );
}
