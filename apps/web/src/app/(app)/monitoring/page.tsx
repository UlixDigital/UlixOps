// Monitoring (spec screen 16): opens on the Uptime tab.
import { redirect } from "next/navigation";

export default function MonitoringPage() {
  redirect("/monitoring/uptime");
}
