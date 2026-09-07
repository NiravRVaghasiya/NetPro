import Link from "next/link";
import OutreachComposer from "./composer";

export const metadata = {
  title: "Outreach — NetPro",
};

export default function OutreachPage() {
  return (
    <div>
      <h1>AI Outreach</h1>
      <p style={{ marginTop: "0.25rem" }}>
        Drafting a one-off message? Use the composer below. Reaching out to many
        people with a personalized sequence?{" "}
        <Link href="/outreach/campaigns">Create a campaign</Link>.
      </p>
      <OutreachComposer />
    </div>
  );
}
