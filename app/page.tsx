import { Suspense } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { WelcomeScreen } from "@/components/layout/WelcomeScreen";
import { ErrorBoundary } from "@/components/layout/ErrorBoundary";

export default function Home() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<div className="h-dvh"><WelcomeScreen variant="loading" /></div>}>
        <AppShell />
      </Suspense>
    </ErrorBoundary>
  );
}
