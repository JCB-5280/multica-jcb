import type { Metadata } from "next";
import { MATOLanding } from "@/features/landing/components/mato-landing";

export const metadata: Metadata = {
  title: "Homepage",
  description:
    "MATO — open-source platform that turns coding agents into real teammates. Assign tasks, track progress, compound skills.",
  openGraph: {
    title: "MATO — Project Management for Human + Agent Teams",
    description:
      "Manage your human + agent workforce in one place.",
    url: "/homepage",
  },
  alternates: {
    canonical: "/homepage",
  },
};

export default function HomepagePage() {
  return <MATOLanding />;
}
