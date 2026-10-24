import type { Metadata } from "next";
import Link from "next/link";
import { LiveRefresh } from "@/components/actions";
import "./globals.css";

export const metadata: Metadata = { title: "Learning Lab", description: "Your local, adaptive learning space." };
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body><header className="header"><nav className="nav" aria-label="Main navigation">
    <Link className="brand" href="/"><span className="brand-icon">L</span> Learning Lab</Link>
    <div className="nav-links"><Link href="/">Dashboard</Link><Link href="/assessments">Assessments</Link><Link href="/progress">Progress</Link></div>
    <span className="local-label"><span />Local workspace</span>
  </nav></header><LiveRefresh /><main className="container">{children}</main>
    <footer>Local-first. Instructor-guided. Your pace.</footer></body></html>;
}
